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
});
