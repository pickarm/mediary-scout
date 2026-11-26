import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  GuangYaStorageExecutor,
  InMemoryWorkflowRepository,
  createEpisodeStates,
  getStorageWriteAccountKey,
  initializeWorkflowPostgresSchema,
  runType3MonitoringV2AndPersist,
  setStorageWriteAccountKey,
  type GuangYaStorageClient,
  type GuangYaStorageItem,
  type MediaTitle,
  type ResourceProvider,
  type TrackedSeason,
} from "@media-track/workflow";
import { PostgresScanStore, type ScanConfiguration } from "@media-track/workflow/library";
import { getLibraryDatabasePool } from "./library-database";
import {
  attachConfiguredAcquisitionLibraryStore,
} from "./workflow-runtime";

const adminConnectionString =
  process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL ?? process.env.TEST_POSTGRES_ADMIN;
const integration = describe.skipIf(!adminConnectionString);
const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

function toolCall(name: string, input: unknown, id: string) {
  return {
    content: [{ type: "tool-call" as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
    usage: USAGE,
    warnings: [],
  };
}

class MemoryGuangYaClient implements GuangYaStorageClient {
  private readonly items = new Map<string, GuangYaStorageItem>();
  private nextId = 1;
  readonly createdDirectories: Array<{ parentId: string; name: string }> = [];
  readonly restoredFiles: string[] = [];
  restoredFileId = "";

  addDirectory(parentId: string, name: string): string {
    const fileId = `gy_dir_${this.nextId}`;
    this.nextId += 1;
    this.items.set(fileId, { fileId, parentId, fileName: name, fileSize: 0, resType: 2 });
    return fileId;
  }

  addFile(parentId: string, name: string, sizeBytes: number): string {
    const fileId = `gy_file_${this.nextId}`;
    this.nextId += 1;
    this.items.set(fileId, { fileId, parentId, fileName: name, fileSize: sizeBytes, resType: 1 });
    return fileId;
  }

  async listFiles(parentId: string): Promise<GuangYaStorageItem[]> {
    return [...this.items.values()].filter((item) => item.parentId === parentId);
  }

  async createDir(parentId: string, dirName: string): Promise<string> {
    this.createdDirectories.push({ parentId, name: dirName });
    return this.addDirectory(parentId, dirName);
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    const item = this.items.get(fileId);
    if (item) this.items.set(fileId, { ...item, fileName: newName });
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    const remove = (fileId: string): void => {
      for (const child of [...this.items.values()]) {
        if (child.parentId === fileId) remove(child.fileId);
      }
      this.items.delete(fileId);
    };
    for (const fileId of fileIds) remove(fileId);
  }

  async moveFiles(fileIds: string[], parentId: string): Promise<void> {
    for (const fileId of fileIds) {
      const item = this.items.get(fileId);
      if (item) this.items.set(fileId, { ...item, parentId });
    }
  }

  async resolveRes(): Promise<never> {
    throw new Error("share transfer is used in this test");
  }

  async createTask(): Promise<never> {
    throw new Error("share transfer is used in this test");
  }

  async listTask(): Promise<never[]> {
    return [];
  }

  async getShareAccessToken(): Promise<string> {
    return "share-token";
  }

  async listShareFiles(): Promise<GuangYaStorageItem[]> {
    return [{
      fileId: "share-file",
      parentId: "",
      fileName: "Source.S01E01.mkv",
      fileSize: 100 * 1024 * 1024,
      resType: 1,
    }];
  }

  async restoreShare(input: {
    accessToken: string;
    fileIds: string[];
    parentId: string;
  }): Promise<string> {
    this.restoredFiles.push(input.parentId);
    this.restoredFileId = this.addFile(input.parentId, "Source.S01E01.mkv", 100 * 1024 * 1024);
    return "restore-task";
  }

  async getTaskStatus(): Promise<{ status: number }> {
    return { status: 2 };
  }
}

integration("F14b runtime → runner → native guangya executor", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseUrl: string;
  let databaseName: string;
  let scanStore: PostgresScanStore;
  const previousPostgresUrl = process.env.MEDIA_TRACK_POSTGRES_URL;

  const dbTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `runtime_acquisition_naming_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminConnectionString);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    pool = new pg.Pool({ connectionString: databaseUrl });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    scanStore = new PostgresScanStore(pool);
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
  }, 30_000);

  afterAll(async () => {
    try {
      await getLibraryDatabasePool().end();
    } finally {
      try {
        if (pool) await pool.end();
      } finally {
        try {
          if (adminPool && databaseName) {
            await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
          }
        } finally {
          if (adminPool) await adminPool.end();
          if (previousPostgresUrl === undefined) delete process.env.MEDIA_TRACK_POSTGRES_URL;
          else process.env.MEDIA_TRACK_POSTGRES_URL = previousPostgresUrl;
        }
      }
    }
  }, 30_000);

  async function createScope(): Promise<{
    accountId: string;
    connectedStorageId: string;
  }> {
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `acct_${suffix}`;
    const connectedStorageId = `storage_${suffix}`;
    await pool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, '', false, now()::text)",
      [accountId, `user_${suffix}`],
    );
    await pool.query(
      "INSERT INTO connected_storages " +
        "(id, account_id, provider, provider_uid, payload, created_at) VALUES ($1, $2, 'guangya', $3, '{}'::jsonb, now()::text)",
      [connectedStorageId, accountId, `uid_${suffix}`],
    );
    return { accountId, connectedStorageId };
  }

  function configuration(input: {
    scope: { accountId: string; connectedStorageId: string };
    configId: string;
    tvRoot: string;
    episodeFile?: string;
  }): ScanConfiguration {
    return {
      configId: input.configId,
      scope: input.scope,
      sourceRoots: [{ directoryId: "scan-root", name: "扫描源" }],
      movieTargetDirectoryId: "movie-root",
      movieTargetDirectoryName: "电影",
      tvTargetDirectoryId: input.tvRoot,
      tvTargetDirectoryName: "剧集",
      mediaKind: "mixed",
      dailyScheduleEnabled: false,
      dailyScheduleTime: null,
      dailyScheduleTimezone: "Asia/Shanghai",
      autoOrganize: false,
      autoAcquire: false,
      templates: {
        tvDirectory: "库/{title}",
        seasonDirectory: "S{season:02}",
        episodeFile: input.episodeFile ?? "{title} - {episodeCode}{ext}",
      },
    };
  }

  function title(): MediaTitle {
    return {
      id: "tmdb_tv_601",
      tmdbId: 601,
      type: "tv",
      title: "规范标题",
      originalTitle: "Canonical Show",
      year: 2026,
      aliases: [],
    };
  }

  function season(): TrackedSeason {
    return {
      id: "tmdb_tv_601_s1",
      mediaTitleId: "tmdb_tv_601",
      seasonNumber: 1,
      status: "active",
      qualityPreference: "high",
      storageDirectoryId: "",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
  }

  function provider(): ResourceProvider {
    return {
      async search(input) {
        return {
          id: "s1",
          provider: "fake",
          keyword: input.keyword,
          createdAt: "2026-11-16T00:00:00.000Z",
          candidates: [{
            id: "s1-1",
            snapshotId: "s1",
            index: 0,
            title: "Canonical Show S01E01",
            type: "guangya",
            source: "fixture",
            providerPayload: {
              url: "https://guangyapan.com/s/example?password=abcd",
            },
          }],
        };
      },
    };
  }

  dbTest("runtime attachment runs native transfer and move through the runner and renames only the verified new ID", async () => {
    const scope = await createScope();
    const client = new MemoryGuangYaClient();
    const tvRoot = client.addDirectory("", "TV");
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "default",
      tvRoot,
    }));
    const libraryRoot = client.addDirectory(tvRoot, "库");
    const show = client.addDirectory(libraryRoot, "规范标题");
    const seasonDirectory = client.addDirectory(show, "S01");
    const oldFile = client.addFile(seasonDirectory, "用户保留.S01E99.mkv", 80 * 1024 * 1024);
    const storage = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [tvRoot],
      minVideoSizeBytes: 10 * 1024 * 1024,
      taskPollIntervalMs: 1,
      subtitleTaskPollIntervalMs: 1,
    });
    const accountKey = `guangya:${scope.accountId}`;
    let writeTasks = 0;
    const coordinator = {
      async run<T>(_keys: readonly string[], run: () => Promise<T>): Promise<T> {
        writeTasks += 1;
        return run();
      },
      async assertHeld(): Promise<void> {},
    };
    setStorageWriteAccountKey(storage, accountKey, coordinator);
    expect(attachConfiguredAcquisitionLibraryStore(storage)).toBe(storage);
    expect(getStorageWriteAccountKey(storage)).toBe(accountKey);

    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        step += 1;
        if (step === 1) return toolCall("viewResourceSnapshot", {}, "s1");
        if (step === 2) {
          return toolCall("transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }, "s2");
        }
        if (step === 3) {
          return toolCall("moveToSeason", {
            moves: [{ season: 1, fileIds: [client.restoredFileId] }],
          }, "s3");
        }
        if (step === 4) return toolCall("markObtained", { codes: ["S01E01"] }, "s4");
        if (step === 5) return toolCall("discardStaging", {}, "s5");
        if (step === 6) return toolCall("finish", {}, "s6");
        return {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: { unified: "stop" as const, raw: "stop" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });
    const episodes = createEpisodeStates({
      trackedSeasonId: "tmdb_tv_601_s1",
      seasonNumber: 1,
      totalEpisodes: 2,
      latestAiredEpisode: 2,
    });

    await runType3MonitoringV2AndPersist({
      title: title(),
      season: season(),
      episodes,
      categoryParentId: tvRoot,
      resourceProvider: provider(),
      storage,
      model,
      repository: new InMemoryWorkflowRepository(),
      accountId: scope.accountId,
      connectedStorageId: scope.connectedStorageId,
      workflowRun: {
        id: "run-f14b-native",
        startedAt: "2026-11-16T00:00:00.000Z",
        finishedAt: "2026-11-16T00:02:00.000Z",
      },
      now: () => "2026-11-16T00:02:00.000Z",
    });

    expect(writeTasks).toBeGreaterThan(0);
    expect(client.restoredFiles).toHaveLength(1);
    expect((await client.listFiles(seasonDirectory)).map((item) => [item.fileId, item.fileName]))
      .toEqual([
        [oldFile, "用户保留.S01E99.mkv"],
        [client.restoredFileId, "规范标题 - S01E01.mkv"],
      ]);
    expect(client.createdDirectories).toEqual([
      { parentId: show, name: "staging-run-f14b-native" },
    ]);
    expect(getStorageWriteAccountKey(storage)).toBe(accountKey);
  });

  dbTest("runner rejects conflicting PG templates before the native cloud receives any write", async () => {
    const scope = await createScope();
    const client = new MemoryGuangYaClient();
    const tvRoot = client.addDirectory("", "TV");
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "a",
      tvRoot,
      episodeFile: "{title} - A - {episodeCode}{ext}",
    }));
    await scanStore.saveConfiguration(configuration({
      scope,
      configId: "b",
      tvRoot,
      episodeFile: "{title} - B - {episodeCode}{ext}",
    }));
    const storage = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [tvRoot],
    });
    setStorageWriteAccountKey(storage, `guangya:${scope.accountId}`, {
      async run<T>(_keys: readonly string[], run: () => Promise<T>): Promise<T> {
        return run();
      },
      async assertHeld(): Promise<void> {},
    });
    attachConfiguredAcquisitionLibraryStore(storage);
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: "must not run" }],
        finishReason: { unified: "stop" as const, raw: "stop" as const },
        usage: USAGE,
        warnings: [],
      }),
    });

    await expect(runType3MonitoringV2AndPersist({
      title: title(),
      season: season(),
      episodes: createEpisodeStates({
        trackedSeasonId: "tmdb_tv_601_s1",
        seasonNumber: 1,
        totalEpisodes: 2,
        latestAiredEpisode: 2,
      }),
      categoryParentId: tvRoot,
      resourceProvider: provider(),
      storage,
      model,
      repository: new InMemoryWorkflowRepository(),
      accountId: scope.accountId,
      connectedStorageId: scope.connectedStorageId,
      workflowRun: {
        id: "run-f14b-conflict",
        startedAt: "2026-11-16T00:00:00.000Z",
        finishedAt: "2026-11-16T00:01:00.000Z",
      },
    })).rejects.toMatchObject({
      code: "ACQUISITION_NAMING_TEMPLATE_CONFLICT",
    });

    expect(client.createdDirectories).toEqual([]);
    expect(client.restoredFiles).toEqual([]);
    expect(await client.listFiles(tvRoot)).toEqual([]);
  });
});
