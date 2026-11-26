import pg from "pg";
import { createClient } from "redis";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema } from "../src/postgres.js";
import { PostgresSummaryCache, probeRedisConnection } from "../src/library/summary-cache.js";
import { normalizePostgresLibraryQueryInput, PostgresLibraryQuery } from "../src/library/library-query.js";
import { normalizePostgresActivityQueryInput, PostgresActivityQuery } from "../src/library/activity-query.js";

const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const redisUrl = process.env.MEDIA_TRACK_TEST_REDIS_URL;
if (process.env.MEDIA_TRACK_CI_REQUIRE_POSTGRES === "1" && !adminUrl) {
  throw new Error("MEDIA_TRACK_CI_REQUIRE_POSTGRES=1 requires MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL for isolated summary-cache tests.");
}
if (process.env.MEDIA_TRACK_CI_REQUIRE_REDIS === "1" && !redisUrl) {
  throw new Error("MEDIA_TRACK_CI_REQUIRE_REDIS=1 requires MEDIA_TRACK_TEST_REDIS_URL for isolated summary-cache tests.");
}
if (!adminUrl || !redisUrl) console.info("Skipping summary cache integration tests: set MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL and MEDIA_TRACK_TEST_REDIS_URL to isolated local services.");
const integration = describe.skipIf(!adminUrl || !redisUrl);

