import type { NextRequest } from "next/server";
import { LibraryStorageScopeError } from "@media-track/workflow/library";
import { apiErrorResponse, LibraryApiError, libraryAccount, readJson, requireString } from "../../../../lib/library-api";
import { setLibrarySeasonTracking } from "../../../../lib/library-identification-runtime";

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["storageId", "trackedSeasonId", "autoAcquire"].includes(key))) throw new LibraryApiError(400, "请求包含不支持的字段。");
    const scope = { accountId, connectedStorageId: requireString(body.storageId, "网盘") };
    const trackedSeasonId = requireString(body.trackedSeasonId, "剧季 ID", 300);
    if (typeof body.autoAcquire !== "boolean") throw new LibraryApiError(400, "补缺开关无效。");
    await setLibrarySeasonTracking(scope, trackedSeasonId, body.autoAcquire);
    return Response.json({ trackedSeasonId, autoAcquire: body.autoAcquire });
  } catch (error) {
    if (error instanceof LibraryStorageScopeError) return Response.json({ error: "剧季不存在或不属于当前账号与网盘。" }, { status: 404 });
    return apiErrorResponse(error);
  }
}
