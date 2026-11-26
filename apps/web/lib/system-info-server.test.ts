import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistWorkflowRunSnapshotInput } from "@media-track/workflow";

const ENV_KEYS = [
  "MEDIA_TRACK_SQLITE_PATH",
  "MEDIA_TRACK_POSTGRES_URL",
  "REDIS_URL",
  "MEDIA_TRACK_REHEARSAL",
  "MEDIA_TRACK_DEMO_MODE",
  "MEDIA_TRACK_DISTRIBUTION",
  "MEDIA_TRACK_IMAGE",
  "MEDIA_TRACK_IMAGE_TAG",
  "MEDIA_TRACK_SUMMARY_CACHE_NAMESPACE",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

let activeRuntime: typeof import("./workflow-runtime") | null = null;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function boot(overrides?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.REDIS_URL;
  delete process.env.MEDIA_TRACK_REHEARSAL;
  delete process.env.MEDIA_TRACK_DEMO_MODE;
  delete process.env.MEDIA_TRACK_DISTRIBUTION;
  delete process.env.MEDIA_TRACK_IMAGE;
  delete process.env.MEDIA_TRACK_IMAGE_TAG;
  delete process.env.MEDIA_TRACK_SUMMARY_CACHE_NAMESPACE;
  if (overrides) {
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  vi.resetModules();
  activeRuntime = await import("./workflow-runtime");
  const server = await import("./system-info-server");
  return { rt: activeRuntime, collectSystemInfo: server.collectSystemInfo };
}

function makeSnapshotInput(over: {
  accountId: string;
  storageId: string;
  tmdbId: number;
  type: "movie" | "tv" | "anime";
  title: string;
  seasonId: string;
  runId: string;
  episodes: Array<{ code: string; obtained: boolean }>;
}): PersistWorkflowRunSnapshotInput {
  const mediaTitleId = `tmdb_${over.type === "movie" ? "movie" : "tv"}_${over.tmdbId}`;
  return {
    accountId: over.accountId,
    connectedStorageId: over.storageId,
    title: {
      id: mediaTitleId,
      tmdbId: over.tmdbId,
      type: over.type,
      title: over.title,
      originalTitle: over.title,
      year: 2025,
      aliases: [],
    },
    season: {
      id: over.seasonId,
      mediaTitleId,
      seasonNumber: over.type === "movie" ? 0 : 1,
      status: "active",
      qualityPreference: "4k",
      storageDirectoryId: "dir_1",
      totalEpisodes: over.episodes.length,
      latestAiredEpisode: over.episodes.length,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      id: over.runId,
      kind: over.type === "movie" ? "movie_init" : "type2_init",
      status: "succeeded",
      trackedSeasonId: over.seasonId,
      startedAt: "2026-11-26T00:00:00.000Z",
      finishedAt: "2026-11-26T00:05:00.000Z",
      auditEvents: [],
    },
    episodes: over.episodes.map((ep) => ({
      trackedSeasonId: over.seasonId,
      episodeCode: ep.code,
      airDate: "2026-01-01",
      title: ep.code,
      airStatus: "aired",
      obtained: ep.obtained,
      metadataStatus: "confirmed",
      verifiedFileIds: ep.obtained ? ["fid_1"] : [],
    })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  };
}

beforeEach(() => {
  restoreEnv();
});

afterEach(async () => {
  if (activeRuntime) {
    await activeRuntime.closeWorkflowRepositoryForTests();
    activeRuntime = null;
  }
  vi.resetModules();
  restoreEnv();
});

describe("collectSystemInfo", () => {
  it("counts landed titles by media type, ignores staging-janitor, counts drives, and respects infra visibility", async () => {
    const { rt, collectSystemInfo } = await boot();
    const repo = rt.getWorkflowRepository();

    await repo.upsertConnectedStorage({
      id: "cs_active",
      accountId: "acct_default",
      provider: "quark",
      providerUid: "u_active",
      label: "主力夸克",
      payload: { cookie: "ck1" },
      createdAt: "2026-11-26T00:00:00.000Z",
    });
    await repo.upsertConnectedStorage({
      id: "cs_frozen",
      accountId: "acct_default",
      provider: "pan115",
      providerUid: "u_frozen",
      label: "备用115",
      payload: { cookie: "ck2" },
      createdAt: "2026-11-26T00:01:00.000Z",
    });
    await repo.setConnectedStorageStatus("cs_frozen", "frozen", "expired", "2026-11-26T01:00:00.000Z");

    // 1) 已入库电影
    await repo.saveWorkflowRunSnapshot(
      makeSnapshotInput({
        accountId: "acct_default",
        storageId: "cs_active",
        tmdbId: 101,
        type: "movie",
        title: "测试电影",
        seasonId: "tmdb_movie_101_s0",
        runId: "run_101",
        episodes: [{ code: "MOVIE", obtained: true }],
      }),
    );
    // 2) 已入库剧集（2/3 集入库）
    await repo.saveWorkflowRunSnapshot(
      makeSnapshotInput({
        accountId: "acct_default",
        storageId: "cs_active",
        tmdbId: 202,
        type: "tv",
        title: "测试剧集",
        seasonId: "tmdb_tv_202_s1",
        runId: "run_202",
        episodes: [
          { code: "S01E01", obtained: true },
          { code: "S01E02", obtained: true },
          { code: "S01E03", obtained: false },
        ],
      }),
    );
    // 3) 仅追踪但未入库动漫
    await repo.saveWorkflowRunSnapshot(
      makeSnapshotInput({
        accountId: "acct_default",
        storageId: "cs_active",
        tmdbId: 303,
        type: "anime",
        title: "未落地动漫",
        seasonId: "tmdb_tv_303_s1",
        runId: "run_303",
        episodes: [{ code: "S01E01", obtained: false }],
      }),
    );
    // 4) staging-janitor 应被忽略，不计入追踪或入库统计
    await repo.saveWorkflowRunSnapshot(
      makeSnapshotInput({
        accountId: "acct_default",
        storageId: "cs_active",
        tmdbId: 404,
        type: "movie",
        title: "隔离记录",
        seasonId: "staging-janitor:cs_active",
        runId: "run_404",
        episodes: [{ code: "MOVIE", obtained: true }],
      }),
    );

    const ownerInfo = await collectSystemInfo({
      accountId: "acct_default",
      canViewInfraDetails: true,
    });
    expect(ownerInfo.database.engine).toBe("sqlite");
    expect(ownerInfo.database.status).toBe("connected");
    expect(ownerInfo.database.target).toBe(":memory:");
    expect(ownerInfo.redis.status).toBe("unconfigured");
    expect(ownerInfo.version.distribution).toBe("fork-image");
    expect(ownerInfo.version.imageRef).toBe("ghcr.io/pickarm/mediary-scout:latest");
    expect(ownerInfo.library).toEqual({
      landedTotal: 2,
      landedMovies: 1,
      landedTv: 1,
      landedAnime: 0,
      trackedTotal: 3,
      obtainedEpisodes: 3,
      activeDrives: 1,
      totalDrives: 2,
    });
    expect(ownerInfo.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(ownerInfo.process.nodeVersion).toBe(process.version);

    const memberInfo = await collectSystemInfo({
      accountId: "acct_default",
      canViewInfraDetails: false,
    });
    expect(memberInfo.canViewInfraDetails).toBe(false);
    expect(memberInfo.database.target).toBeNull();
    expect(memberInfo.database.databaseName).toBeNull();
    expect(memberInfo.redis.namespace).toBe("");
  });

  it("reports rehearsal state for Redis when MEDIA_TRACK_REHEARSAL=1", async () => {
    const { collectSystemInfo } = await boot({
      MEDIA_TRACK_REHEARSAL: "1",
      REDIS_URL: "redis://default:hidden@redis.local:6379/1",
    });

    const info = await collectSystemInfo({
      accountId: "acct_default",
      canViewInfraDetails: true,
    });
    expect(info.version.rehearsalMode).toBe(true);
    expect(info.redis.status).toBe("rehearsal");
    expect(info.redis.target).toBe("redis.local:6379");
    expect(info.redis.dbIndex).toBe("db1");
    expect(JSON.stringify(info)).not.toContain("hidden");
  });
});