integration("PostgresSummaryCache", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let redisAdmin: ReturnType<typeof createClient>;
  let cache: PostgresSummaryCache;
  let dbName: string;
  let secondaryDbName: string | undefined;
  let secondaryPool: pg.Pool | undefined;
  let secondaryCache: PostgresSummaryCache | undefined;
  const namespace = `summary-test-${randomUUID().replaceAll("-", "")}`;
  let redisNamespace: string;
  let databaseIdentity: string;
  const accountId = "summary_account";
  const mediaTitleId = "tmdb_tv_919191";

  beforeAll(async () => {
    if (!adminUrl || !redisUrl) throw new Error("isolated PostgreSQL and Redis URLs are required");
    admin = new pg.Pool({ connectionString: adminUrl });
    dbName = `summary_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const dbUrl = new URL(adminUrl);
    dbUrl.pathname = `/${dbName}`;
    pool = new pg.Pool({ connectionString: dbUrl.toString(), max: 4, application_name: `${namespace}-pg` });
    pool.on("error", () => {});
    databaseIdentity = `127.0.0.1:55439/${dbName}`;
    redisNamespace = `${namespace}:${createHash("sha256").update(databaseIdentity).digest("hex").slice(0, 24)}`;
    redisAdmin = createClient({ url: redisUrl, disableOfflineQueue: true, socket: { connectTimeout: 700 } });
    redisAdmin.on("error", () => undefined);
    await redisAdmin.connect();
    await initializeWorkflowPostgresSchema(pool);
    await pool.query("INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1,$2,'',false,now()::text)", [accountId, `user_${randomUUID()}`]);
    await pool.query("INSERT INTO media_titles (id,payload) VALUES ($1,$2::jsonb)", [mediaTitleId, JSON.stringify({ id: mediaTitleId, tmdbId: 919191, type: "tv", title: "初始标题", year: 2024 })]);
    cache = new PostgresSummaryCache({ pool, redisUrl, namespace, databaseIdentity, mediaTtlMs: 5_000, activityTtlMs: 1_000 });
    expect(await cache.start()).toBe(true);
  }, 60_000);

  afterAll(async () => {
    if (cache) await cache.close();
    if (secondaryCache) await secondaryCache.close();
    if (pool) await pool.end();
    if (secondaryPool) await secondaryPool.end();
    if (admin && dbName) {
      if (secondaryDbName) await admin.query(`DROP DATABASE IF EXISTS "${secondaryDbName}" WITH (FORCE)`);
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
    }
    if (redisAdmin?.isOpen) {
      const keys: string[] = [];
      for await (const batch of redisAdmin.scanIterator({ MATCH: `${namespace}:*`, COUNT: 100 })) keys.push(...batch);
      for (const key of keys) await redisAdmin.del(key);
      await redisAdmin.quit();
    }
  }, 30_000);

  const input = normalizePostgresLibraryQueryInput({ accountId, connectedStorageId: null, type: "tv", page: 1, pageSize: 48 });
  async function readTitle(): Promise<{ title: string }> {
    const result = await pool.query<{ title: string }>("SELECT payload->>'title' AS title FROM media_titles WHERE id=$1", [mediaTitleId]);
    return { title: result.rows[0]?.title ?? "" };
  }

  async function waitForWake(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { unsubscribe(); reject(new Error("summary invalidation wake timed out")); }, 2_000);
      const unsubscribe = cache.subscribe(() => { clearTimeout(timer); unsubscribe(); resolve(); });
    });
  }

  it("isolates normalized scopes and coalesces matching in-flight reads", async () => {
    let accountLoads = 0;
    const accountWide = await cache.getOrLoad("media", input, async () => { accountLoads += 1; return readTitle(); });
    const trimmed = normalizePostgresLibraryQueryInput({ accountId: ` ${accountId} `, connectedStorageId: null, type: "tv", page: 1, pageSize: 48 });
    await cache.getOrLoad("media", trimmed, async () => { accountLoads += 1; return readTitle(); });
    expect(accountWide.title).toBe("初始标题");
    expect(accountLoads).toBe(1);
    expect(() => normalizePostgresLibraryQueryInput({ accountId, connectedStorageId: null, type: "tv", pageSize: 101 })).toThrow();

    let storageLoads = 0;
    const scopedInput = { ...input, connectedStorageId: "drive-a" };
    await cache.getOrLoad("media", scopedInput, async () => { storageLoads += 1; return readTitle(); });
    await cache.getOrLoad("media", { ...input, connectedStorageId: "drive-b" }, async () => { storageLoads += 1; return readTitle(); });
    expect(storageLoads).toBe(2);

    const sharedInput = normalizePostgresActivityQueryInput({ accountId, connectedStorageId: "drive-inflight", runIds: ["run-b", "run-a"] });
    const sameSetInput = normalizePostgresActivityQueryInput({ accountId: ` ${accountId} `, connectedStorageId: "drive-inflight", runIds: ["run-a", "run-b"] });
    let release!: (value: { count: number }) => void;
    const held = new Promise<{ count: number }>((resolve) => { release = resolve; });
    let calls = 0;
    const first = cache.getOrLoad("activity", sharedInput, async () => { calls += 1; return held; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = cache.getOrLoad("activity", sameSetInput, async () => { calls += 1; return { count: 99 }; });
    release({ count: 3 });
    await expect(first).resolves.toEqual({ count: 3 });
    await expect(second).resolves.toEqual({ count: 3 });
    expect(calls).toBe(1);
  });

  it("caches native PostgreSQL library and activity summary query results", async () => {
    const libraryQuery = new PostgresLibraryQuery(pool);
    const activityQuery = new PostgresActivityQuery(pool);
    const nativeAccount = `native_${randomUUID()}`;
    const nativeTitleId = `tmdb_tv_${randomUUID().replaceAll("-", "")}`;
    const notification = waitForWake();
    const fixture = await pool.connect();
    try {
      await fixture.query("BEGIN");
      await fixture.query("INSERT INTO media_titles (id,payload) VALUES ($1,$2::jsonb)", [nativeTitleId, JSON.stringify({ id: nativeTitleId, tmdbId: 919192, type: "tv", title: "原生摘要", year: 2024 })]);
      await fixture.query(
        "INSERT INTO tracked_seasons (id,media_title_id,account_id,connected_storage_id,payload) VALUES ($1,$2,$3,'__unscoped__',$4::jsonb)",
        [`${nativeTitleId}_s1`, nativeTitleId, nativeAccount, JSON.stringify({ id: `${nativeTitleId}_s1`, mediaTitleId: nativeTitleId, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1, status: "active" })],
      );
      await fixture.query("COMMIT");
    } finally {
      fixture.release();
    }
    await notification;
    let libraryLoads = 0;
    const libraryKey = normalizePostgresLibraryQueryInput({ accountId: nativeAccount, connectedStorageId: null, type: "tv", page: 1, pageSize: 48 });
    const libraryPage = await cache.getOrLoad("media", libraryKey, async () => {
      libraryLoads += 1;
      return libraryQuery.list(libraryKey);
    });
    const repeatedLibraryPage = await cache.getOrLoad("media", libraryKey, () => libraryQuery.list(libraryKey));
    expect(libraryPage.items[0]?.title).toBe("原生摘要");
    expect(repeatedLibraryPage).toEqual(libraryPage);
    expect(libraryLoads).toBe(1);

    secondaryDbName = `summary_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${secondaryDbName}"`);
    const secondaryUrl = new URL(adminUrl!);
    secondaryUrl.pathname = `/${secondaryDbName}`;
    secondaryPool = new pg.Pool({ connectionString: secondaryUrl.toString(), max: 4, application_name: `${namespace}-pg-secondary` });
    secondaryPool.on("error", () => {});
    await initializeWorkflowPostgresSchema(secondaryPool);
    await secondaryPool.query("INSERT INTO media_titles (id,payload) VALUES ($1,$2::jsonb)", [nativeTitleId, JSON.stringify({ id: nativeTitleId, tmdbId: 919192, type: "tv", title: "另一个数据库", year: 2024 })]);
    await secondaryPool.query(
      "INSERT INTO tracked_seasons (id,media_title_id,account_id,connected_storage_id,payload) VALUES ($1,$2,$3,'__unscoped__',$4::jsonb)",
      [`${nativeTitleId}_s1`, nativeTitleId, nativeAccount, JSON.stringify({ id: `${nativeTitleId}_s1`, mediaTitleId: nativeTitleId, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1, status: "active" })],
    );
    if (!redisUrl) throw new Error("isolated Redis URL is required");
    secondaryCache = new PostgresSummaryCache({
      pool: secondaryPool,
      redisUrl,
      namespace,
      databaseIdentity: `127.0.0.1:55439/${secondaryDbName}`,
    });
    expect(await secondaryCache.start()).toBe(true);
    const secondaryPage = await secondaryCache.getOrLoad("media", libraryKey, () => new PostgresLibraryQuery(secondaryPool!).list(libraryKey));
    expect(secondaryPage.items[0]?.title).toBe("另一个数据库");
    expect(secondaryPage).not.toEqual(libraryPage);

    let activityLoads = 0;
    const activityKey = normalizePostgresActivityQueryInput({ accountId: nativeAccount, connectedStorageId: null });
    const activityPage = await cache.getOrLoad("activity", activityKey, async () => {
      activityLoads += 1;
      return activityQuery.getPage(activityKey);
    });
    const repeatedActivityPage = await cache.getOrLoad("activity", activityKey, () => activityQuery.getPage(activityKey));
    expect(repeatedActivityPage).toEqual(activityPage);
    expect(activityLoads).toBe(1);
  });

  it("rotates generation only after committed row mutations and ignores zero-row statements", async () => {
    let wakeCount = 0;
    const unsubscribe = cache.subscribe(() => { wakeCount += 1; });
    let loads = 0;
    const read = () => cache.getOrLoad("media", { ...input, accountId: "invalidate-account" }, async () => { loads += 1; return readTitle(); });
    await read();
    await read();
    expect(loads).toBe(1);

    const transaction = await pool.connect();
    try {
      await transaction.query("BEGIN");
      await transaction.query("UPDATE media_titles SET payload=jsonb_set(payload,'{title}','\"回滚标题\"'::jsonb) WHERE id=$1", [mediaTitleId]);
      await transaction.query("ROLLBACK");
    } finally {
      transaction.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakeCount).toBe(0);
    await read();
    expect(loads).toBe(1);

    const wake = waitForWake();
    await pool.query("UPDATE media_titles SET payload=jsonb_set(payload,'{title}','\"提交标题\"'::jsonb) WHERE id=$1", [mediaTitleId]);
    await wake;
    const beforeZeroRow = wakeCount;
    await pool.query("UPDATE media_titles SET payload=payload WHERE id='missing-summary-row'");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakeCount).toBe(beforeZeroRow);
    const changed = await read();
    expect(changed.title).toBe("提交标题");
    expect(loads).toBe(2);
    const notificationWake = waitForWake();
    await pool.query(
      "INSERT INTO notifications (id,workflow_run_id,ordinal,payload) VALUES ($1,'cache-test-run',0,$2::jsonb)",
      [`summary_notification_${randomUUID()}`, JSON.stringify({ createdAt: new Date().toISOString(), report: { status: "complete" } })],
    );
    await notificationWake;
    unsubscribe();
  });

  it("does not publish an in-flight pre-invalidation result under the new generation", async () => {
    const key = { ...input, accountId: "stale-inflight-account" };
    let release!: (value: { title: string }) => void;
    const held = new Promise<{ title: string }>((resolve) => { release = resolve; });
    const stale = cache.getOrLoad("media", key, () => held);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const wake = waitForWake();
    await pool.query("UPDATE media_titles SET payload=jsonb_set(payload,'{title}','\"新代次\"'::jsonb) WHERE id=$1", [mediaTitleId]);
    await wake;
    release({ title: "过期读" });
    await expect(stale).resolves.toEqual({ title: "过期读" });
    let loads = 0;
    await expect(cache.getOrLoad("media", key, async () => { loads += 1; return readTitle(); })).resolves.toEqual({ title: "新代次" });
    expect(loads).toBe(1);
  });

  it("repairs a cleared Redis generation with a fresh random generation", async () => {
    let loads = 0;
    const key = { ...input, accountId: "redis-clear-account" };
    await cache.getOrLoad("media", key, async () => { loads += 1; return readTitle(); });
    const before = await redisAdmin.get(`${redisNamespace}:summary:generation`);
    expect(before).toBeTruthy();
    const staleKeys: string[] = [];
    for await (const batch of redisAdmin.scanIterator({ MATCH: `${redisNamespace}:summary:*`, COUNT: 100 })) staleKeys.push(...batch);
    for (const redisKey of staleKeys) await redisAdmin.del(redisKey);
    await cache.getOrLoad("media", key, async () => { loads += 1; return readTitle(); });
    const after = await redisAdmin.get(`${redisNamespace}:summary:generation`);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
    await cache.getOrLoad("media", key, async () => { loads += 1; return readTitle(); });
    expect(loads).toBe(3);
  });

  it("bypasses Redis while disconnected and rotates before using it after reconnect", async () => {
    const key = { accountId: "redis-down-account" };
    let loads = 0;
    const read = () => cache.getOrLoad("media", key, async () => { loads += 1; return readTitle(); });
    await read();
    await read();
    expect(loads).toBe(1);
    const before = await redisAdmin.get(`${redisNamespace}:summary:generation`);
    expect(before).toBeTruthy();
    const clientList = String(await redisAdmin.sendCommand(["CLIENT", "LIST"]));
    const clientLine = clientList.split("\n").find((line) => line.includes(`name=${redisNamespace}-summary-cache`));
    const clientId = clientLine?.match(/(?:^| )id=(\d+)(?: |$)/)?.[1];
    expect(clientId).toBeDefined();
    await redisAdmin.clientKill({ filter: "ID", id: Number(clientId) });
    // The local Redis may reconnect before a polling assertion observes the brief
    // down state. Verify the request immediately after the disconnect uses PG.
    await read();
    expect(loads).toBe(2);
    const recoveredBy = Date.now() + 8_000;
    while (!cache.isReady() && Date.now() < recoveredBy) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cache.isReady()).toBe(true);
    const after = await redisAdmin.get(`${redisNamespace}:summary:generation`);
    expect(after).toBeTruthy();
    expect(after).not.toBe(before);
  }, 15_000);

  it("returns the PostgreSQL result promptly when its configured Redis endpoint is unreachable", async () => {
    if (!redisUrl) throw new Error("isolated Redis URL is required");
    const unavailableUrl = new URL(redisUrl);
    unavailableUrl.port = "1";
    const unavailableCache = new PostgresSummaryCache({ pool, redisUrl: unavailableUrl.toString(), namespace, databaseIdentity, connectTimeoutMs: 100 });
    let loads = 0;
    const startedAt = Date.now();
    await expect(unavailableCache.getOrLoad("media", { accountId: "redis-unreachable" }, async () => {
      loads += 1;
      return readTitle();
    })).resolves.toEqual({ title: "新代次" });
    expect(loads).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await unavailableCache.close();
  }, 5_000);

  it("recovers a lost LISTEN connection and rotates before serving cache hits again", async () => {
    const result = await admin.query<{ pid: number }>(
      "SELECT pid FROM pg_stat_activity WHERE datname=$1 AND application_name=$2 AND query='LISTEN media_track_summary_v1' LIMIT 1",
      [dbName, `${namespace}-pg`],
    );
    const pid = result.rows[0]?.pid;
    expect(pid).toBeDefined();
    await admin.query("SELECT pg_terminate_backend($1)", [pid]);
    const deadline = Date.now() + 5_000;
    while (cache.isReady() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.isReady()).toBe(false);
    const recoveredBy = Date.now() + 8_000;
    while (!cache.isReady() && Date.now() < recoveredBy) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cache.isReady()).toBe(true);
  }, 15_000);

  it("probes live Redis version/latency and redacts secrets on unreachable endpoints", async () => {
    if (!redisUrl) throw new Error("isolated Redis URL is required");
    const live = await probeRedisConnection(redisUrl, { timeoutMs: 1_500 });
    expect(live.ok).toBe(true);
    if (live.ok) {
      expect(live.latencyMs).toBeGreaterThanOrEqual(0);
      expect(live.version).toMatch(/^\d+\.\d+/);
    }

    const unavailable = await probeRedisConnection("redis://user:super-secret-token@127.0.0.1:1/0", {
      timeoutMs: 300,
    });
    expect(unavailable.ok).toBe(false);
    if (!unavailable.ok) {
      expect(unavailable.error).not.toContain("super-secret-token");
    }
  }, 10_000);
});
