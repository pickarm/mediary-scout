import type { Pool } from "pg";

export type LibraryQueryMediaType = "movie" | "tv" | "anime";
export type LibraryQueryState = "complete" | "tracking" | "partial" | "reserved";
export type LibraryQuerySort = "title" | "year" | "obtainedEpisodes" | "totalAiredEpisodes";

export interface PostgresLibraryQueryInput {
  accountId: string;
  /** Null means all storages owned by this account. */
  connectedStorageId: string | null;
  type?: LibraryQueryMediaType;
  state?: LibraryQueryState;
  search?: string;
  sort?: LibraryQuerySort;
  direction?: "asc" | "desc";
  page?: number;
  pageSize?: number;
}

/** Bounded poster-wall summary; artwork is database metadata and may be absent. */
export interface LibraryQueryItem {
  tmdbId: number;
  type: LibraryQueryMediaType;
  title: string;
  year: number;
  posterPath: string | null;
  releaseDate: string | null;
  seasonCount: number;
  obtainedEpisodes: number;
  totalAiredEpisodes: number;
  totalEpisodes: number;
  state: LibraryQueryState;
  airing: boolean;
  acquiring: boolean;
  /** Null means all matching seasons predate the persisted option. */
  autoAcquire: boolean | null;
}

export interface LibraryQueryPage {
  items: LibraryQueryItem[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export class LibraryQueryInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryQueryInputError";
  }
}

const LIBRARY_QUERY_INDEX_LOCK_KEY = 4_011_989_142;

/**
 * Add only the indexes this query needs. Kept separate from workflow schema
 * initialization so callers run it during startup/migration, never per request.
 * The distinct transaction advisory lock serializes concurrent first boot while
 * leaving the original workflow schema lock and schema untouched.
 */
export async function initializePostgresLibraryQueryIndexes(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [LIBRARY_QUERY_INDEX_LOCK_KEY]);
    await client.query(`
      CREATE INDEX IF NOT EXISTS tracked_seasons_library_scope_idx
        ON tracked_seasons (account_id, connected_storage_id, media_title_id);
      CREATE INDEX IF NOT EXISTS episode_states_library_scope_idx
        ON episode_states (tracked_season_id, connected_storage_id, episode_code);
      CREATE INDEX IF NOT EXISTS episode_copies_library_season_idx
        ON episode_copies (tracked_season_id, storage_id, episode_code);
      CREATE INDEX IF NOT EXISTS workflow_runs_library_scope_idx
        ON workflow_runs (account_id, connected_storage_id, tracked_season_id);
    `);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the DDL failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

