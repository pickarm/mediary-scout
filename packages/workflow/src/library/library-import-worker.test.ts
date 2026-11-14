import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import { FakeResourceProvider, FakeStorageExecutor } from "../fakes.js";
import type { EpisodeState, MediaTitle, TrackedSeason } from "../domain.js";
import type { WorkflowRepository } from "../repository.js";
import type { TrackedSeasonState } from "../repository.js";
import { runScheduledType3Monitoring } from "../worker.js";

function movieState(autoAcquire?: boolean): TrackedSeasonState {
  const title: MediaTitle = {
    id: "tmdb_movie_930001",
    tmdbId: 930001,
    type: "movie",
    title: "Test movie",
    originalTitle: "Test movie",
    year: 2020,
    aliases: [],
  };
  const season: TrackedSeason = {
    id: "tmdb_movie_930001_movie",
    mediaTitleId: title.id,
    seasonNumber: 1,
    status: "completed",
    qualityPreference: "high",
    storageDirectoryId: "movie-dir",
    totalEpisodes: 1,
    latestAiredEpisode: 1,
    latestAiredSource: "metadata",
    ...(autoAcquire === undefined ? {} : { autoAcquire }),
  };
  const episode: EpisodeState = {
    trackedSeasonId: season.id,
    episodeCode: "S01E01",
    airDate: null,
    title: "Test movie",
    airStatus: "aired",
    obtained: false,
    metadataStatus: "confirmed",
    verifiedFileIds: [],
  };
  return { accountId: "acct_test", connectedStorageId: "storage_test", title, season, episodes: [episode] };
}

function repositoryForState(
  state: TrackedSeasonState,
  onReserve: () => Promise<never>,
): WorkflowRepository {
  return {
    listAllTrackedSeasonStates: async () => [state],
    listWorksWithPendingMessages: async () => [],
    listWorksWithPendingReplacements: async () => [],
    listWorksWithProcessingMessages: async () => [],
    listConnectedStorages: async () => [],
    listActiveWorkflowRuns: async () => [],
    reserveWorkflowRun: onReserve,
  } as unknown as WorkflowRepository;
}

describe("existing-library auto-acquire compatibility", () => {
  it("skips a scheduled patrol for an explicit false setting", async () => {
    let reserveCalls = 0;
    let accountContextCalls = 0;
    const outcomes = await runScheduledType3Monitoring({
      repository: repositoryForState(movieState(false), async () => {
        reserveCalls += 1;
        throw new Error("explicit false must not reserve an automatic run");
      }),
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage: new FakeStorageExecutor(),
      model: {} as LanguageModel,
      storageParentDirectoryId: "root-dir",
      moviesParentDirectoryId: "movies-dir",
      resolveAccountContext: async () => {
        accountContextCalls += 1;
        return {};
      },
    });

    expect(outcomes).toEqual([]);
    expect(reserveCalls).toBe(0);
    expect(accountContextCalls).toBe(0);
  });

  it("keeps the old automatic behavior when the optional field is absent", async () => {
    let reserveCalls = 0;
    await expect(
      runScheduledType3Monitoring({
        repository: repositoryForState(movieState(), async () => {
          reserveCalls += 1;
          throw new Error("legacy season reached the patrol reservation");
        }),
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage: new FakeStorageExecutor(),
        model: {} as LanguageModel,
        storageParentDirectoryId: "root-dir",
        moviesParentDirectoryId: "movies-dir",
      }),
    ).rejects.toThrow("legacy season reached the patrol reservation");
    expect(reserveCalls).toBe(1);
  });
});
