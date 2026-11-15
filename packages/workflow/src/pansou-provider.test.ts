import { afterEach, describe, expect, it, vi } from "vitest";
import { PanSouResourceProvider, configuredPanSouConcurrency } from "./pansou-provider.js";

const originalLimit = process.env.MEDIA_TRACK_PANSOU_CONCURRENCY;
afterEach(() => {
  if (originalLimit === undefined) delete process.env.MEDIA_TRACK_PANSOU_CONCURRENCY;
  else process.env.MEDIA_TRACK_PANSOU_CONCURRENCY = originalLimit;
});

describe("PanSou server request gate", () => {
  it("shares the bounded default across provider instances and canonical endpoint spellings", async () => {
    delete process.env.MEDIA_TRACK_PANSOU_CONCURRENCY;
    expect(configuredPanSouConcurrency()).toBe(2);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fetchJson = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await barrier;
      active -= 1;
      return { code: 0, data: { total: 0 } };
    });
    const first = new PanSouResourceProvider({ baseURL: "https://PANSOU.invalid/", fetchJson, maxSearchAttempts: 1 });
    const second = new PanSouResourceProvider({ baseURL: "https://pansou.invalid", fetchJson, maxSearchAttempts: 1 });
    const pending = [first, first, second, second].map((provider, index) => provider.search({ keyword: `film-${index}` }));
    while (active < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maximum).toBe(2);
    release();
    await Promise.all(pending);
    expect(maximum).toBe(2);
  });

  it("rejects invalid concurrency configuration", () => {
    process.env.MEDIA_TRACK_PANSOU_CONCURRENCY = "11";
    expect(() => configuredPanSouConcurrency()).toThrow("PANSOU_CONCURRENCY_INVALID");
  });
});
