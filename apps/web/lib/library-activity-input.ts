import type { PostgresActivityQueryInput } from "@media-track/workflow/activity-query";
import { LibraryApiError, parseLimit, requireString } from "./library-api";

function pageParam(value: string | null, name: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/u.test(value)) throw new LibraryApiError(400, `${name}无效。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1_000_000) throw new LibraryApiError(400, `${name}超出允许范围。`);
  return parsed;
}

function historyCursor(value: string | null): { createdAt: string; id: string } | undefined {
  if (!value) return undefined;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new LibraryApiError(400, "历史游标无效。");
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new Error("bad cursor");
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("bad cursor");
    const item = parsed as Record<string, unknown>;
    if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.id !== "string" || !item.id || item.id.length > 200) throw new Error("bad cursor");
    return { createdAt: item.createdAt, id: item.id };
  } catch { throw new LibraryApiError(400, "历史游标无效。"); }
}

/** Shared F10b query parsing for the JSON activity route and the progress stream. */
export function parseLibraryActivityInput(params: URLSearchParams, accountId: string): PostgresActivityQueryInput {
  const rawStorage = params.get("storageId");
  const storageId = rawStorage === null ? null : requireString(rawStorage, "网盘");
  const runIds = params.getAll("runId");
  if (runIds.length > 100) throw new LibraryApiError(400, "任务 ID 数量超出允许范围。");
  return {
    accountId,
    connectedStorageId: storageId,
    ...(params.has("activePage") ? { activePage: pageParam(params.get("activePage"), "活动页码")! } : {}),
    ...(params.has("activePageSize") ? { activePageSize: parseLimit(params.get("activePageSize"), 48, 100) } : {}),
    ...(params.has("recentLimit") ? { recentLimit: parseLimit(params.get("recentLimit"), 30, 100) } : {}),
    ...(params.has("historyCursor") ? { historyCursor: historyCursor(params.get("historyCursor"))! } : {}),
    ...(runIds.length ? { runIds: runIds.map((id) => requireString(id, "任务 ID", 200)) } : {}),
  };
}
