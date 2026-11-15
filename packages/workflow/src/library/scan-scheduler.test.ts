import { describe, expect, it } from "vitest";
import { LibraryScanScheduler, dailyScanTaskId, shanghaiDateAndTime } from "./scan-scheduler.js";
import type { ScanConfiguration, ScanScope, ScanTask } from "./scanner.js";

const scope: ScanScope = { accountId: "account-a", connectedStorageId: "guangya-a" };
function config(id: string, time: string | null = null): ScanConfiguration {
  return { configId: id, scope, sourceRoots: [{ directoryId: "root", name: "Library" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null,
    mediaKind: "mixed", dailyScheduleEnabled: time !== null, dailyScheduleTime: time, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} };
}
function task(taskId: string, status: ScanTask["status"], configId = "c"): ScanTask {
  return { taskId, scope, configId, status, directoriesDone: 0, filesDiscovered: 0, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" };
}

class FakeStore {
  configs: ScanConfiguration[] = [];
  tasks = new Map<string, ScanTask>();
  identificationJobs = new Set<string>();
  activeConfigs = new Set<string>();
  async listConfigurations(_scope: ScanScope, limit = 50, after?: string): Promise<ScanConfiguration[]> { return this.configs.filter((item) => after === undefined || item.configId > after).slice(0, limit); }
  async listTasks(_scope: ScanScope, input: { limit?: number; afterTaskId?: string } = {}): Promise<ScanTask[]> { return [...this.tasks.values()].filter((item) => input.afterTaskId === undefined || item.taskId > input.afterTaskId).sort((a,b) => a.taskId.localeCompare(b.taskId)).slice(0, input.limit ?? 50); }
  async getConfiguration(_scope: ScanScope, id: string): Promise<ScanConfiguration | null> { return this.configs.find((item) => item.configId === id) ?? null; }
  async getTask(_scope: ScanScope, id: string): Promise<ScanTask | null> { return this.tasks.get(id) ?? null; }
  async hasIdentificationJob(_scope: ScanScope, id: string): Promise<boolean> { return this.identificationJobs.has(id); }
  async createTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: ScanConfiguration["sourceRoots"]; now: string }): Promise<ScanTask> {
    if (this.tasks.has(input.taskId)) throw new Error("duplicate task id");
    const created = task(input.taskId, "queued", input.configuration.configId); this.tasks.set(created.taskId, created); return created;
  }
  async createScheduledTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: ScanConfiguration["sourceRoots"]; now: string }): Promise<ScanTask | null> {
    const existing = this.tasks.get(input.taskId);
    if (existing) return existing;
    if (this.activeConfigs.has(input.configuration.configId)) return null;
    return this.createTask(input);
  }
  async hasActiveTaskForConfiguration(_scope: ScanScope, id: string): Promise<boolean> { return this.activeConfigs.has(id); }
}

describe("LibraryScanScheduler", () => {
  it("uses the Shanghai calendar across UTC midnight and a stable scoped daily key", () => {
    expect(shanghaiDateAndTime(new Date("2026-11-14T16:00:00.000Z"))).toEqual({ date: "2026-11-15", time: "00:00" });
    const one = dailyScanTaskId(scope, "c", "2026-11-15");
    expect(one).toBe(dailyScanTaskId(scope, "c", "2026-11-15"));
    expect(one).not.toBe(dailyScanTaskId({ ...scope, accountId: "account-b" }, "c", "2026-11-15"));
  });

  it("schedules once after the configured local time, and recovers create-before-resume after restart", async () => {
    const store = new FakeStore(); store.configs = [config("c", "08:00")];
    const now = () => new Date("2026-11-15T00:05:00.000Z");
    let resumeCount = 0; let failFirstResume = true; const enqueued: string[] = [];
    const make = () => new LibraryScanScheduler({ store, now, resumeScan: async (_s, id) => { resumeCount++; if (failFirstResume) { failFirstResume = false; throw new Error("simulated process exit after task insert"); } store.tasks.set(id, task(id, "running")); }, hasIdentificationJob: async (_s, id) => store.identificationJobs.has(id), ensureIdentification: async (_s, id) => { enqueued.push(id); store.identificationJobs.add(id); }, drainIdentification: async () => undefined });
    const first = make();
    await expect(first.tick(scope)).rejects.toThrow("simulated process exit");
    const id = dailyScanTaskId(scope, "c", "2026-11-15");
    expect(store.tasks.has(id)).toBe(true);
    await make().tick(scope);
    expect(resumeCount).toBe(2);
    store.tasks.set(id, task(id, "completed"));
    await make().tick(scope);
    expect(enqueued).toContain(id);
    store.identificationJobs.add("previously-failed-job");
    store.tasks.set("z-failed-scan", task("z-failed-scan", "completed", "c"));
    store.identificationJobs.add("z-failed-scan");
    const enqueueCount = enqueued.length;
    await make().tick(scope);
    expect(enqueued).toHaveLength(enqueueCount);
    expect([...store.tasks.keys()].filter((key) => key === id)).toHaveLength(1);
  });

  it("defers daily scheduling around paused and other active work without resuming a pause", async () => {
    const store = new FakeStore(); store.configs = [config("c", "08:00")]; store.activeConfigs.add("c");
    let resumed: string[] = [];
    const scheduler = new LibraryScanScheduler({ store, now: () => new Date("2026-11-15T00:05:00.000Z"), resumeScan: async (_s,id) => { resumed.push(id); }, hasIdentificationJob: async () => false, ensureIdentification: async () => undefined, drainIdentification: async () => undefined });
    store.tasks.set("manual-paused", task("manual-paused", "paused"));
    await scheduler.tick(scope);
    expect(store.tasks.has(dailyScanTaskId(scope, "c", "2026-11-15"))).toBe(false);
    expect(resumed).toEqual([]);
  });

  it("rotates past more than one bounded configuration and task page", async () => {
    const store = new FakeStore(); store.configs = Array.from({ length: 5 }, (_, i) => config(`c${i}`, null));
    store.tasks = new Map(Array.from({ length: 5 }, (_, i) => [`t${i}`, task(`t${i}`, "queued")]));
    const resumed: string[] = [];
    const scheduler = new LibraryScanScheduler({ store, pageSize: 2, maxConfigurationsPerTick: 2, maxTasksPerTick: 2, resumeScan: async (_s,id) => { resumed.push(id); }, hasIdentificationJob: async () => false, ensureIdentification: async () => undefined, drainIdentification: async () => undefined });
    for (let i = 0; i < 4; i++) await scheduler.tick(scope);
    expect(new Set(resumed)).toEqual(new Set(["t0", "t1", "t2", "t3", "t4"]));
  });
});
