import type { NextRequest } from "next/server";
import { getStorageBrand } from "@media-track/workflow";
import { apiErrorResponse, libraryAccount, requireString, LibraryApiError } from "../../../../lib/library-api";
import { issueDirectorySelectionTicket } from "../../../../lib/library-runtime";
import { getLibraryServices } from "../../../../lib/library-runtime";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const { reader, storage } = await getLibraryServices({ accountId, connectedStorageId: storageId });
    const requestedParentId = request.nextUrl.searchParams.get("parentId");
    const parentId = requestedParentId === null || requestedParentId === ""
      ? getStorageBrand(storage.provider).provisionRootId
      : requestedParentId;
    if (parentId.length > 300 || /[\u0000-\u001f]/u.test(parentId)) throw new LibraryApiError(400, "目录 ID 无效。");
    const pageRaw = request.nextUrl.searchParams.get("page") ?? "0";
    if (!/^\d+$/u.test(pageRaw) || Number(pageRaw) > 100_000) throw new LibraryApiError(400, "目录分页无效。");
    const cursor = request.nextUrl.searchParams.get("cursor") ?? undefined;
    if (cursor !== undefined && (!cursor || cursor.length > 4096)) throw new LibraryApiError(400, "目录分页游标无效。");
    const page = Number(pageRaw);
    const result = await reader.listPage({
      directoryId: parentId,
      directoryPath: "",
      page,
      pageSize: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const items = result.items.filter((entry) => entry.isDirectory).map((entry) => ({
      directoryId: entry.fileId,
      name: entry.name,
      selectionToken: issueDirectorySelectionTicket({
        accountId,
        connectedStorageId: storageId,
        directoryId: entry.fileId,
        parentId,
        name: entry.name,
        page,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    }));
    return Response.json({ items, nextPage: result.nextPage, nextCursor: result.nextCursor ?? null });
  } catch (error) { return apiErrorResponse(error); }
}
