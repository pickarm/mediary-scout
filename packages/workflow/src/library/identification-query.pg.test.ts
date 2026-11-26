import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEpisodeStates, type MediaTitle, type TrackedSeason } from "../domain.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { IdentificationService } from "./identification-service.js";
import { PostgresIdentificationStore, type StoredIdentificationStatus } from "./identification-store.js";
import { PostgresLibraryStore } from "./store.js";
import { PostgresScanStore } from "./scan-store.js";
import { LibraryScanner, type ScanConfiguration, type ScanScope } from "./scanner.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresIdentificationResultQuery", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_ident_query_${randomUUID().replaceAll("-", "")}`;
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

  async function createResultTask(scope: ScanScope, taskId: string, count: number): Promise<{ service: IdentificationService; store: PostgresIdentificationStore }> {
    const scans = new PostgresScanStore(pool);
    const savedConfig = configuration(scope);
    await scans.saveConfiguration(savedConfig);
    const files = Array.from({ length: count }, (_, index) => {
      const fileId = `file-${String(index).padStart(3, "0")}`;
      return { fileId, parentDirectoryId: "root", name: `${fileId}.mkv`, path: `Library/${fileId}.mkv`, isDirectory: false, sizeBytes: 100 + index, modifiedAt: null };
    });
    const scanner = new LibraryScanner({ store: scans, reader: { async listPage() { return { items: files, nextPage: null }; } }, idFactory: () => taskId });
    await scanner.start(scope, savedConfig.configId);
    const task = await scanner.waitForIdle(scope, taskId);
    expect(task.status).toBe("completed");

    const store = new PostgresIdentificationStore(pool);
    await store.enqueueForScan(scope, taskId, "2026-11-15T02:00:00.000Z");
    expect(await store.claimJob(scope, taskId, `lease_${taskId}`, "2026-11-15T02:01:00.000Z", "2026-11-15T03:00:00.000Z")).toBe(true);
    for (const [index, file] of files.entries()) {
      const status: StoredIdentificationStatus = index % 2 === 0 ? "confirmed" : "pending";
      expect(await store.saveResult({ scope, taskId, leaseId: `lease_${taskId}`, fileId: file.fileId, status, reason: "fixture", evidence: [], candidates: [],
        mediaType: status === "confirmed" ? "tv" : null, tmdbId: status === "confirmed" ? 90001 : null, seasonNumber: status === "confirmed" ? 1 : null,
        episodeCodes: status === "confirmed" ? ["S01E01"] : [], importStatus: "not_applicable", manual: false, now: "2026-11-15T02:02:00.000Z" })).toBe(true);
    }
    const service = new IdentificationService({ pool, identificationStore: store, scanStore: scans, tmdb: { async search() { return []; }, async getTitle() { throw new Error("GET must not call TMDB"); }, async getSeason() { throw new Error("GET must not call TMDB"); } } });
    return { service, store };
  }

  async function importBinding(scope: ScanScope, fileId: string, seasonNo: number, autoAcquire: boolean): Promise<string> {
    const titleId = `tmdb_tv_${91000 + seasonNo}`;
    const trackedSeasonId = `${titleId}_s1`;
    const title: MediaTitle = { id: titleId, tmdbId: 91000 + seasonNo, type: "tv", title: `Series ${seasonNo}`, originalTitle: `Series ${seasonNo}`, year: 2020, aliases: [`Series ${seasonNo}`] };
    const season: TrackedSeason = { id: trackedSeasonId, mediaTitleId: titleId, seasonNumber: 1, status: "active", qualityPreference: "", storageDirectoryId: "root", totalEpisodes: 1, latestAiredEpisode: 1, latestAiredSource: "metadata", autoAcquire };
    const library = new PostgresLibraryStore(pool);
    await library.importExistingMedia({ accountId: scope.accountId, connectedStorageId: scope.connectedStorageId, title, season,
      episodes: createEpisodeStates({ trackedSeasonId, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 }),
      files: [{ fileId, parentDirectoryId: "root", episodeCode: "S01E01", sizeBytes: 101, quality: null }], now: "2026-11-15T02:03:00.000Z" });
    if (autoAcquire) await library.setSeasonAutoAcquire({ accountId: scope.accountId, connectedStorageId: scope.connectedStorageId, trackedSeasonId, autoAcquire: true });
    return trackedSeasonId;
  }

  it("walks stable pages for all and filtered results without dropping or repeating equal lexical IDs", async () => {
    const scope = await createScope();
    const { service } = await createResultTask(scope, "task_pages", 57);
    const invalidDbQuery = vi.spyOn(pool, "query");
    await expect(service.list(scope, "task_pages", { limit: 0 })).rejects.toThrow("分页大小必须介于 1 到 200");
    expect(invalidDbQuery).not.toHaveBeenCalled();
    invalidDbQuery.mockRestore();

    const all: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await service.list(scope, "task_pages", { limit: 10, ...(cursor === undefined ? {} : { afterFileId: cursor }) });
      all.push(...page.items.map((item) => item.fileId));
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); break; }
      expect(page.items).toHaveLength(10);
      expect(page.nextCursor).toBe(page.items.at(-1)?.fileId);
      cursor = page.nextCursor ?? undefined;
    }
    expect(all).toEqual(Array.from({ length: 57 }, (_, index) => `file-${String(index).padStart(3, "0")}`));
    expect(new Set(all).size).toBe(57);

    const confirmed: string[] = [];
    cursor = undefined;
    for (;;) {
      const page = await service.list(scope, "task_pages", { limit: 7, status: "confirmed", ...(cursor === undefined ? {} : { afterFileId: cursor }) });
      confirmed.push(...page.items.map((item) => item.fileId));
      if (!page.hasMore) { expect(page.nextCursor).toBeNull(); break; }
      cursor = page.nextCursor ?? undefined;
    }
    expect(confirmed).toEqual(Array.from({ length: 29 }, (_, index) => `file-${String(index * 2).padStart(3, "0")}`));
  }, 30_000);

  it("adds current tracking state with one scoped batch lookup and preserves legacy nulls", async () => {
    const scope = await createScope();
    const { service } = await createResultTask(scope, "task_tracking", 16);
    const other = await createScope();
    const falseSeasonId = await importBinding(scope, "file-000", 1, false);
    const trueSeasonId = await importBinding(scope, "file-001", 2, true);
    const legacySeasonId = await importBinding(scope, "file-002", 3, false);
    await pool.query("UPDATE tracked_seasons SET payload=payload-'autoAcquire' WHERE id=$1 AND connected_storage_id=$2 AND account_id=$3", [legacySeasonId, scope.connectedStorageId, scope.accountId]);
    await importBinding(other, "file-000", 1, true);

    const trackingSpy = vi.spyOn(service.identificationStore, "listTrackingForFiles");
    const page = await service.list(scope, "task_tracking", { limit: 10 });
    expect(trackingSpy).toHaveBeenCalledTimes(1);
    expect(trackingSpy).toHaveBeenCalledWith(scope, Array.from({ length: 10 }, (_, index) => `file-${String(index).padStart(3, "0")}`));
    trackingSpy.mockRestore();
    const byId = new Map(page.items.map((item) => [item.fileId, item]));
    expect(byId.get("file-000")?.tracking).toEqual({ trackedSeasonId: falseSeasonId, autoAcquire: false });
    expect(byId.get("file-001")?.tracking).toEqual({ trackedSeasonId: trueSeasonId, autoAcquire: true });
    expect(byId.get("file-002")?.tracking).toEqual({ trackedSeasonId: legacySeasonId, autoAcquire: null });
    expect(byId.get("file-003")?.tracking).toBeNull();
    expect(byId.get("file-000")?.file).toMatchObject({ fileId: "file-000", name: "file-000.mkv", sizeBytes: 100, path: "Library/file-000.mkv" });
  }, 30_000);
});
