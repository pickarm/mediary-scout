import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkflowRun } from "@media-track/workflow";
import { initializeWorkflowPostgresSchema } from "@media-track/workflow";
import { PostgresPreparationStore, PreparationService } from "@media-track/workflow/library";
import { createPreparationConsumer } from "@media-track/workflow/preparation-consumer";
import { JevPrefilterProvider } from "@media-track/workflow";
import { CandidateRegistry } from "@media-track/workflow";
import { RealResourceProviderV2 } from "@media-track/workflow";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("native preparation discovery and consume", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;
  let databaseUrl: string;
  let workflowRuntime: typeof import("./workflow-runtime");
  let preparationRuntime: typeof import("./library-preparation-runtime");
  let workerRuntime: typeof import("./library-preparation-worker");
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = `prep_runtime_${suffix}`;
  const noGuangYaAccountId = `prep_runtime_none_${suffix}`;
  const firstStorageId = `prep_runtime_ga1_${suffix}`;
  const secondStorageId = `prep_runtime_ga2_${suffix}`;
  const otherStorageId = `prep_runtime_115_${suffix}`;
  const originalEnv = {
    postgres: process.env.MEDIA_TRACK_POSTGRES_URL,
    adapter: process.env.MEDIA_TRACK_WORKFLOW_ADAPTER,
    storageAdapter: process.env.MEDIA_TRACK_STORAGE_ADAPTER,
    pansou: process.env.PANSOU_BASE_URL,
  };

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `prep_runtime_${suffix}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminConnectionString);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
    process.env.MEDIA_TRACK_WORKFLOW_ADAPTER = "pansou";
    process.env.MEDIA_TRACK_STORAGE_ADAPTER = "115";
    process.env.PANSOU_BASE_URL = "https://pansou.invalid";
    pool = new pg.Pool({ connectionString: databaseUrl });
    await initializeWorkflowPostgresSchema(pool);
    await pool.query("INSERT INTO accounts(id,username,password_hash,is_owner,created_at) VALUES($1,$2,'',false,now()::text),($3,$4,'',false,now()::text)", [accountId, `runtime_${suffix}`, noGuangYaAccountId, `runtime_none_${suffix}`]);
    await insertStorage({ id: firstStorageId, accountId, provider: "guangya", providerUid: `ga1_${suffix}`, createdAt: "2026-11-01T00:00:00.000Z", payload: snakeStoragePayload("generation-1"), roots: true });
    await insertStorage({ id: secondStorageId, accountId, provider: "guangya", providerUid: `ga2_${suffix}`, createdAt: "2026-11-02T00:00:00.000Z", payload: mixedStoragePayload("generation-2"), roots: true });
    await insertStorage({ id: otherStorageId, accountId, provider: "pan115", providerUid: `115_${suffix}`, createdAt: "2026-11-03T00:00:00.000Z", payload: { cookie: "test-cookie" }, roots: true });
    await insertStorage({ id: `bad_cids_${suffix}`, accountId, provider: "guangya", providerUid: `bad_${suffix}`, createdAt: "2026-11-04T00:00:00.000Z", payload: storagePayload("missing-roots") });
    await insertStorage({ id: `no_ga_${suffix}`, accountId: noGuangYaAccountId, provider: "pan115", providerUid: `no_ga_${suffix}`, createdAt: "2026-11-01T00:00:00.000Z", payload: { cookie: "test-cookie" }, roots: true });

    // Many older unrelated runs would fill a page if scope filtering happened after LIMIT.
    for (let index = 0; index < 70; index += 1) {
      const id = `a_decoy_${suffix}_${String(index).padStart(3, "0")}`;
      await insertRun({ id, accountId: noGuangYaAccountId, storageId: `no_ga_${suffix}`, tmdbId: 90000 + index });
    }
    const runs = [
      { id: `z_ready_${suffix}_0`, storageId: firstStorageId, tmdbId: 81000 },
      { id: `z_ready_${suffix}_1`, storageId: firstStorageId, tmdbId: 81001 },
      { id: `z_ready_${suffix}_2`, storageId: secondStorageId, tmdbId: 81002 },
      { id: `z_ready_${suffix}_3`, storageId: secondStorageId, tmdbId: 81003 },
      { id: `z_ready_${suffix}_4`, storageId: "__unscoped__", tmdbId: 81004 },
      { id: `z_invalid_${suffix}_year`, storageId: firstStorageId, tmdbId: 81005 },
    ];
    for (const run of runs) await insertRun({ ...run, accountId });
    await pool.query("UPDATE media_titles SET payload=jsonb_set(payload,'{year}','2301'::jsonb) WHERE id=$1", [`runtime_movie_${suffix}_81005`]);
    workflowRuntime = await import("./workflow-runtime");
    preparationRuntime = await import("./library-preparation-runtime");
    workerRuntime = await import("./library-preparation-worker");
  }, 60_000);

  afterAll(async () => {
    await preparationRuntime?.closeLibraryPreparationRuntimeForTests();
    await workflowRuntime?.closeWorkflowRepositoryForTests();
    await pool?.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
    restoreEnv("MEDIA_TRACK_POSTGRES_URL", originalEnv.postgres);
    restoreEnv("MEDIA_TRACK_WORKFLOW_ADAPTER", originalEnv.adapter);
    restoreEnv("MEDIA_TRACK_STORAGE_ADAPTER", originalEnv.storageAdapter);
    restoreEnv("PANSOU_BASE_URL", originalEnv.pansou);
  }, 60_000);

  it("discovers only eligible Guangya runs, supports multiple owned drives, and consumes current PG results without cloud calls", async () => {
    const discovered = await workerRuntime.findPreparationNativeRunPage(pool, "", 64, new Date().toISOString());
    expect(discovered.map((row) => row.id)).toHaveLength(6);
    expect(discovered.map((row) => row.connected_storage_id)).toContain(firstStorageId);
    expect(discovered.map((row) => row.connected_storage_id)).toContain(secondStorageId);
    expect(discovered.map((row) => row.connected_storage_id)).toContain("__unscoped__");
    expect(discovered.some((row) => row.account_id === noGuangYaAccountId)).toBe(false);

    const descriptorRows = discovered.map((row) => ({
      workflowRunId: row.id, accountId: row.account_id,
      connectedStorageId: row.connected_storage_id === "__unscoped__" ? null : row.connected_storage_id,
      kind: row.workflow_kind, status: row.workflow_status, nextAttemptAt: row.next_attempt_at,
      mediaType: row.media_type, tmdbId: row.tmdb_id, title: row.title, aliases: row.aliases, year: row.year,
    }));
    const descriptors = await workflowRuntime.resolveLibraryPreparationDescriptorsForPage(descriptorRows);
    expect(descriptors).toHaveLength(5);
    expect(descriptors.some((descriptor) => descriptor.workflowRunId === `z_invalid_${suffix}_year`)).toBe(false);
    expect(descriptors.map((descriptor) => descriptor.connectedStorageId)).toContain(firstStorageId);
    expect(descriptors.map((descriptor) => descriptor.connectedStorageId)).toContain(secondStorageId);
    expect(descriptors.find((descriptor) => descriptor.connectedStorageId === null)?.workflowRunId).toBe(`z_ready_${suffix}_4`);

    const store = new PostgresPreparationStore(pool);
    await store.ensureSchema();
    const searched: string[] = [];
    const service = new PreparationService({
      store,
      context: { async refresh(job) {
        return {
          target: { title: job.title, aliases: job.aliases, ...(job.year === undefined ? {} : { year: job.year }), searchConfigFingerprint: job.searchConfigFingerprint },
          searchLane: "other" as const, searchServiceKey: "fake-provider", aiServiceKey: "fake-jev",
          resourceProvider: { async search({ keyword, workflowRunId }) {
            searched.push(workflowRunId ?? "");
            const id = `raw_${workflowRunId}`;
            return { id, provider: "pansou", keyword, createdAt: new Date().toISOString(), candidates: [
              { id: `candidate_${workflowRunId}`, snapshotId: id, index: 0, title: `${keyword} 2024`, type: "guangya", source: "pansou", providerPayload: { url: "https://guangyapan.com/s/runtime" } },
            ] };
          } },
          jev: { async judgeCandidates(input) { return { scores: Object.fromEntries(input.candidates.map((candidate) => [candidate.id, 0.95])), model: "fake-model" }; } },
        };
      } },
    });
    for (const descriptor of descriptors) await service.register(descriptor);
    expect(await service.tick(5)).toBe(5);
    expect(new Set(searched)).toHaveProperty("size", 5);

    const first = descriptors.find((descriptor) => descriptor.connectedStorageId === firstStorageId)!;
    const liveSearch = { search: async () => { throw new Error("prepared raw result should be consumed"); } };
    const liveJudge = { judgeCandidates: async () => { throw new Error("prepared Jev evidence should be consumed"); } };
    const consumer = createPreparationConsumer({ descriptor: first, reader: store, inner: liveSearch, judge: liveJudge });
    const filteredProvider = new JevPrefilterProvider({ inner: consumer.resourceProvider, target: { kind: "movie", title: first.title, aliases: first.aliases, ...(first.year === undefined ? {} : { year: first.year }) }, judge: consumer.jevJudge! });
    const registry = new CandidateRegistry();
    const v2 = new RealResourceProviderV2({ provider: filteredProvider, registry, workflowRunId: first.workflowRunId });
    const result = await v2.search(first.title);
    expect(result.candidates).toHaveLength(1);
    expect(registry.get(result.candidates[0]!.id)?.id).toBe(`candidate_${first.workflowRunId}`);
    expect(v2.snapshots()[0]?.id).toBe(`raw_${first.workflowRunId}`);

    const mismatchedDescriptor = await workflowRuntime.resolveLibraryPreparationDescriptor(
      accountId, firstStorageId, first.workflowRunId, ["guangya"], first.searchConfigFingerprint,
    );
    expect(mismatchedDescriptor).toBeNull();
    const liveAfterMismatch = { ...snapshotFor(first.title), id: "live-after-provider-mismatch" };
    const mismatchLiveSearch = { search: async () => liveAfterMismatch };
    const mismatchConsumer = createPreparationConsumer({
      loadDescriptor: async (runId) => workflowRuntime.resolveLibraryPreparationDescriptor(
        accountId, firstStorageId, runId, ["guangya"], first.searchConfigFingerprint,
      ),
      reader: { async getReadyResult() { throw new Error("provider mismatch must bypass the prepared result"); } },
      inner: mismatchLiveSearch,
    });
    expect((await mismatchConsumer.resourceProvider.search({ keyword: first.title, workflowRunId: first.workflowRunId })).id)
      .toBe("live-after-provider-mismatch");

    const beforeRefresh = await workflowRuntime.resolveLibraryPreparationDescriptor(accountId, firstStorageId, first.workflowRunId, ["guangya", "pan115"]);
    const row = await pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM connected_storages WHERE id=$1", [firstStorageId]);
    const payload = row.rows[0]!.payload;
    await pool.query("UPDATE connected_storages SET payload=$2::jsonb WHERE id=$1", [firstStorageId, JSON.stringify({ ...payload, accessToken: "rotated-access", refreshToken: "rotated-refresh" })]);
    const afterRotation = await workflowRuntime.resolveLibraryPreparationDescriptor(accountId, firstStorageId, first.workflowRunId, ["guangya", "pan115"]);
    expect(afterRotation?.searchConfigFingerprint).toBe(beforeRefresh?.searchConfigFingerprint);
    expect(await store.getReadyResult(afterRotation!)).not.toBeNull();

    await pool.query("UPDATE connected_storages SET payload=jsonb_set(payload,'{meta,connectedAt}','\"2026-11-15T00:00:00.000Z\"'::jsonb) WHERE id=$1", [firstStorageId]);
    const afterRebind = await workflowRuntime.resolveLibraryPreparationDescriptor(accountId, firstStorageId, first.workflowRunId, ["guangya", "pan115"]);
    expect(afterRebind?.searchConfigFingerprint).not.toBe(beforeRefresh?.searchConfigFingerprint);
    expect(await store.getReadyResult(afterRebind!)).toBeNull();

    const invalidCidsRun = discovered[0]!;
    const beforeInvalidDrive = await workflowRuntime.resolveLibraryPreparationDescriptor(accountId, firstStorageId, invalidCidsRun.id);
    await insertStorage({ id: `late_missing_roots_${suffix}`, accountId, provider: "guangya", providerUid: `late_missing_${suffix}`, createdAt: "2026-11-05T00:00:00.000Z", payload: storagePayload("late-missing-roots") });
    const afterInvalidDrive = await workflowRuntime.resolveLibraryPreparationDescriptor(accountId, firstStorageId, invalidCidsRun.id);
    expect(afterInvalidDrive?.searchConfigFingerprint).toBe(beforeInvalidDrive?.searchConfigFingerprint);
  }, 60_000);

  async function insertStorage(input: { id: string; accountId: string; provider: string; providerUid: string; createdAt: string; payload: Record<string, unknown>; roots?: boolean }): Promise<void> {
    await pool.query(
      `INSERT INTO connected_storages(id,account_id,provider,provider_uid,payload,root_cid,movies_cid,tv_cid,anime_cid,created_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [input.id, input.accountId, input.provider, input.providerUid, JSON.stringify(input.payload), input.roots ? "root" : null, input.roots ? "movies" : null, input.roots ? "tv" : null, input.roots ? "anime" : null, input.createdAt],
    );
  }

  async function insertRun(input: { id: string; accountId: string; storageId: string; tmdbId: number }): Promise<void> {
    const titleId = `runtime_movie_${suffix}_${input.tmdbId}`;
    const seasonId = `runtime_season_${input.id}`;
    const run: WorkflowRun = { id: input.id, kind: "movie_init", status: "queued", trackedSeasonId: seasonId, startedAt: "2026-11-15T00:00:00.000Z", finishedAt: null, auditEvents: [] };
    const connectedStorageId = input.storageId === "__unscoped__" ? "__unscoped__" : input.storageId;
    await pool.query("INSERT INTO media_titles(id,payload) VALUES($1,$2::jsonb)", [titleId, JSON.stringify({ id: titleId, tmdbId: input.tmdbId, type: "movie", title: `Film ${input.tmdbId}`, originalTitle: `Film ${input.tmdbId}`, year: 2024, aliases: [`Alt ${input.tmdbId}`] })]);
    await pool.query("INSERT INTO tracked_seasons(id,media_title_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [seasonId, titleId, input.accountId, connectedStorageId, JSON.stringify({ id: seasonId, mediaTitleId: titleId, seasonNumber: 1 })]);
    await pool.query("INSERT INTO workflow_runs(id,tracked_season_id,account_id,connected_storage_id,payload) VALUES($1,$2,$3,$4,$5::jsonb)", [input.id, seasonId, input.accountId, connectedStorageId, JSON.stringify(run)]);
  }

  function snapshotFor(keyword: string): import("@media-track/workflow").ResourceSnapshot {
    return { id: "live-snapshot", provider: "pansou", keyword, createdAt: new Date().toISOString(), candidates: [] };
  }
});

function storagePayload(connectionGeneration: string): Record<string, unknown> {
  return { accessToken: `access-${connectionGeneration}`, refreshToken: `refresh-${connectionGeneration}`, deviceId: "device-test", meta: { connectedAt: connectionGeneration } };
}

function snakeStoragePayload(connectionGeneration: string): Record<string, unknown> {
  return { access_token: `access-${connectionGeneration}`, refresh_token: `refresh-${connectionGeneration}`, device_id: "device-test", meta: { connectedAt: connectionGeneration } };
}

function mixedStoragePayload(connectionGeneration: string): Record<string, unknown> {
  return { accessToken: `access-${connectionGeneration}`, refresh_token: `refresh-${connectionGeneration}`, deviceId: "device-test", meta: { connectedAt: connectionGeneration } };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
