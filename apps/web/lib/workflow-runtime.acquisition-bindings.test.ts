import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import {
  FakeResourceProvider,
  FakeStorageExecutor,
  GuangYaStorageExecutor,
  InMemoryWorkflowRepository,
  createEpisodeStates,
  getStorageWriteAccountKey,
  initializeWorkflowPostgresSchema,
  runType3MonitoringV2AndPersist,
  setStorageWriteAccountKey,
  withStorageWriteTask,
  type EpisodeState,
  type GuangYaStorageClient,
  type GuangYaStorageItem,
  type MediaTitle,
  type TrackedSeason,
  type VerifiedFile,
} from "@media-track/workflow";
import { PostgresLibraryStore, acquisitionLibraryStoreOf } from "@media-track/workflow/library";
import { getLibraryDatabasePool } from "./library-database";
import {
  attachConfiguredAcquisitionLibraryStore,
  getWorkerStorageExecutor,
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

function video(fileId: string, directoryId: string, name: string): VerifiedFile {
  return {
    id: fileId,
    providerFileId: fileId,
    storageDirectoryId: directoryId,
    name,
    sizeBytes: 100,
    episodeCode: null,
  };
}

/** Minimal stateful client behind the REAL GuangYaStorageExecutor (provider `guangya`). */
class MemoryGuangYaClient implements GuangYaStorageClient {
  private readonly items = new Map<string, GuangYaStorageItem>();
  private nextId = 1;
  readonly createdDirectories: Array<{ parentId: string; name: string }> = [];

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
    throw new Error("transfer is not used in this test");
  }

  async createTask(): Promise<never> {
    throw new Error("offline task is not used in this test");
  }

  async listTask(): Promise<never[]> {
    return [];
  }
}

