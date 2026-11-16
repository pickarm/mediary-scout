import type { OrganizationScope, OrganizationTaskStatus } from "./organizer.js";

export type AutoOrganizationTaskStatus = "idle" | "planning" | "requested" | "paused" | "failed" | "completed";
export type AutoOrganizationItemStatus = "planning" | "requested" | "completed" | "paused" | "failed" | "cancelled";

export interface AutoOrganizationCheckpoint {
  scope: OrganizationScope;
  taskId: string;
  configId: string;
  status: AutoOrganizationTaskStatus;
  batchId: string | null;
  operationKey: string | null;
  fileIds: string[];
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  lastCheckedAt: string | null;
}

export interface AutoOrganizationCandidate {
  scope: OrganizationScope;
  taskId: string;
  configId: string;
  checkpoint: AutoOrganizationCheckpoint | null;
}

export interface AutoOrganizationBatch {
  batchId: string;
  fileIds: string[];
}

export interface AutoOrganizationPlanState {
  status: OrganizationTaskStatus;
  executeRequested: boolean;
}

/** F08c is the only execution authority. The scheduler never talks to a storage provider. */
export interface AutoOrganizationExecutionPort {
  preview(scope: OrganizationScope, taskId: string, fileIds: readonly string[], now: string): Promise<{ operationKey: string }>;
  getPlan(scope: OrganizationScope, taskId: string, operationKey: string): Promise<AutoOrganizationPlanState | null>;
  requestExecution(scope: OrganizationScope, taskId: string, operationKey: string, now: string, authorization: { batchId: string; leaseId: string }): Promise<boolean>;
}

export interface AutoOrganizationStore {
  ensureSchema(): Promise<void>;
  /** Cancel persisted but unrequested batches once their config/connection/task is no longer eligible. */
  cancelUnrequested(now: string, limit?: number): Promise<number>;
  listRunnableTasks(input: { now: string; limit: number }): Promise<AutoOrganizationCandidate[]>;
  /** Planning rows whose operationKey may already exist must be reconciled even when autoOrganize is now off. */
  listPlanningRecoveryTasks(input: { now: string; limit: number }): Promise<AutoOrganizationCandidate[]>;
  beginTask(input: { candidate: AutoOrganizationCandidate; leaseId: string; now: string; leaseExpiresAt: string; requireEligible: boolean }): Promise<AutoOrganizationCheckpoint | null>;
  releaseTask(scope: OrganizationScope, taskId: string, leaseId: string, now: string): Promise<void>;
  getCheckpoint(scope: OrganizationScope, taskId: string): Promise<AutoOrganizationCheckpoint | null>;
  isAuthorized(scope: OrganizationScope, taskId: string, configId: string): Promise<boolean>;
  claimBatch(input: { scope: OrganizationScope; taskId: string; configId: string; batchId: string; now: string; limit: number; leaseId: string }): Promise<AutoOrganizationBatch | null>;
  markPlanning(input: { scope: OrganizationScope; taskId: string; batchId: string; operationKey: string; now: string; leaseId: string }): Promise<boolean>;
  markRequested(input: { scope: OrganizationScope; taskId: string; batchId: string; operationKey: string; now: string; nextAttemptAt: string; leaseId: string }): Promise<boolean>;
  completeBatch(input: { scope: OrganizationScope; taskId: string; batchId: string; now: string; leaseId: string }): Promise<boolean>;
  cancelBatch(input: { scope: OrganizationScope; taskId: string; batchId: string; reason: string; now: string; leaseId: string }): Promise<boolean>;
  markBatchTerminal(input: { scope: OrganizationScope; taskId: string; batchId: string; status: "paused" | "failed"; error: string; now: string; leaseId: string }): Promise<boolean>;
  completeTask(input: { scope: OrganizationScope; taskId: string; now: string; nextCheckAt: string; leaseId: string }): Promise<boolean>;
  deferTask(input: { scope: OrganizationScope; taskId: string; now: string; nextAttemptAt: string; leaseId: string }): Promise<boolean>;
  recordFailure(input: { scope: OrganizationScope; taskId: string; batchId: string | null; error: string; now: string; leaseId: string; maxAttempts: number; retryDelayMs: number }): Promise<"retry" | "failed">;
}

