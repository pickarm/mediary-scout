import type { NextRequest } from "next/server";
import { apiErrorResponse, libraryAccount, readJson, requireString, LibraryApiError } from "../../../../../lib/library-api";
import { getLibraryReadServices, getLibraryServices } from "../../../../../lib/library-runtime";

type RouteContext = { params: Promise<{ taskId: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const { taskId } = await context.params;
    const scope = { accountId, connectedStorageId: storageId };
    const { scanStore } = await getLibraryReadServices(scope);
    const task = await scanStore.getTask(scope, requireString(taskId, "扫描任务", 100));
    if (!task) return Response.json({ error: "扫描任务不存在或已不可访问。" }, { status: 404 });
    const { scope: _scope, ...dto } = task;
    return Response.json({ item: dto });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request, 4_000);
    if (Object.keys(body).some((key) => !["storageId", "action"].includes(key))) throw new LibraryApiError(400, "请求包含不支持的字段。");
    const storageId = requireString(body.storageId, "网盘");
    const action = body.action;
    if (action !== "pause" && action !== "resume" && action !== "cancel" && action !== "retry") throw new LibraryApiError(400, "扫描操作无效。");
    const { taskId } = await context.params;
    const scope = { accountId, connectedStorageId: storageId };
    const { scanner } = await getLibraryServices(scope);
    const id = requireString(taskId, "扫描任务", 100);
    const task = action === "pause" ? await scanner.pause(scope, id)
      : action === "resume" ? await scanner.resume(scope, id)
        : action === "cancel" ? await scanner.cancel(scope, id)
          : await scanner.retryFailed(scope, id);
    const { scope: _scope, ...dto } = task;
    return Response.json({ item: dto }, { status: 202 });
  } catch (error) { return apiErrorResponse(error); }
}
