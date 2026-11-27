import type { NextRequest } from "next/server";
import { PostgresOrganizedIndexStore } from "@media-track/workflow/library";
import { apiErrorResponse, libraryAccount, LibraryApiError, parseLimit, readJson, requireString } from "../../../../lib/library-api";
import { getLibraryOrganizationService, LibraryOrganizationRuntimeError } from "../../../../lib/library-organization-runtime";
import { wakeLibraryOrganizationWorker } from "../../../../lib/library-organization-worker";
import { getLibraryReadServices } from "../../../../lib/library-runtime";

const ALLOWED_DRIFT_STATUSES = new Set<"drifted" | "ignored">(["drifted", "ignored"]);
const ALLOWED_POST_KEYS = new Set(["storageId", "action", "fileIds", "allDrifted"]);

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const params = request.nextUrl.searchParams;
    const storageId = requireString(params.get("storageId"), "网盘");
    const pageRaw = params.get("page");
    let page = 1;
    if (pageRaw !== null && pageRaw.trim() !== "") {
      const parsed = Number(pageRaw);
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000) {
        throw new LibraryApiError(400, "页码须为 1 到 10000 的整数。");
      }
      page = parsed;
    }
    const pageSize = parseLimit(params.get("pageSize"), 20, 100);
    const statusRaw = (params.get("status") ?? "drifted").trim();
    if (!ALLOWED_DRIFT_STATUSES.has(statusRaw as "drifted" | "ignored")) {
      throw new LibraryApiError(400, "变更状态筛选无效。");
    }
    const scope = { accountId, connectedStorageId: storageId };
    const { pool } = await getLibraryReadServices(scope);
    const indexStore = new PostgresOrganizedIndexStore(pool);
    const result = await indexStore.listDrifts(scope, {
      status: statusRaw as "drifted" | "ignored",
      page,
      pageSize,
    });
    return Response.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !ALLOWED_POST_KEYS.has(key))) {
      throw new LibraryApiError(400, "请求包含不支持的字段。");
    }
    const storageId = requireString(body.storageId, "网盘");
    const action = requireString(body.action, "操作类型", 40);
    const now = new Date().toISOString();

    if (action === "ignore" || action === "unignore") {
      const fileIds = parseFileIds(body.fileIds);
      const scope = { accountId, connectedStorageId: storageId };
      const { pool } = await getLibraryReadServices(scope);
      const indexStore = new PostgresOrganizedIndexStore(pool);
      const updatedCount = action === "ignore"
        ? await indexStore.ignoreDrifts(scope, fileIds, now)
        : await indexStore.unignoreDrifts(scope, fileIds, now);
      return Response.json({ updatedCount, accepted: updatedCount > 0 });
    }

    if (action !== "reorganize") {
      throw new LibraryApiError(400, "索引操作类型无效。");
    }

    const service = await getLibraryOrganizationService(accountId, storageId);
    const allDrifted = body.allDrifted === true;
    const requestedIds = allDrifted
      ? await service.organizedIndexStore.listAllDriftedFileIds(service.scope, 50)
      : parseFileIds(body.fileIds);
    if (requestedIds.length === 0) {
      return Response.json({ queuedPlans: 0, queuedFiles: 0 });
    }

    const entries = await service.organizedIndexStore.listByFileIds(service.scope, requestedIds);
    if (entries.length === 0) {
      throw new LibraryApiError(404, "未找到对应的已整理索引记录。");
    }

    const { pool } = await getLibraryReadServices(service.scope);
    const fallbackTaskRes = entries.some((entry) => !entry.observedTaskId)
      ? await pool.query<{ task_id: string }>(
          `SELECT task_id
             FROM library_scan_tasks
            WHERE account_id=$1
              AND connected_storage_id=$2
              AND config_id NOT LIKE 'msg\\_%' ESCAPE '\\'
              AND status IN ('completed','partial')
            ORDER BY updated_at DESC, task_id DESC
            LIMIT 1`,
          [service.scope.accountId, service.scope.connectedStorageId],
        )
      : null;
    const fallbackTaskId = fallbackTaskRes?.rows[0]?.task_id ?? null;

    const filesByTask = new Map<string, string[]>();
    for (const entry of entries) {
      const taskId = entry.observedTaskId ?? fallbackTaskId;
      if (!taskId) {
        throw new LibraryOrganizationRuntimeError(
          "organization_conflict",
          "部分变更文件缺少最近扫库上下文，请先执行一次扫描刷新文件位置后再重新整理。",
        );
      }
      const list = filesByTask.get(taskId) ?? [];
      list.push(entry.fileId);
      filesByTask.set(taskId, list);
    }

    let queuedPlans = 0;
    let queuedFiles = 0;
    for (const [taskId, groupFileIds] of filesByTask.entries()) {
      await service.organizedIndexStore.syncScannedParentBindings(service.scope, taskId, groupFileIds, now);
      const plan = await service.preview(taskId, { fileIds: groupFileIds });
      if (plan.operations.length === 0) continue;
      if (await service.store.requestExecution(service.scope, taskId, plan.operationKey, now)) {
        queuedPlans += 1;
        queuedFiles += groupFileIds.length;
      }
    }
    if (queuedPlans > 0) {
      wakeLibraryOrganizationWorker();
    }
    return Response.json({ queuedPlans, queuedFiles });
  } catch (error) {
    if (error instanceof LibraryOrganizationRuntimeError) {
      return Response.json(
        { error: error.message },
        { status: error.code === "storage_not_found" ? 404 : error.code === "credentials_invalid" ? 403 : 409 },
      );
    }
    if (error instanceof Error && error.message.includes("扫描")) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return apiErrorResponse(error);
  }
}

function parseFileIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 50) {
    throw new LibraryApiError(400, "每次需选择 1 到 50 个文件。");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const id = requireString(item, "文件 ID", 200);
    if (seen.has(id)) {
      throw new LibraryApiError(400, "文件列表不能包含重复 ID。");
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}
