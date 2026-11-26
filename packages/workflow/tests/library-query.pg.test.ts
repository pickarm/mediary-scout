import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema } from "../src/postgres.js";
import {
  initializePostgresLibraryQueryIndexes,
  LibraryQueryInputError,
  PostgresLibraryQuery,
} from "../src/library/library-query.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
if (!adminConnectionString) {
  console.info("Skipping PostgresLibraryQuery integration tests: set MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL to an isolated PostgreSQL admin URL.");
}
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresLibraryQuery", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let query: PostgresLibraryQuery;
  let databaseName: string;
  const accountId = "acct_library_query";
  const accountStorage = "storage_library_query";
  const secondStorage = "storage_library_query_2";
  const copiesStorage = "storage_library_query_copies";

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_query_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    await initializePostgresLibraryQueryIndexes(pool);
    await initializePostgresLibraryQueryIndexes(pool);
    query = new PostgresLibraryQuery(pool);
    await seedFixtures();
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  }, 30_000);

  async function seedFixtures(): Promise<void> {
    await pool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, '', false, now()::text)",
      [accountId, `user_${randomUUID()}`],
    );
    for (const storageId of [accountStorage, secondStorage, copiesStorage]) {
      await pool.query(
        "INSERT INTO connected_storages (id, account_id, provider, provider_uid, payload, created_at) VALUES ($1, $2, 'quark', $3, '{}'::jsonb, now()::text)",
        [storageId, accountId, `uid_${storageId}`],
      );
    }

    // A thousand distinct tracked titles exercise real DB-side paging and a
    // bounded one-query response. The named fixtures below add richer states.
    await pool.query(`
      INSERT INTO media_titles (id, payload)
      SELECT 'tmdb_tv_' || n,
             jsonb_build_object('id', 'tmdb_tv_' || n, 'tmdbId', n, 'type', 'tv',
               'title', '标题' || lpad(n::text, 4, '0'), 'originalTitle', 'Original ' || n,
               'year', 2020, 'aliases', '[]'::jsonb, 'posterPath', NULL)
        FROM generate_series(1, 1000) n;
    `);
    await pool.query(`
      INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload)
      SELECT 'tmdb_tv_' || n || '_s1', 'tmdb_tv_' || n, $1, $2,
             jsonb_build_object('id', 'tmdb_tv_' || n || '_s1', 'mediaTitleId', 'tmdb_tv_' || n,
               'seasonNumber', 1, 'status', 'active', 'totalEpisodes', 2,
               'latestAiredEpisode', 2, 'latestAiredSource', 'metadata')
        FROM generate_series(1, 1000) n;
    `, [accountId, accountStorage]);
    await pool.query(`
      INSERT INTO media_titles (id, payload)
      SELECT 'tmdb_tv_multi_' || n,
             jsonb_build_object('id', 'tmdb_tv_multi_' || n, 'tmdbId', 10000 + n, 'type', 'tv',
               'title', 'Multi Season ' || n, 'originalTitle', 'Multi Season ' || n, 'year', 2021)
        FROM generate_series(1, 300) n;
    `);
    await pool.query(`
      INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload)
      SELECT 'tmdb_tv_multi_' || title_num || '_s' || season_num,
             'tmdb_tv_multi_' || title_num, $1, $2,
             jsonb_build_object('id', 'tmdb_tv_multi_' || title_num || '_s' || season_num,
               'mediaTitleId', 'tmdb_tv_multi_' || title_num, 'seasonNumber', season_num,
               'status', 'active', 'totalEpisodes', 10, 'latestAiredEpisode', 2)
        FROM generate_series(1, 300) title_num
        CROSS JOIN generate_series(1, 8) season_num;
    `, [accountId, accountStorage]);

    // Same numeric TMDB ID in the separate movie namespace.
    await insertTitleAndSeason({
      id: "tmdb_movie_1", type: "movie", tmdbId: 1, title: "Collision Movie",
      seasonId: "tmdb_movie_1_movie", storageId: accountStorage, total: 1, aired: 1,
      status: "active", releaseDate: "2099-05-01", autoAcquire: false,
    });
    // TV fixture 2 exercises account-wide union for the same season on two drives.
    const unionSeasonId = "tmdb_tv_8000_s1";
    await insertTitleAndSeason({
      id: "tmdb_tv_8000", type: "tv", tmdbId: 8000, title: "跨盘合集",
      seasonId: unionSeasonId, storageId: accountStorage, total: 3, aired: 3,
      status: "completed", autoAcquire: true,
    });
    await pool.query(
      "INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)",
      [unionSeasonId, "tmdb_tv_8000", accountId, secondStorage, JSON.stringify({ id: unionSeasonId, mediaTitleId: "tmdb_tv_8000", seasonNumber: 1, status: "completed", totalEpisodes: 3, latestAiredEpisode: 3, autoAcquire: true })],
    );
    await insertEpisode(unionSeasonId, accountStorage, "S01E01", true);
    await insertEpisode(unionSeasonId, secondStorage, "S01E02", true);
    await pool.query(
      "INSERT INTO episode_copies (tracked_season_id, episode_code, storage_id, file_ids, run_id, recorded_at) VALUES ($1, 'S01E03', $2, '[\"file-3\"]'::jsonb, 'run-copy', now()::text)",
      [unionSeasonId, copiesStorage],
    );

    // A legacy title with no autoAcquire field and a missing aired episode.
    await insertTitleAndSeason({
      id: "tmdb_tv_9001", type: "tv", tmdbId: 9001, title: "待播缺集", seasonId: "tmdb_tv_9001_s1",
      storageId: accountStorage, total: 4, aired: 3, status: "active",
    });
    await insertEpisode("tmdb_tv_9001_s1", accountStorage, "S01E01", true);
    // An explicitly disabled season must remain false in the summary.
    await insertTitleAndSeason({
      id: "tmdb_tv_9002", type: "tv", tmdbId: 9002, title: "关闭自动补缺", seasonId: "tmdb_tv_9002_s1",
      storageId: accountStorage, total: 1, aired: 1, status: "completed", autoAcquire: false,
    });
    await insertEpisode("tmdb_tv_9002_s1", accountStorage, "S01E01", true);
    await pool.query(
      "INSERT INTO workflow_runs (id, tracked_season_id, account_id, connected_storage_id, payload) VALUES ('run_library_query', 'tmdb_tv_9002_s1', $1, $2, $3::jsonb)",
      [accountId, accountStorage, JSON.stringify({ id: "run_library_query", kind: "type3_monitor", status: "running" })],
    );
    // Fully caught up so far, but season metadata says more episodes will air.
    await insertTitleAndSeason({
      id: "tmdb_tv_9003", type: "tv", tmdbId: 9003, title: "追更但当前齐全", seasonId: "tmdb_tv_9003_s1",
      storageId: accountStorage, total: 5, aired: 2, status: "active",
    });
    await insertEpisode("tmdb_tv_9003_s1", accountStorage, "S01E01", true);
    await insertEpisode("tmdb_tv_9003_s1", accountStorage, "S01E02", true);
    // Account boundary: same numeric identity but a distinct account-only title.
    await pool.query("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ('acct_other_library', $1, '', false, now()::text)", [`user_${randomUUID()}`]);
    await pool.query("INSERT INTO media_titles (id, payload) VALUES ('tmdb_movie_7777', $1::jsonb)", [JSON.stringify({ id: "tmdb_movie_7777", tmdbId: 7777, type: "movie", title: "别的账号", year: 2020 })]);
    await pool.query("INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload) VALUES ('other_movie_s1', 'tmdb_movie_7777', 'acct_other_library', '__unscoped__', $1::jsonb)", [JSON.stringify({ id: "other_movie_s1", mediaTitleId: "tmdb_movie_7777", seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1, status: "completed" })]);
  }

  async function insertTitleAndSeason(input: {
    id: string; type: "movie" | "tv" | "anime"; tmdbId: number; title: string; seasonId: string;
    storageId: string; total: number; aired: number; status: "active" | "completed";
    releaseDate?: string; autoAcquire?: boolean;
  }): Promise<void> {
    await pool.query("INSERT INTO media_titles (id, payload) VALUES ($1, $2::jsonb)", [input.id, JSON.stringify({
      id: input.id, tmdbId: input.tmdbId, type: input.type, title: input.title,
      originalTitle: `${input.title} original`, year: 2024, posterPath: null,
      ...(input.releaseDate === undefined ? {} : { releaseDate: input.releaseDate }),
    })]);
    await pool.query("INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload) VALUES ($1, $2, $3, $4, $5::jsonb)", [
      input.seasonId, input.id, accountId, input.storageId, JSON.stringify({
        id: input.seasonId, mediaTitleId: input.id, seasonNumber: 1, status: input.status,
        totalEpisodes: input.total, latestAiredEpisode: input.aired,
        ...(input.autoAcquire === undefined ? {} : { autoAcquire: input.autoAcquire }),
      }),
    ]);
  }

  async function insertEpisode(seasonId: string, storageId: string, episodeCode: string, obtained: boolean): Promise<void> {
    await pool.query("INSERT INTO episode_states (tracked_season_id, connected_storage_id, episode_code, payload) VALUES ($1, $2, $3, $4::jsonb)", [
      seasonId, storageId, episodeCode, JSON.stringify({ trackedSeasonId: seasonId, episodeCode, obtained, metadataStatus: "confirmed", verifiedFileIds: [] }),
    ]);
  }

  const integrationIt = (name: string, fn: () => Promise<void>) => it(name, fn, 30_000);

  integrationIt("returns stable bounded pages from 1,000 titles in one SQL call", async () => {
    let queryCount = 0;
    const originalQuery = pool.query.bind(pool);
    pool.query = ((...args: Parameters<typeof pool.query>) => {
      queryCount += 1;
      return originalQuery(...args);
    }) as typeof pool.query;
    try {
      const page1 = await query.list({ accountId, connectedStorageId: accountStorage, page: 1, pageSize: 100 });
      const firstCallCount = queryCount;
      const page2 = await query.list({ accountId, connectedStorageId: accountStorage, page: 2, pageSize: 100 });
      expect(queryCount - firstCallCount).toBe(1);
      expect(page1.total).toBeGreaterThanOrEqual(1000);
      expect(firstCallCount).toBe(1);
      expect(page1.items).toHaveLength(100);
      expect(page2.items).toHaveLength(100);
      expect(page1.items[0]?.title).not.toBe(page2.items[0]?.title);
      expect(page1.hasMore).toBe(true);
      expect(page2.hasMore).toBe(true);
      expect(JSON.stringify(page1).length).toBeLessThan(100_000);
    } finally {
      pool.query = originalQuery;
    }
  });

  integrationIt("does not rescan the full scoped-season CTE per season in a multi-season plan", async () => {
    let statement: string | null = null;
    let values: unknown[] = [];
    const originalQuery = pool.query.bind(pool);
    pool.query = ((...args: Parameters<typeof pool.query>) => {
      const queryArg = args[0];
      if (typeof queryArg === "string") {
        statement = queryArg;
        values = (args[1] as unknown[] | undefined) ?? [];
      }
      return originalQuery(...args);
    }) as typeof pool.query;
    try {
      await query.list({ accountId, connectedStorageId: accountStorage, pageSize: 100 });
    } finally {
      pool.query = originalQuery;
    }
    expect(statement).not.toBeNull();
    const planResult = await pool.query<{ "QUERY PLAN": Array<{ Plan: ExplainPlanNode }> }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement!}`,
      values,
    );
    const plan = planResult.rows[0]?.["QUERY PLAN"][0]?.Plan;
    expect(plan).toBeDefined();
    const nodes = flattenExplainPlan(plan!);
    const scopedSeasonScans = nodes.filter(
      (node) => node["Node Type"] === "CTE Scan" && node["CTE Name"] === "scoped_seasons",
    );
    expect(scopedSeasonScans.length).toBeGreaterThan(0);
    const scanLoops = scopedSeasonScans.map((node) => Number(node["Actual Loops"] ?? 0));
    expect(Math.max(...scanLoops)).toBeLessThan(20);
    const workflowSequentialScans = nodes.filter(
      (node) => node["Relation Name"] === "workflow_runs" && node["Node Type"] === "Seq Scan",
    );
    expect(workflowSequentialScans.every((node) => Number(node["Actual Loops"] ?? 0) === 1)).toBe(true);
    const workflowAccesses = nodes.filter((node) => node["Relation Name"] === "workflow_runs");
    expect(workflowAccesses.length).toBeGreaterThan(0);
    const workflowAccessSummary = workflowAccesses.map(
      (node) => `${String(node["Node Type"])}:${String(node["Index Name"] ?? "-")}×${String(node["Actual Loops"] ?? 0)}`,
    );
    console.info(
      `F10a EXPLAIN: scoped_seasons CTE scan loops=${scanLoops.join(",")}; ` +
      `workflow_runs access=${workflowAccessSummary.join(",")}; ` +
      "300 titles × 8 seasons",
    );
  });

  integrationIt("filters and searches in SQL while preserving media type identity", async () => {
    const movie = await query.list({ accountId, connectedStorageId: accountStorage, type: "movie", search: "Collision", pageSize: 10 });
    const collisionTv = await query.list({ accountId, connectedStorageId: accountStorage, type: "tv", search: "Original 1", pageSize: 10 });
    expect(movie.items.map((item) => [item.type, item.tmdbId])).toEqual([["movie", 1]]);
    expect(collisionTv.items.some((item) => item.type === "tv" && item.tmdbId === 1)).toBe(true);
    const byState = await query.list({ accountId, connectedStorageId: accountStorage, state: "reserved", pageSize: 10 });
    expect(byState.items.map((item) => item.title)).toContain("Collision Movie");
    expect(byState.items[0]?.posterPath).toBeNull();
    expect(byState.items[0]?.airing).toBe(false);
  });

  integrationIt("unions distinct episodes across drives and keeps scope and account isolated", async () => {
    const accountWide = await query.list({ accountId, connectedStorageId: null, search: "跨盘合集" });
    expect(accountWide.total).toBe(1);
    expect(accountWide.items[0]).toMatchObject({ obtainedEpisodes: 3, totalAiredEpisodes: 3, totalEpisodes: 3, state: "complete", autoAcquire: true });
    const firstDrive = await query.list({ accountId, connectedStorageId: accountStorage, search: "跨盘合集" });
    expect(firstDrive.items[0]?.obtainedEpisodes).toBe(1);
    const otherAccount = await query.list({ accountId: "acct_other_library", connectedStorageId: null });
    expect(otherAccount.items.map((item) => item.title)).toEqual(["别的账号"]);
  });

  integrationIt("preserves missing legacy autoAcquire, false, and unreleased/missing states", async () => {
    const rows = await query.list({ accountId, connectedStorageId: accountStorage, search: "待播缺集" });
    expect(rows.items[0]).toMatchObject({ autoAcquire: null, obtainedEpisodes: 1, totalAiredEpisodes: 3, totalEpisodes: 4, state: "partial", airing: true });
    const disabled = await query.list({ accountId, connectedStorageId: accountStorage, search: "关闭自动补缺" });
    expect(disabled.items[0]).toMatchObject({ autoAcquire: false, state: "complete", acquiring: true });
    const caughtUp = await query.list({ accountId, connectedStorageId: accountStorage, search: "追更但当前齐全" });
    expect(caughtUp.items[0]).toMatchObject({ obtainedEpisodes: 2, totalAiredEpisodes: 2, state: "tracking", airing: true });
  });

  it("rejects invalid query bounds before touching the database", async () => {
    await expect(query.list({ accountId, connectedStorageId: null, page: 0 })).rejects.toBeInstanceOf(LibraryQueryInputError);
    await expect(query.list({ accountId, connectedStorageId: null, pageSize: 101 })).rejects.toBeInstanceOf(LibraryQueryInputError);
    await expect(query.list({ accountId, connectedStorageId: null, search: "x".repeat(201) })).rejects.toBeInstanceOf(LibraryQueryInputError);
  });
});

interface ExplainPlanNode {
  [key: string]: unknown;
  Plans?: ExplainPlanNode[];
}

function flattenExplainPlan(node: ExplainPlanNode): ExplainPlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flattenExplainPlan)];
}