export interface AutoOrganizationSchedulerOptions {
  store: AutoOrganizationStore;
  execution: AutoOrganizationExecutionPort;
  now?: () => Date;
  idFactory?: () => string;
  batchSize?: number;
  leaseMs?: number;
  maxTasksPerTick?: number;
  maxRecoveryPerTick?: number;
  planPollDelayMs?: number;
  completedRecheckDelayMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
}

export interface AutoOrganizationTickResult {
  processed: number;
  recovered: number;
  cancelled: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_MAX_TASKS = 4;
const DEFAULT_MAX_RECOVERY = 2;
const DEFAULT_PLAN_POLL_MS = 10_000;
const DEFAULT_COMPLETED_RECHECK_MS = 60_000;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Bounded, fair auto-organization dispatcher.
 *
 * It never selects identities by itself, never confirms ambiguous files, and never writes to a
 * storage provider. Every batch is previewed and requested through F08c; the persisted checkpoint
 * separates "plan generated" from "execution requested" so a crash in between can be recovered
 * with the exact F08c operationKey.
 */
export class LibraryAutoOrganizationScheduler {
  private readonly store: AutoOrganizationStore;
  private readonly execution: AutoOrganizationExecutionPort;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly maxTasksPerTick: number;
  private readonly maxRecoveryPerTick: number;
  private readonly planPollDelayMs: number;
  private readonly completedRecheckDelayMs: number;
  private readonly retryDelayMs: number;
  private readonly maxAttempts: number;

  constructor(options: AutoOrganizationSchedulerOptions) {
    this.store = options.store;
    this.execution = options.execution;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.batchSize = bounded(options.batchSize ?? DEFAULT_BATCH_SIZE, 1, 100, "batchSize");
    this.leaseMs = bounded(options.leaseMs ?? DEFAULT_LEASE_MS, 10_000, 1_800_000, "leaseMs");
    this.maxTasksPerTick = bounded(options.maxTasksPerTick ?? DEFAULT_MAX_TASKS, 1, 50, "maxTasksPerTick");
    this.maxRecoveryPerTick = bounded(options.maxRecoveryPerTick ?? DEFAULT_MAX_RECOVERY, 0, 50, "maxRecoveryPerTick");
    this.planPollDelayMs = bounded(options.planPollDelayMs ?? DEFAULT_PLAN_POLL_MS, 1_000, 3_600_000, "planPollDelayMs");
    this.completedRecheckDelayMs = bounded(options.completedRecheckDelayMs ?? DEFAULT_COMPLETED_RECHECK_MS, 1_000, 86_400_000, "completedRecheckDelayMs");
    this.retryDelayMs = bounded(options.retryDelayMs ?? DEFAULT_RETRY_MS, 1_000, 3_600_000, "retryDelayMs");
    this.maxAttempts = bounded(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, 20, "maxAttempts");
  }

  async tick(): Promise<AutoOrganizationTickResult> {
    await this.store.ensureSchema();
    const now = this.now().toISOString();
    const cancelled = await this.store.cancelUnrequested(now, 50);
    const seen = new Set<string>();
    let processed = 0;
    let recovered = 0;

    const recovery = this.maxRecoveryPerTick === 0 ? [] : await this.store.listPlanningRecoveryTasks({ now, limit: this.maxRecoveryPerTick });
    for (const candidate of recovery) {
      const key = taskKey(candidate.scope, candidate.taskId);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await this.runCandidate(candidate, false)) recovered += 1;
    }

    const runnable = await this.store.listRunnableTasks({ now, limit: this.maxTasksPerTick });
    for (const candidate of runnable) {
      const key = taskKey(candidate.scope, candidate.taskId);
      if (seen.has(key)) continue;
      seen.add(key);
      if (await this.runCandidate(candidate, true)) processed += 1;
    }
    return { processed, recovered, cancelled };
  }

