/** Process-local, account-scoped pacing for GuangYa HTTP requests. */

export type GuangYaRequestPriority = "write" | "read" | "scan-read";

export type GuangYaSchedulerClock = () => number;
export type GuangYaSchedulerSleep = (milliseconds: number) => Promise<void>;

export interface GuangYaRequestScheduler {
  /** Schedule exactly one HTTP fetch. The callback starts only after the queue grants a slot. */
  schedule<T>(operation: () => Promise<T>, priority?: GuangYaRequestPriority): Promise<T>;
  /** Apply a shared cooldown after a provider response that signals frequent operations. */
  cooldown(milliseconds: number): void;
}

export interface GuangYaRequestSchedulerOptions {
  /** Stable provider UID or connected-storage identity. Never pass a credential/token. */
  accountKey: string;
  minIntervalMs?: number;
  clock?: GuangYaSchedulerClock;
  sleep?: GuangYaSchedulerSleep;
}

const DEFAULT_MIN_INTERVAL_MS = 500;
const MAX_MIN_INTERVAL_MS = 60_000;
const WRITES_BEFORE_SCAN = 3;
const REGISTRY_SYMBOL = Symbol.for("media-track.guangya-request-scheduler.v1");

interface QueuedRequest<T = unknown> {
  operation: () => Promise<T>;
  priority: GuangYaRequestPriority;
  sequence: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface QueueState {
  queue: Array<QueuedRequest>;
  running: boolean;
  lastStartedAt: number | null;
  cooldownUntil: number;
  writesSinceScan: number;
  minIntervalMs: number;
  clock: GuangYaSchedulerClock;
  sleep: GuangYaSchedulerSleep;
  nextSequence: number;
}

type SchedulerRegistry = Map<string, QueueState>;

/**
 * Create (or reuse) the shared queue for an account key. Default pacing is 2
 * requests per second. Multiple client/factory instances in this process share
 * the same account queue through globalThis.
 */
export function createGuangYaRequestScheduler(
  options: GuangYaRequestSchedulerOptions,
): GuangYaRequestScheduler {
  const accountKey = options.accountKey.trim();
  if (!accountKey) throw new Error("GUANGYA_SCHEDULER_ACCOUNT_KEY_REQUIRED");
  const minIntervalMs = validateMinInterval(options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const state = getOrCreateState(accountKey, {
    minIntervalMs,
    clock: options.clock ?? Date.now,
    sleep: options.sleep ?? defaultSleep,
  });
  // If different call sites configure the same account, keep the safer interval.
  state.minIntervalMs = Math.max(state.minIntervalMs, minIntervalMs);

  return {
    schedule<T>(operation: () => Promise<T>, priority: GuangYaRequestPriority = "write"): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        state.queue.push({ operation, priority, sequence: state.nextSequence++, resolve, reject } as QueuedRequest);
        void drainQueue(state);
      });
    },
    cooldown(milliseconds: number): void {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) return;
      state.cooldownUntil = Math.max(state.cooldownUntil, state.clock() + Math.min(milliseconds, MAX_MIN_INTERVAL_MS * 10));
    },
  };
}

/** Parse and validate the production pacing environment setting (default 500 ms). */
export function getGuangYaMinIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.MEDIA_TRACK_GUANGYA_MIN_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MIN_INTERVAL_MS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new RangeError("MEDIA_TRACK_GUANGYA_MIN_INTERVAL_MS must be an integer from 0 to 60000");
  }
  return validateMinInterval(Number(raw.trim()));
}

/** Return a non-negative cooldown indicated by a Retry-After header, if present. */
export function parseGuangYaRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (value === null || value.trim() === "") return null;
  const trimmed = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, Math.min(seconds * 1000, MAX_MIN_INTERVAL_MS * 10)) : null;
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp)
    ? Math.max(0, Math.min(timestamp - nowMs, MAX_MIN_INTERVAL_MS * 10))
    : null;
}

async function drainQueue(state: QueueState): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    while (state.queue.length > 0) {
      const request = takeNext(state);
      const now = state.clock();
      const intervalReadyAt = state.lastStartedAt === null ? now : state.lastStartedAt + state.minIntervalMs;
      const readyAt = Math.max(intervalReadyAt, state.cooldownUntil);
      try {
        if (readyAt > now) await state.sleep(readyAt - now);
        // Cooldown can be extended by another active scheduler during sleep.
        const afterSleep = state.clock();
        const remaining = Math.max(state.lastStartedAt === null ? 0 : state.lastStartedAt + state.minIntervalMs, state.cooldownUntil) - afterSleep;
        if (remaining > 0) await state.sleep(remaining);
      } catch (error) {
        request.reject(error);
        continue;
      }
      state.lastStartedAt = state.clock();
      try {
        const result = await request.operation();
        const response = responseLike(result);
        if (response?.status === 429) {
          const cooldown = parseGuangYaRetryAfter(response.headers?.get("Retry-After"), state.clock());
          state.cooldownUntil = Math.max(state.cooldownUntil, state.clock() + (cooldown ?? state.minIntervalMs));
        }
        request.resolve(result);
      } catch (error) {
        request.reject(error);
      }
    }
  } finally {
    state.running = false;
    // A request can be enqueued after the loop condition but before running flips.
    if (state.queue.length > 0) void drainQueue(state);
  }
}

function takeNext(state: QueueState): QueuedRequest {
  const lowPriority = state.queue.filter((request) => request.priority !== "write");
  const writes = state.queue.filter((request) => request.priority === "write");
  let selected: QueuedRequest | undefined;
  if (lowPriority.length > 0 && (writes.length === 0 || state.writesSinceScan >= WRITES_BEFORE_SCAN)) {
    selected = lowPriority[0];
    state.writesSinceScan = 0;
  } else {
    selected = writes[0] ?? lowPriority[0];
    if (selected?.priority === "write") state.writesSinceScan += 1;
    else if (selected?.priority === "scan-read") state.writesSinceScan = 0;
  }
  if (!selected) throw new Error("GUANGYA_SCHEDULER_QUEUE_EMPTY");
  const index = state.queue.indexOf(selected);
  state.queue.splice(index, 1);
  return selected;
}

function getOrCreateState(
  accountKey: string,
  defaults: Pick<QueueState, "minIntervalMs" | "clock" | "sleep">,
): QueueState {
  const root = globalThis as typeof globalThis & { [REGISTRY_SYMBOL]?: SchedulerRegistry };
  const registry = root[REGISTRY_SYMBOL] ?? (root[REGISTRY_SYMBOL] = new Map());
  let state = registry.get(accountKey);
  if (!state) {
    state = {
      queue: [],
      running: false,
      lastStartedAt: null,
      cooldownUntil: 0,
      writesSinceScan: 0,
      nextSequence: 0,
      ...defaults,
    };
    registry.set(accountKey, state);
  }
  return state;
}

function validateMinInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MIN_INTERVAL_MS) {
    throw new RangeError("GuangYa minIntervalMs must be an integer from 0 to 60000");
  }
  return value;
}

function responseLike(value: unknown): { status: number; headers: { get(name: string): string | null } } | null {
  if (typeof value !== "object" || value === null || !("status" in value)) return null;
  const candidate = value as { status?: unknown; headers?: unknown };
  if (typeof candidate.status !== "number") return null;
  const headers = candidate.headers as { get?: (name: string) => string | null } | undefined;
  return { status: candidate.status, headers: { get: (name) => headers?.get?.(name) ?? null } };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
