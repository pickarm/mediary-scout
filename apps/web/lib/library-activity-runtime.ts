import { initializePostgresActivityQueryIndexes, PostgresActivityQuery } from "@media-track/workflow/activity-query";
import type { PostgresActivityPage, PostgresActivityQueryInput } from "@media-track/workflow/activity-query";
import { getLibraryPool } from "./library-runtime";

let query: PostgresActivityQuery | null = null;
let prepared: Promise<void> | null = null;

/** Lazy server singleton. Index DDL is guarded once per process and never runs per request. */
export async function getLibraryActivityPage(input: PostgresActivityQueryInput): Promise<PostgresActivityPage> {
  const pool = getLibraryPool();
  if (!query) query = new PostgresActivityQuery(pool);
  if (!prepared) prepared = initializePostgresActivityQueryIndexes(pool).catch((error: unknown) => { prepared = null; throw error; });
  await prepared;
  return query.getPage(input);
}
