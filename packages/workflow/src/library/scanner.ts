import type { GuangYaClient, GuangYaItem } from "../guangya-client.js";
import type { Pool } from "pg";
import { PostgresScanStore } from "./scan-store.js";

export type ScanMediaKind = "movie" | "tv" | "mixed";
export type ScanTaskStatus = "queued" | "running" | "paused" | "cancelling" | "cancelled" | "completed" | "partial" | "failed";
export type ScanDirectoryStatus = "pending" | "running" | "done" | "failed";
export const SCAN_SCHEDULE_TIME_ZONE = "Asia/Shanghai" as const;
export { DEFAULT_ORGANIZE_CONCURRENCY, MAX_ORGANIZE_CONCURRENCY, MIN_ORGANIZE_CONCURRENCY } from "./naming.js";

export interface ScanScope {
  accountId: string;
  connectedStorageId: string;
}

export interface ScanRoot {
  directoryId: string;
  name: string;
}

/** Persisted scanner configuration; roots must be saved by an authenticated service flow. */
export interface ScanConfiguration {
  configId: string;
  scope: ScanScope;
  sourceRoots: readonly ScanRoot[];
  movieTargetDirectoryId: string | null;
  movieTargetDirectoryName?: string | null;
  tvTargetDirectoryId: string | null;
  tvTargetDirectoryName?: string | null;
  mediaKind: ScanMediaKind;
  dailyScheduleEnabled: boolean;
  dailyScheduleTime: string | null;
  dailyScheduleTimezone: typeof SCAN_SCHEDULE_TIME_ZONE;
  autoOrganize: boolean;
  organizeConcurrency?: number;
  autoAcquire: false;
  templates: Readonly<Record<string, string>>;
}

export interface ScanFileFact {
  fileId: string;
  parentDirectoryId: string;
  name: string;
  isDirectory: boolean;
  sizeBytes: number | null;
  path: string;
  modifiedAt: string | null;
}

export interface DirectoryPage {
  items: readonly ScanFileFact[];
  /** The next zero-based page, or null when the directory is complete. */
  nextPage: number | null;
  /** Provider-native continuation token, persisted beside nextPage. */
  nextCursor?: string;
}

export interface DirectoryReader {
  listPage(input: {
    directoryId: string;
    directoryPath: string;
    page: number;
    pageSize: number;
    cursor?: string;
  }): Promise<DirectoryPage>;
}

export interface ScanDirectoryCheckpoint {
  directoryId: string;
  parentDirectoryId: string | null;
  path: string;
  nextPage: number;
  nextCursor?: string;
  status: ScanDirectoryStatus;
}

