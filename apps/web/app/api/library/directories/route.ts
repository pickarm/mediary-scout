import type { NextRequest } from "next/server";
import { apiErrorResponse, libraryAccount, requireString, LibraryApiError } from "../../../../lib/library-api";
import { issueDirectorySelectionTicket } from "../../../../lib/library-runtime";
import { getLibraryServices } from "../../../../lib/library-runtime";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const parentId = request.nextUrl.searchParams.get("parentId") ?? "";
    if (parentId.length > 300 || /[\u0000-\u001f]/u.test(parentId)) throw new LibraryApiError(400, "目录 ID 无效。");
    const pageRaw = request.nextUrl.searchParams.get("page") ?? "0";
    if (!/^\d+$/u.test(pageRaw) || Number(pageRaw) > 100_000) throw new LibraryApiError(400, "目录分页无效。");
    const { client } = await getLibraryServices({ accountId, connectedStorageId: storageId });
    const page = Number(pageRaw);
    const result = await client.listFilesPage(parentId, page, 200);
    const items = result.items.filter((entry) => entry.resType === 2).map((entry) => ({
      directoryId: entry.fileId,
      name: entry.fileName,
      selectionToken: issueDirectorySelectionTicket({ accountId, connectedStorageId: storageId, directoryId: entry.fileId, parentId, name: entry.fileName, page }),
    }));
    return Response.json({ items, nextPage: result.hasMore ? page + 1 : null });
  } catch (error) { return apiErrorResponse(error); }
}
