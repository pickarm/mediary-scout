import { initializePostgresActivityQueryIndexes, normalizePostgresActivityQueryInput, PostgresActivityQuery } from "@media-track/workflow/activity-query";
import type { PostgresActivityPage, PostgresActivityQueryInput } from "@media-track/workflow/activity-query";
import { getLibraryPool } from "./library-runtime";
import { getLibrarySummaryCache } from "./library-summary-cache";

let query: PostgresActivityQuery | null = null;
let prepared: Promise<void> | null = null;

/** Lazy server singleton. Index DDL is guarded once per process and never runs per request. */
export async function getLibraryActivityPage(input: PostgresActivityQueryInput): Promise<PostgresActivityPage> {
  const pool = getLibraryPool();
  if (!query) query = new PostgresActivityQuery(pool);
  const activityQuery = query;
  if (!prepared) prepared = initializePostgresActivityQueryIndexes(pool).catch((error: unknown) => { prepared = null; throw error; });
  await prepared;
  const normalized = normalizePostgresActivityQueryInput(input);
  return getLibrarySummaryCache().getOrLoad("activity", normalized, () => activityQuery.getPage(normalized));
}
