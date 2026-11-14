import type { NextRequest } from "next/server";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, parseLimit, readJson, requireString, LibraryApiError } from "../../../../lib/library-api";
import { getLibraryServices } from "../../../../lib/library-runtime";
import { getLibraryIdentificationService, watchLibraryScanForIdentification } from "../../../../lib/library-identification-runtime";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const requestedLimit = parseLimit(request.nextUrl.searchParams.get("limit"), 20, 99);
    const afterTaskId = decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const scope = { accountId, connectedStorageId: storageId };
    const { scanStore } = await getLibraryServices(scope);
    const rows = await scanStore.listTasks(scope, { limit: requestedLimit + 1, ...(afterTaskId === undefined ? {} : { afterTaskId }) });
    const hasMore = rows.length > requestedLimit;
    const page = rows.slice(0, requestedLimit);
    return Response.json({ items: page.map(({ scope: _scope, ...task }) => task), nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1]!.taskId) : null, hasMore });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !["storageId", "configId"].includes(key))) throw new LibraryApiError(400, "请求包含不支持的字段。");
    const storageId = requireString(body.storageId, "网盘");
    const configId = requireString(body.configId, "配置 ID", 100);
    const scope = { accountId, connectedStorageId: storageId };
    const { scanner } = await getLibraryServices(scope);
    const task = await scanner.start(scope, configId);
    const identification = await getLibraryIdentificationService(scope);
    await identification.enqueueForScan(scope, task.taskId);
    void watchLibraryScanForIdentification(scope, task.taskId).catch(() => undefined);
    const { scope: _scope, ...dto } = task;
    return Response.json({ item: dto }, { status: 202 });
  } catch (error) { return apiErrorResponse(error); }
}
