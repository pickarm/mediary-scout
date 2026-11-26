import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IdentificationTmdbPort } from "./identification.js";
import { IdentificationService } from "./identification-service.js";
import { PostgresIdentificationStore } from "./identification-store.js";
import { LibraryImportConflictError, PostgresLibraryStore } from "./store.js";
import { PostgresScanStore } from "./scan-store.js";
import { LibraryScanner, type ScanConfiguration, type ScanFileFact, type ScanScope } from "./scanner.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresIdentificationService", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_identification_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  }, 30_000);

  async function createScope(): Promise<ScanScope> {
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `account_${suffix}`;
    const connectedStorageId = `storage_${suffix}`;
    await pool.query("INSERT INTO accounts (id,username,password_hash,is_owner,created_at) VALUES ($1,$2,'',false,now()::text)", [accountId, `user_${suffix}`]);
    await pool.query("INSERT INTO connected_storages (id,account_id,provider,provider_uid,payload,created_at) VALUES ($1,$2,'guangya',$3,'{}'::jsonb,now()::text)", [connectedStorageId, accountId, `uid_${suffix}`]);
    return { accountId, connectedStorageId };
  }

  function configuration(scope: ScanScope): ScanConfiguration {
    return { configId: `config_${scope.accountId}`, scope, sourceRoots: [{ directoryId: "root", name: "Library" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null,
      mediaKind: "tv", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} };
  }

  async function scanOneFile(scope: ScanScope, taskId: string, name = "Show (2020) S01E01.mkv", fileId = `file_${taskId}`): Promise<{ scans: PostgresScanStore; task: Awaited<ReturnType<LibraryScanner["waitForIdle"]>> }> {
    const scans = new PostgresScanStore(pool);
    const savedConfig = configuration(scope);
    await scans.saveConfiguration(savedConfig);
    const scanner = new LibraryScanner({ store: scans, reader: { async listPage() {
      return { items: [{ fileId, parentDirectoryId: "root", name, path: `Library/${name}`, isDirectory: false, sizeBytes: 400, modifiedAt: null }], nextPage: null };
    } }, idFactory: () => taskId });
    await scanner.start(scope, savedConfig.configId);
    return { scans, task: await scanner.waitForIdle(scope, taskId) };
  }

  function tmdb(): IdentificationTmdbPort {
    const title = { id: 88001, mediaType: "tv" as const, title: "Show", originalTitle: "Show", year: 2020, overview: "", posterPath: null, backdropPath: null,
      originCountries: ["US"], genreIds: [18], seasons: [{ seasonNumber: 1, episodeCount: 2 }, { seasonNumber: 2, episodeCount: 1 }] };
    return {
      async search(query, kind) { return query === "Show" && kind === "tv" ? [{ tmdbId: title.id, mediaType: "tv", title: "Show", originalTitle: "Show", year: 2020, reason: "fake TMDB" }] : []; },
      async getTitle(id) { if (id === title.id) return title; if (id === 88002) return { ...title, id, title: "Other Show", originalTitle: "Other Show" }; throw new Error("unexpected tmdb id"); },
      async getSeason(id, seasonNumber) { if ((id !== title.id && id !== 88002) || (seasonNumber !== 1 && seasonNumber !== 2)) throw new Error("unexpected season"); return (seasonNumber === 1 ? [1, 2] : [1]).map((episodeNumber) => ({ episodeNumber, airDate: "2020-01-01", title: `Episode ${episodeNumber}` })); },
    };
  }

  it("uses actual nested ancestry, imports once, confirms a pending file and isolates accounts", async () => {
    const scope = await createScope();
    const scans = new PostgresScanStore(pool);
    const library = new PostgresLibraryStore(pool);
    const savedConfig = configuration(scope);
    await scans.saveConfiguration(savedConfig);
    const reader = {
      async listPage(input: { directoryId: string }) {
        const items: ScanFileFact[] = input.directoryId === "root" ? [{ fileId: "show-dir", parentDirectoryId: "root", name: "Show (2020)", path: "Library/Show (2020)", isDirectory: true, sizeBytes: null, modifiedAt: null }]
          : input.directoryId === "show-dir" ? [{ fileId: "season-dir", parentDirectoryId: "show-dir", name: "Season 01", path: "Library/Show (2020)/Season 01", isDirectory: true, sizeBytes: null, modifiedAt: null },
            { fileId: "season-dir-2", parentDirectoryId: "show-dir", name: "Season 02", path: "Library/Show (2020)/Season 02", isDirectory: true, sizeBytes: null, modifiedAt: null }]
            : input.directoryId === "season-dir" ? [{ fileId: "file-auto", parentDirectoryId: "season-dir", name: "01.mkv", path: "Library/Show (2020)/Season 01/01.mkv", isDirectory: false, sizeBytes: 100, modifiedAt: null },
              { fileId: "file-manual", parentDirectoryId: "season-dir", name: "unknown.mkv", path: "Library/Show (2020)/Season 01/unknown.mkv", isDirectory: false, sizeBytes: 200, modifiedAt: null }]
              : [{ fileId: "file-season2", parentDirectoryId: "season-dir-2", name: "S02E01.mkv", path: "Library/Show (2020)/Season 02/S02E01.mkv", isDirectory: false, sizeBytes: 300, modifiedAt: null }];
        return { items, nextPage: null };
      },
    };
    const scanner = new LibraryScanner({ store: scans, reader, idFactory: () => "task_nested" });
    await scanner.start(scope, savedConfig.configId);
    const task = await scanner.waitForIdle(scope, "task_nested");
    expect(task.status).toBe("completed");

    const identifications = new PostgresIdentificationStore(pool);
    await identifications.enqueueForScan(scope, task.taskId, "2026-11-15T02:00:00.000Z");
    const service = new IdentificationService({ pool, identificationStore: identifications, scanStore: scans, libraryStore: library, tmdb: tmdb(), idFactory: () => "ident_lease" });
    await service.processTaskBatch(scope, task.taskId);
    const afterAuto = await identifications.getSummary(scope, task.taskId);
    expect(afterAuto).toMatchObject({ confirmed: 2, pending: 1, imported: 2, job: { status: "completed" } });
    const firstRows = await library.listPhysicalFileBindings({ ...scope, limit: 10 });
    expect(firstRows.map((row) => row.fileId).sort()).toEqual(["file-auto", "file-season2"]);

    const manual = await service.confirmFile({ scope, taskId: task.taskId, fileId: "file-manual", tmdbId: 88001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [1, 2] });
    expect(manual.item).toMatchObject({ status: "confirmed", manual: true, importStatus: "imported", episodeCodes: ["S01E01", "S01E02"] });
    await service.processTaskBatch(scope, task.taskId);
    await expect(service.confirmFile({ scope, taskId: task.taskId, fileId: "file-auto", tmdbId: 88002, mediaType: "tv", seasonNumber: 1, episodeNumbers: [1] })).rejects.toBeInstanceOf(LibraryImportConflictError);
    await service.setTracking({ scope, trackedSeasonId: "tmdb_tv_88001_s1", autoAcquire: true });
    const tracked = await pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM tracked_seasons WHERE id=$1 AND connected_storage_id=$2", ["tmdb_tv_88001_s1", scope.connectedStorageId]);
    expect(tracked.rows[0]?.payload.autoAcquire).toBe(true);
    const finalRows = await library.listPhysicalFileBindings({ ...scope, limit: 10 });
    expect(finalRows.map((row) => row.fileId).sort()).toEqual(["file-auto", "file-manual", "file-season2"]);
    expect(finalRows.find((row) => row.fileId === "file-manual")?.episodeCodes).toEqual(["S01E01", "S01E02"]);
    const stored = await identifications.listResults(scope, task.taskId, { limit: 10 });
    expect(stored.find((row) => row.fileId === "file-manual")?.manual).toBe(true);

    const other = await createScope();
    await expect(service.list(other, task.taskId, { limit: 10 })).rejects.toThrow("扫描任务不存在");
  }, 30_000);

  it("persists a waiting job during active scans and cancels it without undoing imported facts", async () => {
    const scope = await createScope();
    const scans = new PostgresScanStore(pool);
    const savedConfig = configuration(scope);
    await scans.saveConfiguration(savedConfig);
    const task = await scans.createTask({ taskId: "task_waiting", scope, configuration: savedConfig, roots: savedConfig.sourceRoots, now: new Date().toISOString() });
    const jobs = new PostgresIdentificationStore(pool);
    await jobs.enqueueForScan(scope, task.taskId);
    const service = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, tmdb: tmdb(), idFactory: () => "lease_wait" });
    await service.processTaskBatch(scope, task.taskId);
    expect((await jobs.getJob(scope, task.taskId))?.status).toBe("waiting");

    await scans.transitionTaskStatus(scope, task.taskId, task.status, "cancelled", new Date().toISOString());
    await service.processTaskBatch(scope, task.taskId);
    expect((await jobs.getJob(scope, task.taskId))?.status).toBe("cancelled");
  }, 30_000);

  it("rejects an expired worker after TMDB returns and preserves the newer manual identity", async () => {
    const scope = await createScope();
    const scans = new PostgresScanStore(pool);
    const savedConfig = configuration(scope);
    await scans.saveConfiguration(savedConfig);
    const reader = { async listPage() {
      return { items: [{ fileId: "file-stale", parentDirectoryId: "root", name: "Show (2020) S01E01.mkv", path: "Library/Show (2020) S01E01.mkv", isDirectory: false, sizeBytes: 400, modifiedAt: null }], nextPage: null };
    } };
    const scanner = new LibraryScanner({ store: scans, reader, idFactory: () => "task_stale" });
    await scanner.start(scope, savedConfig.configId);
    const task = await scanner.waitForIdle(scope, "task_stale");
    expect(task.status).toBe("completed");

    let unblock: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const baseTmdb = tmdb();
    const slowTmdb: IdentificationTmdbPort = {
      async search(query, kind) { signalStarted(); await blocked; return query === "Show" && kind === "tv" ? [{ tmdbId: 88001, mediaType: "tv", title: "Show", originalTitle: "Show", year: 2020, reason: "fake TMDB" }] : []; },
      getTitle: (id, type) => baseTmdb.getTitle(id, type),
      getSeason: (id, seasonNumber) => baseTmdb.getSeason(id, seasonNumber),
    };
    const jobs = new PostgresIdentificationStore(pool);
    await jobs.enqueueForScan(scope, task.taskId);
    const staleService = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, tmdb: slowTmdb, idFactory: () => "lease_old" });
    const staleProcess = staleService.processTaskBatch(scope, task.taskId);
    await started;

    const future = Date.now() + 11 * 60_000;
    expect(await jobs.claimJob(scope, task.taskId, "lease_new", new Date(future).toISOString(), new Date(future + 10 * 60_000).toISOString())).toBe(true);
    const freshService = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, tmdb: tmdb() });
    await freshService.confirmFile({ scope, taskId: task.taskId, fileId: "file-stale", tmdbId: 88002, mediaType: "tv", seasonNumber: 1, episodeNumbers: [2] });
    unblock();
    await staleProcess;

    const bindings = await new PostgresLibraryStore(pool).listPhysicalFileBindings({ ...scope, limit: 10 });
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.mediaTitleId).toBe("tmdb_tv_88002");
    const stored = await jobs.listResults(scope, task.taskId, { limit: 10 });
    expect(stored[0]).toMatchObject({ tmdbId: 88002, manual: true, importStatus: "imported", episodeCodes: ["S01E02"] });
    expect(bindings[0]?.episodeCodes).toEqual(["S01E02"]);
  }, 30_000);

  it("keeps lease takeover behind the final file transaction and commits binding, result, and checkpoint together", async () => {
    const scope = await createScope();
    const { scans, task } = await scanOneFile(scope, "task_tx_lock");
    const jobs = new PostgresIdentificationStore(pool);
    await jobs.enqueueForScan(scope, task.taskId);
    let entered: () => void = () => undefined;
    let release: () => void = () => undefined;
    const inTransaction = new Promise<void>((resolve) => { entered = resolve; });
    const continueTransaction = new Promise<void>((resolve) => { release = resolve; });
    const library = new PostgresLibraryStore(pool);
    const originalImport = library.importExistingMediaWithTransactionHooks.bind(library);
    library.importExistingMediaWithTransactionHooks = async (input, hooks) => originalImport(input, {
      ...hooks,
      beforeImport: async (client) => {
        const valid = await hooks.beforeImport(client);
        if (valid) { entered(); await continueTransaction; }
        return valid;
      },
    });
    const service = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, libraryStore: library, tmdb: tmdb(), idFactory: () => "lease_tx_old", now: () => "2026-11-15T10:00:00.000Z" });
    const processing = service.processTaskBatch(scope, task.taskId);
    await inTransaction;
    let takeoverFinished = false;
    const takeover = jobs.claimJob(scope, task.taskId, "lease_tx_new", "2026-11-15T11:00:00.000Z", "2026-11-15T11:10:00.000Z").then((claimed) => { takeoverFinished = true; return claimed; });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(takeoverFinished).toBe(false);
    release();
    await processing;
    expect(await takeover).toBe(true);
    const rows = await new PostgresLibraryStore(pool).listPhysicalFileBindings({ ...scope, limit: 10 });
    const stored = await jobs.listResults(scope, task.taskId, { limit: 10 });
    const job = await jobs.getJob(scope, task.taskId);
    expect(rows.map((row) => row.fileId)).toEqual([`file_${task.taskId}`]);
    expect(stored[0]).toMatchObject({ status: "confirmed", importStatus: "imported", tmdbId: 88001 });
    expect(job?.afterFileId).toBe(`file_${task.taskId}`);
  }, 30_000);

  it("writes nothing when the old lease is replaced during external lookup before the final transaction", async () => {
    const scope = await createScope();
    const { scans, task } = await scanOneFile(scope, "task_tx_stale");
    const jobs = new PostgresIdentificationStore(pool);
    await jobs.enqueueForScan(scope, task.taskId);
    let unblock: () => void = () => undefined;
    let signalStarted: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const baseTmdb = tmdb();
    const slowTmdb: IdentificationTmdbPort = {
      async search(query, kind) { signalStarted(); await blocked; return query === "Show" && kind === "tv" ? [{ tmdbId: 88001, mediaType: "tv", title: "Show", originalTitle: "Show", year: 2020, reason: "fake TMDB" }] : []; },
      getTitle: (id, type) => baseTmdb.getTitle(id, type),
      getSeason: (id, seasonNumber) => baseTmdb.getSeason(id, seasonNumber),
    };
    const service = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, tmdb: slowTmdb, idFactory: () => "lease_tx_stale_old" });
    const processing = service.processTaskBatch(scope, task.taskId);
    await started;
    const future = Date.now() + 11 * 60_000;
    expect(await jobs.claimJob(scope, task.taskId, "lease_tx_stale_new", new Date(future).toISOString(), new Date(future + 10 * 60_000).toISOString())).toBe(true);
    unblock();
    await processing;
    expect(await new PostgresLibraryStore(pool).listPhysicalFileBindings({ ...scope, limit: 10 })).toEqual([]);
    expect(await jobs.listResults(scope, task.taskId, { limit: 10 })).toEqual([]);
    expect((await jobs.getJob(scope, task.taskId))?.afterFileId).toBeNull();
  }, 30_000);

  it("preserves a manual E02 binding when a later scan identifies the same file as E01", async () => {
    const scope = await createScope();
    const jobs = new PostgresIdentificationStore(pool);
    const first = await scanOneFile(scope, "task_manual_e2", "unknown.mkv", "shared-provider-file");
    const firstService = new IdentificationService({ pool, identificationStore: jobs, scanStore: first.scans, tmdb: tmdb() });
    await firstService.confirmFile({ scope, taskId: first.task.taskId, fileId: "shared-provider-file", tmdbId: 88001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [2] });

    const second = await scanOneFile(scope, "task_auto_e1", "Show (2020) S01E01.mkv", "shared-provider-file");
    await jobs.enqueueForScan(scope, second.task.taskId);
    const secondService = new IdentificationService({ pool, identificationStore: jobs, scanStore: second.scans, tmdb: tmdb() });
    await secondService.processTaskBatch(scope, second.task.taskId);

    const binding = await pool.query<{ episode_codes: string[] }>("SELECT episode_codes FROM library_file_bindings WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3", [scope.accountId, scope.connectedStorageId, "shared-provider-file"]);
    expect(binding.rows[0]?.episode_codes).toEqual(["S01E02"]);
    expect(await jobs.listResults(scope, second.task.taskId, { limit: 10 })).toEqual(expect.arrayContaining([expect.objectContaining({ status: "pending", importStatus: "not_applicable", episodeCodes: ["S01E01"] })]));
  }, 30_000);

  it("rolls back F02 rows, identification result, and checkpoint when the after-import hook fails", async () => {
    const scope = await createScope();
    const { scans, task } = await scanOneFile(scope, "task_tx_rollback");
    const jobs = new PostgresIdentificationStore(pool);
    await jobs.enqueueForScan(scope, task.taskId);
    const beforeTitles = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM media_titles WHERE id='tmdb_tv_88001'");
    const library = new PostgresLibraryStore(pool);
    const originalImport = library.importExistingMediaWithTransactionHooks.bind(library);
    library.importExistingMediaWithTransactionHooks = async (input, hooks) => originalImport(input, {
      ...hooks,
      afterImport: async (client, result) => { await hooks.afterImport(client, result); throw new Error("forced after-import failure"); },
    });
    const service = new IdentificationService({ pool, identificationStore: jobs, scanStore: scans, libraryStore: library, tmdb: tmdb(), idFactory: () => "lease_tx_rollback" });
    await service.processTaskBatch(scope, task.taskId);
    expect(await new PostgresLibraryStore(pool).listPhysicalFileBindings({ ...scope, limit: 10 })).toEqual([]);
    expect(await jobs.listResults(scope, task.taskId, { limit: 10 })).toEqual([]);
    expect((await jobs.getJob(scope, task.taskId))?.afterFileId).toBeNull();
    const imported = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM media_titles WHERE id='tmdb_tv_88001'");
    expect(imported.rows[0]?.count).toBe(beforeTitles.rows[0]?.count);
  }, 30_000);
});
