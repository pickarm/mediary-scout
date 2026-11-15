import { afterEach, describe, expect, it, vi } from "vitest";
import type { PostgresActivityPage } from "@media-track/workflow/activity-query";
import { createLibraryProgressStream, type ProgressStreamClock } from "./library-progress-stream";

const page = (active: number): PostgresActivityPage => ({
  active: { items: [], total: active, page: 1, pageSize: 48, hasMore: false },
  totals: { queued: active, running: 0, active },
  recentCompleted: { items: [], nextCursor: null, hasMore: false },
});

function setup(options: Partial<Parameters<typeof createLibraryProgressStream>[0]> = {}) {
  let wake: (() => void) | null = null;
  const stop = vi.fn();
  const loadPage = options.loadPage ?? vi.fn<() => Promise<PostgresActivityPage>>().mockResolvedValue(page(2));
  const abort = new AbortController();
  const clock: ProgressStreamClock = {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const response = createLibraryProgressStream({
    initialPage: page(1), signal: abort.signal, loadPage,
    subscribe(listener) { wake = listener; return stop; },
    clock, ...options,
  });
  return { response, abort, clock, loadPage, stop, wake: () => wake?.() };
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const item = await reader.read();
  expect(item.done).toBe(false);
  return new TextDecoder().decode(item.value);
}

afterEach(() => vi.useRealTimers());

describe("library progress SSE", () => {
  it("sends a fresh initial snapshot on each connection and ignores event replay state", async () => {
    vi.useFakeTimers();
    const one = setup();
    const two = setup();
    expect(one.response.headers.get("content-type")).toContain("text/event-stream");
    expect(one.response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(one.response.headers.get("x-accel-buffering")).toBe("no");
    const first = await readText(one.response.body!.getReader());
    const second = await readText(two.response.body!.getReader());
    expect(first).toContain('"version":1');
    expect(first).toContain('"active":1');
    expect(second).toContain('"active":1');
    one.abort.abort(); two.abort.abort();
    expect(one.stop).toHaveBeenCalledOnce();
    expect(two.stop).toHaveBeenCalledOnce();
  });

  it("coalesces wake bursts, enforces the minimum interval, and never overlaps reads", async () => {
    vi.useFakeTimers();
    const pending: { resolve?: (value: PostgresActivityPage) => void } = {};
    const stream = setup({ loadPage: vi.fn(() => new Promise<PostgresActivityPage>((resolve) => { pending.resolve = resolve; })) });
    const reader = stream.response.body!.getReader();
    await readText(reader);
    stream.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stream.loadPage).toHaveBeenCalledOnce();
    stream.wake(); stream.wake(); stream.wake();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stream.loadPage).toHaveBeenCalledOnce();
    pending.resolve?.(page(7));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stream.loadPage).toHaveBeenCalledTimes(2);
    stream.abort.abort();
  });

  it("uses periodic PostgreSQL-backed snapshots when no cache wakeups arrive", async () => {
    vi.useFakeTimers();
    const stream = setup();
    await readText(stream.response.body!.getReader());
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.loadPage).toHaveBeenCalledOnce();
    stream.abort.abort();
  });

  it("bounds slow-consumer buffering to one queued and one latest unpublished snapshot", async () => {
    vi.useFakeTimers();
    let value = 2;
    const stream = setup({ loadPage: vi.fn(async () => page(value++)) });
    const reader = stream.response.body!.getReader();
    await readText(reader);
    stream.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    stream.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    stream.wake();
    await vi.advanceTimersByTimeAsync(1_000);
    const queued = await readText(reader);
    const latest = await readText(reader);
    expect(queued).toContain('"active":2');
    expect(latest).toContain('"active":4');
    stream.wake();
    await vi.advanceTimersByTimeAsync(1_001);
    const newer = await readText(reader);
    expect(newer).toContain('"active":5');
    const observedAt = [queued, latest, newer].map((frame) => {
      const data = frame.match(/data: (.+)\n/u)?.[1];
      return Date.parse((JSON.parse(data ?? "{}") as { observedAt?: string }).observedAt ?? "");
    });
    expect(observedAt[0]).toBeLessThanOrEqual(observedAt[1]!);
    expect(observedAt[1]).toBeLessThanOrEqual(observedAt[2]!);
    stream.abort.abort();
  });

  it("cleans up exactly once on abort, reader cancellation and maximum lifetime", async () => {
    vi.useFakeTimers();
    const aborted = setup();
    aborted.abort.abort(); aborted.abort.abort();
    expect(aborted.stop).toHaveBeenCalledOnce();

    const canceled = setup();
    const reader = canceled.response.body!.getReader();
    await readText(reader);
    await reader.cancel();
    expect(canceled.stop).toHaveBeenCalledOnce();

    const expired = setup({ maximumLifetimeMs: 2_000 });
    const expiredReader = expired.response.body!.getReader();
    await readText(expiredReader);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(expired.stop).toHaveBeenCalledOnce();
    expect((await expiredReader.read()).done).toBe(true);
  });

  it("ignores late query completion after cancellation and closes on midstream failure", async () => {
    vi.useFakeTimers();
    const pending: { resolve?: (value: PostgresActivityPage) => void } = {};
    const late = setup({ loadPage: vi.fn(() => new Promise<PostgresActivityPage>((resolve) => { pending.resolve = resolve; })) });
    const reader = late.response.body!.getReader();
    await readText(reader);
    late.wake(); await vi.advanceTimersByTimeAsync(1_000);
    await reader.cancel();
    pending.resolve?.(page(99));
    await vi.advanceTimersByTimeAsync(0);
    expect(late.stop).toHaveBeenCalledOnce();

    const failed = setup({ loadPage: vi.fn().mockRejectedValue(new Error("secret raw database details")) });
    const failedReader = failed.response.body!.getReader();
    await readText(failedReader);
    failed.wake(); await vi.advanceTimersByTimeAsync(1_000);
    expect((await failedReader.read()).done).toBe(true);
    expect(failed.stop).toHaveBeenCalledOnce();
  });
});