integration("F14a runtime → runner acquisition bindings", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresLibraryStore;
  let databaseUrl: string;
  let databaseName: string;
  const previousPostgresUrl = process.env.MEDIA_TRACK_POSTGRES_URL;
  const previousStorageAdapter = process.env.MEDIA_TRACK_STORAGE_ADAPTER;

  const dbTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `runtime_acquisition_bindings_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(adminConnectionString);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();
    pool = new pg.Pool({ connectionString: databaseUrl });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool);
    store = new PostgresLibraryStore(pool);
    process.env.MEDIA_TRACK_STORAGE_ADAPTER = "fake";
  }, 30_000);

  afterAll(async () => {
    try {
      process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
      await getLibraryDatabasePool().end();
    } catch {
      // No runtime pool was created in this file.
    }
    if (pool) await pool.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
    if (previousPostgresUrl === undefined) delete process.env.MEDIA_TRACK_POSTGRES_URL;
    else process.env.MEDIA_TRACK_POSTGRES_URL = previousPostgresUrl;
    if (previousStorageAdapter === undefined) delete process.env.MEDIA_TRACK_STORAGE_ADAPTER;
    else process.env.MEDIA_TRACK_STORAGE_ADAPTER = previousStorageAdapter;
  }, 30_000);

  async function createScope(
    provider = "quark",
  ): Promise<{ accountId: string; connectedStorageId: string }> {
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `acct_${suffix}`;
    const connectedStorageId = `storage_${suffix}`;
    await pool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, '', false, now()::text)",
      [accountId, `user_${suffix}`],
    );
    await pool.query(
      "INSERT INTO connected_storages " +
        "(id, account_id, provider, provider_uid, payload, created_at) VALUES ($1, $2, $3, $4, '{}'::jsonb, now()::text)",
      [connectedStorageId, accountId, provider, `uid_${suffix}`],
    );
    return { accountId, connectedStorageId };
  }

  function makeTitle(): MediaTitle {
    return {
      id: "tmdb_tv_24201",
      tmdbId: 24201,
      type: "tv",
      title: "规范标题",
      originalTitle: "Custom Show",
      year: 2024,
      aliases: [],
    };
  }

  function makeSeason(title: MediaTitle): TrackedSeason {
    return {
      id: `${title.id}_s1`,
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "high",
      storageDirectoryId: "",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
  }

  dbTest("does not attach a library store when no PG configuration exists", async () => {
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    const storage = new FakeStorageExecutor();
    expect(attachConfiguredAcquisitionLibraryStore(storage)).toBe(storage);
    expect(acquisitionLibraryStoreOf(storage)).toBeNull();
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
  });

  dbTest("a mount failure with PG configured fails closed without leaking the connection string", async () => {
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
    const frozen = Object.freeze(new FakeStorageExecutor());
    let caught: unknown;
    try {
      attachConfiguredAcquisitionLibraryStore(frozen);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/^ACQUISITION_LIBRARY_STORE_UNAVAILABLE: TypeError$/);
    expect((caught as Error).message).not.toContain("codex-isolated-test");
  });

  dbTest("real import binding → runtime executor → runner reuses IDs and protects imported versions", async () => {
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
    const scope = await createScope();
    const title = makeTitle();
    const season = makeSeason(title);

    // The runtime hands the worker the executor it will actually use. With PG
    // configured, this is the same public attachAcquisitionLibraryStore port.
    const storage = await getWorkerStorageExecutor(scope.accountId, scope.connectedStorageId);
    expect(storage).toBeInstanceOf(FakeStorageExecutor);
    expect(acquisitionLibraryStoreOf(storage)).not.toBeNull();
    const fake = storage as FakeStorageExecutor;

    const showId = await fake.createDirectory({ name: "我的自定义剧名", parentId: "tv_root" });
    const seasonId = await fake.createDirectory({ name: "特别季目录", parentId: showId });
    season.storageDirectoryId = seasonId;
    fake.seedDirectoryFiles(seasonId, [
      video("v1080", seasonId, "E01.1080p.mkv"),
      video("v4k", seasonId, "E01.4K.mkv"),
      video("v2", seasonId, "E02.mkv"),
    ]);

    await store.importExistingMedia({
      ...scope,
      title,
      season,
      episodes: [1, 2].map((episodeNumber) => ({
        trackedSeasonId: season.id,
        episodeCode: `S01E0${episodeNumber}`,
        airDate: null,
        title: `Episode ${episodeNumber}`,
        airStatus: "aired",
        obtained: false,
        metadataStatus: "confirmed",
        verifiedFileIds: [],
      })),
      files: [
        { fileId: "v1080", parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 100, quality: "1080p" },
        { fileId: "v4k", parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 200, quality: "2160p" },
        { fileId: "v2", parentDirectoryId: seasonId, episodeCode: "S01E02", sizeBytes: 300, quality: "1080p" },
      ],
      directories: [{ directoryId: seasonId, parentDirectoryId: showId }],
      now: "2026-11-16T00:00:00.000Z",
    });

    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: 1,
      totalEpisodes: 2,
      latestAiredEpisode: 2,
    });
    episodes[0] = {
      ...episodes[0]!,
      obtained: true,
      verifiedFileIds: ["v1080", "v4k"],
    } satisfies EpisodeState;

    let system = "";
    let deleteResult: unknown;
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        step += 1;
        if (step === 1) {
          system = JSON.stringify(options.prompt.find((message) => message.role === "system") ?? "");
          // A keep-larger dedup attempt on an already-imported version. The
          // imported plan must have added this episode to protectExisting.
          return toolCall("deleteFiles", { directory: "season", season: 1, fileIds: ["v1080"] }, "c1");
        }
        const messages = options.prompt as Array<{
          role: string;
          content: Array<{ type: string; output?: { value?: unknown } }>;
        }>;
        if (step === 2) {
          deleteResult = messages.filter((message) => message.role === "tool").at(-1)?.content[0]?.output?.value;
        }
        return {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: { unified: "stop" as const, raw: "stop" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const repository = new InMemoryWorkflowRepository();
    await runType3MonitoringV2AndPersist({
      title,
      season,
      episodes,
      categoryParentId: "tv_root",
      resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
      storage,
      model,
      repository,
      accountId: scope.accountId,
      connectedStorageId: scope.connectedStorageId,
      workflowRun: {
        id: "run-f14a",
        startedAt: "2026-11-16T00:00:00.000Z",
        finishedAt: "2026-11-16T00:01:00.000Z",
      },
      now: () => "2026-11-16T00:01:00.000Z",
    });

    // Multi-version imported episode is named in the prompt, and the sandbox
    // refuses the delete instead of letting keep-larger remove the user's file.
    expect(system).toContain("S01E01");
    expect(system).toMatch(/intentionally kept duplicates/);
    expect(deleteResult).toEqual({ error: expect.stringContaining("SANDBOX_FILE_PROTECTED") });
    expect((await fake.listTree({ directoryId: seasonId })).map((file) => file.providerFileId)).toEqual(
      expect.arrayContaining(["v1080", "v4k", "v2"]),
    );

    // Bound IDs were used: no canonical show twin, no canonical Season 01.
    const categoryChildren = await fake.listChildDirectories("tv_root");
    expect(categoryChildren.map((child) => child.name)).toEqual(["我的自定义剧名"]);
    expect(categoryChildren.map((child) => child.id)).toEqual([showId]);
    const showChildren = await fake.listChildDirectories(showId);
    expect(showChildren.map((child) => child.id)).toContain(seasonId);
    expect(showChildren.map((child) => child.name)).not.toContain("Season 01");
  });

  dbTest("native guangya: real import → runtime attach after F07b fencing → runner reuses IDs", async () => {
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
    const scope = await createScope("guangya");
    const suffix = randomUUID().replaceAll("-", "");
    const providerRow = await pool.query<{ provider: string }>(
      "SELECT provider FROM connected_storages WHERE id = $1",
      [scope.connectedStorageId],
    );
    expect(providerRow.rows[0]?.provider).toBe("guangya");
    const title: MediaTitle = {
      id: "tmdb_tv_24301",
      tmdbId: 24301,
      type: "tv",
      title: "光鸭规范标题",
      originalTitle: "GuangYa Custom Show",
      year: 2024,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: `${title.id}_s1`,
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "high",
      storageDirectoryId: "",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };

    const client = new MemoryGuangYaClient();
    const tvRootId = client.addDirectory("", "TV");
    const templateRootId = client.addDirectory(tvRootId, "光鸭多级模板");
    const showId = client.addDirectory(templateRootId, "光鸭自定义目录");
    const seasonId = client.addDirectory(showId, "特别季目录");
    const v1080 = client.addFile(seasonId, "E01.1080p.mkv", 100 * 1024 * 1024);
    const v4k = client.addFile(seasonId, "E01.4K.mkv", 200 * 1024 * 1024);
    const v2 = client.addFile(seasonId, "E02.mkv", 150 * 1024 * 1024);
    season.storageDirectoryId = seasonId;

    // The REAL guangya executor (write scope, derived-scope guard, find-or-create),
    // not a FakeStorageExecutor or a mis-spelled provider alias.
    const storage = new GuangYaStorageExecutor({
      client,
      writeScopeDirectoryIds: [tvRootId],
    });
    expect(storage).toBeInstanceOf(GuangYaStorageExecutor);

    await store.importExistingMedia({
      ...scope,
      title,
      season,
      episodes: [1, 2].map((episodeNumber) => ({
        trackedSeasonId: season.id,
        episodeCode: `S01E0${episodeNumber}`,
        airDate: null,
        title: `Episode ${episodeNumber}`,
        airStatus: "aired",
        obtained: false,
        metadataStatus: "confirmed",
        verifiedFileIds: [],
      })),
      files: [
        { fileId: v1080, parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 100, quality: "1080p" },
        { fileId: v4k, parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 200, quality: "2160p" },
        { fileId: v2, parentDirectoryId: seasonId, episodeCode: "S01E02", sizeBytes: 300, quality: "1080p" },
      ],
      directories: [
        { directoryId: seasonId, parentDirectoryId: showId },
        { directoryId: showId, parentDirectoryId: templateRootId },
        { directoryId: templateRootId, parentDirectoryId: tvRootId },
      ],
      now: "2026-11-16T00:00:00.000Z",
    });

    // Runtime attaches the store to the executor the runner will receive.
    expect(attachConfiguredAcquisitionLibraryStore(storage)).toBe(storage);
    expect(acquisitionLibraryStoreOf(storage)).not.toBeNull();

    // F07b fencing: account metadata + the write-task wrapper, then method-level
    // fencing (the same shape guardGuangYaExecutor applies). Both symbol-keyed
    // facts must still be visible on the SAME executor object.
    const accountKey = `guangya:acct_${suffix}`;
    let fencedWrites = 0;
    const coordinator = {
      async run<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
        expect(keys).toEqual([accountKey]);
        fencedWrites += 1;
        return run();
      },
      async assertHeld(key: string): Promise<void> {
        expect(key).toBe(accountKey);
      },
    };
    setStorageWriteAccountKey(storage, accountKey, coordinator);
    const fencedCreateDirectory = storage.createDirectory.bind(storage);
    storage.createDirectory = (input) =>
      coordinator.run([accountKey], () => fencedCreateDirectory(input));
    const fencedRemoveDirectory = storage.removeDirectory.bind(storage);
    storage.removeDirectory = (directoryId) =>
      coordinator.run([accountKey], () => fencedRemoveDirectory(directoryId));
    const fencedDeleteFiles = storage.deleteFiles.bind(storage);
    storage.deleteFiles = (input) =>
      coordinator.run([accountKey], () => fencedDeleteFiles(input));

    expect(getStorageWriteAccountKey(storage)).toBe(accountKey);
    expect(acquisitionLibraryStoreOf(storage)).not.toBeNull();

    const episodes = createEpisodeStates({
      trackedSeasonId: season.id,
      seasonNumber: 1,
      totalEpisodes: 2,
      latestAiredEpisode: 2,
    });
    episodes[0] = {
      ...episodes[0]!,
      obtained: true,
      verifiedFileIds: [v1080, v4k],
    } satisfies EpisodeState;

    let system = "";
    let deleteResult: unknown;
    let step = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        step += 1;
        if (step === 1) {
          system = JSON.stringify(options.prompt.find((message) => message.role === "system") ?? "");
          return toolCall("deleteFiles", { directory: "season", season: 1, fileIds: [v1080] }, "gy-c1");
        }
        const messages = options.prompt as Array<{
          role: string;
          content: Array<{ type: string; output?: { value?: unknown } }>;
        }>;
        if (step === 2) {
          deleteResult = messages.filter((message) => message.role === "tool").at(-1)?.content[0]?.output?.value;
        }
        return {
          content: [{ type: "text" as const, text: "done" }],
          finishReason: { unified: "stop" as const, raw: "stop" as const },
          usage: USAGE,
          warnings: [],
        };
      },
    });

    const repository = new InMemoryWorkflowRepository();
    await withStorageWriteTask([storage], async () => {
      expect(acquisitionLibraryStoreOf(storage)).not.toBeNull();
      await runType3MonitoringV2AndPersist({
        title,
        season,
        episodes,
        categoryParentId: tvRootId,
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage,
        model,
        repository,
        accountId: scope.accountId,
        connectedStorageId: scope.connectedStorageId,
        workflowRun: {
          id: "run-f14a-gy",
          startedAt: "2026-11-16T00:00:00.000Z",
          finishedAt: "2026-11-16T00:01:00.000Z",
        },
        now: () => "2026-11-16T00:01:00.000Z",
      });
    });

    expect(system).toContain("S01E01");
    expect(system).toMatch(/intentionally kept duplicates/);
    expect(deleteResult).toEqual({ error: expect.stringContaining("SANDBOX_FILE_PROTECTED") });
    expect((await client.listFiles(seasonId)).map((item) => item.fileId).sort()).toEqual(
      [v1080, v4k, v2].sort(),
    );
    expect(fencedWrites).toBeGreaterThan(0);

    // Only the run's staging dir was created; the already-imported nested show
    // and season kept their IDs and names, with no canonical twin.
    expect(client.createdDirectories).toEqual([{ parentId: showId, name: "staging-run-f14a-gy" }]);
    expect((await client.listFiles(tvRootId)).map((item) => item.fileName)).toEqual(["光鸭多级模板"]);
    expect((await client.listFiles(templateRootId)).map((item) => item.fileName)).toEqual(["光鸭自定义目录"]);
    expect((await client.listFiles(showId)).map((item) => item.fileName)).toEqual(["特别季目录"]);
    expect(acquisitionLibraryStoreOf(storage)).not.toBeNull();
    expect(getStorageWriteAccountKey(storage)).toBe(accountKey);
  });

  dbTest("the runner fails closed when the imported directory is outside the acquisition root", async () => {
    process.env.MEDIA_TRACK_POSTGRES_URL = databaseUrl;
    const scope = await createScope();
    const suffix = randomUUID().replaceAll("-", "");
    const categoryParentId = `tv_root_${suffix}`;
    const otherRootId = `other_root_${suffix}`;
    const title: MediaTitle = {
      id: "tmdb_tv_24202",
      tmdbId: 24202,
      type: "tv",
      title: "根外作品",
      originalTitle: "Outside Show",
      year: 2024,
      aliases: [],
    };
    const season: TrackedSeason = {
      id: `${title.id}_s1`,
      mediaTitleId: title.id,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "high",
      storageDirectoryId: "",
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
    const storage = await getWorkerStorageExecutor(scope.accountId, scope.connectedStorageId);
    const fake = storage as FakeStorageExecutor;
    const showId = await fake.createDirectory({ name: "根外剧目录", parentId: otherRootId });
    const seasonId = await fake.createDirectory({ name: "S01", parentId: showId });
    season.storageDirectoryId = seasonId;
    fake.seedDirectoryFiles(seasonId, [video("outside-24202", seasonId, "E01.mkv")]);
    await store.importExistingMedia({
      ...scope,
      title,
      season,
      episodes: [1, 2].map((episodeNumber) => ({
        trackedSeasonId: season.id,
        episodeCode: `S01E0${episodeNumber}`,
        airDate: null,
        title: `Episode ${episodeNumber}`,
        airStatus: "aired",
        obtained: false,
        metadataStatus: "confirmed",
        verifiedFileIds: [],
      })),
      files: [{ fileId: "outside-24202", parentDirectoryId: seasonId, episodeCode: "S01E01" }],
      directories: [{ directoryId: seasonId, parentDirectoryId: showId }],
      now: "2026-11-16T00:00:00.000Z",
    });

    const neverCalledModel = new MockLanguageModelV3({
      doGenerate: async () => {
        throw new Error("agent must not run before binding safety is verified");
      },
    });
    await expect(
      runType3MonitoringV2AndPersist({
        title,
        season,
        episodes: createEpisodeStates({
          trackedSeasonId: season.id,
          seasonNumber: 1,
          totalEpisodes: 2,
          latestAiredEpisode: 2,
        }),
        categoryParentId,
        resourceProvider: new FakeResourceProvider({ keywordResults: {} }),
        storage,
        model: neverCalledModel,
        repository: new InMemoryWorkflowRepository(),
        accountId: scope.accountId,
        connectedStorageId: scope.connectedStorageId,
        workflowRun: {
          id: "run-f14a-outside",
          startedAt: "2026-11-16T00:00:00.000Z",
          finishedAt: "2026-11-16T00:01:00.000Z",
        },
        now: () => "2026-11-16T00:01:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_BINDING_OUTSIDE_SANDBOX" });

    // No sandbox expansion and no new directory under the configured root.
    expect(await fake.listChildDirectories(categoryParentId)).toEqual([]);
    expect((await fake.listTree({ directoryId: seasonId })).map((file) => file.providerFileId)).toEqual([
      "outside-24202",
    ]);
  });
});
