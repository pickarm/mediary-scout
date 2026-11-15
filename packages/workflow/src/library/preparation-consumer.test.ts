import { describe, expect, it, vi } from "vitest";
import type { JevJudge } from "../jev-judge.js";
import type { ResourceSnapshot } from "../domain.js";
import type { PreparationDescriptor, PreparationResult } from "./preparation-store.js";
import { createPreparationConsumer } from "./preparation-consumer.js";
import { JevPrefilterProvider } from "../jev-prefilter-provider.js";
import { CandidateRegistry } from "../acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../acquisition-v2/real-provider-adapter.js";
import { deadLinkKey } from "../acquisition-v2/dead-links.js";
import { resourceLinkKey } from "../acquisition-v2/resource-link.js";

const descriptor: PreparationDescriptor = {
  accountId: "acct-a", connectedStorageId: "drive-a", workflowRunId: "run-1", mediaType: "movie", tmdbId: 7,
  title: "Example", aliases: ["Example Alt"], year: 2020, searchConfigFingerprint: "fingerprint-a",
};
const snapshot: ResourceSnapshot = {
  id: "raw-1", provider: "pansou", keyword: "Example", createdAt: "2026-11-15T00:00:00.000Z", candidates: [
    { id: "c1", snapshotId: "raw-1", index: 0, title: "Example 2020 1080p", type: "guangya", source: "pansou", providerPayload: { url: "https://share.invalid/1" } },
    { id: "c2", snapshotId: "raw-1", index: 1, title: "Other 2010", type: "guangya", source: "pansou", providerPayload: { url: "https://share.invalid/2" } },
  ],
};
const ready: PreparationResult = {
  snapshots: [snapshot],
  jev: { target: { mediaType: "movie", tmdbId: 7, title: "Example", aliases: ["Example Alt"], year: 2020 }, result: { scores: { c1: 0.9, c2: 0.1 }, nsfw: { c1: 0.01, c2: 0.99 }, model: "model-x", inputTokens: 22, cost: 0.01 } },
};

