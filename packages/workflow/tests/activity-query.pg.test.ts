import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeWorkflowPostgresSchema } from "../src/postgres.js";
import { initializePostgresActivityQueryIndexes, PostgresActivityQuery } from "../src/library/activity-query.js";

const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
if (!adminUrl) console.info("Skipping activity query PG tests: set MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL to an isolated PostgreSQL admin URL.");
const integration = describe.skipIf(!adminUrl);

integration("PostgresActivityQuery", () => {
  let admin: pg.Pool; let pool: pg.Pool; let dbName: string; let query: PostgresActivityQuery;
  const account = "acct_activity_test", drive = "activity_drive";
  beforeAll(async () => {
    if (!adminUrl) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL required");
    admin = new pg.Pool({ connectionString: adminUrl });
    dbName = `activity_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: dbUrl.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    await initializePostgresActivityQueryIndexes(pool);
    query = new PostgresActivityQuery(pool);
    await pool.query("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1,$2,'',false,now()::text)", [account, `user_${randomUUID()}`]);
    await pool.query("INSERT INTO connected_storages (id, account_id, provider, provider_uid, payload, created_at) VALUES ($1,$2,'quark',$3,'{}'::jsonb,now()::text)", [drive, account, `uid_${drive}`]);
    for (let i = 1; i <= 3; i++) {
      const type = i === 3 ? "movie" : "tv", titleId = `${type}_${i}`, seasonId = `${titleId}_s1`;
      await pool.query("INSERT INTO media_titles (id,payload) VALUES ($1,$2::jsonb)", [titleId, JSON.stringify({ id: titleId, type, tmdbId: 77, title: `Title ${i}`, year: 2024, posterPath: `/p${i}.jpg` })]);
      await pool.query("INSERT INTO tracked_seasons (id,media_title_id,account_id,connected_storage_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [seasonId, titleId, account, drive, JSON.stringify({ id: seasonId, mediaTitleId: titleId, seasonNumber: 1, status: "active", totalEpisodes: 2, latestAiredEpisode: 2 })]);
      const status = i === 1 ? "running" : "queued";
      await pool.query("INSERT INTO workflow_runs (id,tracked_season_id,account_id,connected_storage_id,payload) VALUES ($1,$2,$3,$4,$5::jsonb)", [`run_${i}`, seasonId, account, drive, JSON.stringify({ id: `run_${i}`, kind: "type3_monitor", status, startedAt: `2026-01-0${i}T00:00:00.000Z`, progress: { activity: "检索中", phase: "search", percent: 10, updatedAt: "2026-01-01T00:00:00.000Z" } })]);
    }
    await pool.query("INSERT INTO workflow_runs (id,tracked_season_id,account_id,connected_storage_id,payload) VALUES ('run_hidden','tv_1_s1',$1,$2,$3::jsonb)", [account, drive, JSON.stringify({ id: "run_hidden", kind: "staging_recovery", status: "queued", startedAt: "2025-01-01T00:00:00.000Z" })]);
    await pool.query("INSERT INTO episode_states (tracked_season_id,connected_storage_id,episode_code,payload) VALUES ('tv_1_s1',$1,'S01E01',$2::jsonb)", [drive, JSON.stringify({ obtained: true, airStatus: "aired" })]);
    await pool.query("INSERT INTO episode_states (tracked_season_id,connected_storage_id,episode_code,payload) VALUES ('tv_2_s1',$1,'S01E01',$2::jsonb)", [drive, JSON.stringify({ obtained: false, airStatus: "aired" })]);
    await pool.query("INSERT INTO notifications (id,workflow_run_id,ordinal,payload) VALUES ('notice_1','run_1',0,$1::jsonb)", [JSON.stringify({ id: "notice_1", workflowRunId: "run_1", kind: "workflow_finished", createdAt: "2026-01-02T00:00:00.000Z", report: { titleName: "Title 1", seasonLabel: "第 1 季", status: "partial", tmdbId: 77, mediaType: "tv", fileCount: 2, totalBytes: 2097152 } })]);
    for (const id of ["notice_2", "notice_3"]) await pool.query("INSERT INTO notifications (id,workflow_run_id,ordinal,payload) VALUES ($1,'run_1',0,$2::jsonb)", [id, JSON.stringify({ id, workflowRunId: "run_1", kind: "workflow_finished", createdAt: "2026-01-02T00:00:00.000Z", report: { titleName: "Title 1", seasonLabel: "第 1 季", status: "partial", tmdbId: 77, mediaType: "tv", fileCount: 2, totalBytes: 2097152 } })]);
    await pool.query(`
      INSERT INTO notifications (id,workflow_run_id,ordinal,payload)
      SELECT 'history_' || n, 'run_1', n,
             jsonb_build_object('id','history_' || n,'workflowRunId','run_1','kind','workflow_finished',
               'createdAt',('2020-01-01T00:00:00Z'::timestamptz + n * interval '1 second')::text,
               'report',jsonb_build_object('titleName','旧记录','seasonLabel',NULL,'status','partial','tmdbId',77,'mediaType','tv'))
        FROM generate_series(1,5000) n;
    `);
  }, 60_000);
  afterAll(async () => {
    if (pool) await pool.end();
    if (admin && dbName) { await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); await admin.end(); }
  }, 30_000);

  it("uses bounded two-query summaries with global FIFO ranks, visible running priority, and type-safe poster fallback", async () => {
    const sqlSpy = vi.spyOn(pool, "query");
    const result = await query.getPage({ accountId: account, connectedStorageId: drive, activePageSize: 1, recentLimit: 1 });
    expect(sqlSpy).toHaveBeenCalledTimes(2);
    sqlSpy.mockRestore();
    expect(result.active.items).toHaveLength(1);
    expect(result.active.items[0]).toMatchObject({ runId: "run_1", status: "running", type: "tv", seasonNumbers: [1] });
    expect(result.totals).toEqual({ queued: 2, running: 1, active: 3 });
    const second = await query.getPage({ accountId: account, connectedStorageId: drive, activePage: 2, activePageSize: 1 });
    expect(second.active.items[0]).toMatchObject({ runId: "run_2", queuePosition: 1, missingCount: 1 });
    expect(second.active.total).toBe(3);
    expect(result.recentCompleted.items[0]).toMatchObject({ workflowRunId: "run_1", posterPath: "/p1.jpg", sizeText: "每集 约 1 MB" });
  });

  it("validates bounded inputs before querying", async () => {
    await expect(query.getPage({ accountId: account, connectedStorageId: drive, activePageSize: 101 })).rejects.toThrow();
    await expect(query.getPage({ accountId: account, connectedStorageId: drive, runIds: Array.from({ length: 101 }, (_, i) => `${i}`) })).rejects.toThrow();
  });

  it("paginates equal timestamps by the stable notification id tie-breaker", async () => {
    const first = await query.getPage({ accountId: account, connectedStorageId: drive, recentLimit: 1 });
    expect(first.recentCompleted.items[0]?.workflowRunId).toBe("run_1");
    expect(first.recentCompleted.nextCursor).toMatchObject({ id: "notice_3", createdAt: "2026-01-02T00:00:00.000Z" });
    const second = await query.getPage({ accountId: account, connectedStorageId: drive, recentLimit: 1, historyCursor: first.recentCompleted.nextCursor! });
    expect(second.recentCompleted.items[0]?.workflowRunId).toBe("run_1");
    expect(second.recentCompleted.nextCursor?.id).toBe("notice_2");
  });

  it("EXPLAIN ANALYZE keeps the large notification-history read as one limited SQL query", async () => {
    const sqlSpy = vi.spyOn(pool, "query");
    await query.getPage({ accountId: account, connectedStorageId: drive, recentLimit: 5 });
    const captured = sqlSpy.mock.calls[1] as unknown as [string, readonly unknown[]];
    sqlSpy.mockRestore();
    const plan = await pool.query<{ "QUERY PLAN": unknown }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured[0]}`, [...captured[1]]);
    const planText = JSON.stringify(plan.rows[0]?.["QUERY PLAN"] ?? null);
    expect(planText).toContain("Limit");
    expect(planText).not.toContain("resource_snapshots");
    expect(planText).not.toContain("agent_decisions");
    expect(planText).not.toContain("transfer_attempts");
  });
});
