import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema } from "./postgres.js";
import {
  LibraryScanner,
  type DirectoryPage,
  type DirectoryReader,
  type ScanConfiguration,
  type ScanDirectoryStatus,
  type ScanScope,
} from "./library/scanner.js";
import { PostgresScanStore } from "./library/scan-store.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);
let adminPool: pg.Pool;
let pool: pg.Pool;
let databaseName = "";
let databaseCreated = false;

async function createScope(provider = "guangya"): Promise<ScanScope> {
  const suffix = randomUUID().replaceAll("-", "");
  const accountId = `f04_acct_${suffix}`;
  const connectedStorageId = `f04_storage_${suffix}`;
  await pool.query(
    "INSERT INTO accounts (id,username,password_hash,is_owner,created_at) VALUES ($1,$2,'',false,now()::text)",
    [accountId,`user_${suffix}`],
  );
  await pool.query(
    "INSERT INTO connected_storages (id,account_id,provider,provider_uid,payload,created_at) VALUES ($1,$2,$3,$4,'{}'::jsonb,now()::text)",
    [connectedStorageId,accountId,provider,`uid_${suffix}`],
  );
  return { accountId, connectedStorageId };
}

function makeConfig(scope: ScanScope): ScanConfiguration {
  return {
    configId: "f04-config",
    scope,
    sourceRoots: [{ directoryId: "root", name: "Media" }],
    movieTargetDirectoryId: "target-movies",
    tvTargetDirectoryId: "target-tv",
    mediaKind: "mixed",
    dailyScheduleEnabled: true,
    dailyScheduleTime: "03:15",
    dailyScheduleTimezone: "Asia/Shanghai",
    autoOrganize: false,
    autoAcquire: false,
    templates: {},
  };
}

class FakeReader implements DirectoryReader {
  readonly calls: Array<{ directoryId: string; page: number }> = [];
  async listPage({ directoryId, directoryPath, page }: { directoryId: string; directoryPath: string; page: number; pageSize: number }): Promise<DirectoryPage> {
    this.calls.push({ directoryId, page });
    if (directoryId === "root" && page === 0) return {
      items: [{ fileId: "dir-a", parentDirectoryId: "root", name: "A", isDirectory: true, sizeBytes: null, path: `${directoryPath}/A`, modifiedAt: null }],
      nextPage: 1,
    };
    if (directoryId === "root" && page === 1) return {
      items: [{ fileId: "root-file", parentDirectoryId: "root", name: "Movie.mkv", isDirectory: false, sizeBytes: 100, path: `${directoryPath}/Movie.mkv`, modifiedAt: "2026-01-01T00:00:00Z" }],
      nextPage: null,
    };
    if (directoryId === "dir-a" && page === 0) return {
      items: [
        { fileId: "dir-b", parentDirectoryId: "dir-a", name: "B", isDirectory: true, sizeBytes: null, path: `${directoryPath}/B`, modifiedAt: null },
        { fileId: "nested-file", parentDirectoryId: "dir-a", name: "Episode.mkv", isDirectory: false, sizeBytes: 200, path: `${directoryPath}/Episode.mkv`, modifiedAt: null },
      ],
      nextPage: null,
    };
    if (directoryId === "dir-b" && page === 0) return {
      items: [{ fileId: "deep-file", parentDirectoryId: "dir-b", name: "deep.srt", isDirectory: false, sizeBytes: 5, path: `${directoryPath}/deep.srt`, modifiedAt: null }],
      nextPage: null,
    };
    throw new Error(`unexpected fake page ${directoryId}:${page}`);
  }
}

