import type { NextRequest } from "next/server";
import type { OrganizationHistoryStatusFilter } from "@media-track/workflow/library";
import { apiErrorResponse, libraryAccount, LibraryApiError, parseLimit, requireString } from "../../../../lib/library-api";
import { getLibraryReadOrganizationService } from "../../../../lib/library-read-runtime";
import { getLibraryReadServices } from "../../../../lib/library-runtime";

const ALLOWED_STATUSES = new Set<OrganizationHistoryStatusFilter>(["all", "active", "planned", "running", "verified", "failed"]);

interface LatestScanRow {
  task_id: string;
  config_id: string;
  status: string;
  directories_done: number;
  directories_discovered: number;
  files_discovered: number;
  updated_at: string;
}

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
    const statusRaw = (params.get("status") ?? "all").trim();
    if (!ALLOWED_STATUSES.has(statusRaw as OrganizationHistoryStatusFilter)) {
      throw new LibraryApiError(400, "整理状态筛选无效。");
    }
    const status = statusRaw as OrganizationHistoryStatusFilter;

    const [{ store, scope }, { pool }] = await Promise.all([
      getLibraryReadOrganizationService(accountId, storageId),
      getLibraryReadServices({ accountId, connectedStorageId: storageId }),
    ]);

    const [historyPage, scanTaskResult, activePlansResult] = await Promise.all([
      store.listOperationHistory(scope, { page, pageSize, status }),
      pool.query<LatestScanRow>(
        `SELECT task_id, config_id, status, directories_done, directories_discovered, files_discovered, updated_at
           FROM library_scan_tasks
          WHERE account_id=$1 AND connected_storage_id=$2 AND config_id NOT LIKE 'msg\\_%' ESCAPE '\\'
          ORDER BY updated_at DESC, task_id DESC
          LIMIT 1`,
        [scope.accountId, scope.connectedStorageId],
      ),
      pool.query<{ active_count: string }>(
        `SELECT COUNT(*)::text AS active_count
           FROM library_organization_plans
          WHERE account_id=$1 AND connected_storage_id=$2
            AND (status='running' OR (execute_requested=true AND status IN ('planned','paused')))`,
        [scope.accountId, scope.connectedStorageId],
      ),
    ]);

    const latestScan = scanTaskResult.rows[0]
      ? {
          taskId: scanTaskResult.rows[0].task_id,
          configId: scanTaskResult.rows[0].config_id,
          status: scanTaskResult.rows[0].status,
          directoriesDone: Number(scanTaskResult.rows[0].directories_done),
          directoriesDiscovered: Number(scanTaskResult.rows[0].directories_discovered),
          filesDiscovered: Number(scanTaskResult.rows[0].files_discovered),
          updatedAt: scanTaskResult.rows[0].updated_at,
        }
      : null;

    const activePlanCount = Number(activePlansResult.rows[0]?.active_count ?? 0);
    const scanRunning = Boolean(latestScan && ["queued", "running", "cancelling"].includes(latestScan.status));
    const hasActiveWork = scanRunning || activePlanCount > 0 || historyPage.counts.running > 0;

    return Response.json({
      ...historyPage,
      activeSummary: {
        hasActiveWork,
        latestScanTask: latestScan,
        activePlanCount,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
