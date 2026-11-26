import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { PostgresScanStore } from "./scan-store.js";
import { LibraryScanner, type ScanConfiguration, type ScanFileFact, type ScanScope } from "./scanner.js";
import { PostgresLibraryStore } from "./store.js";
import { IdentificationService } from "./identification-service.js";
import type { IdentificationTmdbPort } from "./identification.js";
import { PostgresOrganizationStore } from "./organization-store.js";
import { buildOrganizationPlan, LibraryOrganizer, type OrganizationPlan, type OrganizationStorage } from "./organizer.js";
import { PostgresAutoOrganizationStore } from "./auto-organization-store.js";
import { LibraryAutoOrganizationScheduler, type AutoOrganizationExecutionPort, type AutoOrganizationPlanState, type AutoOrganizationStore } from "./auto-organization.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresLibraryAutoOrganizationScheduler", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_auto_org_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString); databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) { await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await adminPool.end(); }
  }, 30_000);

  function tmdb(): IdentificationTmdbPort {
    const title = {
      id: 91001, mediaType: "tv" as const, title: "Auto Show", originalTitle: "Auto Show", year: 2021,
      overview: "", posterPath: null, backdropPath: null, originCountries: ["US"], genreIds: [18],
      seasons: [{ seasonNumber: 1, episodeCount: 50 }],
    };
    return {
      async search(query, kind) { return query === "Auto Show" && kind === "tv" ? [{ tmdbId: title.id, mediaType: "tv", title: title.title, originalTitle: title.originalTitle, year: title.year, reason: "fake" }] : []; },
      async getTitle(id) { if (id !== title.id) throw new Error("unexpected tmdb id"); return title; },
      async getSeason(id, seasonNumber) {
        if (id !== title.id || seasonNumber !== 1) throw new Error("unexpected season");
        return Array.from({ length: 50 }, (_, index) => ({ episodeNumber: index + 1, airDate: "2021-01-01", title: `Episode ${index + 1}` }));
      },
    };
  }

  class MemoryOrganizationStorage implements OrganizationStorage {
    private sequence = 0;
    private readonly items: Array<{ fileId: string; parentId: string; name: string; isDirectory: boolean }>;

    constructor(items: Array<{ fileId: string; parentId: string; name: string; isDirectory: boolean }>) {
      this.items = items.map((item) => ({ ...item }));
    }

    async list(parentId: string) {
      return this.items.filter((item) => item.parentId === parentId).map((item) => ({ ...item }));
    }
    async read(fileId: string, knownParentIds: readonly string[]) {
      const item = this.items.find((entry) => entry.fileId === fileId && knownParentIds.includes(entry.parentId));
      return item ? { ...item } : null;
    }
    async createDir(parentId: string, name: string): Promise<string> {
      const fileId = `dir_${++this.sequence}`;
      this.items.push({ fileId, parentId, name, isDirectory: true });
      return fileId;
    }
    async rename(fileId: string, name: string): Promise<void> {
      const item = this.items.find((entry) => entry.fileId === fileId);
      if (!item) throw new Error(`missing file ${fileId}`);
      item.name = name;
    }
    async move(fileId: string, parentId: string): Promise<void> {
      const item = this.items.find((entry) => entry.fileId === fileId);
      if (!item) throw new Error(`missing file ${fileId}`);
      item.parentId = parentId;
    }
  }

  interface World {
    scope: ScanScope;
    config: ScanConfiguration;
    taskId: string;
    rootId: string;
    targetId: string;
    scans: PostgresScanStore;
    identifications: IdentificationService;
    plans: PostgresOrganizationStore;
    auto: PostgresAutoOrganizationStore;
  }

  async function createWorld(options: { autoOrganize?: boolean; files?: Array<{ fileId: string; name: string; confirm?: boolean }> } = {}): Promise<World> {
    const suffix = randomUUID().replaceAll("-", "");
    const scope = { accountId: `account_${suffix}`, connectedStorageId: `storage_${suffix}` };
    await pool.query("INSERT INTO accounts (id,username,password_hash,is_owner,created_at) VALUES ($1,$2,'',false,now()::text)", [scope.accountId, `user_${suffix}`]);
    await pool.query("INSERT INTO connected_storages (id,account_id,provider,provider_uid,payload,created_at) VALUES ($1,$2,'quark',$3,'{}'::jsonb,now()::text)", [scope.connectedStorageId, scope.accountId, `uid_${suffix}`]);
    const rootId = `root_${suffix}`;
    const targetId = `target_${suffix}`;
    const config: ScanConfiguration = {
      configId: `config_${suffix}`, scope, sourceRoots: [{ directoryId: rootId, name: "Library" }],
      movieTargetDirectoryId: null, tvTargetDirectoryId: targetId, mediaKind: "tv",
      dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai",
      autoOrganize: options.autoOrganize ?? true, autoAcquire: false, templates: {},
    };
    const scans = new PostgresScanStore(pool);
    await scans.saveConfiguration(config);
    const files = options.files ?? [{ fileId: `file_${suffix}`, name: "Auto Show (2021) S01E01.mkv" }];
    const facts: ScanFileFact[] = files.map((file) => ({
      fileId: file.fileId, parentDirectoryId: rootId, name: file.name,
      path: `Library/${file.name}`, isDirectory: false, sizeBytes: 100, modifiedAt: null,
    }));
    const taskId = `task_${suffix}`;
    const scanner = new LibraryScanner({
      store: scans,
      reader: { async listPage(input) { return input.directoryId === rootId ? { items: facts, nextPage: null } : { items: [], nextPage: null }; } },
      idFactory: () => taskId,
    });
    await scanner.start(scope, config.configId);
    const task = await scanner.waitForIdle(scope, taskId);
    if (task.status !== "completed") throw new Error(`fixture scan was ${task.status}`);
    const library = new PostgresLibraryStore(pool);
    const identifications = new IdentificationService({ pool, scanStore: scans, libraryStore: library, tmdb: tmdb() });
    let episode = 1;
    for (const file of files) {
      if (file.confirm === false) continue;
      await identifications.confirmFile({ scope, taskId, fileId: file.fileId, tmdbId: 91001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [episode] });
      episode += 1;
    }
    return { scope, config, taskId, rootId, targetId, scans, identifications, plans: new PostgresOrganizationStore(pool), auto: new PostgresAutoOrganizationStore(pool) };
  }

  interface FakeExecution {
    port: AutoOrganizationExecutionPort;
    requested: string[];
    previews: string[][];
  }

  function execution(world: World, options: {
    completed?: Set<string>;
    beforeRequest?: (operationKey: string) => Promise<void>;
    beforeExecutionRequest?: (operationKey: string) => Promise<void>;
    forceStatus?: { status: AutoOrganizationPlanState["status"]; executeRequested?: boolean };
  } = {}): FakeExecution {
    const requested: string[] = [];
    const previews: string[][] = [];
    const completed = options.completed ?? new Set<string>();
    const port: AutoOrganizationExecutionPort = {
      async preview(scope, taskId, fileIds, now) {
        previews.push([...fileIds]);
        const operationKey = operationKeyFor(fileIds);
        const plan: OrganizationPlan = {
          scope, taskId, operationKey, sourceRootIds: [world.rootId], targetRootIds: [world.targetId],
          targetRootByMediaType: { tv: world.targetId }, status: "planned", createdAt: now, updatedAt: now,
          operations: [], skippedFiles: [],
        };
        await world.plans.createOrGet({ plan, operationKey });
        if (options.beforeRequest) await options.beforeRequest(operationKey);
        return { operationKey };
      },
      async getPlan(scope, taskId, operationKey): Promise<AutoOrganizationPlanState | null> {
        const plan = await world.plans.get(scope, taskId, operationKey);
        if (!plan) return null;
        if (options.forceStatus) return { status: options.forceStatus.status, executeRequested: options.forceStatus.executeRequested ?? false };
        if (completed.has(operationKey)) return { status: "completed", executeRequested: true };
        return { status: plan.status, executeRequested: plan.executeRequested === true };
      },
      async requestExecution(scope, taskId, operationKey, now, authorization) {
        requested.push(operationKey);
        if (options.beforeExecutionRequest) await options.beforeExecutionRequest(operationKey);
        return world.plans.requestExecution(scope, taskId, operationKey, now, { autoOrganization: authorization });
      },
    };
    return { port, requested, previews };
  }

  function operationKeyFor(fileIds: readonly string[]): string {
    return `auto_${createHash("sha256").update([...fileIds].sort().join("\0")).digest("hex").slice(0, 32)}`;
  }

  function scheduler(world: World, executionPort: AutoOrganizationExecutionPort, clock: { now: number }, batchSize = 20): LibraryAutoOrganizationScheduler {
    return new LibraryAutoOrganizationScheduler({
      store: world.auto, execution: executionPort, now: () => new Date(clock.now), idFactory: () => randomUUID(),
      batchSize, leaseMs: 60_000, maxTasksPerTick: 10, maxRecoveryPerTick: 5,
      planPollDelayMs: 1_000, completedRecheckDelayMs: 1_000, retryDelayMs: 1_000, maxAttempts: 3,
    });
  }

  it("initializes every native dependency schema before the first tick on a fresh database", async () => {
    const freshName = `library_auto_org_fresh_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${freshName}"`);
    const freshUrl = new URL(adminConnectionString!); freshUrl.pathname = `/${freshName}`;
    const freshPool = new pg.Pool({ connectionString: freshUrl.toString() });
    try {
      // Only the native workflow schema exists at process start. Scan/identification/F02/F08c
      // schemas are not created by a prior page render or by another worker.
      await initializeWorkflowPostgresSchema(freshPool);
      const untouchable: AutoOrganizationExecutionPort = {
        async preview() { throw new Error("preview must not be called without candidates"); },
        async getPlan() { throw new Error("getPlan must not be called without candidates"); },
        async requestExecution() { throw new Error("requestExecution must not be called without candidates"); },
      };
      const runner = new LibraryAutoOrganizationScheduler({
        store: new PostgresAutoOrganizationStore(freshPool), execution: untouchable,
        now: () => new Date("2026-11-16T01:00:00.000Z"), idFactory: () => randomUUID(),
      });
      await expect(runner.tick()).resolves.toEqual({ processed: 0, recovered: 0, cancelled: 0 });
      for (const table of [
        "library_scan_tasks", "library_scan_configs", "library_scan_identifications",
        "library_file_bindings", "library_organization_plans", "library_auto_organization_tasks",
      ]) {
        const exists = await freshPool.query<{ exists: boolean }>("SELECT to_regclass($1) IS NOT NULL AS exists", [table]);
        expect(exists.rows[0]?.exists, table).toBe(true);
      }
    } finally {
      await freshPool.end();
      await adminPool.query(`DROP DATABASE IF EXISTS "${freshName}" WITH (FORCE)`);
    }
  });

  async function checkpoint(world: World) {
    return world.auto.getCheckpoint(world.scope, world.taskId);
  }

  it("does not persist or request anything until autoOrganize is explicitly enabled", async () => {
    const world = await createWorld({ autoOrganize: false });
    const fake = execution(world);
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const runner = scheduler(world, fake.port, clock);

    await runner.tick();
    expect(fake.previews).toEqual([]);
    expect(fake.requested).toEqual([]);
    expect(await checkpoint(world)).toBeNull();

    await world.scans.saveConfiguration({ ...world.config, autoOrganize: true });
    await runner.tick();
    expect(fake.previews).toHaveLength(1);
    expect(fake.requested).toHaveLength(1);
    expect((await checkpoint(world))?.status).toBe("requested");
    const plan = await world.plans.get(world.scope, world.taskId, fake.requested[0]!);
    expect(plan?.executeRequested).toBe(true);
  });

  it("keeps later confirmations schedulable after a completed task without a high-water cursor", async () => {
    const world = await createWorld({
      files: [
        { fileId: "file-a-later", name: "Auto Show (2021) S01E02.mkv", confirm: false },
        { fileId: "file-z-first", name: "Auto Show (2021) S01E01.mkv" },
      ],
    });
    const completed = new Set<string>();
    const fake = execution(world, { completed });
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const runner = scheduler(world, fake.port, clock, 1);

    await runner.tick();
    expect(fake.previews[0]).toEqual(["file-z-first"]);
    completed.add(fake.requested[0]!);
    clock.now += 2_000;
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("idle");
    clock.now += 2_000;
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("completed");
    expect(fake.previews).toHaveLength(1);

    await world.identifications.confirmFile({ scope: world.scope, taskId: world.taskId, fileId: "file-a-later", tmdbId: 91001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [2] });
    clock.now += 2_000;
    await runner.tick();
    expect(fake.previews.at(-1)).toEqual(["file-a-later"]);
    expect((await checkpoint(world))?.status).toBe("requested");
  });

  it("never restarts a manually paused or failed plan on later ticks", async () => {
    for (const status of ["paused", "failed"] as const) {
      const world = await createWorld();
      const fake = execution(world, { forceStatus: { status } });
      const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
      const runner = scheduler(world, fake.port, clock);
      await runner.tick();
      clock.now += 2_000;
      await runner.tick();
      const firstRequests = fake.requested.length;
      expect((await checkpoint(world))?.status).toBe(status);
      clock.now += 2_000;
      await runner.tick();
      clock.now += 2_000;
      await runner.tick();
      expect(fake.requested).toHaveLength(firstRequests);
      expect(fake.previews).toHaveLength(1);
      expect((await checkpoint(world))?.status).toBe(status);
    }
  }, 30_000);

  it("keeps one in-flight batch idempotent across repeated and concurrent ticks", async () => {
    const world = await createWorld();
    const fake = execution(world);
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const runner = scheduler(world, fake.port, clock);
    await Promise.all([runner.tick(), runner.tick()]);
    expect(fake.previews).toHaveLength(1);
    expect(fake.requested).toHaveLength(1);
    clock.now += 2_000;
    await runner.tick();
    clock.now += 2_000;
    await runner.tick();
    expect(fake.previews).toHaveLength(1);
    expect(fake.requested).toHaveLength(1);
    expect(await checkpoint(world)).toMatchObject({ status: "requested", operationKey: fake.requested[0] });
  });

  it("treats paused+executeRequested as an F08c slice yield and continues until completion", async () => {
    const world = await createWorld();
    const fake = execution(world);
    let planReads = 0;
    const yieldingPort: AutoOrganizationExecutionPort = {
      ...fake.port,
      async getPlan(): Promise<AutoOrganizationPlanState> {
        planReads += 1;
        return planReads > 2
          ? { status: "completed", executeRequested: true }
          : { status: "paused", executeRequested: true };
      },
    };
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const runner = scheduler(world, yieldingPort, clock);
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("requested");

    clock.now += 2_000;
    await runner.tick();
    expect(await checkpoint(world)).toMatchObject({ status: "requested" });
    expect(fake.requested).toHaveLength(1);

    clock.now += 2_000;
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("requested");

    clock.now += 2_000;
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("idle");
    expect(fake.requested).toHaveLength(1);
    expect(fake.previews).toHaveLength(1);
  });

  it("completes a real 25-operation F08c plan across a 20-operation system yield", async () => {
    const files = Array.from({ length: 25 }, (_, index) => {
      const episode = String(index + 1).padStart(2, "0");
      return { fileId: `yield-file-${episode}`, name: `Auto Show (2021) S01E${episode}.mkv` };
    });
    const world = await createWorld({ files });
    await pool.query(
      `UPDATE library_scan_configs SET configuration=jsonb_set(configuration,'{autoOrganize}','false'::jsonb)
        WHERE NOT (account_id=$1 AND connected_storage_id=$2)`,
      [world.scope.accountId, world.scope.connectedStorageId],
    );
    let operationKey = "";
    const port: AutoOrganizationExecutionPort = {
      async preview(scope, taskId, fileIds, now) {
        const provisional = await world.plans.derivePlanInput(scope, taskId, { fileIds, limit: fileIds.length, operationKey: "pending" });
        const authorized = await world.plans.authorizePlan(provisional);
        operationKey = operationKeyFor(fileIds);
        const plan = buildOrganizationPlan({ ...authorized, operationKey, now });
        await world.plans.createOrGet({ plan, operationKey });
        return { operationKey };
      },
      async getPlan(scope, taskId, key) {
        const plan = await world.plans.get(scope, taskId, key);
        return plan ? { status: plan.status, executeRequested: plan.executeRequested === true } : null;
      },
      async requestExecution(scope, taskId, key, now, authorization) {
        return world.plans.requestExecution(scope, taskId, key, now, { autoOrganization: authorization });
      },
    };
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const runner = scheduler(world, port, clock, 100);
    await runner.tick();
    const plan = await world.plans.get(world.scope, world.taskId, operationKey);
    expect(plan?.operations).toHaveLength(25);
    expect(plan).toMatchObject({ status: "planned", executeRequested: true });
    expect(await world.plans.getPlanSummary(world.scope, world.taskId, operationKey)).toMatchObject({ executeRequested: true });
    expect((await world.plans.listPlans(world.scope, world.taskId, { limit: 10 }))[0]).toMatchObject({ executeRequested: true });

    const storage = new MemoryOrganizationStorage([
      ...files.map((file) => ({ fileId: file.fileId, parentId: world.rootId, name: file.name, isDirectory: false })),
      { fileId: world.targetId, parentId: "", name: "Target", isDirectory: true },
    ]);
    const organizer = new LibraryOrganizer({ store: world.plans, storage, idFactory: () => randomUUID() });
    const first = await organizer.execute(world.scope, world.taskId, operationKey, { maxOperations: 20 });
    expect(first.plan.status).toBe("paused");
    expect(first.plan.executeRequested).toBe(true);
    expect(first.plan.operations.filter((operation) => operation.status === "verified")).toHaveLength(20);
    expect(await world.plans.getPlanSummary(world.scope, world.taskId, operationKey)).toMatchObject({ status: "paused", executeRequested: true });

    clock.now += 2_000;
    await runner.tick();
    expect(await checkpoint(world)).toMatchObject({ status: "requested", operationKey });

    const second = await organizer.execute(world.scope, world.taskId, operationKey, { maxOperations: 20 });
    expect(second.plan.status).toBe("completed");
    expect(second.plan.operations.every((operation) => operation.status === "verified")).toBe(true);
    expect(await world.plans.getPlanSummary(world.scope, world.taskId, operationKey)).toMatchObject({ status: "completed", executeRequested: false });

    clock.now += 2_000;
    await runner.tick();
    expect((await checkpoint(world))?.status).toBe("idle");
  }, 60_000);

  it("stops the failed CAS batch without stopping another task with its own lease", async () => {
    const world = await createWorld();
    const facts = await pool.query<{
      file_id: string; parent_directory_id: string; name: string; is_directory: boolean;
      size_bytes: string | number | null; path: string; modified_at: string | null;
    }>(
      "SELECT file_id,parent_directory_id,name,is_directory,size_bytes,path,modified_at FROM library_scan_task_files WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
      [world.scope.accountId, world.scope.connectedStorageId, world.taskId],
    );
    const secondTaskId = `task2_${randomUUID().replaceAll("-", "")}`;
    const secondScanner = new LibraryScanner({
      store: world.scans,
      reader: {
        async listPage(input) {
          return input.directoryId === world.rootId
            ? { items: facts.rows.map((fact) => ({ fileId: fact.file_id, parentDirectoryId: fact.parent_directory_id, name: fact.name, path: fact.path, isDirectory: fact.is_directory, sizeBytes: fact.size_bytes === null ? null : Number(fact.size_bytes), modifiedAt: fact.modified_at })), nextPage: null }
            : { items: [], nextPage: null };
        },
      },
      idFactory: () => secondTaskId,
    });
    await secondScanner.start(world.scope, world.config.configId);
    expect((await secondScanner.waitForIdle(world.scope, secondTaskId)).status).toBe("completed");
    await world.identifications.confirmFile({
      scope: world.scope, taskId: secondTaskId, fileId: facts.rows[0]!.file_id,
      tmdbId: 91001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [1],
    });

    const fake = execution(world);
    const requestedTasks: string[] = [];
    const port: AutoOrganizationExecutionPort = {
      ...fake.port,
      async requestExecution(scope, taskId, operationKey, now, authorization) {
        requestedTasks.push(taskId);
        return fake.port.requestExecution(scope, taskId, operationKey, now, authorization);
      },
    };
    const failingStore = new Proxy(world.auto as AutoOrganizationStore, {
      get(target, property) {
        if (property === "markPlanning") {
          return async (input: Parameters<AutoOrganizationStore["markPlanning"]>[0]) =>
            input.taskId === world.taskId ? false : target.markPlanning(input);
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await new LibraryAutoOrganizationScheduler({
      store: failingStore, execution: port, now: () => new Date("2026-11-16T01:00:00.000Z"), idFactory: () => randomUUID(),
      batchSize: 20, leaseMs: 60_000, maxTasksPerTick: 10, maxRecoveryPerTick: 5,
    }).tick();

    expect(fake.previews).toHaveLength(2);
    expect(requestedTasks).toEqual([secondTaskId]);
    expect(await checkpoint(world)).toMatchObject({ status: "planning", operationKey: null, attempts: 0 });
    expect(await world.auto.getCheckpoint(world.scope, secondTaskId)).toMatchObject({ status: "requested", attempts: 0 });
  });

  it("excludes a stale moved binding so valid files in the same task still proceed", async () => {
    const world = await createWorld({
      files: [
        { fileId: "file-good", name: "Auto Show (2021) S01E01.mkv" },
        { fileId: "file-moved", name: "Auto Show (2021) S01E02.mkv" },
      ],
    });
    const binding = await pool.query<{
      media_title_id: string; tracked_season_id: string; media_type: string; tmdb_id: number; bound_at: string;
    }>(
      "SELECT media_title_id,tracked_season_id,media_type,tmdb_id,bound_at FROM library_file_bindings WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3",
      [world.scope.accountId, world.scope.connectedStorageId, "file-moved"],
    );
    const row = binding.rows[0]!;
    await pool.query(
      `INSERT INTO library_directory_bindings(account_id,connected_storage_id,directory_id,parent_directory_id,media_title_id,tracked_season_id,media_type,tmdb_id,season_number,exclusive,bound_at)
       VALUES($1,$2,'moved-parent',NULL,$3,$4,$5,$6,1,false,$7)`,
      [world.scope.accountId, world.scope.connectedStorageId, row.media_title_id, row.tracked_season_id, row.media_type, row.tmdb_id, row.bound_at],
    );
    await pool.query(
      "UPDATE library_file_bindings SET parent_directory_id='moved-parent' WHERE account_id=$1 AND connected_storage_id=$2 AND file_id='file-moved'",
      [world.scope.accountId, world.scope.connectedStorageId],
    );

    const fake = execution(world);
    await scheduler(world, fake.port, { now: Date.parse("2026-11-16T01:00:00.000Z") }).tick();
    expect(fake.previews).toContainEqual(["file-good"]);
    expect(fake.previews.flat()).not.toContain("file-moved");
    expect(fake.requested).toContain(operationKeyFor(["file-good"]));
    expect((await checkpoint(world))?.status).toBe("requested");
  });

  it("rejects an execution intent when autoOrganize is closed between preview and request", async () => {
    const world = await createWorld();
    const fake = execution(world, {
      beforeRequest: async () => { await world.scans.saveConfiguration({ ...world.config, autoOrganize: false }); },
    });
    const runner = scheduler(world, fake.port, { now: Date.parse("2026-11-16T01:00:00.000Z") });
    await runner.tick();
    expect(fake.requested).toHaveLength(1);
    const plan = await world.plans.get(world.scope, world.taskId, fake.requested[0]!);
    expect(plan?.executeRequested).toBe(false);
    expect(await checkpoint(world)).toMatchObject({ status: "idle", batchId: null, operationKey: null });
    const items = await pool.query<{ status: string }>(
      "SELECT status FROM library_auto_organization_items WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
      [world.scope.accountId, world.scope.connectedStorageId, world.taskId],
    );
    expect(items.rows.map((row) => row.status)).toEqual(["cancelled"]);
  });

  it("rejects an execution intent after a manual pause wins the race", async () => {
    const world = await createWorld();
    let operationKey = "";
    const fake = execution(world, {
      beforeRequest: async (key) => {
        operationKey = key;
        expect(await world.plans.pause(world.scope, world.taskId, key, "2026-11-16T01:00:00.000Z")).toBe(true);
      },
    });
    const runner = scheduler(world, fake.port, { now: Date.parse("2026-11-16T01:00:00.000Z") });
    await runner.tick();
    const plan = await world.plans.get(world.scope, world.taskId, operationKey);
    expect(plan).toMatchObject({ status: "paused", executeRequested: false });
    expect(await checkpoint(world)).toMatchObject({ status: "planning", operationKey, attempts: 1 });
  });

  it("rejects an execution intent after the auto checkpoint lease was transferred", async () => {
    const world = await createWorld();
    const fake = execution(world, {
      beforeExecutionRequest: async () => {
        await pool.query(
          "UPDATE library_auto_organization_tasks SET lease_id='other-worker',lease_expires_at=$4::timestamptz WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
          [world.scope.accountId, world.scope.connectedStorageId, world.taskId, "2026-11-16T02:00:00.000Z"],
        );
      },
    });
    const runner = scheduler(world, fake.port, { now: Date.parse("2026-11-16T01:00:00.000Z") });
    await runner.tick();
    const plan = await world.plans.get(world.scope, world.taskId, fake.requested[0]!);
    expect(plan?.executeRequested).toBe(false);
    expect(await checkpoint(world)).toMatchObject({ status: "planning", attempts: 0 });
    const row = await pool.query<{ lease_id: string }>(
      "SELECT lease_id FROM library_auto_organization_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
      [world.scope.accountId, world.scope.connectedStorageId, world.taskId],
    );
    expect(row.rows[0]?.lease_id).toBe("other-worker");
  });

  it("recovers the window between persisted plan digest and execution intent without re-previewing", async () => {
    const world = await createWorld();
    const clock = { now: Date.parse("2026-11-16T01:00:00.000Z") };
    const now = new Date(clock.now).toISOString();
    const candidate = { scope: world.scope, taskId: world.taskId, configId: world.config.configId, checkpoint: null };
    const begun = await world.auto.beginTask({
      candidate, leaseId: "lease-before-crash", now, leaseExpiresAt: new Date(clock.now + 60_000).toISOString(), requireEligible: true,
    });
    expect(begun).not.toBeNull();
    const batch = await world.auto.claimBatch({
      scope: world.scope, taskId: world.taskId, configId: world.config.configId,
      batchId: "batch-before-crash", now, limit: 20, leaseId: "lease-before-crash",
    });
    expect(batch?.fileIds).toHaveLength(1);
    const operationKey = operationKeyFor(batch!.fileIds);
    await world.plans.createOrGet({
      operationKey,
      plan: {
        scope: world.scope, taskId: world.taskId, operationKey, sourceRootIds: [world.rootId], targetRootIds: [world.targetId],
        targetRootByMediaType: { tv: world.targetId }, status: "planned", createdAt: now, updatedAt: now,
        operations: [], skippedFiles: [],
      },
    });
    expect(await world.auto.markPlanning({
      scope: world.scope, taskId: world.taskId, batchId: "batch-before-crash", operationKey, now, leaseId: "lease-before-crash",
    })).toBe(true);
    await world.auto.releaseTask(world.scope, world.taskId, "lease-before-crash", now);

    const fake = execution(world);
    await scheduler(world, fake.port, clock).tick();
    expect(fake.previews).toEqual([]);
    expect(fake.requested).toEqual([operationKey]);
    expect((await world.plans.get(world.scope, world.taskId, operationKey))?.executeRequested).toBe(true);
    expect((await checkpoint(world))?.status).toBe("requested");
  });

  it("keeps the manual requestExecution resume semantics when no automatic guard is supplied", async () => {
    const world = await createWorld();
    const operationKey = "manual-op";
    const now = "2026-11-16T01:00:00.000Z";
    await world.plans.createOrGet({
      operationKey,
      plan: {
        scope: world.scope, taskId: world.taskId, operationKey, sourceRootIds: [world.rootId], targetRootIds: [world.targetId],
        targetRootByMediaType: { tv: world.targetId }, status: "planned", createdAt: now, updatedAt: now,
        operations: [], skippedFiles: [],
      },
    });
    expect(await world.plans.pause(world.scope, world.taskId, operationKey, now)).toBe(true);
    expect(await world.plans.requestExecution(world.scope, world.taskId, operationKey, now)).toBe(true);
    expect(await world.plans.get(world.scope, world.taskId, operationKey)).toMatchObject({ status: "planned", executeRequested: true });
  });

  it("cancels a bounded page of unrequested batches after the configuration is closed", async () => {
    const world = await createWorld();
    const now = "2026-11-16T01:00:00.000Z";
    const candidate = { scope: world.scope, taskId: world.taskId, configId: world.config.configId, checkpoint: null };
    expect(await world.auto.beginTask({
      candidate, leaseId: "lease-cancel", now, leaseExpiresAt: "2026-11-16T01:01:00.000Z", requireEligible: true,
    })).not.toBeNull();
    expect(await world.auto.claimBatch({
      scope: world.scope, taskId: world.taskId, configId: world.config.configId,
      batchId: "batch-cancel", now, limit: 20, leaseId: "lease-cancel",
    })).not.toBeNull();
    await world.auto.releaseTask(world.scope, world.taskId, "lease-cancel", now);
    await world.scans.saveConfiguration({ ...world.config, autoOrganize: false });

    expect(await world.auto.cancelUnrequested(now, 1)).toBe(1);
    expect(await checkpoint(world)).toMatchObject({ status: "idle", batchId: null, operationKey: null });
    const items = await pool.query<{ status: string }>(
      "SELECT status FROM library_auto_organization_items WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
      [world.scope.accountId, world.scope.connectedStorageId, world.taskId],
    );
    expect(items.rows.map((row) => row.status)).toEqual(["cancelled"]);
  });
});
