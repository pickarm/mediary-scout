import type { NextRequest } from "next/server";
import { LibraryQueryInputError, normalizePostgresLibraryQueryInput, type LibraryQueryMediaType, type LibraryQuerySort, type LibraryQueryState } from "@media-track/workflow/library-query";
import { getLibraryMediaPage } from "../../../../lib/library-media-runtime";
import { apiErrorResponse, LibraryApiError, libraryAccount, requireString } from "../../../../lib/library-api";
import { getWorkflowRepository } from "../../../../lib/workflow-runtime";

const MEDIA_TYPES: readonly LibraryQueryMediaType[] = ["movie", "tv", "anime"];
const MEDIA_STATES: readonly LibraryQueryState[] = ["complete", "tracking", "partial", "reserved"];
const SORTS: readonly LibraryQuerySort[] = ["title", "year", "obtainedEpisodes", "totalAiredEpisodes"];

function enumParam<T extends string>(value: string | null, values: readonly T[], label: string): T | undefined {
  if (value === null || value === "") return undefined;
  if (!values.includes(value as T)) throw new LibraryApiError(400, `${label}无效。`);
  return value as T;
}

function positiveInt(value: string | null, fallback: number, label: string, max: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new LibraryApiError(400, `${label}无效。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) throw new LibraryApiError(400, `${label}超出允许范围。`);
  return parsed;
}

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const params = request.nextUrl.searchParams;
    const rawStorageId = params.get("storageId");
    const connectedStorageId = rawStorageId === null || rawStorageId === "" ? null : requireString(rawStorageId, "网盘", 200);
    if (connectedStorageId !== null) {
      const storages = await getWorkflowRepository().listConnectedStorages(accountId);
      if (!storages.some((storage) => storage.id === connectedStorageId && storage.accountId === accountId)) {
        throw new LibraryApiError(404, "找不到该账号的网盘连接。");
      }
    }
    const search = params.get("search") ?? "";
    if (search.length > 200) throw new LibraryApiError(400, "查找内容不能超过 200 个字符。");
    const direction = params.get("direction") ?? undefined;
    if (direction !== undefined && direction !== "asc" && direction !== "desc") throw new LibraryApiError(400, "排序方向无效。");
    const input = normalizePostgresLibraryQueryInput({
      accountId,
      connectedStorageId,
      type: enumParam(params.get("type"), MEDIA_TYPES, "媒体类型") ?? null,
      state: enumParam(params.get("state"), MEDIA_STATES, "状态") ?? null,
      search,
      sort: enumParam(params.get("sort"), SORTS, "排序") ?? "title",
      direction: direction ?? "asc",
      page: positiveInt(params.get("page"), 1, "页码", 1_000_000),
      pageSize: positiveInt(params.get("pageSize"), 48, "每页数量", 100),
    });
    return Response.json(await getLibraryMediaPage(input));
  } catch (error) {
    if (error instanceof LibraryQueryInputError) return Response.json({ error: error.message }, { status: 400 });
    return apiErrorResponse(error);
  }
}
