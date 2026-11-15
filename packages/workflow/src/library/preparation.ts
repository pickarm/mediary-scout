import type { JevJudge, JevJudgeResult } from "../jev-judge.js";
import type { ResourceSnapshot } from "../domain.js";
import type { ResourceProvider } from "../ports.js";
import {
  PostgresPreparationStore,
  type PreparationDescriptor,
  type PreparationClaimFilter,
  type PreparationJob,
  type PreparationResult,
} from "./preparation-store.js";

export type { PreparationClaimFilter, PreparationDescriptor, PreparationJob, PreparationResult, PreparedJevResult, PreparationScope, PreparationStatus } from "./preparation-store.js";

export interface PreparationTarget {
  title: string;
  aliases: string[];
  year?: number;
  searchConfigFingerprint: string;
}
/** Read-only metadata/config refresh port. Implementations must not probe storage or create executors. */
export interface PreparationContextProvider {
  refresh(job: PreparationDescriptor): Promise<ResolvedPreparationContext>;
}
export interface ResolvedPreparationContext {
  target: PreparationTarget;
  resourceProvider: ResourceProvider;
  jev?: JevJudge;
  /** Stable, non-secret key for the endpoint/service; secrets must never be used as lane keys. */
  searchServiceKey: string;
  searchLane: "pansou" | "other";
  aiServiceKey?: string;
}
export interface PreparationServiceOptions {
  store: PostgresPreparationStore;
  context: PreparationContextProvider;
  preparationConcurrency?: number;
  panSouConcurrency?: number;
  aiConcurrency?: number;
  now?: () => Date;
  leaseMs?: number;
}

const LIMIT_REGISTRY = Symbol.for("media-track.library-preparation.limit-registry");
type Lane = "preparation" | "search" | "pansou" | "ai";
type LaneEntry = { active: number; limit: number; queue: Array<() => void> };
type GlobalRegistry = typeof globalThis & { [LIMIT_REGISTRY]?: Map<string, LaneEntry> };

/** Independent durable-job drain. It never claims workflow_runs or touches a storage executor.
 * PG leases/fencing coordinate replicas; search and AI lane ceilings are shared across module copies in this process only. Multiple app replicas each have their own lane budget. */
export class PreparationService {
  private readonly limits: Record<Lane, number>;
  private readonly now: () => Date;
  private readonly leaseMs: number;

  constructor(private readonly options: PreparationServiceOptions) {
    this.limits = {
      preparation: bounded(options.preparationConcurrency ?? 5, 1, 20),
      search: bounded(options.preparationConcurrency ?? 5, 1, 20),
      pansou: bounded(options.panSouConcurrency ?? 2, 1, 10),
      ai: bounded(options.aiConcurrency ?? 2, 1, 10),
    };
    this.now = options.now ?? (() => new Date());
    this.leaseMs = bounded(options.leaseMs ?? 30_000, 5_000, 5 * 60_000);
  }

  register(descriptor: PreparationDescriptor): Promise<boolean> { return this.options.store.register(descriptor, this.now()); }
  retry(descriptor: PreparationDescriptor): Promise<boolean> { return this.options.store.retry(descriptor, this.now()); }
  getReadyResult(descriptor: PreparationDescriptor): Promise<PreparationResult | null> { return this.options.store.getReadyResult(descriptor, this.now()); }
  cancel(accountId: string, connectedStorageId: string | null, workflowRunId: string): Promise<boolean> {
    return this.options.store.cancel({ accountId, connectedStorageId }, workflowRunId, this.now());
  }

  /** A bounded independent tick; invoke at startup and periodically. Returns jobs completed in this tick. */
  async tick(maxJobs = this.limits.preparation, scopeFilter?: PreparationClaimFilter): Promise<number> {
    const limit = bounded(maxJobs, 1, this.limits.preparation);
    const jobs: PreparationJob[] = [];
    for (let index = 0; index < limit; index += 1) {
      const job = await this.options.store.claim(this.now(), this.leaseMs, scopeFilter);
      if (!job) break;
      jobs.push(job);
    }
    const settled = await Promise.all(jobs.map((job) => withLane("preparation", this.limits.preparation, () => this.process(job))));
    return settled.filter(Boolean).length;
  }

