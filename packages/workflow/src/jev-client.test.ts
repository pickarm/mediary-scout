import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredJevConcurrency, createJevJudge } from "./jev-client.js";

const originalLimit = process.env.MEDIA_TRACK_AI_CONCURRENCY;
afterEach(() => {
  if (originalLimit === undefined) delete process.env.MEDIA_TRACK_AI_CONCURRENCY;
  else process.env.MEDIA_TRACK_AI_CONCURRENCY = originalLimit;
});

describe("Jev HTTP request gate", () => {
  it("bounds expanded chunks to two across judge instances sharing an endpoint", async () => {
    delete process.env.MEDIA_TRACK_AI_CONCURRENCY;
    expect(configuredJevConcurrency()).toBe(2);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl: typeof fetch = vi.fn(async (_url, init) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await barrier;
      active -= 1;
      const body = JSON.parse(String(init?.body)) as { state: { candidates: Record<string, string> } };
      const answers = Object.fromEntries(Object.keys(body.state.candidates).flatMap((key) => [[key, { noul: 0.8 }], [`n${key.slice(1)}`, { noul: 0.1 }]]));
      return new Response(JSON.stringify({ model: "test", answers }), { status: 200 });
    });
    const judgeA = createJevJudge({ apiKey: "one", baseUrl: "https://jev.invalid/api?key=ignored", fetchImpl });
    const judgeB = createJevJudge({ apiKey: "two", baseUrl: "https://JEV.invalid/api", fetchImpl });
    const target = { kind: "movie" as const, title: "Film", aliases: [], year: 2020 };
    const candidates = Array.from({ length: 151 }, (_, index) => ({ id: `id-${index}`, title: `Film ${index}` }));
    const pending = [judgeA, judgeB, judgeA].map((judge) => judge.judgeCandidates({ target, candidates }));
    while (active < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(maximum).toBe(2);
    release();
    await Promise.all(pending);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(maximum).toBe(2);
  });

  it("rejects invalid concurrency configuration", () => {
    process.env.MEDIA_TRACK_AI_CONCURRENCY = "0";
    expect(() => configuredJevConcurrency()).toThrow("JEV_CONCURRENCY_INVALID");
  });
});