  private async runCandidate(candidate: AutoOrganizationCandidate, requireEligible: boolean): Promise<boolean> {
    const now = this.now();
    const nowIso = now.toISOString();
    const leaseId = this.idFactory();
    const checkpoint = await this.store.beginTask({
      candidate, leaseId, now: nowIso,
      leaseExpiresAt: new Date(now.getTime() + this.leaseMs).toISOString(),
      requireEligible,
    });
    if (!checkpoint) return false;
    try {
      return await this.processCheckpoint(checkpoint, leaseId, nowIso);
    } catch (error) {
      const current = await this.store.getCheckpoint(checkpoint.scope, checkpoint.taskId).catch(() => null);
      if (current) {
        await this.store.recordFailure({
          scope: current.scope, taskId: current.taskId, batchId: current.batchId,
          error: error instanceof Error ? error.message.slice(0, 1000) : "自动整理调度异常",
          now: nowIso, leaseId, maxAttempts: this.maxAttempts, retryDelayMs: this.retryDelayMs,
        }).catch(() => undefined);
      }
      return false;
    } finally {
      await this.store.releaseTask(checkpoint.scope, checkpoint.taskId, leaseId, nowIso);
    }
  }

  private async processCheckpoint(checkpoint: AutoOrganizationCheckpoint, leaseId: string, now: string): Promise<boolean> {
    if (checkpoint.status === "paused" || checkpoint.status === "failed") return false;

    if (checkpoint.status === "requested") {
      if (!checkpoint.operationKey || !checkpoint.batchId) {
        await this.failOrRetry(checkpoint, leaseId, now, "自动整理批次缺少清单键", checkpoint.batchId);
        return true;
      }
      const plan = await this.execution.getPlan(checkpoint.scope, checkpoint.taskId, checkpoint.operationKey);
      if (!plan) {
        await this.failOrRetry(checkpoint, leaseId, now, "整理清单不存在，自动执行未恢复", checkpoint.batchId);
        return true;
      }
      if (plan.status === "completed") {
        await this.store.completeBatch({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, now, leaseId });
        return true;
      }
      if (plan.status === "paused" && plan.executeRequested) {
        // F08c's bounded 20-operation slice intentionally yields as paused with execute_requested
        // still true. Leave the durable intent in place so the next worker slice continues it.
        await this.store.deferTask({ scope: checkpoint.scope, taskId: checkpoint.taskId, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
        return false;
      }
      if (plan.status === "paused" || plan.status === "failed") {
        await this.store.markBatchTerminal({
          scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId,
          status: plan.status, error: plan.status === "paused" ? "整理清单已人工暂停，自动调度不恢复" : "整理清单失败，自动调度不无限重试",
          now, leaseId,
        });
        return true;
      }
      await this.store.deferTask({ scope: checkpoint.scope, taskId: checkpoint.taskId, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
      return false;
    }

    if (checkpoint.status === "planning") {
      if (!checkpoint.batchId || checkpoint.fileIds.length === 0) {
        await this.store.cancelBatch({
          scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId ?? "",
          reason: "自动整理批次缺少文件或批次键，已取消", now, leaseId,
        });
        return true;
      }
      let operationKey = checkpoint.operationKey;
      if (!operationKey) {
        if (!(await this.store.isAuthorized(checkpoint.scope, checkpoint.taskId, checkpoint.configId))) {
          await this.store.cancelBatch({
            scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId,
            reason: "自动整理已关闭或任务不可用，未请求批次已取消", now, leaseId,
          });
          return true;
        }
        // Preview is deterministic in F08c; replaying the same persisted file IDs recreates the
        // same operationKey rather than inventing a new plan.
        const preview = await this.execution.preview(checkpoint.scope, checkpoint.taskId, checkpoint.fileIds, now);
        operationKey = preview.operationKey;
        if (!(await this.store.markPlanning({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, operationKey, now, leaseId }))) {
          return true;
        }
      }

      const plan = await this.execution.getPlan(checkpoint.scope, checkpoint.taskId, operationKey);
      if (plan) {
        if (plan.status === "completed") {
          await this.store.completeBatch({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, now, leaseId });
          return true;
        }
        if (plan.status === "paused" && plan.executeRequested) {
          await this.store.markRequested({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, operationKey, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
          return true;
        }
        if (plan.status === "paused" || plan.status === "failed") {
          await this.store.markBatchTerminal({
            scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId,
            status: plan.status, error: plan.status === "paused" ? "整理清单已人工暂停，自动调度不恢复" : "整理清单失败，自动调度不无限重试",
            now, leaseId,
          });
          return true;
        }
        if (plan.executeRequested) {
          await this.store.markRequested({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, operationKey, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
          return true;
        }
      }

      // The configuration/connection/scan/lease recheck and the execute-intent update are one
      // transaction inside F08c's requestExecution; there is no separate TOCTOU window here.
      const requested = await this.execution.requestExecution(checkpoint.scope, checkpoint.taskId, operationKey, now, { batchId: checkpoint.batchId, leaseId });
      if (!requested) {
        if (!(await this.store.isAuthorized(checkpoint.scope, checkpoint.taskId, checkpoint.configId))) {
          await this.store.cancelBatch({
            scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId,
            reason: "自动整理已关闭或任务不可用，未请求批次已取消", now, leaseId,
          });
        } else {
          await this.failOrRetry(checkpoint, leaseId, now, "登记整理执行意图失败", checkpoint.batchId);
        }
        return true;
      }
      await this.store.markRequested({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: checkpoint.batchId, operationKey, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
      return true;
    }

    // idle / completed: choose a new bounded batch. The candidate query is based on currently
    // confirmed+imported facts, not a high-water file cursor, so later confirmations are visible.
    if (!(await this.store.isAuthorized(checkpoint.scope, checkpoint.taskId, checkpoint.configId))) return false;
    const batchId = this.idFactory();
    const batch = await this.store.claimBatch({
      scope: checkpoint.scope, taskId: checkpoint.taskId, configId: checkpoint.configId,
      batchId, now, limit: this.batchSize, leaseId,
    });
    if (!batch) {
      await this.store.completeTask({
        scope: checkpoint.scope, taskId: checkpoint.taskId, now, leaseId,
        nextCheckAt: plusMs(now, this.completedRecheckDelayMs),
      });
      return false;
    }
    if (!(await this.store.isAuthorized(checkpoint.scope, checkpoint.taskId, checkpoint.configId))) {
      await this.store.cancelBatch({
        scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: batch.batchId,
        reason: "自动整理已关闭或任务不可用，未请求批次已取消", now, leaseId,
      });
      return true;
    }
    const preview = await this.execution.preview(checkpoint.scope, checkpoint.taskId, batch.fileIds, now);
    if (!(await this.store.markPlanning({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: batch.batchId, operationKey: preview.operationKey, now, leaseId }))) return true;
    if (!(await this.execution.requestExecution(checkpoint.scope, checkpoint.taskId, preview.operationKey, now, { batchId: batch.batchId, leaseId }))) {
      if (!(await this.store.isAuthorized(checkpoint.scope, checkpoint.taskId, checkpoint.configId))) {
        await this.store.cancelBatch({
          scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: batch.batchId,
          reason: "自动整理已关闭或任务不可用，未请求批次已取消", now, leaseId,
        });
      } else {
        await this.failOrRetry(checkpoint, leaseId, now, "登记整理执行意图失败", batch.batchId);
      }
      return true;
    }
    await this.store.markRequested({ scope: checkpoint.scope, taskId: checkpoint.taskId, batchId: batch.batchId, operationKey: preview.operationKey, now, leaseId, nextAttemptAt: plusMs(now, this.planPollDelayMs) });
    return true;
  }

  private async failOrRetry(checkpoint: AutoOrganizationCheckpoint, leaseId: string, now: string, error: string, batchId: string | null): Promise<void> {
    await this.store.recordFailure({
      scope: checkpoint.scope, taskId: checkpoint.taskId, batchId, error, now, leaseId,
      maxAttempts: this.maxAttempts, retryDelayMs: this.retryDelayMs,
    });
  }
}

function plusMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
function taskKey(scope: OrganizationScope, taskId: string): string {
  return `${scope.accountId}\0${scope.connectedStorageId}\0${taskId}`;
}
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${name} must be between ${min} and ${max}`);
  return value;
}
