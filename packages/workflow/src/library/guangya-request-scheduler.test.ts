import { describe, expect, it } from "vitest";
import {
  createGuangYaRequestScheduler,
  getGuangYaMinIntervalMs,
  parseGuangYaRetryAfter,
} from "./guangya-request-scheduler.js";

function fakeTime() {
  let now = 10_000;
  const sleeps: number[] = [];
  return {
    clock: () => now,
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => { now += ms; },
  };
}

describe("GuangYa request scheduler", () => {
  it("shares a serial queue between clients with the same account and separates accounts", async () => {
    const time = fakeTime();
    const first = createGuangYaRequestScheduler({ accountKey: "share-a", minIntervalMs: 500, ...time });
    const second = createGuangYaRequestScheduler({ accountKey: "share-a", minIntervalMs: 500, ...time });
    const other = createGuangYaRequestScheduler({ accountKey: "share-b", minIntervalMs: 500, ...time });
    const starts: Array<[string, number]> = [];
    await Promise.all([
      first.schedule(async () => { starts.push(["one", time.clock()]); }),
      second.schedule(async () => { starts.push(["two", time.clock()]); }),
      other.schedule(async () => { starts.push(["other", time.clock()]); }),
    ]);
    expect(starts.map(([name]) => name)).toContain("other");
    const sharedStarts = starts.filter(([name]) => name !== "other").map(([, at]) => at);
    expect(Math.abs(sharedStarts[0]! - sharedStarts[1]!)).toBeGreaterThanOrEqual(500);
    expect(time.sleeps).toContain(500);
  });

  it("preserves FIFO per priority and lets a waiting scan through after three writes", async () => {
    const time = fakeTime();
    const scheduler = createGuangYaRequestScheduler({ accountKey: "fairness", minIntervalMs: 0, ...time });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = scheduler.schedule(async () => { order.push("first"); await firstGate; });
    await Promise.resolve();
    const scan = scheduler.schedule(async () => { order.push("scan"); }, "scan-read");
    const writes = [0, 1, 2, 3].map((i) => scheduler.schedule(async () => { order.push(`w${i}`); }, "write"));
    releaseFirst();
    await Promise.all([first, scan, ...writes]);
    expect(order).toEqual(["first", "w0", "w1", "scan", "w2", "w3"]);
  });

  it("lets an ordinary read through within the same bounded write burst", async () => {
    const scheduler = createGuangYaRequestScheduler({ accountKey: "read-fairness", minIntervalMs: 0, ...fakeTime() });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const order: string[] = [];
    const first = scheduler.schedule(async () => { order.push("first"); await firstGate; });
    await Promise.resolve();
    const read = scheduler.schedule(async () => { order.push("read"); }, "read");
    const writes = [0, 1, 2, 3].map((i) => scheduler.schedule(async () => { order.push(`w${i}`); }, "write"));
    releaseFirst();
    await Promise.all([first, read, ...writes]);
    expect(order).toEqual(["first", "w0", "w1", "read", "w2", "w3"]);
  });

  it("applies Retry-After cooldown to subsequent shared work without retrying the response", async () => {
    const time = fakeTime();
    const scheduler = createGuangYaRequestScheduler({ accountKey: "cooldown", minIntervalMs: 10, ...time });
    let calls = 0;
    const first = scheduler.schedule(async () => {
      calls += 1;
      return { status: 429, headers: { get: (name: string) => name === "Retry-After" ? "2" : null } };
    });
    const second = scheduler.schedule(async () => { calls += 1; });
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(time.sleeps).toContain(2_000);
  });

  it("releases the queue after a rejected operation", async () => {
    const scheduler = createGuangYaRequestScheduler({ accountKey: "errors", minIntervalMs: 0, ...fakeTime() });
    const failed = scheduler.schedule(async () => { throw new Error("offline"); });
    const passed = scheduler.schedule(async () => "next");
    await expect(failed).rejects.toThrow("offline");
    await expect(passed).resolves.toBe("next");
  });

  it("rejects a request when injected sleep fails and continues draining", async () => {
    const time = fakeTime();
    let failSleep = true;
    const scheduler = createGuangYaRequestScheduler({
      accountKey: "sleep-errors",
      minIntervalMs: 100,
      clock: time.clock,
      sleep: async (ms) => {
        if (failSleep) {
          failSleep = false;
          throw new Error("sleep failed");
        }
        await time.sleep(ms);
      },
    });
    await scheduler.schedule(async () => "started");
    const rejected = scheduler.schedule(async () => "never");
    const passed = scheduler.schedule(async () => "continued");
    await expect(rejected).rejects.toThrow("sleep failed");
    await expect(passed).resolves.toBe("continued");
  });

  it("validates the environment interval and parses Retry-After values", () => {
    expect(getGuangYaMinIntervalMs({})).toBe(500);
    expect(getGuangYaMinIntervalMs({ MEDIA_TRACK_GUANGYA_MIN_INTERVAL_MS: "250" })).toBe(250);
    expect(() => getGuangYaMinIntervalMs({ MEDIA_TRACK_GUANGYA_MIN_INTERVAL_MS: "-1" })).toThrow(RangeError);
    expect(parseGuangYaRetryAfter("1.5", 0)).toBe(1_500);
    expect(parseGuangYaRetryAfter("invalid", 0)).toBeNull();
  });
});
