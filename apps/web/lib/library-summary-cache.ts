import { PostgresSummaryCache } from "@media-track/workflow/summary-cache";
import { getLibraryPool } from "./library-runtime";

let cache: PostgresSummaryCache | null = null;

function ttlFromEnvironment(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(30_000, value) : undefined;
}

function libraryDatabaseIdentity(connectionString: string | undefined): string | null {
  if (!connectionString?.trim()) return null;
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!url.hostname || !database) return null;
    // Deliberately omit username, password, and arbitrary query parameters.
    return JSON.stringify([url.protocol, url.hostname.toLowerCase(), url.port || "5432", database, url.searchParams.get("sslmode") ?? ""]);
  } catch {
    return null;
  }
}

/** A lazy, process-wide optional cache. Importing this module opens no connections. */
export function getLibrarySummaryCache(): PostgresSummaryCache {
  if (!cache) {
    const databaseIdentity = libraryDatabaseIdentity(process.env.MEDIA_TRACK_POSTGRES_URL);
    const configuredNamespace = process.env.MEDIA_TRACK_SUMMARY_CACHE_NAMESPACE?.trim() || "mediary-scout";
    const rehearsal = process.env.MEDIA_TRACK_REHEARSAL === "1";
    const redisUrl = rehearsal ? undefined : process.env.REDIS_URL;
    const identity = rehearsal ? undefined : databaseIdentity ?? undefined;
    const mediaTtlMs = ttlFromEnvironment("MEDIA_TRACK_SUMMARY_MEDIA_TTL_MS");
    const activityTtlMs = ttlFromEnvironment("MEDIA_TRACK_SUMMARY_ACTIVITY_TTL_MS");
    cache = new PostgresSummaryCache({
      pool: getLibraryPool(),
      ...(redisUrl ? { redisUrl } : {}),
      namespace: configuredNamespace,
      ...(identity ? { databaseIdentity: identity } : {}),
      ...(mediaTtlMs !== undefined ? { mediaTtlMs } : {}),
      ...(activityTtlMs !== undefined ? { activityTtlMs } : {}),
    });
  }
  return cache;
}

/** Lightweight post-commit/reconnect wake for future snapshot-based subscribers. */
export function subscribeLibrarySummaryWake(listener: () => void): () => void {
  return getLibrarySummaryCache().subscribe(listener);
}

export function isLibrarySummaryCacheReady(): boolean {
  return cache?.isReady() ?? false;
}
