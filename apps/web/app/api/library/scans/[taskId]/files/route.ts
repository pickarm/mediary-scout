import type { NextRequest } from "next/server";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, parseLimit, requireString } from "../../../../../../lib/library-api";
import { getLibraryServices } from "../../../../../../lib/library-runtime";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"), 100, 200);
    const afterFileId = decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const { taskId } = await context.params;
    const scope = { accountId, connectedStorageId: storageId };
    const { scanStore } = await getLibraryServices(scope);
    const rows = await scanStore.listTaskFiles(scope, requireString(taskId, "扫描任务", 100), { limit: limit + 1, ...(afterFileId === undefined ? {} : { afterFileId }) });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return Response.json({ items, nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!.fileId) : null, hasMore });
  } catch (error) { return apiErrorResponse(error); }
}
