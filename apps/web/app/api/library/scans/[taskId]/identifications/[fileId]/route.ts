import type { NextRequest } from "next/server";
import { IdentificationConflictError, IdentificationInputError, IdentificationStoreScopeError, ScanScopeError, ScanStorageScopeError, ScanStoreInputError, LibraryImportConflictError, LibraryStorageScopeError } from "@media-track/workflow/library";
import { apiErrorResponse, LibraryApiError, libraryAccount, readJson, requireString } from "../../../../../../../lib/library-api";
import { getLibraryIdentificationService } from "../../../../../../../lib/library-identification-runtime";

type RouteContext = { params: Promise<{ taskId: string; fileId: string }> };

function mapError(error: unknown): Response {
  if (error instanceof IdentificationInputError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof IdentificationConflictError || error instanceof LibraryImportConflictError || error instanceof ScanStoreInputError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof IdentificationStoreScopeError || error instanceof LibraryStorageScopeError || error instanceof ScanScopeError || error instanceof ScanStorageScopeError) return Response.json({ error: error.message }, { status: 404 });
  return apiErrorResponse(error);
}

export async function POST(request: NextRequest, context: RouteContext): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    const allowed = new Set(["storageId", "tmdbId", "mediaType", "seasonNumber", "episodeNumbers"]);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new LibraryApiError(400, "请求包含不支持的字段。");
    const storageId = requireString(body.storageId, "网盘");
    if (typeof body.tmdbId !== "number" || !Number.isSafeInteger(body.tmdbId) || body.tmdbId < 1) throw new LibraryApiError(400, "TMDB ID 无效。");
    if (body.mediaType !== "movie" && body.mediaType !== "tv" && body.mediaType !== "anime") throw new LibraryApiError(400, "媒体类型无效。");
    if (body.seasonNumber !== undefined && (typeof body.seasonNumber !== "number" || !Number.isSafeInteger(body.seasonNumber))) throw new LibraryApiError(400, "季号无效。");
    if (body.episodeNumbers !== undefined && (!Array.isArray(body.episodeNumbers) || body.episodeNumbers.length > 50 || body.episodeNumbers.some((n) => typeof n !== "number" || !Number.isSafeInteger(n)))) throw new LibraryApiError(400, "集号列表无效。");
    const { taskId, fileId } = await context.params;
    const scope = { accountId, connectedStorageId: storageId };
    const service = await getLibraryIdentificationService(scope);
    const result = await service.confirmFile({
      scope,
      taskId: requireString(taskId, "扫描任务 ID", 150),
      fileId: requireString(fileId, "文件 ID", 500),
      tmdbId: body.tmdbId,
      mediaType: body.mediaType,
      ...(body.seasonNumber === undefined ? {} : { seasonNumber: body.seasonNumber as number }),
      ...(body.episodeNumbers === undefined ? {} : { episodeNumbers: body.episodeNumbers as number[] }),
    });
    return Response.json(result);
  } catch (error) { return mapError(error); }
}
