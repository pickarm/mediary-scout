import type { PostgresActivityPage } from "@media-track/workflow/activity-query";

export interface ProgressStreamClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export interface LibraryProgressStreamOptions {
  initialPage: PostgresActivityPage;
  signal: AbortSignal;
  loadPage(): Promise<PostgresActivityPage>;
  subscribe(listener: () => void): () => void;
  clock?: ProgressStreamClock;
  snapshotIntervalMs?: number;
  heartbeatIntervalMs?: number;
  minimumReadIntervalMs?: number;
  maximumLifetimeMs?: number;
}

const systemClock: ProgressStreamClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value!))) : fallback;
}

function snapshotFrame(page: PostgresActivityPage, now: number): string {
  return `event: snapshot\ndata: ${JSON.stringify({ version: 1, observedAt: new Date(now).toISOString(), page })}\n\n`;
}

/** Build a bounded SSE response. Query/auth failures before this call remain normal HTTP errors. */
export function createLibraryProgressStream(options: LibraryProgressStreamOptions): Response {
  const clock = options.clock ?? systemClock;
  const snapshotIntervalMs = bounded(options.snapshotIntervalMs, 5_000, 1_000, 30_000);
  const heartbeatIntervalMs = bounded(options.heartbeatIntervalMs, 15_000, 1_000, 60_000);
  const minimumReadIntervalMs = bounded(options.minimumReadIntervalMs, 1_000, 1_000, 10_000);
  const maximumLifetimeMs = bounded(options.maximumLifetimeMs, 5 * 60_000, 1_000, 5 * 60_000);

  let unsubscribe: (() => void) | null = null;
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let inFlight = false;
  let refreshPending = false;
  let lastReadAt = clock.now();
  let latestUnpublishedSnapshot: string | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const encoder = new TextEncoder();

  const clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    clock.clearTimeout(timer);
    timers.delete(timer);
  };
  const schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const timer = clock.setTimeout(() => {
      timers.delete(timer);
      if (!closed) callback();
    }, Math.max(0, delayMs));
    timers.add(timer);
    return timer;
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clock.clearTimeout(timer);
    timers.clear();
    options.signal.removeEventListener("abort", abort);
    const stop = unsubscribe;
    unsubscribe = null;
    if (stop) stop();
    latestUnpublishedSnapshot = null;
    const activeController = controller;
    controller = null;
    if (activeController) {
      try { activeController.close(); } catch { /* already canceled */ }
    }
  };
  const abort = (): void => cleanup();
  const publish = (frame: string, keepLatestSnapshot = false): void => {
    if (closed || !controller) return;
    if ((controller.desiredSize ?? 0) > 0) {
      // A newly publishable snapshot supersedes any older unpublished snapshot.
      if (keepLatestSnapshot) latestUnpublishedSnapshot = null;
      try { controller.enqueue(encoder.encode(frame)); }
      catch { cleanup(); }
      return;
    }
    if (keepLatestSnapshot) latestUnpublishedSnapshot = frame;
  };
  const flushLatest = (): void => {
    if (closed || !controller || !latestUnpublishedSnapshot || (controller.desiredSize ?? 0) <= 0) return;
    const frame = latestUnpublishedSnapshot;
    latestUnpublishedSnapshot = null;
    publish(frame, true);
  };

  const pumpRefresh = (): void => {
    if (closed || inFlight || !refreshPending) return;
    refreshPending = false;
    inFlight = true;
    lastReadAt = clock.now();
    void options.loadPage().then((page) => {
      if (!closed) publish(snapshotFrame(page, clock.now()), true);
    }).catch(() => {
      // Do not send raw database/cache errors through the stream. F13 will reconnect/fallback.
      cleanup();
    }).finally(() => {
      inFlight = false;
      if (!closed && refreshPending) requestRefresh();
    });
  };
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const requestRefresh = (): void => {
    if (closed) return;
    refreshPending = true;
    if (inFlight) return;
    const wait = Math.max(0, lastReadAt + minimumReadIntervalMs - clock.now());
    if (refreshTimer !== null) clearTimer(refreshTimer);
    refreshTimer = schedule(() => {
      refreshTimer = null;
      pumpRefresh();
    }, wait);
  };
  const schedulePeriodic = (): void => {
    schedule(() => {
      requestRefresh();
      schedulePeriodic();
    }, snapshotIntervalMs);
  };
  const scheduleHeartbeat = (): void => {
    schedule(() => {
      publish(`: heartbeat ${clock.now()}\n\n`);
      scheduleHeartbeat();
    }, heartbeatIntervalMs);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      if (options.signal.aborted) { cleanup(); return; }
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        unsubscribe = options.subscribe(() => requestRefresh());
        publish(snapshotFrame(options.initialPage, clock.now()), true);
        schedulePeriodic();
        scheduleHeartbeat();
        schedule(cleanup, maximumLifetimeMs);
      } catch {
        cleanup();
      }
    },
    pull() { flushLatest(); },
    cancel() { cleanup(); },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