export interface ScanTask {
  taskId: string;
  scope: ScanScope;
  configId: string;
  status: ScanTaskStatus;
  directoriesDone: number;
  filesDiscovered: number;
  directoriesDiscovered: number;
  failures: readonly { directoryId: string; page: number; message: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface ScanStore {
  saveConfiguration(configuration: ScanConfiguration): Promise<void>;
  getConfiguration(scope: ScanScope, configId: string): Promise<ScanConfiguration | null>;
  createTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: readonly ScanRoot[]; now: string }): Promise<ScanTask>;
  getTask(scope: ScanScope, taskId: string): Promise<ScanTask | null>;
  claimTask(scope: ScanScope, taskId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<boolean>;
  renewTaskLease(scope: ScanScope, taskId: string, leaseId: string, leaseExpiresAt: string, now: string): Promise<boolean>;
  listDirectories(scope: ScanScope, taskId: string, statuses: readonly ScanDirectoryStatus[]): Promise<ScanDirectoryCheckpoint[]>;
  commitPage(input: {
    scope: ScanScope;
    taskId: string;
    leaseId: string;
    directory: ScanDirectoryCheckpoint;
    facts: readonly ScanFileFact[];
    childDirectories: readonly ScanDirectoryCheckpoint[];
    nextPage: number | null;
    nextCursor?: string | null;
    now: string;
  }): Promise<boolean>;
  failPage(input: { scope: ScanScope; taskId: string; leaseId: string; directoryId: string; page: number; message: string; now: string }): Promise<boolean>;
  finishTask(input: { scope: ScanScope; taskId: string; leaseId: string; status: Extract<ScanTaskStatus, "completed" | "partial" | "failed">; message?: string; now: string }): Promise<boolean>;
  transitionTaskStatus(scope: ScanScope, taskId: string, expected: ScanTaskStatus, status: Extract<ScanTaskStatus, "paused" | "cancelled">, now: string): Promise<boolean>;
  resetFailedDirectories(scope: ScanScope, taskId: string, now: string): Promise<boolean>;
}

export interface ScannerOptions {
  store: ScanStore;
  reader: DirectoryReader;
  pageSize?: number;
  maxPagesPerDirectory?: number;
  maxDirectories?: number;
  maxDepth?: number;
  leaseDurationMs?: number;
  idFactory?: () => string;
  now?: () => string;
}

export class ScanScopeError extends Error {
  constructor(message: string) { super(message); this.name = "ScanScopeError"; }
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 10_000;
const DEFAULT_MAX_DIRECTORIES = 100_000;
const DEFAULT_MAX_DEPTH = 256;
const DEFAULT_LEASE_DURATION_MS = 120_000;

/** Read-only, checkpointed traversal. It never invokes any write operation on the provider. */
export class LibraryScanner {
  private readonly store: ScanStore;
  private readonly reader: DirectoryReader;
  private readonly pageSize: number;
  private readonly maxPagesPerDirectory: number;
  private readonly maxDirectories: number;
  private readonly maxDepth: number;
  private readonly leaseDurationMs: number;
  private readonly idFactory: () => string;
  private readonly now: () => string;
  private readonly active = new Map<string, Promise<void>>();