function boundedText(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new LibraryQueryInputError(`${name} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value.trim();
}

function pageInteger(value: number | undefined, fallback: number, name: string, max: number): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > max) {
    throw new LibraryQueryInputError(`${name} must be an integer between 1 and ${max}`);
  }
  return candidate;
}

interface ValidatedLibraryQueryInput {
  accountId: string;
  connectedStorageId: string | null;
  type: LibraryQueryMediaType | null;
  state: LibraryQueryState | null;
  search: string;
  sort: LibraryQuerySort;
  direction: "asc" | "desc";
  page: number;
  pageSize: number;
}

function validateInput(input: PostgresLibraryQueryInput): ValidatedLibraryQueryInput {
  const accountId = boundedText(input.accountId, "accountId", 200);
  const connectedStorageId = input.connectedStorageId === null
    ? null
    : boundedText(input.connectedStorageId, "connectedStorageId", 200);
  if (input.type !== undefined && !["movie", "tv", "anime"].includes(input.type)) {
    throw new LibraryQueryInputError("type must be movie, tv, or anime");
  }
  if (input.state !== undefined && !["complete", "tracking", "partial", "reserved"].includes(input.state)) {
    throw new LibraryQueryInputError("state must be complete, tracking, partial, or reserved");
  }
  const search = input.search?.trim() ?? "";
  if (search.length > 200) {
    throw new LibraryQueryInputError("search must be at most 200 characters");
  }
  const sort = input.sort ?? "title";
  if (!["title", "year", "obtainedEpisodes", "totalAiredEpisodes"].includes(sort)) {
    throw new LibraryQueryInputError("sort is not supported");
  }
  const direction = input.direction ?? "asc";
  if (direction !== "asc" && direction !== "desc") {
    throw new LibraryQueryInputError("direction must be asc or desc");
  }
  const page = pageInteger(input.page, 1, "page", 1_000_000);
  const pageSize = pageInteger(input.pageSize, 48, "pageSize", 100);
  if ((page - 1) * pageSize > 2_147_483_647) {
    throw new LibraryQueryInputError("requested page is too large");
  }
  return { accountId, connectedStorageId, type: input.type ?? null, state: input.state ?? null, search, sort, direction, page, pageSize };
}

type DbItem = Omit<LibraryQueryItem, "tmdbId" | "year" | "seasonCount" | "obtainedEpisodes" | "totalAiredEpisodes" | "totalEpisodes" | "airing" | "acquiring"> & {
  tmdb_id: number | string;
  year: number | string;
  seasonCount: number | string;
  obtainedEpisodes: number | string;
  totalAiredEpisodes: number | string;
  totalEpisodes: number | string;
  airing: boolean;
  acquiring: boolean;
};

interface QueryResultRow {
  total: number | string;
  items: DbItem[];
}

/** SQL-backed, bounded summary queries for the tracked-media poster wall. */
export class PostgresLibraryQuery {
  constructor(private readonly pool: Pool) {}

  async list(input: PostgresLibraryQueryInput): Promise<LibraryQueryPage> {
    const parsed = validateInput(input);
    const sortColumns: Record<LibraryQuerySort, string> = {
      title: "title",
      year: "year",
      obtainedEpisodes: "obtained_episodes",
      totalAiredEpisodes: "total_aired_episodes",
    };
    const sortColumn = sortColumns[parsed.sort];
    const sortDirection = parsed.direction === "asc" ? "ASC" : "DESC";
    const nowDate = new Date().toISOString().slice(0, 10);
    const result = await this.pool.query<QueryResultRow>(`
      WITH scoped_seasons AS (
        SELECT ts.id AS season_id,
               ts.account_id,
               ts.connected_storage_id,
               ts.media_title_id,
               m.payload AS title_payload,
               (m.payload->>'tmdbId')::integer AS tmdb_id,
               m.payload->>'type' AS media_type,
               COALESCE(m.payload->>'title', '') AS title,
               COALESCE((m.payload->>'year')::integer, 0) AS year,
               NULLIF(m.payload->>'posterPath', '') AS poster_path,
               NULLIF(m.payload->>'releaseDate', '') AS release_date,
               (ts.payload->>'seasonNumber')::integer AS season_number,
               COALESCE((ts.payload->>'totalEpisodes')::integer, 0) AS total_episodes,
               COALESCE((ts.payload->>'latestAiredEpisode')::integer, 0) AS latest_aired_episode,
               ts.payload->>'status' AS season_status,
               CASE WHEN ts.payload ? 'autoAcquire'
                    THEN (ts.payload->>'autoAcquire')::boolean ELSE NULL END AS auto_acquire
          FROM tracked_seasons ts
          JOIN media_titles m ON m.id = ts.media_title_id
         WHERE ts.account_id = $1
           AND ($2::text IS NULL OR ts.connected_storage_id = $2)
           AND ($3::text IS NULL OR m.payload->>'type' = $3)
           AND NOT ts.id LIKE 'staging-janitor%'
           AND ($4::text = '' OR
                m.payload->>'title' ILIKE ('%' || $4 || '%') OR
                m.payload->>'originalTitle' ILIKE ('%' || $4 || '%'))
      ),
      obtained_codes AS (
        SELECT s.account_id, s.media_title_id, s.media_type, s.tmdb_id, s.season_number,
               e.episode_code
          FROM scoped_seasons s
          JOIN episode_states e
            ON e.tracked_season_id = s.season_id
           AND e.connected_storage_id = s.connected_storage_id
         WHERE e.payload->>'obtained' = 'true'
        UNION
        SELECT s.account_id, s.media_title_id, s.media_type, s.tmdb_id, s.season_number,
               c.episode_code
          FROM scoped_seasons s
          JOIN episode_copies c ON c.tracked_season_id = s.season_id
          JOIN connected_storages cs
            ON cs.id = c.storage_id AND cs.account_id = s.account_id
         WHERE ($2::text IS NULL OR c.storage_id = $2)
           -- An episode_states bucket is authoritative for the whole season/drive;
           -- only use copy rows for drives that have no such bucket.
           AND NOT EXISTS (
             SELECT 1 FROM episode_states e
              WHERE e.tracked_season_id = c.tracked_season_id
                AND e.connected_storage_id = c.storage_id
           )
      ),
      season_latest AS (
        SELECT account_id, media_title_id, season_number,
               MAX(latest_aired_episode) AS latest_aired_episode
          FROM scoped_seasons
         GROUP BY account_id, media_title_id, season_number
      ),
      season_meta AS (
        SELECT s.account_id, s.media_title_id, s.media_type, s.tmdb_id, s.season_number,
               MAX(s.title) AS title, MAX(s.year) AS year,
               MAX(s.poster_path) AS poster_path, MAX(s.release_date) AS release_date,
               sl.latest_aired_episode,
               MAX(s.total_episodes) FILTER (WHERE s.latest_aired_episode = sl.latest_aired_episode) AS total_episodes,
               BOOL_OR(s.season_status = 'active') AS has_active,
               BOOL_OR(s.auto_acquire) AS any_auto_acquire,
               BOOL_OR(s.auto_acquire IS NOT NULL) AS has_auto_acquire
          FROM scoped_seasons s
          JOIN season_latest sl
            ON sl.account_id = s.account_id
           AND sl.media_title_id = s.media_title_id
           AND sl.season_number = s.season_number
         GROUP BY s.account_id, s.media_title_id, s.media_type, s.tmdb_id, s.season_number,
                  sl.latest_aired_episode
      ),
      season_counts AS (
        SELECT sm.*,
               COUNT(DISTINCT oc.episode_code)::integer AS obtained_count,
               LEAST(sm.latest_aired_episode, sm.total_episodes) AS aired_count
          FROM season_meta sm
          LEFT JOIN obtained_codes oc
            ON oc.account_id = sm.account_id
           AND oc.media_title_id = sm.media_title_id
           AND oc.season_number = sm.season_number
         GROUP BY sm.account_id, sm.media_title_id, sm.media_type, sm.tmdb_id, sm.season_number,
                  sm.title, sm.year, sm.poster_path, sm.release_date,
                  sm.latest_aired_episode, sm.total_episodes, sm.has_active,
                  sm.any_auto_acquire, sm.has_auto_acquire
      ),
      active_runs AS (
        SELECT DISTINCT s.account_id, s.media_title_id
          FROM scoped_seasons s
          JOIN workflow_runs wr
            ON wr.tracked_season_id = s.season_id
           AND wr.account_id = s.account_id
           AND wr.connected_storage_id = s.connected_storage_id
         WHERE ($2::text IS NULL OR wr.connected_storage_id = $2)
           AND wr.payload->>'status' IN ('queued', 'running')
           AND wr.payload->>'kind' NOT IN ('replace_request', 'staging_recovery')
      ),
      title_summary AS (
        SELECT season_counts.account_id, season_counts.media_title_id, season_counts.media_type, season_counts.tmdb_id,
               MAX(season_counts.title) AS title, MAX(season_counts.year) AS year,
               MAX(season_counts.poster_path) AS poster_path, MAX(season_counts.release_date) AS release_date,
               COUNT(*)::integer AS season_count,
               SUM(season_counts.obtained_count)::integer AS obtained_episodes,
               SUM(season_counts.aired_count)::integer AS total_aired_episodes,
               SUM(season_counts.total_episodes)::integer AS total_episodes,
               BOOL_OR(
                 NOT (season_counts.total_episodes > 0 AND season_counts.latest_aired_episode >= season_counts.total_episodes
                      AND season_counts.obtained_count >= season_counts.aired_count)
                 AND season_counts.has_active
               ) AS airing,
               CASE WHEN BOOL_OR(season_counts.has_auto_acquire) THEN BOOL_OR(season_counts.any_auto_acquire) ELSE NULL END AS auto_acquire,
               BOOL_OR(season_counts.obtained_count < season_counts.aired_count) AS behind,
               BOOL_OR(active_runs.media_title_id IS NOT NULL) AS acquiring
          FROM season_counts
          LEFT JOIN active_runs
            ON active_runs.account_id = season_counts.account_id
           AND active_runs.media_title_id = season_counts.media_title_id
         GROUP BY season_counts.account_id, season_counts.media_title_id, season_counts.media_type, season_counts.tmdb_id
      ),
      classified AS (
        SELECT tmdb_id, media_type AS type, title, year, poster_path AS "posterPath",
               release_date AS "releaseDate", season_count AS "seasonCount",
               obtained_episodes AS "obtainedEpisodes",
               total_aired_episodes AS "totalAiredEpisodes", total_episodes AS "totalEpisodes",
               CASE WHEN media_type = 'movie' AND release_date IS NOT NULL AND release_date > $5
                    THEN false ELSE airing END AS airing,
               acquiring, auto_acquire AS "autoAcquire",
               CASE WHEN media_type = 'movie' AND release_date IS NOT NULL AND release_date > $5
                    THEN 'reserved'
                    WHEN behind THEN 'partial'
                    WHEN airing THEN 'tracking'
                    ELSE 'complete' END AS state,
               obtained_episodes AS obtained_episodes,
               total_aired_episodes AS total_aired_episodes
          FROM title_summary
      ),
      filtered AS (
        SELECT * FROM classified WHERE ($6::text IS NULL OR state = $6)
      ),
      page_rows AS (
        SELECT * FROM filtered
         ORDER BY ${sortColumn} ${sortDirection} NULLS LAST, title ASC, type ASC, tmdb_id ASC
         LIMIT $7 OFFSET $8
      )
      SELECT (SELECT COUNT(*)::integer FROM filtered) AS total,
             COALESCE(jsonb_agg(to_jsonb(page_rows)), '[]'::jsonb) AS items
        FROM page_rows
    `, [parsed.accountId, parsed.connectedStorageId, parsed.type, parsed.search, nowDate,
      parsed.state, parsed.pageSize, (parsed.page - 1) * parsed.pageSize]);

    const row = result.rows[0];
    const total = Number(row?.total ?? 0);
    const items = (row?.items ?? []).map((item) => ({
      tmdbId: Number(item.tmdb_id),
      type: item.type,
      title: item.title,
      year: Number(item.year),
      posterPath: item.posterPath ?? null,
      releaseDate: item.releaseDate ?? null,
      seasonCount: Number(item.seasonCount),
      obtainedEpisodes: Number(item.obtainedEpisodes),
      totalAiredEpisodes: Number(item.totalAiredEpisodes),
      totalEpisodes: Number(item.totalEpisodes),
      state: item.state,
      airing: item.airing,
      acquiring: item.acquiring,
      autoAcquire: item.autoAcquire,
    }));
    return { items, total, page: parsed.page, pageSize: parsed.pageSize, hasMore: parsed.page * parsed.pageSize < total };
  }
}