describe("preparation consumer", () => {
  it("reuses only matching bare-title raw snapshot and exact Jev evidence", async () => {
    const search = vi.fn(async () => { throw new Error("search should be skipped"); });
    const actualJudge = vi.fn(async () => ({ scores: { c1: 0.7, c2: 0.4 }, model: "actual" }));
    const reader = { getReadyResult: vi.fn(async () => ready) };
    const consumer = createPreparationConsumer({ descriptor, reader, inner: { search }, judge: { judgeCandidates: actualJudge } });
    const raw = await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" });
    expect(raw).toBe(snapshot);
    const cached = await consumer.jevJudge!.judgeCandidates({ target: { kind: "movie", title: "Example", aliases: ["Example Alt"], year: 2020 }, candidates: [{ id: "c1", title: "Example 2020 1080p" }, { id: "c2", title: "Other 2010" }] });
    expect(cached.model).toBe("model-x");
    expect(cached.nsfw?.c2).toBe(0.99);
    expect(actualJudge).not.toHaveBeenCalled();
    expect(reader.getReadyResult).toHaveBeenCalledTimes(1);
  });

  it.each([
    { keyword: "Example 4K", workflowRunId: "run-1" },
    { keyword: "Example", workflowRunId: "other-run" },
  ])("falls back to live search for non-bare or different run", async (input) => {
    const search = vi.fn(async () => ({ ...snapshot, id: "live" }));
    const consumer = createPreparationConsumer({ descriptor, reader: { getReadyResult: async () => ready }, inner: { search } });
    expect((await consumer.resourceProvider.search(input)).id).toBe("live");
    expect(search).toHaveBeenCalledOnce();
  });

  it("falls back to Jev when target or any candidate evidence differs", async () => {
    const actualJudge: JevJudge["judgeCandidates"] = vi.fn(async () => ({ scores: { c1: 0.7, c2: 0.4 }, model: "live" }));
    const consumer = createPreparationConsumer({ descriptor, reader: { getReadyResult: async () => ready }, inner: { search: async () => snapshot }, judge: { judgeCandidates: actualJudge } });
    await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" });
    const targetMismatch = await consumer.jevJudge!.judgeCandidates({ target: { kind: "movie", title: "Example", aliases: [], year: 2020 }, candidates: [{ id: "c1", title: "Example 2020 1080p" }, { id: "c2", title: "Other 2010" }] });
    expect(targetMismatch.model).toBe("live");
    const candidateMismatch = await consumer.jevJudge!.judgeCandidates({ target: { kind: "movie", title: "Example", aliases: ["Example Alt"], year: 2020 }, candidates: [{ id: "c1", title: "Example 2020 1080p" }, { id: "new", title: "New candidate" }] });
    expect(candidateMismatch.model).toBe("live");
    expect(actualJudge).toHaveBeenCalledTimes(2);
  });

  it("falls back if cached Jev evidence is partial or snapshot read fails", async () => {
    const partial: PreparationResult = { ...ready, jev: { ...ready.jev!, result: { scores: { c1: 0.9 }, model: "partial", failedChunks: 1 } } };
    const liveJudge = vi.fn(async () => ({ scores: { c1: 0.8, c2: 0.5 }, model: "live" }));
    const consumer = createPreparationConsumer({ descriptor, reader: { getReadyResult: async () => partial }, inner: { search: async () => snapshot }, judge: { judgeCandidates: liveJudge } });
    await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" });
    expect((await consumer.jevJudge!.judgeCandidates({ target: { kind: "movie", title: "Example", aliases: ["Example Alt"], year: 2020 }, candidates: [{ id: "c1", title: "Example 2020 1080p" }, { id: "c2", title: "Other 2010" }] })).model).toBe("live");
    expect(liveJudge).toHaveBeenCalledOnce();
    const fallback = createPreparationConsumer({ descriptor, reader: { getReadyResult: async () => { throw new Error("db unavailable"); } }, inner: { search: async () => snapshot } });
    expect(await fallback.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" })).toBe(snapshot);
  });

  it("re-reads a ready result after a miss and revalidates it on later searches", async () => {
    let readyResult: PreparationResult | null = null;
    const reader = { getReadyResult: vi.fn(async () => readyResult) };
    const loadDescriptor = vi.fn(async () => descriptor);
    const inner = { search: vi.fn(async () => ({ ...snapshot, id: "live" })) };
    const consumer = createPreparationConsumer({ loadDescriptor, reader, inner });
    expect((await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" })).id).toBe("live");
    readyResult = ready;
    expect((await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" })).id).toBe("raw-1");
    readyResult = null; // TTL expiry or a current descriptor/config mismatch.
    expect((await consumer.resourceProvider.search({ keyword: "Example", workflowRunId: "run-1" })).id).toBe("live");
    expect(loadDescriptor).toHaveBeenCalledTimes(3);
    expect(reader.getReadyResult).toHaveBeenCalledTimes(3);
    expect(inner.search).toHaveBeenCalledTimes(2);
  });

  it("does not read the durable result for a non-bare keyword", async () => {
    const reader = { getReadyResult: vi.fn(async () => ready) };
    const loadDescriptor = vi.fn(async () => descriptor);
    const inner = { search: vi.fn(async () => ({ ...snapshot, id: "live" })) };
    const consumer = createPreparationConsumer({ loadDescriptor, reader, inner });
    expect((await consumer.resourceProvider.search({ keyword: "Example 4K", workflowRunId: "run-1" })).id).toBe("live");
    expect(reader.getReadyResult).not.toHaveBeenCalled();
    expect(loadDescriptor).toHaveBeenCalledOnce();
  });

  it("runs prepared snapshots through original Jev filtering, dead/rejected checks, registry aliases, and persistence IDs", async () => {
    const url = (shareId: string) => `https://guangyapan.com/s/${shareId}`;
    const candidates = [
      { suffix: "floor", title: "Example false match" },
      { suffix: "drop", title: "Unrelated title" },
      { suffix: "adult", title: "Unrelated adult" },
      { suffix: "titleless", title: "https://share.invalid/titleless" },
      { suffix: "dead", title: "Dead link result" },
      { suffix: "rejected", title: "Rejected link result" },
      { suffix: "keep", title: "Example 2020 WEB-DL" },
    ].map(({ suffix, title }, index) => ({
      id: `candidate-${suffix}`, snapshotId: "prepared-original-id", index, title,
      type: "guangya" as const, source: "pansou", providerPayload: { url: url(suffix) },
    }));
    const raw: ResourceSnapshot = { id: "prepared-original-id", provider: "pansou", keyword: "Example", createdAt: "2026-11-15T00:00:00.000Z", candidates };
    const result: PreparationResult = {
      snapshots: [raw],
      jev: { target: { mediaType: "movie", tmdbId: 7, title: "Example", aliases: ["Example Alt"], year: 2020 }, result: {
        scores: { "candidate-floor": 0.1, "candidate-drop": 0.1, "candidate-adult": 0.9, "candidate-titleless": 0.1, "candidate-dead": 0.9, "candidate-rejected": 0.9, "candidate-keep": 0.9 },
        nsfw: { "candidate-adult": 0.99 }, model: "cached-model",
      } },
    };
    const deadKey = deadLinkKey(url("dead"))!.key;
    const rejectedKey = resourceLinkKey(url("rejected"));
    const reader = { getReadyResult: vi.fn(async () => result) };
    const liveSearch = vi.fn(async () => { throw new Error("matching prepared bare-title search should be used"); });
    const actualJev = vi.fn(async () => { throw new Error("complete matching Jev evidence should be reused"); });
    const consumer = createPreparationConsumer({ descriptor, reader, inner: { search: liveSearch }, judge: { judgeCandidates: actualJev } });
    const prefilter = new JevPrefilterProvider({ inner: consumer.resourceProvider, target: { kind: "movie", title: "Example", aliases: ["Example Alt"], year: 2020 }, judge: consumer.jevJudge! });
    const registry = new CandidateRegistry();
    const provider = new RealResourceProviderV2({
      provider: prefilter,
      registry,
      workflowRunId: descriptor.workflowRunId,
      deadLinkStore: { async listDeadLinkKeys() { return [deadKey]; }, async recordDeadLink() { return undefined; } },
      rejectedResources: { async list() { return rejectedKey ? [{ linkKey: rejectedKey, label: "previously rejected", sizeBytes: null }] : []; } },
    });
    const filtered = await provider.search("Example");
    expect(liveSearch).not.toHaveBeenCalled();
    expect(actualJev).not.toHaveBeenCalled();
    expect(filtered.candidates.map((item) => item.id)).toEqual(["s1-1", "s1-2", "s1-5"]);
    expect(filtered.prefilterScores).toEqual({ "s1-1": 0.1, "s1-5": 0.9 });
    expect(filtered.prefilterDropped).toBe(2);
    expect(registry.get("s1-1")?.id).toBe("candidate-floor");
    expect(registry.get("s1-2")?.id).toBe("candidate-titleless");
    expect(registry.get("s1-5")?.id).toBe("candidate-keep");
    expect(registry.get("candidate-drop")).toBeUndefined(); // Jev identity drop.
    expect(registry.get("candidate-adult")).toBeUndefined(); // NSFW drop.
    expect(registry.get("candidate-dead")).toBeUndefined(); // Current dead-link check.
    expect(registry.get("candidate-rejected")).toBeUndefined(); // Current rejected-resource check.
    const persisted = provider.snapshots()[0]!;
    expect(persisted.id).toBe("prepared-original-id");
    expect(persisted.candidates.map((candidate) => candidate.id)).toEqual(["candidate-floor", "candidate-titleless", "candidate-keep"]);
    expect(persisted.prefilter?.status).toBe("applied");
    expect(persisted.prefilter?.floored?.map((item) => item.id)).toEqual(["candidate-floor"]);
    expect(persisted.prefilter?.nsfwDropped?.map((item) => item.id)).toEqual(["candidate-adult"]);
  });
});
