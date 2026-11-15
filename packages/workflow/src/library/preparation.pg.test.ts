import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowRun } from "../domain.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { PostgresPreparationStore, type PreparationDescriptor } from "./preparation-store.js";
import { PreparationService } from "./preparation.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("durable preparation queue", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let store: PostgresPreparationStore;
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = `prep_acct_${suffix}`;
  const storageId = `prep_storage_${suffix}`;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `preparation_${suffix}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    await initializeWorkflowPostgresSchema(pool);
    store = new PostgresPreparationStore(pool);
    await store.ensureSchema();
    await pool.query("INSERT INTO accounts(id,username,password_hash,is_owner,created_at) VALUES($1,$2,'',false,now()::text)", [accountId, `prep_user_${suffix}`]);
    await pool.query("INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,created_at) VALUES($1,$2,'guangya',$3,'{}'::jsonb,now()::text)", [storageId, accountId, `prep_uid_${suffix}`]);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) { await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await adminPool.end(); }
  }, 30_000);

  async function addRun(id: string, status: WorkflowRun["status"] = "queued", tmdbId = 81001): Promise<void> {
    const titleId = `tmdb_movie_${tmdbId}`;
    const run: WorkflowRun = { id, kind: "movie_init", status, trackedSeasonId: `season_${id}`, startedAt: new Date().toISOString(), finishedAt: null, auditEvents: [] };
    await pool.query("INSERT INTO media_titles(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [titleId, JSON.stringify({ id: titleId, tmdbId, type: "movie", title: `Film ${tmdbId}`, originalTitle: `Film ${tmdbId}`, year: 2024, aliases: [] })]);
    await pool.query("INSERT INTO tracked_seasons(id,media_title_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [`season_${id}`,titleId,accountId,storageId,JSON.stringify({ id: `season_${id}`, mediaTitleId: titleId, seasonNumber: 1 })]);
    await pool.query("INSERT INTO workflow_runs(id,tracked_season_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [id,`season_${id}`,accountId,storageId,JSON.stringify(run)]);
  }

  function descriptor(workflowRunId: string, tmdbId = 81001, fingerprint = "sha256:original-config"): PreparationDescriptor {
    return { accountId, connectedStorageId: storageId, workflowRunId, mediaType: "movie", tmdbId, title: `Film ${tmdbId}`, aliases: [], year: 2024, searchConfigFingerprint: fingerprint };
  }

  it("runs five queued works on one Guangya storage concurrently, while AI has its own two-call lane", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `parallel_${suffix}_${i}`);
    for (const id of ids) { await addRun(id); await store.register(descriptor(id)); }
    let activeSearches = 0; let maxSearches = 0; let activeAi = 0; let maxAi = 0;
    let searchStarted = 0; let unblockSearch!: () => void;
    const searchBarrier = new Promise<void>((resolve) => { unblockSearch = resolve; });
    const provider = { async search({ keyword, workflowRunId }: { keyword: string; workflowRunId?: string }) {
      activeSearches += 1; maxSearches = Math.max(maxSearches, activeSearches); searchStarted += 1;
      if (searchStarted === 5) unblockSearch();
      await searchBarrier;
      activeSearches -= 1;
      return { id: `snapshot_${workflowRunId}`, provider: "pansou", keyword, candidates: [{ id: `candidate_${workflowRunId}`, snapshotId: `snapshot_${workflowRunId}`, index: 0, title: keyword, type: "guangya" as const, source: "pansou", providerPayload: {} }], createdAt: new Date().toISOString() };
    } };
    let aiStarted = 0; let unblockAi!: () => void;
    const aiBarrier = new Promise<void>((resolve) => { unblockAi = resolve; });
    const service = new PreparationService({ store, context: { async refresh(job) { return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint }, resourceProvider: provider, searchServiceKey: "pansou-test-endpoint", searchLane: "other",
      jev: { async judgeCandidates(input) { activeAi += 1; maxAi = Math.max(maxAi, activeAi); aiStarted += 1; if (aiStarted === 2) unblockAi(); await aiBarrier; activeAi -= 1; return { scores: Object.fromEntries(input.candidates.map((c) => [c.id, 0.9])), model: "test-model" }; } } }; } } });
    const ticking = service.tick(5, { accountId, connectedStorageId: storageId, workflowRunIds: ids });
    await waitUntil(() => searchStarted === 5);
    unblockSearch();
    await waitUntil(() => aiStarted >= 2);
    // Release the first two judges; subsequent callers are allowed to enter only after a slot frees.
    unblockAi();
    await ticking;
    expect(maxSearches).toBe(5);
    expect(maxAi).toBeLessThanOrEqual(2);
    for (const id of ids) {
      expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("ready");
      expect(await store.getReadyResult(descriptor(id))).not.toBeNull();
      expect(await store.getReadyResult({ ...descriptor(id), searchConfigFingerprint: "sha256:wrong-config" })).toBeNull();
      expect(await store.getReadyResult({ ...descriptor(id), title: "Changed title" })).toBeNull();
    }
  }, 30_000);

  it("limits a PanSou lane to two searches while allowing other preparations to drain", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `pansou_${suffix}_${i}`);
    for (const id of ids) { await addRun(id); await store.register(descriptor(id)); }
    const lateId = `pansou_late_${suffix}`; await addRun(lateId); await store.register(descriptor(lateId));
    let active = 0; let maxActive = 0; let started = 0; let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => { unblock = resolve; });
    const service = new PreparationService({ store, context: { async refresh(job) { return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint }, searchServiceKey: "pansou-lane-test", searchLane: "pansou", resourceProvider: { async search({ keyword, workflowRunId }) {
      active += 1; started += 1; maxActive = Math.max(maxActive, active);
      if (started === 2) unblock();
      await barrier; active -= 1;
      return { id: `pansou_snapshot_${workflowRunId}`, provider: "pansou", keyword, candidates: [], createdAt: new Date().toISOString() };
    } } }; } } });
    const ticking = service.tick(5, { accountId, connectedStorageId: storageId, workflowRunIds: ids });
    await waitUntil(() => started >= 2);
    const lateTick = service.tick(1, { accountId, connectedStorageId: storageId, workflowRunIds: [lateId] });
    unblock(); await Promise.all([ticking, lateTick]);
    expect(started).toBe(6);
    expect(maxActive).toBe(2);
  }, 30_000);

  it("drops results cancelled during search and rejects terminal runs and stale config", async () => {
    const id = `cancel_${suffix}`; await addRun(id); await store.register(descriptor(id));
    let started!: () => void; let release!: () => void;
    const startedWait = new Promise<void>((resolve) => { started = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const service = new PreparationService({ store, context: { async refresh(job) { return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint }, searchServiceKey: "cancel-test", searchLane: "pansou", resourceProvider: { async search() { started(); await blocked; return { id: "cancelled-snapshot", provider: "pansou", keyword: "Film", candidates: [], createdAt: new Date().toISOString() }; } } }; } } });
    const tick = service.tick(1, { accountId, connectedStorageId: storageId, workflowRunIds: [id] }); await startedWait; await store.cancel({ accountId, connectedStorageId: storageId }, id); release(); await tick;
    expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("cancelled");
    await service.register(descriptor(id));
    expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("cancelled");
    await service.register(descriptor(id, 81001, "sha256:changed-config"));
    expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("cancelled");
    expect(await service.retry(descriptor(id, 81001, "sha256:changed-config"))).toBe(true);
    await store.cancel({ accountId, connectedStorageId: storageId }, id);

    const terminal = `terminal_${suffix}`; await addRun(terminal); await store.register(descriptor(terminal));
    await pool.query("UPDATE workflow_runs SET payload=jsonb_set(payload,'{status}','\"succeeded\"'::jsonb) WHERE id=$1", [terminal]);
    const noClaim = await store.claim(new Date(), 30_000, { accountId, connectedStorageId: storageId, workflowRunIds: [terminal] });
    expect(noClaim).toBeNull();
    expect((await store.get({ accountId, connectedStorageId: storageId }, terminal))?.status).toBe("stale");

    const changed = `changed_${suffix}`; await addRun(changed); await store.register(descriptor(changed));
    const staleService = new PreparationService({ store, context: { async refresh(job) { return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: "sha256:changed-config" }, searchServiceKey: "stale-test", searchLane: "other", resourceProvider: { async search() { throw new Error("must not search stale config"); } } }; } } });
    await staleService.tick(1, { accountId, connectedStorageId: storageId, workflowRunIds: [changed] });
    expect((await store.get({ accountId, connectedStorageId: storageId }, changed))?.status).toBe("stale");
  }, 30_000);

  it("invalidates a config change observed after an external search call", async () => {
    const id = `config_during_call_${suffix}`; await addRun(id); await store.register(descriptor(id));
    let refreshCount = 0; let searched = false;
    const service = new PreparationService({ store, context: { async refresh(job) {
      refreshCount += 1;
      return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: refreshCount === 1 ? job.searchConfigFingerprint : "sha256:changed-during-search" },
        searchServiceKey: "config-change-test", searchLane: "other", resourceProvider: { async search() { searched = true; return { id: "config-stale-snapshot", provider: "pansou", keyword: "Film", candidates: [], createdAt: new Date().toISOString() }; } } };
    } } });
    await service.tick(1, { accountId, connectedStorageId: storageId, workflowRunIds: [id] });
    const result = await store.get({ accountId, connectedStorageId: storageId }, id);
    expect(searched).toBe(true);
    expect(result?.status).toBe("stale");
    expect(result?.result).toBeNull();
  });

  it("does not start a search for a job cancelled while waiting in the PanSou lane", async () => {
    const firstId = `lane_first_${suffix}`;
    const queuedId = `lane_cancelled_${suffix}`;
    await addRun(firstId); await store.register(descriptor(firstId));
    await addRun(queuedId); await store.register(descriptor(queuedId));
    let firstStarted!: () => void;
    let releaseFirst!: () => void;
    const firstWait = new Promise<void>((resolve) => { firstStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const searched: string[] = [];
    const service = new PreparationService({ store, panSouConcurrency: 1, context: { async refresh(job) { return {
      target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint },
      searchServiceKey: "queued-cancel-test", searchLane: "pansou", resourceProvider: { async search({ workflowRunId }) {
        searched.push(workflowRunId ?? "");
        if (workflowRunId === firstId) { firstStarted(); await blocked; }
        return { id: `snapshot_${workflowRunId}`, provider: "pansou", keyword: "Film", candidates: [], createdAt: new Date().toISOString() };
      } },
    }; } } });
    const tick = service.tick(2, { accountId, connectedStorageId: storageId, workflowRunIds: [firstId, queuedId] });
    await firstWait;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.cancel({ accountId, connectedStorageId: storageId }, queuedId);
    releaseFirst();
    await tick;
    expect(searched).toEqual([firstId]);
    expect((await store.get({ accountId, connectedStorageId: storageId }, queuedId))?.status).toBe("cancelled");
  }, 30_000);

  it("invalidates a target change observed after an external search call", async () => {
    const id = `target_during_call_${suffix}`; await addRun(id); await store.register(descriptor(id));
    let refreshCount = 0;
    let searched = false;
    const service = new PreparationService({ store, context: { async refresh(job) {
      refreshCount += 1;
      const targetTitle = refreshCount === 1 ? job.title : "Changed during search";
      return { target: { title: targetTitle, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint },
        searchServiceKey: "target-change-test", searchLane: "other", resourceProvider: { async search() {
          searched = true;
          return { id: "target-stale-snapshot", provider: "pansou", keyword: "Film", candidates: [], createdAt: new Date().toISOString() };
        } } };
    } } });
    await service.tick(1, { accountId, connectedStorageId: storageId, workflowRunIds: [id] });
    const result = await store.get({ accountId, connectedStorageId: storageId }, id);
    expect(searched).toBe(true);
    expect(result?.status).toBe("stale");
    expect(result?.result).toBeNull();
  });

  it("recovers expired leases after restart and fences the old owner", async () => {
    const id = `recovery_${suffix}`; await addRun(id); await store.register(descriptor(id));
    const filter = { accountId, connectedStorageId: storageId, workflowRunIds: [id] };
    const first = await store.claim(new Date(), 5_000, filter);
    expect(first).not.toBeNull();
    await pool.query("UPDATE library_preparation_jobs SET lease_expires_at=now()-interval '1 second' WHERE workflow_run_id=$1", [id]);
    expect(await store.heartbeat(first!, new Date(), 5_000)).toBe(false);
    expect(await store.commit(first!, { snapshots: [] })).toBe(false);
    const recovered = await store.claim(new Date(), 30_000, filter);
    expect(recovered?.workflowRunId).toBe(id);
    expect(recovered?.leaseId).not.toBe(first?.leaseId);
    const staleWrite = await store.commit(first!, { snapshots: [] });
    expect(staleWrite).toBe(false);
    const committed = await store.commit(recovered!, { snapshots: [] });
    expect(committed).toBe(true);
    expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("ready");
  });

  it("rejects cross-account scope and enforces descriptor/result bounds", async () => {
    const id = `scope_${suffix}`; await addRun(id);
    expect(await store.register({ ...descriptor(id), accountId: "other-account" })).toBe(false);
    await expect(store.register({ ...descriptor(id), aliases: Array.from({ length: 21 }, (_, i) => `alias-${i}`) })).rejects.toThrow("PREPARATION_DESCRIPTOR_INVALID");
    expect(await store.register(descriptor(id))).toBe(true);
    await pool.query("UPDATE library_preparation_jobs SET expires_at=now()-interval '1 second' WHERE workflow_run_id=$1", [id]);
    expect(await store.claim(new Date(), 30_000, { accountId, connectedStorageId: storageId, workflowRunIds: [id] })).toBeNull();
    expect((await store.get({ accountId, connectedStorageId: storageId }, id))?.status).toBe("stale");
  });

  it("requires season account ownership and an active native Guangya connection", async () => {
    const foreign = `foreign_season_${suffix}`;
    const titleId = "tmdb_movie_81001";
    await pool.query("INSERT INTO tracked_seasons(id,media_title_id,account_id,connected_storage_id,payload) VALUES($1,$2,'other-account',$3,$4::jsonb)", [foreign,titleId,storageId,JSON.stringify({ id: foreign, mediaTitleId: titleId, seasonNumber: 1 })]);
    const runId = `foreign_run_${suffix}`;
    const run: WorkflowRun = { id: runId, kind: "movie_init", status: "queued", trackedSeasonId: foreign, startedAt: new Date().toISOString(), finishedAt: null, auditEvents: [] };
    await pool.query("INSERT INTO workflow_runs(id,tracked_season_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [runId,foreign,accountId,storageId,JSON.stringify(run)]);
    expect(await store.register(descriptor(runId))).toBe(false);

    const frozenId = `frozen_run_${suffix}`; await addRun(frozenId);
    await pool.query("UPDATE connected_storages SET status='frozen' WHERE id=$1", [storageId]);
    expect(await store.register(descriptor(frozenId))).toBe(false);
    await pool.query("UPDATE connected_storages SET status='active' WHERE id=$1", [storageId]);
  });

  it("keeps target payloads secret-free and hides expired or terminal ready results", async () => {
    const secretId = `secret_descriptor_${suffix}`; await addRun(secretId);
    const withSecret = Object.assign(descriptor(secretId), { accessToken: "must-not-persist" });
    await store.register(withSecret);
    const stored = await pool.query<{ descriptor: Record<string, unknown> }>("SELECT descriptor FROM library_preparation_jobs WHERE workflow_run_id=$1", [secretId]);
    expect(stored.rows[0]?.descriptor).not.toHaveProperty("accessToken");

    const expiredId = `expired_ready_${suffix}`; await addRun(expiredId); await store.register(descriptor(expiredId));
    const expiredClaim = await store.claim(new Date(), 30_000, { accountId, connectedStorageId: storageId, workflowRunIds: [expiredId] });
    await store.commit(expiredClaim!, { snapshots: [] });
    await pool.query("UPDATE library_preparation_jobs SET expires_at=now()-interval '1 second' WHERE workflow_run_id=$1", [expiredId]);
    expect(await store.getReadyResult(descriptor(expiredId))).toBeNull();

    const terminalId = `terminal_ready_${suffix}`; await addRun(terminalId); await store.register(descriptor(terminalId));
    const terminalClaim = await store.claim(new Date(), 30_000, { accountId, connectedStorageId: storageId, workflowRunIds: [terminalId] });
    await store.commit(terminalClaim!, { snapshots: [] });
    await pool.query("UPDATE workflow_runs SET payload=jsonb_set(payload,'{status}','\"succeeded\"'::jsonb) WHERE id=$1", [terminalId]);
    expect(await store.getReadyResult(descriptor(terminalId))).toBeNull();

    const retargetId = `retarget_${suffix}`; await addRun(retargetId); await store.register(descriptor(retargetId));
    const retargetClaim = await store.claim(new Date(), 30_000, { accountId, connectedStorageId: storageId, workflowRunIds: [retargetId] });
    await store.commit(retargetClaim!, { snapshots: [] });
    const renamed = { ...descriptor(retargetId), title: "Updated title", aliases: ["Updated alias"] };
    await store.register(renamed);
    expect((await store.get({ accountId, connectedStorageId: storageId }, retargetId))?.status).toBe("queued");
    expect(await store.getReadyResult(descriptor(retargetId))).toBeNull();
  });

  it("resolves the provider and AI context independently for each account job", async () => {
    const secondAccount = `prep_account_b_${suffix}`; const secondStorage = `prep_storage_b_${suffix}`;
    await pool.query("INSERT INTO accounts(id,username,password_hash,is_owner,created_at) VALUES($1,$2,'',false,now()::text)", [secondAccount, `prep_user_b_${suffix}`]);
    await pool.query("INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,created_at) VALUES($1,$2,'guangya',$3,'{}'::jsonb,now()::text)", [secondStorage,secondAccount,`prep_uid_b_${suffix}`]);
    const ids = [`account_a_run_${suffix}`, `account_b_run_${suffix}`];
    const scopes = [{ accountId, storageId, tmdbId: 81001, id: ids[0]! }, { accountId: secondAccount, storageId: secondStorage, tmdbId: 81002, id: ids[1]! }];
    for (const entry of scopes) {
      const titleId = `tmdb_movie_${entry.tmdbId}`;
      await pool.query("INSERT INTO media_titles(id,payload) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload", [titleId, JSON.stringify({ id: titleId, tmdbId: entry.tmdbId, type: "movie", title: `Film ${entry.tmdbId}`, originalTitle: `Film ${entry.tmdbId}`, year: 2024, aliases: [] })]);
      await pool.query("INSERT INTO tracked_seasons(id,media_title_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [`season_${entry.id}`,titleId,entry.accountId,entry.storageId,JSON.stringify({ id: `season_${entry.id}`, mediaTitleId: titleId, seasonNumber: 1 })]);
      const run: WorkflowRun = { id: entry.id, kind: "movie_init", status: "queued", trackedSeasonId: `season_${entry.id}`, startedAt: new Date().toISOString(), finishedAt: null, auditEvents: [] };
      await pool.query("INSERT INTO workflow_runs(id,tracked_season_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [entry.id,`season_${entry.id}`,entry.accountId,entry.storageId,JSON.stringify(run)]);
      await store.register({ ...descriptor(entry.id, entry.tmdbId), accountId: entry.accountId, connectedStorageId: entry.storageId });
    }
    const seenA: string[] = []; const seenB: string[] = [];
    const service = new PreparationService({ store, context: { async refresh(job) {
      const owner = scopes.find((entry) => entry.accountId === job.accountId)!;
      const record = owner.accountId === accountId ? seenA : seenB;
      return { target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint }, searchServiceKey: owner.storageId, searchLane: "other", resourceProvider: { async search({ workflowRunId }) {
        record.push(workflowRunId ?? "");
        return { id: `snapshot_${workflowRunId}`, provider: "pansou", keyword: job.title, candidates: [], createdAt: new Date().toISOString() };
      } } };
    } } });
    await service.tick(2, { workflowRunIds: ids });
    expect(seenA).toEqual([ids[0]]);
    expect(seenB).toEqual([ids[1]]);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > end) throw new Error("waitUntil timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
