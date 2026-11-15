import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LibraryScanScheduler } from "./scan-scheduler.js";
import { PostgresScanStore } from "./scan-store.js";
import { LibraryScanner, type ScanConfiguration, type ScanScope } from "./scanner.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresLibraryScanScheduler", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName: string;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_scan_scheduler_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString); databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) { await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await adminPool.end(); }
  }, 30_000);

  async function fixture(schedule = true): Promise<{ scope: ScanScope; config: ScanConfiguration; store: PostgresScanStore }> {
    const suffix = randomUUID().replaceAll("-", "");
    const scope = { accountId: `account_${suffix}`, connectedStorageId: `storage_${suffix}` };
    await pool.query("INSERT INTO accounts (id,username,password_hash,is_owner,created_at) VALUES ($1,$2,'',false,now()::text)", [scope.accountId, `user_${suffix}`]);
    await pool.query("INSERT INTO connected_storages (id,account_id,provider,provider_uid,payload,created_at) VALUES ($1,$2,'guangya',$3,'{}'::jsonb,now()::text)", [scope.connectedStorageId, scope.accountId, `uid_${suffix}`]);
    const config: ScanConfiguration = { configId: `config_${suffix}`, scope, sourceRoots: [{ directoryId: `root_${suffix}`, name: "Library" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null,
      mediaKind: "mixed", dailyScheduleEnabled: schedule, dailyScheduleTime: "08:00", dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} };
    const store = new PostgresScanStore(pool); await store.saveConfiguration(config);
    return { scope, config, store };
  }

  it("uses PostgreSQL's task primary key as a cross-instance daily idempotency barrier", async () => {
    const { scope, store } = await fixture();
    let resumes = 0;
    const scheduler = () => new LibraryScanScheduler({ store, hasIdentificationJob: async () => false, now: () => new Date("2026-11-15T00:05:00.000Z"), resumeScan: async () => { resumes += 1; }, ensureIdentification: async () => undefined, drainIdentification: async () => undefined });
    await Promise.all([scheduler().tick(scope), scheduler().tick(scope)]);
    const tasks = await store.listTasks(scope, { limit: 10 });
    expect(tasks.filter((task) => task.taskId.startsWith("daily-2026-11-15-")).length).toBe(1);
    // Both schedulers can observe the first worker's newly queued row in their recovery pass;
    // scanner lease claiming fences the duplicate resume attempts.
    expect(resumes).toBeGreaterThanOrEqual(1);
  });

  it("does not create the daily task when a manual task wins after the scheduler precheck", async () => {
    const { scope, config, store } = await fixture();
    let releaseDailyCreate!: () => void;
    let signalDailyCreate!: () => void;
    const dailyCreateReached = new Promise<void>((resolve) => { signalDailyCreate = resolve; });
    const allowDailyCreate = new Promise<void>((resolve) => { releaseDailyCreate = resolve; });
    const racingStore = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "createScheduledTask") return async (input: Parameters<PostgresScanStore["createScheduledTask"]>[0]) => {
          signalDailyCreate();
          await allowDailyCreate;
          return target.createScheduledTask(input);
        };
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const scheduler = new LibraryScanScheduler({ store: racingStore, hasIdentificationJob: async () => false, now: () => new Date("2026-11-15T00:05:00.000Z"), resumeScan: async () => undefined, ensureIdentification: async () => undefined, drainIdentification: async () => undefined });
    const tick = scheduler.tick(scope);
    await dailyCreateReached;
    await store.createTask({ taskId: "manual-won", scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:05:01.000Z" });
    releaseDailyCreate();
    await tick;

    expect((await store.getTask(scope, "manual-won"))?.status).toBe("queued");
    expect((await store.listTasks(scope, { limit: 10 })).filter((task) => task.taskId.startsWith("daily-2026-11-15-")).length).toBe(0);
  });

  it("returns no scheduled task while the same configuration has paused work", async () => {
    const { scope, config, store } = await fixture();
    await store.createTask({ taskId: "manual-paused", scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:00:00.000Z" });
    await store.transitionTaskStatus(scope, "manual-paused", "queued", "paused", "2026-11-15T00:00:01.000Z");
    const dailyId = "daily-2026-11-15-pausedcheck";

    expect(await store.createScheduledTask({ taskId: dailyId, scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:05:00.000Z" })).toBeNull();
    expect(await store.getTask(scope, dailyId)).toBeNull();
  });

  it("claims an expired running scan after restart and leaves paused or cancelled tasks alone", async () => {
    const { scope, config, store } = await fixture(false);
    const scanner = new LibraryScanner({ store, now: () => "2026-11-15T00:01:00.000Z", reader: { async listPage() { return { items: [], nextPage: null }; } } });
    await store.createTask({ taskId: "expired", scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:00:00.000Z" });
    await pool.query("UPDATE library_scan_tasks SET status='running',lease_id='dead',lease_expires_at='2026-11-15T00:00:01.000Z' WHERE account_id=$1 AND connected_storage_id=$2 AND task_id='expired'", [scope.accountId, scope.connectedStorageId]);
    await store.createTask({ taskId: "paused", scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:00:00.000Z" });
    await store.transitionTaskStatus(scope, "paused", "queued", "paused", "2026-11-15T00:00:00.000Z");
    await store.createTask({ taskId: "cancelled", scope, configuration: config, roots: config.sourceRoots, now: "2026-11-15T00:00:00.000Z" });
    await store.transitionTaskStatus(scope, "cancelled", "queued", "cancelled", "2026-11-15T00:00:00.000Z");
    const resumed: string[] = [];
    const scheduler = new LibraryScanScheduler({ store, hasIdentificationJob: async () => false, now: () => new Date("2026-11-15T00:01:00.000Z"), resumeScan: async (_s, id) => { resumed.push(id); await scanner.resume(scope, id); }, ensureIdentification: async () => undefined, drainIdentification: async () => undefined });
    await scheduler.tick(scope);
    await scanner.waitForIdle(scope, "expired");
    expect((await store.getTask(scope, "expired"))?.status).toBe("completed");
    expect(resumed).toContain("expired");
    expect(resumed).not.toContain("paused");
    expect(resumed).not.toContain("cancelled");
    expect((await store.getTask(scope, "paused"))?.status).toBe("paused");
    expect((await store.getTask(scope, "cancelled"))?.status).toBe("cancelled");
  });
});