  constructor(options: ScannerOptions) {
    this.store = options.store;
    this.reader = options.reader;
    this.pageSize = boundedInteger(options.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE, "pageSize");
    this.maxPagesPerDirectory = boundedInteger(options.maxPagesPerDirectory ?? DEFAULT_MAX_PAGES, 1, 100_000, "maxPagesPerDirectory");
    this.maxDirectories = boundedInteger(options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES, 1, 1_000_000, "maxDirectories");
    this.maxDepth = boundedInteger(options.maxDepth ?? DEFAULT_MAX_DEPTH, 1, 4096, "maxDepth");
    this.leaseDurationMs = boundedInteger(options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS, 1_000, 3_600_000, "leaseDurationMs");
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async start(scope: ScanScope, configId: string): Promise<ScanTask> {
    const config = await this.store.getConfiguration(scope, configId);
    if (!config) throw new ScanScopeError("扫描配置不存在或不属于指定账号与网盘");
    if (config.sourceRoots.length === 0) throw new ScanScopeError("扫描配置没有授权来源目录");
    const roots = dedupeRoots(config.sourceRoots);
    const task = await this.store.createTask({ taskId: this.idFactory(), scope, configuration: config, roots, now: this.now() });
    await this.claimAndLaunch(scope, task.taskId);
    return (await this.store.getTask(scope, task.taskId))!;
  }

  async resume(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const task = await this.store.getTask(scope, taskId);
    if (!task) throw new ScanScopeError("扫描任务不存在或不属于指定账号与网盘");
    if (task.status !== "queued" && task.status !== "paused" && task.status !== "running") return task;
    if (task.status === "running" && this.active.has(scopeKey(scope, taskId))) return task;
    await this.claimAndLaunch(scope, taskId);
    return (await this.store.getTask(scope, taskId))!;
  }

  /** Partial/failed scans require an explicit retry; successful page checkpoints are retained. */
  async retryFailed(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const task = await this.requireTask(scope, taskId);
    if (task.status !== "partial" && task.status !== "failed") return task;
    if (await this.store.resetFailedDirectories(scope, taskId, this.now())) await this.claimAndLaunch(scope, taskId);
    return (await this.requireTask(scope, taskId));
  }

  /** Wait for the current in-process page loop; restart recovery uses resume(). */
  async waitForIdle(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const active = this.active.get(scopeKey(scope, taskId));
    if (active) await active;
    return this.requireTask(scope, taskId);
  }

  async pause(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const task = await this.requireTask(scope, taskId);
    if (task.status === "running" || task.status === "queued") {
      await this.store.transitionTaskStatus(scope, taskId, task.status, "paused", this.now());
    }
    return (await this.requireTask(scope, taskId));
  }

  async cancel(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const task = await this.requireTask(scope, taskId);
    if (!["completed", "partial", "failed", "cancelled"].includes(task.status)) {
      await this.store.transitionTaskStatus(scope, taskId, task.status, "cancelled", this.now());
    }
    return (await this.requireTask(scope, taskId));
  }

  private async requireTask(scope: ScanScope, taskId: string): Promise<ScanTask> {
    const task = await this.store.getTask(scope, taskId);
    if (!task) throw new ScanScopeError("扫描任务不存在或不属于指定账号与网盘");
    return task;
  }

  private async claimAndLaunch(scope: ScanScope, taskId: string): Promise<void> {
    const key = scopeKey(scope, taskId);
    const active = this.active.get(key);
    if (active) await active;
    const leaseId = globalThis.crypto.randomUUID();
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    if (await this.store.claimTask(scope, taskId, leaseId, now, leaseExpiresAt)) this.launch(scope, taskId, leaseId);
  }

  private launch(scope: ScanScope, taskId: string, leaseId: string): void {
    const key = scopeKey(scope, taskId);
    const run = this.run(scope, taskId, leaseId).catch(async (error: unknown) => {
      const message = safeError(error);
      await this.store.finishTask({ scope, taskId, leaseId, status: "failed", message, now: this.now() }).catch(() => false);
    }).finally(() => { if (this.active.get(key) === run) this.active.delete(key); });
    this.active.set(key, run);
  }

  private async run(scope: ScanScope, taskId: string, leaseId: string): Promise<void> {
    for (;;) {
      const task = await this.requireTask(scope, taskId);
      if (task.status !== "running") return;
      const leaseExpiresAt = new Date(Date.parse(this.now()) + this.leaseDurationMs).toISOString();
      if (!(await this.store.renewTaskLease(scope, taskId, leaseId, leaseExpiresAt, this.now()))) return;
      const pending = await this.store.listDirectories(scope, taskId, ["pending", "running"]);
      if (pending.length === 0) {
        const finalStatus: ScanTaskStatus = task.failures.length === 0
          ? "completed"
          : task.directoriesDone === 0 && task.filesDiscovered === 0 ? "failed" : "partial";
        await this.store.finishTask({ scope, taskId, leaseId, status: finalStatus as "completed" | "partial" | "failed", now: this.now() });
        return;
      }
      const directory = pending[0]!;
      if (task.directoriesDiscovered > this.maxDirectories) {
        await this.store.failPage({ scope, taskId, leaseId, directoryId: directory.directoryId, page: directory.nextPage, message: "扫描目录数超过安全上限", now: this.now() });
        continue;
      }
      if (pathDepth(directory.path) > this.maxDepth) {
        await this.store.failPage({ scope, taskId, leaseId, directoryId: directory.directoryId, page: directory.nextPage, message: "目录深度超过安全上限", now: this.now() });
        continue;
      }
      if (directory.nextPage >= this.maxPagesPerDirectory) {
        await this.store.failPage({ scope, taskId, leaseId, directoryId: directory.directoryId, page: directory.nextPage, message: "目录页数超过安全上限", now: this.now() });
        continue;
      }
      try {
        const page = await this.reader.listPage({
          directoryId: directory.directoryId,
          directoryPath: directory.path,
          page: directory.nextPage,
          pageSize: this.pageSize,
          ...(directory.nextCursor !== undefined ? { cursor: directory.nextCursor } : {}),
        });
        validatePage(directory, page);
        const children = page.items.filter((fact) => fact.isDirectory).map((fact) => ({
          directoryId: fact.fileId,
          parentDirectoryId: directory.directoryId,
          path: fact.path,
          nextPage: 0,
          status: "pending" as const,
        }));
        await this.store.commitPage({
          scope,
          taskId,
          leaseId,
          directory,
          facts: page.items,
          childDirectories: children,
          nextPage: page.nextPage,
          nextCursor: page.nextCursor ?? null,
          now: this.now(),
        });
      } catch (error) {
        const currentTask = await this.requireTask(scope, taskId);
        if (currentTask.status !== "running") return;
        const message = safeError(error);
        await this.store.failPage({ scope, taskId, leaseId, directoryId: directory.directoryId, page: directory.nextPage, message, now: this.now() });
      }
    }
  }
}

export function createGuangYaDirectoryReader(client: Pick<GuangYaClient, "listFilesPage">, options: { maxPages?: number } = {}): DirectoryReader {
  const maxPages = boundedInteger(options.maxPages ?? DEFAULT_MAX_PAGES, 1, 100_000, "maxPages");
  return {
    async listPage({ directoryId, directoryPath, page, pageSize }) {
      if (page >= maxPages) throw new Error("GUANGYA_SCAN_PAGE_LIMIT: 目录分页超过上限");
      const result = await client.listFilesPage(directoryId, page, pageSize);
      return {
        items: result.items.map((item) => factFromGuangYa(item, directoryPath)),
        nextPage: result.hasMore ? page + 1 : null,
      };
    },
  };
}

function factFromGuangYa(item: GuangYaItem, parentPath: string): ScanFileFact {
  return {
    fileId: item.fileId,
    parentDirectoryId: item.parentId,
    name: item.fileName,
    isDirectory: item.resType === 2,
    sizeBytes: Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : null,
    path: parentPath ? `${parentPath.replace(/\\/g, "/")}/${item.fileName}` : item.fileName,
    modifiedAt: null,
  };
}

function validatePage(directory: ScanDirectoryCheckpoint, page: DirectoryPage): void {
  if (page.nextPage !== null && (!Number.isSafeInteger(page.nextPage) || page.nextPage <= directory.nextPage)) {
    throw new Error("扫描分页游标无效或未前进");
  }
  if (page.nextCursor !== undefined) {
    if (!page.nextCursor.trim()) throw new Error("扫描分页游标为空");
    if (page.nextCursor === directory.nextCursor) throw new Error("扫描分页游标未前进");
  }
  if (page.nextPage === null && page.nextCursor !== undefined) {
    throw new Error("扫描分页已完成但仍返回了下一游标");
  }
  for (const fact of page.items) {
    if (!fact.fileId || fact.parentDirectoryId !== directory.directoryId || !fact.name || !fact.path || fact.fileId === directory.directoryId) {
      throw new Error("网盘目录页包含无效或与父目录不匹配的文件事实");
    }
    if (fact.sizeBytes !== null && (!Number.isSafeInteger(fact.sizeBytes) || fact.sizeBytes < 0)) throw new Error("文件大小不是有效非负整数");
  }
}

function dedupeRoots(roots: readonly ScanRoot[]): ScanRoot[] {
  const seen = new Set<string>();
  return roots.filter((root) => {
    if (!root.directoryId.trim() || !root.name.trim()) throw new ScanScopeError("来源目录信息不完整");
    if (seen.has(root.directoryId)) return false;
    seen.add(root.directoryId);
    return true;
  });
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
}
function pathDepth(path: string): number { return path.split(/[\\/]/).filter(Boolean).length; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0, 1000) : "扫描失败：未知错误"; }
function scopeKey(scope: ScanScope, taskId: string): string { return `${scope.accountId}\0${scope.connectedStorageId}\0${taskId}`; }

export function createPostgresScanner(pool: Pool, client: Pick<GuangYaClient, "listFilesPage">, options: Omit<ScannerOptions, "store" | "reader"> = {}): LibraryScanner {
  return new LibraryScanner({ ...options, store: new PostgresScanStore(pool), reader: createGuangYaDirectoryReader(client) });
}