  private async process(job: PreparationJob): Promise<boolean> {
    let stopped = false;
    const heartbeat = setInterval(() => {
      void this.options.store.heartbeat(job, this.now(), this.leaseMs).then((ok) => { if (!ok) stopped = true; }).catch(() => { stopped = true; });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    try {
      if (!(await this.options.store.isLive(job))) return false;
      const context = await this.options.context.refresh(job);
      if (stopped || !(await this.options.store.isLive(job))) return false;
      const { target } = context;
      if (!targetMatchesDescriptor(target, job)) { await this.options.store.stale(job, this.now()); return false; }
      if (!target.title.trim() || target.title.length > 300 || target.aliases.length > 20) throw new Error("PREPARATION_TARGET_INVALID");
      // This deliberately performs only the original workflow's one raw title search.
      const searchLane: Lane = context.searchLane === "pansou" ? "pansou" : "search";
      const searchKey = safeServiceKey(context.searchServiceKey);
      const snapshot = await withLane(`${searchLane}:${searchKey}`, searchLane === "pansou" ? this.limits.pansou : this.limits.search, async () => {
        if (stopped || !(await this.options.store.isLive(job))) return null;
        return context.resourceProvider.search({ keyword: target.title, workflowRunId: job.workflowRunId });
      });
      if (!snapshot) return false;
      if (stopped || !(await this.options.store.isLive(job))) return false;
      const afterSearch = await this.options.context.refresh(job);
      if (!targetMatchesDescriptor(afterSearch.target, job)) { await this.options.store.stale(job, this.now()); return false; }
      let jevResult: JevJudgeResult | undefined;
      if (context.jev && snapshot.candidates.length > 0) {
        const aiKey = safeServiceKey(context.aiServiceKey ?? "default");
        const judged = await withLane(`ai:${aiKey}`, this.limits.ai, async () => {
          if (stopped || !(await this.options.store.isLive(job))) return null;
          return context.jev!.judgeCandidates({
            target: { kind: job.mediaType === "movie" ? "movie" : "tv", title: target.title, aliases: target.aliases, ...(target.year === undefined ? {} : { year: target.year }) },
            candidates: snapshot.candidates.map(({ id, title: candidateTitle }) => ({ id, title: candidateTitle })),
          });
        });
        if (!judged) return false;
        jevResult = judged;
        if (stopped || !(await this.options.store.isLive(job))) return false;
      }
      const beforeCommit = await this.options.context.refresh(job);
      if (!targetMatchesDescriptor(beforeCommit.target, job)) { await this.options.store.stale(job, this.now()); return false; }
      const result: PreparationResult = {
        snapshots: [snapshot],
        ...(jevResult ? { jev: { target: { mediaType: job.mediaType, tmdbId: job.tmdbId, title: target.title, aliases: [...target.aliases], ...(target.year === undefined ? {} : { year: target.year }) }, result: jevResult } } : {}),
      };
      return await this.options.store.commit(job, result, this.now());
    } catch {
      if (stopped || !(await this.options.store.isLive(job).catch(() => false))) return false;
      await this.options.store.fail(job, true, this.now());
      return false;
    } finally { clearInterval(heartbeat); }
  }
}

async function withLane<T>(key: string, capacity: number, work: () => Promise<T>): Promise<T> {
  const registry = globalThis as GlobalRegistry;
  const lanes = registry[LIMIT_REGISTRY] ?? new Map<string, LaneEntry>();
  registry[LIMIT_REGISTRY] = lanes;
  const entry = lanes.get(key) ?? { active: 0, limit: capacity, queue: [] };
  // Different module instances may configure the same service differently. The
  // strictest requested ceiling wins for the lifetime of this process.
  entry.limit = Math.min(entry.limit, capacity);
  lanes.set(key, entry);
  let reserved = false;
  while (!reserved && entry.active >= entry.limit) {
    await new Promise<void>((resolve) => entry.queue.push(resolve));
    reserved = true;
  }
  if (!reserved) entry.active += 1;
  try { return await work(); }
  finally {
    entry.active -= 1;
    // Reserve a free slot before waking the oldest waiters, so new arrivals
    // cannot bypass them and overlapping configurations cannot oversubscribe.
    while (entry.queue.length > 0 && entry.active < entry.limit) {
      entry.active += 1;
      entry.queue.shift()?.();
    }
  }
}

function safeServiceKey(value: string): string {
  const key = value.trim();
  if (!key || key.length > 256) throw new Error("PREPARATION_SERVICE_KEY_INVALID");
  return key;
}

function targetMatchesDescriptor(target: PreparationTarget, job: PreparationDescriptor): boolean {
  return target.searchConfigFingerprint === job.searchConfigFingerprint
    && target.title === job.title
    && target.year === job.year
    && target.aliases.length === job.aliases.length
    && target.aliases.every((alias, index) => alias === job.aliases[index]);
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("PREPARATION_LIMIT_INVALID");
  return value;
}

/** Consumer boundary: snapshots are raw and Jev answers are advisory only. F09b must pass these through current provider registry and original filters. */
export function preparedSnapshotsForConsumer(result: PreparationResult | null): readonly ResourceSnapshot[] {
  return result?.snapshots ?? [];
}