integration("F04 authorized directory scanner", () => {
  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_scan_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });
    await initializeWorkflowPostgresSchema(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      try {
        if (databaseCreated) await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
      await adminPool.end();
      }
    }
  }, 30_000);

  it("persists paginated facts, actual directory relationships, and task scope in PostgreSQL", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store = new PostgresScanStore(pool);
    await store.saveConfiguration(config);
    const reader = new FakeReader();
    const scanner = new LibraryScanner({ store, reader, idFactory: () => "f04-paged-task" });
    const task = await scanner.start(scope, config.configId);
    const finished = await scanner.waitForIdle(scope, task.taskId);
    expect(finished.status).toBe("completed");
    expect(reader.calls).toEqual([
      { directoryId: "root", page: 0 }, { directoryId: "root", page: 1 },
      { directoryId: "dir-a", page: 0 }, { directoryId: "dir-b", page: 0 },
    ]);
    expect((await store.listTaskFiles(scope, task.taskId, { limit: 20 })).map((f) => [f.fileId, f.parentDirectoryId])).toEqual([
      ["deep-file", "dir-b"], ["dir-a", "root"], ["dir-b", "dir-a"], ["nested-file", "dir-a"], ["root-file", "root"],
    ]);
    expect((await store.listTaskDirectories(scope, task.taskId)).map((d) => [d.directoryId, d.parentDirectoryId, d.status])).toEqual([
      ["dir-a", "root", "done"], ["dir-b", "dir-a", "done"], ["root", null, "done"],
    ]);
    await expect(store.getTask({ accountId: "other-account", connectedStorageId: scope.connectedStorageId }, task.taskId)).rejects.toThrow(/不属于指定账号/);
  }, 30_000);

  it("keyset-pages configurations and task summaries in the real guangya scope", async () => {
    const scope = await createScope();
    const store = new PostgresScanStore(pool);
    const first = { ...makeConfig(scope), configId: "f04-page-a" };
    const second = { ...makeConfig(scope), configId: "f04-page-b" };
    await store.saveConfiguration(first);
    await store.saveConfiguration(second);
    expect((await store.listConfigurations(scope, 1)).map((item) => item.configId)).toEqual(["f04-page-a"]);
    expect((await store.listConfigurations(scope, 1, "f04-page-a")).map((item) => item.configId)).toEqual(["f04-page-b"]);
    expect(await store.listConfigurations(scope, 1, "f04-page-b")).toEqual([]);

    const makeEmptyScanner = (taskId: string) => new LibraryScanner({
      store,
      idFactory: () => taskId,
      reader: { async listPage() { return { items: [], nextPage: null }; } },
    });
    for (const [config, taskId] of [[first, "f04-page-task-a"], [second, "f04-page-task-b"]] as const) {
      const scanner = makeEmptyScanner(taskId);
      const task = await scanner.start(scope, config.configId);
      expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("completed");
    }
    const firstPage = await store.listTasks(scope, { limit: 1 });
    expect(firstPage.map((task) => task.taskId)).toEqual(["f04-page-task-a"]);
    expect((await store.listTasks(scope, { limit: 1, afterTaskId: "f04-page-task-a" })).map((task) => task.taskId)).toEqual(["f04-page-task-b"]);
    expect(firstPage[0]?.failures).toEqual([]);
  }, 30_000);

  it("pauses at a page boundary and resumes from the durable page checkpoint", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store = new PostgresScanStore(pool);
    await store.saveConfiguration(config);
    let unblock!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const calls: Array<{ directoryId: string; page: number }> = [];
    let firstCall = true;
    const reader: DirectoryReader = {
      async listPage({ directoryId, directoryPath, page }) {
        calls.push({ directoryId, page });
        if (firstCall) { firstCall = false; entered(); await gate; }
        return {
          items: [{ fileId: `resumed-file-${page}`, parentDirectoryId: directoryId, name: `resumed-${page}.mkv`, isDirectory: false, sizeBytes: 1, path: `${directoryPath}/resumed-${page}.mkv`, modifiedAt: null }],
          nextPage: page < 2 ? page + 1 : null,
        };
      },
    };
    const scanner = new LibraryScanner({ store, reader, idFactory: () => "f04-pause-task", maxDirectories: 1 });
    const task = await scanner.start(scope, config.configId);
    await enteredPromise;
    expect((await scanner.pause(scope, task.taskId)).status).toBe("paused");
    await expect(store.saveConfiguration({ ...config, autoOrganize: true })).rejects.toThrow(/暂不能修改配置/);
    unblock();
    await scanner.waitForIdle(scope, task.taskId);
    expect((await store.listTaskFiles(scope, task.taskId)).length).toBe(0);
    const checkpoint = (await store.listTaskDirectories(scope, task.taskId))[0]!;
    expect([checkpoint.nextPage, checkpoint.status]).toEqual([0, "pending"]);
    await scanner.resume(scope, task.taskId);
    expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("completed");
    expect((await store.listTaskFiles(scope, task.taskId)).map((file) => file.fileId)).toEqual([
      "resumed-file-0", "resumed-file-1", "resumed-file-2",
    ]);
    expect(calls).toEqual([
      { directoryId: "root", page: 0 }, { directoryId: "root", page: 0 },
      { directoryId: "root", page: 1 }, { directoryId: "root", page: 2 },
    ]);
  }, 30_000);

  it("cancels safely and retries partial failures only through retryFailed", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store = new PostgresScanStore(pool);
    await store.saveConfiguration(config);
    let unblock!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const reader: DirectoryReader = { async listPage() { entered(); await gate; throw new Error("late read failure after cancellation"); } };
    const scanner = new LibraryScanner({ store, reader, idFactory: () => "f04-cancel-task" });
    const task = await scanner.start(scope, config.configId);
    await enteredPromise;
    expect((await scanner.cancel(scope, task.taskId)).status).toBe("cancelled");
    unblock();
    expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("cancelled");
    expect((await store.listTaskDirectories(scope, task.taskId))[0]?.status).toBe("pending");
    expect(await store.listTaskFailures(scope, task.taskId)).toEqual([]);

    let shouldFail = true;
    const failureCalls: Array<{ directoryId: string; page: number }> = [];
    const failingScanner = new LibraryScanner({
      store,
      reader: { async listPage({ directoryId, directoryPath }) {
        failureCalls.push({ directoryId, page: 0 });
        if (directoryId === "root") return {
          items: [{ fileId: "bad-dir", parentDirectoryId: "root", name: "Bad", isDirectory: true, sizeBytes: null, path: `${directoryPath}/Bad`, modifiedAt: null }],
          nextPage: null,
        };
        if (shouldFail) throw new Error("directory inaccessible");
        return { items: [{ fileId: "recovered-file", parentDirectoryId: directoryId, name: "Recovered.mkv", isDirectory: false, sizeBytes: 1, path: `${directoryPath}/Recovered.mkv`, modifiedAt: null }], nextPage: null };
      } },
      idFactory: () => "f04-partial-task",
    });
    const partialTask = await failingScanner.start(scope, config.configId);
    expect((await failingScanner.waitForIdle(scope, partialTask.taskId)).status).toBe("partial");
    expect((await store.listTaskFailures(scope, partialTask.taskId))[0]?.message).toBe("directory inaccessible");
    expect((await failingScanner.resume(scope, partialTask.taskId)).status).toBe("partial");
    expect(failureCalls).toEqual([{ directoryId: "root", page: 0 }, { directoryId: "bad-dir", page: 0 }]);
    shouldFail = false;
    await failingScanner.retryFailed(scope, partialTask.taskId);
    expect((await failingScanner.waitForIdle(scope, partialTask.taskId)).status).toBe("completed");
    expect(failureCalls).toEqual([
      { directoryId: "root", page: 0 }, { directoryId: "bad-dir", page: 0 }, { directoryId: "bad-dir", page: 0 },
    ]);
    expect(await store.listTaskFailures(scope, partialTask.taskId)).toEqual([]);
  }, 30_000);

  it("uses a PostgreSQL task lease across scanner instances for concurrent success and failure", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store1 = new PostgresScanStore(pool);
    const store2 = new PostgresScanStore(pool);
    await store1.saveConfiguration(config);

    let releaseSuccess!: () => void;
    let successEntered!: () => void;
    const successEnteredPromise = new Promise<void>((resolve) => { successEntered = resolve; });
    const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve; });
    let successfulReads = 0;
    const successfulReader: DirectoryReader = {
      async listPage({ directoryId, directoryPath }) {
        successfulReads += 1;
        successEntered();
        await successGate;
        return { items: [{ fileId: "one-file", parentDirectoryId: directoryId, name: "one.mkv", isDirectory: false, sizeBytes: 1, path: `${directoryPath}/one.mkv`, modifiedAt: null }], nextPage: null };
      },
    };
    let duplicateSuccessReads = 0;
    const scanner1 = new LibraryScanner({ store: store1, reader: successfulReader, idFactory: () => "f04-lease-success" });
    const scanner2 = new LibraryScanner({
      store: store2,
      reader: { async listPage() { duplicateSuccessReads += 1; return { items: [], nextPage: null }; } },
    });
    const successTask = await scanner1.start(scope, config.configId);
    await successEnteredPromise;
    await scanner2.resume(scope, successTask.taskId);
    expect(duplicateSuccessReads).toBe(0);
    releaseSuccess();
    expect((await scanner1.waitForIdle(scope, successTask.taskId)).status).toBe("completed");
    expect(successfulReads).toBe(1);

    await store1.saveConfiguration({ ...config, configId: "f04-failure-config" });
    let releaseFailure!: () => void;
    let failureEntered!: () => void;
    const failureEnteredPromise = new Promise<void>((resolve) => { failureEntered = resolve; });
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let failedReads = 0;
    const scanner3 = new LibraryScanner({
      store: store1,
      reader: { async listPage() { failedReads += 1; failureEntered(); await failureGate; throw new Error("one remote failure"); } },
      idFactory: () => "f04-lease-failure",
    });
    let duplicateFailureReads = 0;
    const scanner4 = new LibraryScanner({
      store: store2,
      reader: { async listPage() { duplicateFailureReads += 1; return { items: [], nextPage: null }; } },
    });
    const failureTask = await scanner3.start(scope, "f04-failure-config");
    await failureEnteredPromise;
    await scanner4.resume(scope, failureTask.taskId);
    expect(duplicateFailureReads).toBe(0);
    releaseFailure();
    expect((await scanner3.waitForIdle(scope, failureTask.taskId)).status).toBe("failed");
    expect(failedReads).toBe(1);
    expect((await store1.listTaskFailures(scope, failureTask.taskId))).toHaveLength(1);
  }, 30_000);

  it("retries a failed task-level checkpoint error without losing pending directories", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const baseStore = new PostgresScanStore(pool);
    await baseStore.saveConfiguration(config);
    class FailOnceListingStore extends PostgresScanStore {
      private shouldFail = true;
      override async listDirectories(scope: ScanScope, taskId: string, statuses: readonly ScanDirectoryStatus[]) {
        if (this.shouldFail) {
          this.shouldFail = false;
          throw new Error("temporary checkpoint read failure");
        }
        return super.listDirectories(scope, taskId, statuses);
      }
    }
    const flakyStore = new FailOnceListingStore(pool);
    const scanner = new LibraryScanner({
      store: flakyStore,
      reader: { async listPage({ directoryId, directoryPath }) {
        return {
          items: [{ fileId: "after-checkpoint-retry", parentDirectoryId: directoryId, name: "Recovered.mkv", isDirectory: false, sizeBytes: 3, path: `${directoryPath}/Recovered.mkv`, modifiedAt: null }],
          nextPage: null,
        };
      } },
      idFactory: () => "f04-checkpoint-retry-task",
    });
    const task = await scanner.start(scope, config.configId);
    expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("failed");
    expect((await baseStore.listTaskDirectories(scope, task.taskId))[0]).toMatchObject({ status: "pending", nextPage: 0 });
    expect((await baseStore.listTaskFailures(scope, task.taskId))[0]?.directoryId).toBe("");
    expect((await scanner.resume(scope, task.taskId)).status).toBe("failed");

    await scanner.retryFailed(scope, task.taskId);
    expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("completed");
    expect((await baseStore.listTaskDirectories(scope, task.taskId))[0]).toMatchObject({ status: "done", nextPage: 0 });
    expect((await baseStore.listTaskFiles(scope, task.taskId))[0]?.fileId).toBe("after-checkpoint-retry");
    expect(await baseStore.listTaskFailures(scope, task.taskId)).toEqual([]);
  }, 30_000);

  it("rejects stale page failures and terminal updates after a newer cursor/status wins", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store = new PostgresScanStore(pool);
    await store.saveConfiguration(config);
    const now = new Date().toISOString();
    const task = await store.createTask({
      taskId: "f04-cas-task",
      scope,
      configuration: config,
      roots: config.sourceRoots,
      now,
    });
    const leaseId = "f04-cas-lease";
    expect(await store.claimTask(scope, task.taskId, leaseId, now, new Date(Date.now() + 120_000).toISOString())).toBe(true);
    const root = (await store.listDirectories(scope, task.taskId, ["pending"]))[0]!;
    expect(await store.commitPage({
      scope,
      taskId: task.taskId,
      leaseId,
      directory: root,
      facts: [],
      childDirectories: [],
      nextPage: 1,
      now,
    })).toBe(true);
    expect(await store.failPage({
      scope,
      taskId: task.taskId,
      leaseId,
      directoryId: root.directoryId,
      page: 0,
      message: "late failure from the already committed page",
      now,
    })).toBe(false);
    const pageOne = (await store.listDirectories(scope, task.taskId, ["pending"]))[0]!;
    expect(pageOne.nextPage).toBe(1);
    expect(await store.commitPage({
      scope,
      taskId: task.taskId,
      leaseId,
      directory: pageOne,
      facts: [],
      childDirectories: [],
      nextPage: null,
      now,
    })).toBe(true);
    expect(await store.finishTask({ scope, taskId: task.taskId, leaseId, status: "completed", now })).toBe(true);
    expect(await store.finishTask({ scope, taskId: task.taskId, leaseId, status: "failed", message: "stale worker", now })).toBe(false);
    expect((await store.getTask(scope, task.taskId))?.status).toBe("completed");
    expect(await store.listTaskFailures(scope, task.taskId)).toEqual([]);
  }, 30_000);

  it("persists a provider cursor with the page and resumes it from a fresh scanner instance", async () => {
    const scope = await createScope();
    const config = makeConfig(scope);
    const store = new PostgresScanStore(pool);
    await store.saveConfiguration(config);

    let unblock!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    const firstCalls: Array<{ page: number; cursor?: string }> = [];
    const firstScanner = new LibraryScanner({
      store,
      idFactory: () => "f20-cursor-restart",
      reader: {
        async listPage({ directoryId, directoryPath, page, cursor }) {
          firstCalls.push({ page, ...(cursor !== undefined ? { cursor } : {}) });
          if (page === 0) {
            return {
              items: [{
                fileId: "first-page-file",
                parentDirectoryId: directoryId,
                name: "First.mkv",
                isDirectory: false,
                sizeBytes: 1,
                path: `${directoryPath}/First.mkv`,
                modifiedAt: null,
              }],
              nextPage: 1,
              nextCursor: "next-17",
            };
          }
          entered();
          await gate;
          return {
            items: [{
              fileId: "late-file",
              parentDirectoryId: directoryId,
              name: "Late.mkv",
              isDirectory: false,
              sizeBytes: 2,
              path: `${directoryPath}/Late.mkv`,
              modifiedAt: null,
            }],
            nextPage: null,
          };
        },
      },
    });

    const task = await firstScanner.start(scope, config.configId);
    await enteredPromise;
    expect((await firstScanner.pause(scope, task.taskId)).status).toBe("paused");
    unblock();
    await firstScanner.waitForIdle(scope, task.taskId);
    expect((await store.listTaskDirectories(scope, task.taskId))[0]).toMatchObject({
      nextPage: 1,
      nextCursor: "next-17",
      status: "pending",
    });
    expect((await store.listTaskFiles(scope, task.taskId)).map((fact) => fact.fileId)).toEqual([
      "first-page-file",
    ]);
    expect(firstCalls).toEqual([
      { page: 0 },
      { page: 1, cursor: "next-17" },
    ]);

    const resumedCalls: Array<{ page: number; cursor?: string }> = [];
    const resumedScanner = new LibraryScanner({
      store,
      reader: {
        async listPage({ directoryId, directoryPath, page, cursor }) {
          resumedCalls.push({ page, ...(cursor !== undefined ? { cursor } : {}) });
          return {
            items: [{
              fileId: "resumed-file",
              parentDirectoryId: directoryId,
              name: "Resumed.mkv",
              isDirectory: false,
              sizeBytes: 3,
              path: `${directoryPath}/Resumed.mkv`,
              modifiedAt: null,
            }],
            nextPage: null,
          };
        },
      },
    });
    await resumedScanner.resume(scope, task.taskId);
    expect((await resumedScanner.waitForIdle(scope, task.taskId)).status).toBe("completed");
    expect(resumedCalls).toEqual([{ page: 1, cursor: "next-17" }]);
    expect((await store.listTaskFiles(scope, task.taskId)).map((fact) => fact.fileId)).toEqual([
      "first-page-file",
      "resumed-file",
    ]);
    expect((await store.listTaskDirectories(scope, task.taskId))[0]?.nextCursor).toBeUndefined();
  }, 30_000);

  it("accepts the six original storage provider names in scan scope", async () => {
    const store = new PostgresScanStore(pool);
    for (const provider of ["pan115", "quark", "uc", "pan123", "tianyi", "guangya"] as const) {
      const scope = await createScope(provider);
      const config = { ...makeConfig(scope), configId: `f20-provider-${provider}` };
      await store.saveConfiguration(config);
      const scanner = new LibraryScanner({
        store,
        idFactory: () => `f20-provider-task-${provider}`,
        reader: { async listPage() { return { items: [], nextPage: null }; } },
      });
      const task = await scanner.start(scope, config.configId);
      expect((await scanner.waitForIdle(scope, task.taskId)).status).toBe("completed");
    }
  }, 30_000);
});
