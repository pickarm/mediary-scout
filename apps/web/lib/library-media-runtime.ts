import {
  initializePostgresLibraryQueryIndexes,
  normalizePostgresLibraryQueryInput,
  PostgresLibraryQuery,
  type LibraryQueryPage,
  type PostgresLibraryQueryInput,
} from "@media-track/workflow/library-query";
import { getLibraryPool } from "./library-runtime";
import { getLibrarySummaryCache } from "./library-summary-cache";

let query: PostgresLibraryQuery | null = null;
let prepared: Promise<void> | null = null;

/** Lazy server query for bounded poster-wall summaries. */
export async function getLibraryMediaPage(input: PostgresLibraryQueryInput): Promise<LibraryQueryPage> {
  const pool = getLibraryPool();
  if (!query) query = new PostgresLibraryQuery(pool);
  const libraryQuery = query;
  if (!prepared) prepared = initializePostgresLibraryQueryIndexes(pool).catch((error: unknown) => { prepared = null; throw error; });
  await prepared;
  const normalized = normalizePostgresLibraryQueryInput(input);
  return getLibrarySummaryCache().getOrLoad("media", normalized, () => libraryQuery.list(normalized));
}
