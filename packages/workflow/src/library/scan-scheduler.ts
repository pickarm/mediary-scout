import { createHash } from "node:crypto";
import type { ScanConfiguration, ScanScope, ScanTask } from "./scanner.js";

export interface ScanSchedulerStore {
  listConfigurations(scope: ScanScope, limit?: number, afterConfigId?: string): Promise<ScanConfiguration[]>;
  listTasks(scope: ScanScope, input?: { limit?: number; afterTaskId?: string }): Promise<ScanTask[]>;
  getConfiguration(scope: ScanScope, configId: string): Promise<ScanConfiguration | null>;
  getTask(scope: ScanScope, taskId: string): Promise<ScanTask | null>;
  createTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: ScanConfiguration["sourceRoots"]; now: string }): Promise<ScanTask>;
  createScheduledTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: ScanConfiguration["sourceRoots"]; now: string }): Promise<ScanTask | null>;
  hasActiveTaskForConfiguration(scope: ScanScope, configId: string): Promise<boolean>;
}

export interface ScanSchedulerOptions {
  store: ScanSchedulerStore;
  resumeScan(scope: ScanScope, taskId: string): Promise<unknown>;
  hasIdentificationJob(scope: ScanScope, taskId: string): Promise<boolean>;
  ensureIdentification(scope: ScanScope, taskId: string): Promise<unknown>;
  drainIdentification(scope: ScanScope, limit: number): Promise<unknown>;
  now?: () => Date;
  pageSize?: number;
  maxConfigurationsPerTick?: number;
  maxTasksPerTick?: number;
}

const TIME_ZONE = "Asia/Shanghai";

/** Bounded, repeatable recovery and daily scan planner. PG task identity is the daily idempotency ledger. */
export class LibraryScanScheduler {
  private readonly store: ScanSchedulerStore;
  private readonly resumeScan: ScanSchedulerOptions["resumeScan"];
  private readonly hasIdentificationJob: ScanSchedulerOptions["hasIdentificationJob"];
  private readonly ensureIdentification: ScanSchedulerOptions["ensureIdentification"];
  private readonly drainIdentification: ScanSchedulerOptions["drainIdentification"];
  private readonly now: () => Date;
  private readonly pageSize: number;
  private readonly maxConfigurationsPerTick: number;
  private readonly maxTasksPerTick: number;
  private readonly configCursors = new Map<string, string | undefined>();
  private readonly taskCursors = new Map<string, string | undefined>();

  constructor(options: ScanSchedulerOptions) {
    this.store = options.store;
    this.resumeScan = options.resumeScan;
    this.hasIdentificationJob = options.hasIdentificationJob;
    this.ensureIdentification = options.ensureIdentification;
    this.drainIdentification = options.drainIdentification;
    this.now = options.now ?? (() => new Date());
    this.pageSize = bounded(options.pageSize ?? 50, 1, 100, "pageSize");
    this.maxConfigurationsPerTick = bounded(options.maxConfigurationsPerTick ?? 50, 1, 500, "maxConfigurationsPerTick");
    this.maxTasksPerTick = bounded(options.maxTasksPerTick ?? 50, 1, 500, "maxTasksPerTick");
  }

  async tick(scope: ScanScope): Promise<void> {
    const configKey = scopeKey(scope);
    const configs = await this.rotatingConfigurations(scope, configKey);
    for (const config of configs) await this.scheduleIfDue(scope, config);
    const tasks = await this.rotatingTasks(scope, configKey);
    for (const task of tasks) {
      if (task.status === "queued" || task.status === "running") {
        await this.resumeScan(scope, task.taskId);
      } else if (task.status === "completed" || task.status === "partial") {
        // Repair only the missing-job crash window. Never reset a failed job or
        // refresh completed work through the enqueue upsert.
        if (!(await this.hasIdentificationJob(scope, task.taskId))) await this.ensureIdentification(scope, task.taskId);
      }
    }
    await this.drainIdentification(scope, 10);
  }

  private async rotatingConfigurations(scope: ScanScope, key: string): Promise<ScanConfiguration[]> {
    const after = this.configCursors.get(key);
    let page = await this.store.listConfigurations(scope, this.pageSize, after);
    if (!page.length && after !== undefined) page = await this.store.listConfigurations(scope, this.pageSize);
    if (!page.length) return [];
    const selected = page.slice(0, this.maxConfigurationsPerTick);
    const cursor = selected.at(-1)!.configId;
    this.configCursors.set(key, selected.length === page.length && page.length < this.pageSize ? undefined : cursor);
    return selected;
  }

  private async rotatingTasks(scope: ScanScope, key: string): Promise<ScanTask[]> {
    const after = this.taskCursors.get(key);
    let page = await this.store.listTasks(scope, { limit: this.pageSize, ...(after === undefined ? {} : { afterTaskId: after }) });
    if (!page.length && after !== undefined) page = await this.store.listTasks(scope, { limit: this.pageSize });
    if (!page.length) return [];
    const selected = page.slice(0, this.maxTasksPerTick);
    const cursor = selected.at(-1)!.taskId;
    this.taskCursors.set(key, selected.length === page.length && page.length < this.pageSize ? undefined : cursor);
    return selected;
  }

  private async scheduleIfDue(scope: ScanScope, listed: ScanConfiguration): Promise<void> {
    if (!listed.dailyScheduleEnabled || !listed.dailyScheduleTime || listed.dailyScheduleTimezone !== TIME_ZONE) return;
    const local = shanghaiDateAndTime(this.now());
    if (local.time < listed.dailyScheduleTime) return;
    const taskId = dailyScanTaskId(scope, listed.configId, local.date);
    if (await this.store.getTask(scope, taskId)) return;
    // Paused tasks are intentionally active for this gate and are never resumed by this branch.
    if (await this.store.hasActiveTaskForConfiguration(scope, listed.configId)) return;
    const configuration = await this.store.getConfiguration(scope, listed.configId);
    if (!configuration || !configuration.dailyScheduleEnabled || configuration.dailyScheduleTime !== listed.dailyScheduleTime) return;
    const scheduled = await this.store.createScheduledTask({ taskId, scope, configuration, roots: configuration.sourceRoots, now: this.now().toISOString() });
    if (!scheduled) return;
    await this.resumeScan(scope, taskId);
  }
}

export function dailyScanTaskId(scope: ScanScope, configId: string, localDate: string): string {
  const digest = createHash("sha256").update(`${scope.accountId}\0${scope.connectedStorageId}\0${configId}`).digest("hex").slice(0, 32);
  return `daily-${localDate}-${digest}`;
}

export function shanghaiDateAndTime(date: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return { date: `${values.get("year")}-${values.get("month")}-${values.get("day")}`, time: `${values.get("hour")}:${values.get("minute")}` };
}

function scopeKey(scope: ScanScope): string { return `${scope.accountId}\0${scope.connectedStorageId}`; }
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
}
