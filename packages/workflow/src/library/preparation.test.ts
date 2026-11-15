import { describe, expect, it } from "vitest";
import type { ResourceSnapshot } from "../domain.js";
import { PreparationService, preparedSnapshotsForConsumer } from "./preparation.js";
import type { PostgresPreparationStore, PreparationResult } from "./preparation-store.js";

describe("preparation consumer contract", () => {
  it("returns raw snapshots without applying Jev scores or dropping candidates", () => {
    const snapshot: ResourceSnapshot = {
      id: "snapshot-1", provider: "pansou", keyword: "Bare title", createdAt: "2026-11-14T00:00:00.000Z",
      candidates: [
        { id: "candidate-low", snapshotId: "snapshot-1", index: 0, title: "Other title", type: "guangya", source: "pansou", providerPayload: {} },
      ],
    };
    const result: PreparationResult = { snapshots: [snapshot], jev: {
      target: { mediaType: "movie", tmdbId: 1, title: "Bare title", aliases: [] },
      result: { scores: { "candidate-low": 0.01 }, model: "test-model" },
    } };
    expect(preparedSnapshotsForConsumer(result)).toEqual([snapshot]);
    expect(preparedSnapshotsForConsumer(result)[0]?.candidates).toHaveLength(1);
  });

  it("validates configured preparation concurrency bounds", () => {
    const options = {
      store: {} as PostgresPreparationStore,
      context: { async refresh() { throw new Error("unused"); } },
    };
    expect(() => new PreparationService({ ...options, preparationConcurrency: 21 })).toThrow("PREPARATION_LIMIT_INVALID");
    expect(() => new PreparationService({ ...options, aiConcurrency: 0 })).toThrow("PREPARATION_LIMIT_INVALID");
  });

  it("keeps a successful raw search when the advisory Jev preparation fails", async () => {
    const job = {
      accountId: "acct-a", connectedStorageId: "drive-a", workflowRunId: "run-a", mediaType: "movie" as const,
      tmdbId: 1, title: "Example", aliases: [], year: 2020, searchConfigFingerprint: "fp", status: "running" as const,
      attempts: 1, leaseId: "lease", leaseExpiresAt: "2026-11-15T00:01:00.000Z", createdAt: "2026-11-15T00:00:00.000Z",
      expiresAt: "2026-11-16T00:00:00.000Z", result: null,
    };
    const snapshot: ResourceSnapshot = {
      id: "raw", provider: "pansou", keyword: "Example", createdAt: "2026-11-15T00:00:00.000Z", candidates: [
        { id: "c1", snapshotId: "raw", index: 0, title: "Example 2020", type: "guangya", source: "pansou", providerPayload: {} },
      ],
    };
    let committed: PreparationResult | undefined;
    const store = {
      async claim() { return job; }, async isLive() { return true; }, async heartbeat() { return true; },
      async commit(_job: unknown, result: PreparationResult) { committed = result; return true; },
      async stale() { return true; }, async fail() { throw new Error("search should not be failed"); },
    } as unknown as PostgresPreparationStore;
    const service = new PreparationService({
      store,
      context: {
        async refresh() {
          return {
            target: { title: "Example", aliases: [], year: 2020, searchConfigFingerprint: "fp" },
            resourceProvider: { async search() { return snapshot; } }, searchServiceKey: "pansou.local", searchLane: "pansou" as const,
            jev: { async judgeCandidates() { throw new Error("JEV_SECRET_MUST_NOT_BE_LOGGED"); } },
          };
        },
      },
    });
    expect(await service.tick(1)).toBe(1);
    expect(committed?.snapshots).toEqual([snapshot]);
    expect(committed?.jev).toBeUndefined();
  });
});
