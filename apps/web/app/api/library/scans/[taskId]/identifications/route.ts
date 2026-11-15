import type { NextRequest } from "next/server";
import { IdentificationConflictError, IdentificationInputError, IdentificationStoreScopeError, ScanScopeError, ScanStorageScopeError, ScanStoreInputError, LibraryImportConflictError, LibraryStorageScopeError } from "@media-track/workflow/library";
import { apiErrorResponse, decodeCursor, encodeCursor, LibraryApiError, libraryAccount, parseLimit, readJson, requireString } from "../../../../../../lib/library-api";
import { getLibraryIdentificationService, watchLibraryScanForIdentification } from "../../../../../../lib/library-identification-runtime";

type RouteContext = { params: Promise<{ taskId: string }> };

function mapError(error: unknown): Response {
  if (error instanceof IdentificationInputError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof IdentificationConflictError || error instanceof LibraryImportConflictError || error instanceof ScanStoreInputError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof IdentificationStoreScopeError || error instanceof LibraryStorageScopeError || error instanceof ScanScopeError || error instanceof ScanStorageScopeError) return Response.json({ error: error.message }, { status: 404 });
  return apiErrorResponse(error);
}

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"), 50, 200);
    const afterFileId = decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const statusValue = request.nextUrl.searchParams.get("status");
    if (statusValue !== null && !["confirmed", "pending", "ignored", "failed"].includes(statusValue)) throw new LibraryApiError(400, "识别状态筛选值无效。");
    const { taskId } = await context.params;
    const scope = { accountId, connectedStorageId: storageId };
    const service = await getLibraryIdentificationService(scope);
    const page = await service.list(scope, requireString(taskId, "扫描任务 ID", 150), {
      limit,
      ...(afterFileId === undefined ? {} : { afterFileId }),
      ...(statusValue === null ? {} : { status: statusValue as "confirmed" | "pending" | "ignored" | "failed" }),
    });
    return Response.json({
      summary: page.summary.job ? { status: page.summary.job.status, scanStatus: page.summary.job.scanStatus, afterFileId: page.summary.job.afterFileId, attempts: page.summary.job.attempts, lastError: page.summary.job.lastError } : null,
      counts: { total: page.summary.total, confirmed: page.summary.confirmed, pending: page.summary.pending, ignored: page.summary.ignored, failed: page.summary.failed, imported: page.summary.imported },
      items: page.items,
      nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      hasMore: page.hasMore,
    });
  } catch (error) { return mapError(error); }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["storageId", "action"].includes(key))) throw new LibraryApiError(400, "请求包含不支持的字段。");
    const storageId = requireString(body.storageId, "网盘");
    const action = body.action === undefined ? "start" : body.action;
    if (action !== "start" && action !== "retry") throw new LibraryApiError(400, "识别操作无效。");
    const { taskId } = await context.params;
    const task = requireString(taskId, "扫描任务 ID", 150);
    const scope = { accountId, connectedStorageId: storageId };
    const service = await getLibraryIdentificationService(scope);
    if (action === "retry") {
      if (!(await service.retryFailed(scope, task))) throw new IdentificationConflictError("当前识别任务没有可重试的失败状态");
    } else {
      await service.enqueueForScan(scope, task);
    }
    const summary = await service.identificationStore.getJob(scope, task);
    void watchLibraryScanForIdentification(scope, task).catch(() => undefined);
    return Response.json({ status: summary?.status ?? "pending" }, { status: 202 });
  } catch (error) { return mapError(error); }
}
