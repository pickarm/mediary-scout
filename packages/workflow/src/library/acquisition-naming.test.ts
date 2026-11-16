import { describe, expect, it } from "vitest";
import type {
  MediaTitle,
  ResourceCandidate,
} from "../domain.js";
import { FakeStorageExecutor } from "../fakes.js";
import {
  AcquisitionNamingError,
  resolveAcquisitionNamingPolicyFromConfigurations,
  withAcquisitionNaming,
  type AcquisitionNamingDatabase,
  type AcquisitionNamingDirectoryIdentity,
  type AcquisitionNamingDirectoryIntent,
  type AcquisitionNamingFileIdentity,
  type AcquisitionNamingFileIntent,
  type AcquisitionNamingPolicy,
  type AcquisitionNamingScope,
} from "./acquisition-naming.js";
import { DEFAULT_NAMING_TEMPLATES } from "./naming.js";

const scope: AcquisitionNamingScope = {
  accountId: "account_naming",
  connectedStorageId: "storage_naming",
};

const title: MediaTitle = {
  id: "tmdb_tv_401",
  tmdbId: 401,
  type: "tv",
  title: "规范标题",
  originalTitle: "Canonical Show",
  year: 2026,
  aliases: [],
};

function directoryKey(identity: AcquisitionNamingDirectoryIdentity): string {
  return [
    identity.scope.accountId,
    identity.scope.connectedStorageId,
    identity.mediaType,
    identity.tmdbId,
    identity.directoryKey,
  ].join("\0");
}

function fileKey(identity: AcquisitionNamingFileIdentity): string {
  return [
    identity.scope.accountId,
    identity.scope.connectedStorageId,
    identity.mediaType,
    identity.tmdbId,
    identity.workflowRunId,
    identity.fileId,
  ].join("\0");
}

class MemoryNamingDatabase implements AcquisitionNamingDatabase {
  readonly directories = new Map<string, AcquisitionNamingDirectoryIntent>();
  readonly files = new Map<string, AcquisitionNamingFileIntent>();

  async resolvePolicy(): Promise<AcquisitionNamingPolicy> {
    throw new Error("The behavior tests inject the already-resolved policy");
  }

  async getDirectoryIntent(
    identity: AcquisitionNamingDirectoryIdentity,
  ): Promise<AcquisitionNamingDirectoryIntent | null> {
    return this.directories.get(directoryKey(identity)) ?? null;
  }

  async beginDirectoryIntent(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    rootDirectoryId: string;
    relativePath: string;
  }): Promise<AcquisitionNamingDirectoryIntent> {
    const key = directoryKey(input.identity);
    const existing = this.directories.get(key);
    if (existing) return existing;
    const created: AcquisitionNamingDirectoryIntent = {
      identity: input.identity,
      rootDirectoryId: input.rootDirectoryId,
      relativePath: input.relativePath,
      directoryId: null,
      status: "planned",
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    this.directories.set(key, created);
    return created;
  }

  async markDirectoryVerified(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    directoryId: string;
    relativePath?: string;
  }): Promise<void> {
    const current = this.directories.get(directoryKey(input.identity));
    if (!current) throw new Error("missing directory intent");
    this.directories.set(directoryKey(input.identity), {
      ...current,
      directoryId: input.directoryId,
      relativePath: input.relativePath ?? current.relativePath,
      status: "verified",
      updatedAt: "2026-11-16T00:00:01.000Z",
    });
  }

  async beginFileIntent(
    input: Omit<AcquisitionNamingFileIntent, "status" | "reason" | "updatedAt">,
  ): Promise<AcquisitionNamingFileIntent> {
    const key = fileKey(input.identity);
    const existing = this.files.get(key);
    if (existing) return existing;
    const created: AcquisitionNamingFileIntent = {
      ...input,
      status: "planned",
      reason: null,
      updatedAt: "2026-11-16T00:00:00.000Z",
    };
    this.files.set(key, created);
    return created;
  }

  async getFileIntent(identity: AcquisitionNamingFileIdentity): Promise<AcquisitionNamingFileIntent | null> {
    return this.files.get(fileKey(identity)) ?? null;
  }

  async listPendingFileIntents(input: {
    scope: AcquisitionNamingScope;
    mediaType: MediaTitle["type"];
    tmdbId: number;
  }): Promise<AcquisitionNamingFileIntent[]> {
    return [...this.files.values()].filter((intent) =>
      intent.identity.scope.accountId === input.scope.accountId
      && intent.identity.scope.connectedStorageId === input.scope.connectedStorageId
      && intent.identity.mediaType === input.mediaType
      && intent.identity.tmdbId === input.tmdbId
      && (intent.status === "planned" || intent.status === "failed")
    );
  }

  async markFileVerified(identity: AcquisitionNamingFileIdentity, targetDirectoryId: string): Promise<void> {
    const current = await this.getFileIntent(identity);
    if (!current) throw new Error("missing file intent");
    this.files.set(fileKey(identity), {
      ...current,
      targetDirectoryId,
      status: "verified",
      reason: null,
      updatedAt: "2026-11-16T00:00:01.000Z",
    });
  }

  async markFileSkipped(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void> {
    const current = await this.getFileIntent(identity);
    if (!current) throw new Error("missing file intent");
    this.files.set(fileKey(identity), {
      ...current,
      status: "skipped",
      reason,
      updatedAt: "2026-11-16T00:00:01.000Z",
    });
  }

  async markFileFailed(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void> {
    const current = await this.getFileIntent(identity);
    if (!current) throw new Error("missing file intent");
    this.files.set(fileKey(identity), {
      ...current,
      status: "failed",
      reason,
      updatedAt: "2026-11-16T00:00:01.000Z",
    });
  }
}

function policy(overrides: Partial<Record<keyof typeof DEFAULT_NAMING_TEMPLATES, string>> = {}): AcquisitionNamingPolicy {
  return {
    targetRootId: "tv_root",
    kind: "tv",
    matchedConfigIds: ["config"],
    templates: { ...DEFAULT_NAMING_TEMPLATES, ...overrides },
  };
}

function decorate(
  storage: FakeStorageExecutor,
  database: MemoryNamingDatabase,
  namingPolicy: AcquisitionNamingPolicy = policy(),
): FakeStorageExecutor {
  return withAcquisitionNaming({
    storage,
    database,
    scope,
    title,
    kind: "tv",
    categoryParentId: "tv_root",
    seasons: [1],
    workflowRunId: "run_naming",
    policy: namingPolicy,
  }) as FakeStorageExecutor;
}

function candidate(id: string): ResourceCandidate {
  return {
    id,
    snapshotId: "snapshot",
    index: 0,
    title: "Canonical Show S01E01",
    type: "115",
    source: "fixture",
    providerPayload: {},
  };
}

function transferredFile(
  id: string,
  name: string,
): {
  id: string;
  storageDirectoryId: string;
  name: string;
  sizeBytes: number;
  episodeCode: null;
  providerFileId: string;
} {
  return {
    id,
    storageDirectoryId: "",
    name,
    sizeBytes: 100,
    episodeCode: null,
    providerFileId: id,
  };
}

describe("F14b acquisition naming policy", () => {
  it("matches only the exact account, storage, media root and relevant template kind", () => {
    const common = {
      scope,
      tvTargetDirectoryId: "tv_root",
      movieTargetDirectoryId: "movie_root",
      sourceRoots: [],
    };
    const resolved = resolveAcquisitionNamingPolicyFromConfigurations({
      scope,
      targetRootId: "tv_root",
      kind: "tv",
      configurations: [
        {
          ...common,
          configId: "a",
          templates: {
            tvDirectory: "电视/{title}",
            seasonDirectory: "季度 {season:02}",
            episodeFile: "{title} - {episodeCode}{ext}",
            movieFile: "ignored-movie-change{ext}",
          },
        },
        {
          ...common,
          configId: "b",
          templates: {
            tvDirectory: "电视/{title}",
            seasonDirectory: "季度 {season:02}",
            episodeFile: "{title} - {episodeCode}{ext}",
          },
        },
        {
          ...common,
          configId: "other-storage",
          scope: { ...scope, connectedStorageId: "other" },
          templates: { tvDirectory: "冲突/{title}" },
        },
      ],
    });

    expect(resolved.matchedConfigIds).toEqual(["a", "b"]);
    expect(resolved.templates).toMatchObject({
      tvDirectory: "电视/{title}",
      seasonDirectory: "季度 {season:02}",
      episodeFile: "{title} - {episodeCode}{ext}",
    });
  });

  it("uses F01 defaults without a match and rejects conflicting matching configurations", () => {
    const defaults = resolveAcquisitionNamingPolicyFromConfigurations({
      scope,
      targetRootId: "tv_root",
      kind: "tv",
      configurations: [],
    });
    expect(defaults).toMatchObject({
      matchedConfigIds: [],
      templates: DEFAULT_NAMING_TEMPLATES,
    });

    expect(() => resolveAcquisitionNamingPolicyFromConfigurations({
      scope,
      targetRootId: "tv_root",
      kind: "tv",
      configurations: [
        { configId: "a", scope, tvTargetDirectoryId: "tv_root", templates: { episodeFile: "A{ext}" } },
        { configId: "b", scope, tvTargetDirectoryId: "tv_root", templates: { episodeFile: "B{ext}" } },
      ],
    })).toThrowError(AcquisitionNamingError);
  });

  it("rejects a file template that cannot preserve the actual extension before any write", () => {
    expect(() => resolveAcquisitionNamingPolicyFromConfigurations({
      scope,
      targetRootId: "tv_root",
      kind: "tv",
      configurations: [{
        configId: "bad",
        scope,
        tvTargetDirectoryId: "tv_root",
        templates: { episodeFile: "{title} - {episodeCode}.mkv" },
      }],
    })).toThrowError(/必须以 \{ext\} 结尾/u);
  });
});

describe("F14b acquisition naming decoration", () => {
  it("names a movie when transfer lands directly in the movie target without flattenMovie", async () => {
    const movieTitle: MediaTitle = {
      id: "tmdb_movie_802",
      tmdbId: 802,
      type: "movie",
      title: "规范电影",
      originalTitle: "Canonical Film",
      year: 2026,
      aliases: [],
    };
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        movie: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("movie1", "Film.Release.1080p.mkv")],
        },
      },
    });
    const wrapped = withAcquisitionNaming({
      storage,
      database,
      scope,
      title: movieTitle,
      kind: "movie",
      categoryParentId: "movie_root",
      seasons: [1],
      workflowRunId: "run_movie",
      policy: {
        targetRootId: "movie_root",
        kind: "movie",
        matchedConfigIds: [],
        templates: { ...DEFAULT_NAMING_TEMPLATES },
      },
    });
    const movieDirectory = await wrapped.createDirectory({
      name: "规范电影 (2026) {tmdb-802}",
      parentId: "movie_root",
    });
    storage.seedDirectoryFiles(movieDirectory, [{
      id: "old-movie",
      providerFileId: "old-movie",
      storageDirectoryId: movieDirectory,
      name: "用户保留的旧版.mkv",
      sizeBytes: 100,
      episodeCode: null,
    }]);

    await wrapped.transfer({
      workflowRunId: "run_movie",
      directoryId: movieDirectory,
      candidate: candidate("movie"),
    });

    const names = (await storage.listTree({ directoryId: movieDirectory })).map((file) => file.path);
    expect(names).toHaveLength(2);
    expect(names).toEqual(expect.arrayContaining([
      "规范电影 (2026).mkv",
      "用户保留的旧版.mkv",
    ]));
  });

  it("leaves a failed attempt's partial physical IDs unnamed and unjournaled", async () => {
    const partialTitle: MediaTitle = {
      id: "tmdb_movie_806",
      tmdbId: 806,
      type: "movie",
      title: "失败部分文件",
      originalTitle: "Failed Partial",
      year: 2026,
      aliases: [],
    };
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor();
    let failedAttempt: Awaited<ReturnType<typeof storage.transfer>> | undefined;
    storage.transfer = async (input) => {
      storage.seedDirectoryFiles(input.directoryId, [
        transferredFile("partial1", "Failed.Partial.1080p.mkv"),
      ]);
      failedAttempt = {
        id: "failed_partial_attempt",
        workflowRunId: input.workflowRunId,
        candidateId: input.candidate.id,
        status: "failed",
        providerMessage: "provider failed after one partial file landed",
        materializedFileIds: ["partial1"],
      };
      return failedAttempt;
    };
    const wrapped = withAcquisitionNaming({
      storage,
      database,
      scope,
      title: partialTitle,
      kind: "movie",
      categoryParentId: "movie_root",
      seasons: [1],
      workflowRunId: "run_failed_partial",
      policy: {
        targetRootId: "movie_root",
        kind: "movie",
        matchedConfigIds: [],
        templates: { ...DEFAULT_NAMING_TEMPLATES },
      },
    });
    const movieDirectory = await wrapped.createDirectory({
      name: "失败部分文件 (2026)",
      parentId: "movie_root",
    });

    const attempt = await wrapped.transfer({
      workflowRunId: "run_failed_partial",
      directoryId: movieDirectory,
      candidate: candidate("failed-partial"),
    });

    expect(attempt).toBe(failedAttempt);
    expect(attempt).toMatchObject({
      status: "failed",
      providerMessage: "provider failed after one partial file landed",
      materializedFileIds: ["partial1"],
    });
    expect((await storage.listTree({ directoryId: movieDirectory })).map((file) => file.path))
      .toEqual(["Failed.Partial.1080p.mkv"]);
    expect(database.files.size).toBe(0);
  });

  it("creates multi-level directories from templates and reuses their provider IDs after a template change", async () => {
    const storage = new FakeStorageExecutor();
    const database = new MemoryNamingDatabase();
    const first = decorate(storage, database, policy({
      tvDirectory: "节目/{title}",
      seasonDirectory: "季度/{season:02}",
    }));
    const showId = await first.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const seasonId = await first.createDirectory({
      name: "Season 01",
      parentId: showId,
    });
    expect((await storage.listChildDirectories("tv_root")).map((entry) => entry.name))
      .toEqual(["节目"]);
    expect((await storage.listChildDirectories(showId)).map((entry) => entry.name))
      .toEqual(["季度"]);

    const changed = decorate(storage, database, policy({
      tvDirectory: "完全不同的模板/{year}",
      seasonDirectory: "Changed {season}",
    }));
    expect(await changed.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    })).toBe(showId);
    expect(await changed.createDirectory({
      name: "Season 01",
      parentId: showId,
    })).toBe(seasonId);
    expect((await storage.listChildDirectories("tv_root")).map((entry) => entry.name))
      .toEqual(["节目"]);
  });

  it("uses the template for a new season under an existing canonical title directory", async () => {
    const storage = new FakeStorageExecutor();
    const database = new MemoryNamingDatabase();
    const existingShow = await storage.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const wrapped = decorate(storage, database, policy({
      seasonDirectory: "新季度/{season:02}",
    }));

    await wrapped.listChildDirectories("tv_root");
    const season = await wrapped.createDirectory({
      name: "Season 01",
      parentId: existingShow,
    });

    const templateRoot = await storage.listChildDirectories(existingShow);
    expect(templateRoot.map((entry) => entry.name)).toEqual(["新季度"]);
    expect((await storage.listChildDirectories(templateRoot[0]!.id)).map((entry) => [
      entry.id,
      entry.name,
    ])).toEqual([[season, "01"]]);
  });

  it("renames only the physically verified new video and leaves an existing version untouched", async () => {
    const database = new MemoryNamingDatabase();
    const outcome = {
      status: "succeeded" as const,
      providerMessage: "",
      files: [transferredFile("new1", "Source.S01E01.mkv")],
    };
    const storage = new FakeStorageExecutor({ transferOutcomes: { c1: outcome } });
    const wrapped = decorate(storage, database);
    const showId = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: showId });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: showId });
    storage.seedDirectoryFiles(season, [{
      id: "old1",
      providerFileId: "old1",
      storageDirectoryId: season,
      name: "用户保留的旧版.S01E01.mkv",
      sizeBytes: 200,
      episodeCode: "S01E01",
    }]);

    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("c1"),
    });
    await wrapped.moveFiles({
      fileIds: attempt.materializedFileIds,
      targetDirectoryId: season,
    });

    expect((await storage.listTree({ directoryId: season })).map((file) => [
      file.providerFileId,
      file.path,
    ])).toEqual([
      ["old1", "用户保留的旧版.S01E01.mkv"],
      ["new1", "规范标题 - S01E01.mkv"],
    ]);
    expect(database.files.size).toBe(1);
    expect([...database.files.values()][0]).toMatchObject({
      kind: "video",
      episodeCodes: ["S01E01"],
      status: "verified",
    });
  });

  it("adds a stable suffix when an old nested file already uses the rendered basename", async () => {
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        nestedCollision: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("newNested", "Source.S01E02.mkv")],
        },
      },
    });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    storage.seedDirectoryFiles(season, [{
      id: "oldNested",
      providerFileId: "oldNested",
      storageDirectoryId: season,
      name: "旧目录/规范标题 - S01E02.mkv",
      sizeBytes: 200,
      episodeCode: "S01E02",
    }]);
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("nestedCollision"),
    });

    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path))
      .toEqual(expect.arrayContaining([
        "旧目录/规范标题 - S01E02.mkv",
        expect.stringMatching(/^规范标题 - S01E02 \([0-9a-f]{8}\)\.mkv$/u),
      ]));
  });

  it("uses F01 deriveSubtitlePath to preserve language and forced markers", async () => {
    const database = new MemoryNamingDatabase();
    const outcome = {
      status: "succeeded" as const,
      providerMessage: "",
      files: [
        transferredFile("video", "Source.S01E01.mkv"),
        transferredFile("subtitle", "Source.S01E01.chs.forced.ass"),
      ],
    };
    const storage = new FakeStorageExecutor({ transferOutcomes: { pair: outcome } });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("pair"),
    });
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path).sort())
      .toEqual([
        "规范标题 - S01E01.chs.forced.ass",
        "规范标题 - S01E01.mkv",
      ]);
  });

  it("keeps a staging subtitle rename as a hint and finalizes it only after the move", async () => {
    const database = new MemoryNamingDatabase();
    const outcome = {
      status: "succeeded" as const,
      providerMessage: "",
      files: [
        transferredFile("video-hint", "Source.S01E01.mkv"),
        transferredFile("subtitle-hint", "Source.S01E01.chs.forced.ass"),
      ],
    };
    const storage = new FakeStorageExecutor({ transferOutcomes: { pair: outcome } });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("pair"),
    });

    await wrapped.renameFile({
      directoryId: staging,
      fileId: "subtitle-hint",
      newName: "Source.S01E01.zh.forced.ass",
    });
    expect([...database.files.values()]).toEqual([]);
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path).sort())
      .toEqual([
        "规范标题 - S01E01.mkv",
        "规范标题 - S01E01.zh.forced.ass",
      ]);
    expect(database.files.size).toBe(2);
  });

  it("verifies a timed-out staging subtitle rename before preserving its language marker", async () => {
    const database = new MemoryNamingDatabase();
    const outcome = {
      status: "succeeded" as const,
      providerMessage: "",
      files: [
        transferredFile("video-hint-timeout", "Source.S01E02.mkv"),
        transferredFile("subtitle-hint-timeout", "Source.S01E02.chs.ass"),
      ],
    };
    const storage = new FakeStorageExecutor({ transferOutcomes: { pairTimeout: outcome } });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("pairTimeout"),
    });
    const rename = storage.renameFile.bind(storage);
    storage.renameFile = async (input) => {
      await rename(input);
      throw new Error("simulated timeout after staging rename");
    };

    await wrapped.renameFile({
      directoryId: staging,
      fileId: "subtitle-hint-timeout",
      newName: "Source.S01E02.zh.forced.ass",
    });
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path).sort())
      .toEqual([
        "规范标题 - S01E02.mkv",
        "规范标题 - S01E02.zh.forced.ass",
      ]);
  });

  it("keeps a multi-episode video under its original name and records an explicit skip", async () => {
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        multi: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("multi1", "Source.S01E01E02.mkv")],
        },
      },
    });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("multi"),
    });
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path))
      .toEqual(["Source.S01E01E02.mkv"]);
    expect([...database.files.values()][0]).toMatchObject({
      episodeCodes: ["S01E01", "S01E02"],
      status: "skipped",
      reason: expect.stringContaining("多集"),
    });
  });

  it("recognizes an E-prefixed episode range and skips it instead of naming it as the first episode", async () => {
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        eRange: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("eRange1", "Source.S01E04-E05.mkv")],
        },
      },
    });
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("eRange"),
    });
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect((await storage.listTree({ directoryId: season })).map((file) => file.path))
      .toEqual(["Source.S01E04-E05.mkv"]);
    expect([...database.files.values()][0]).toMatchObject({
      episodeCodes: ["S01E04", "S01E05"],
      status: "skipped",
    });
  });

  it("reconciles a rename timeout by provider ID without issuing a blind second write", async () => {
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        timeout: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("timeout1", "Source.S01E03.mkv")],
        },
      },
    });
    let renames = 0;
    const rename = storage.renameFile.bind(storage);
    storage.renameFile = async (input) => {
      renames += 1;
      await rename(input);
      throw new Error("simulated timeout after provider rename");
    };
    const wrapped = decorate(storage, database);
    const show = await wrapped.createDirectory({
      name: "规范标题 (2026) {tmdb-401}",
      parentId: "tv_root",
    });
    const staging = await wrapped.createDirectory({ name: "staging-run_naming", parentId: show });
    const season = await wrapped.createDirectory({ name: "Season 01", parentId: show });
    const attempt = await wrapped.transfer({
      workflowRunId: "run_naming",
      directoryId: staging,
      candidate: candidate("timeout"),
    });
    await wrapped.moveFiles({ fileIds: attempt.materializedFileIds, targetDirectoryId: season });

    expect(renames).toBe(1);
    expect((await storage.listTree({ directoryId: season })).map((file) => file.path))
      .toEqual(["规范标题 - S01E03.mkv"]);
    expect([...database.files.values()][0]?.status).toBe("verified");
  });

  it("propagates a transfer error without naming provider IDs discovered after the failure", async () => {
    const movieTitle: MediaTitle = {
      id: "tmdb_movie_803",
      tmdbId: 803,
      type: "movie",
      title: "落盘电影",
      originalTitle: "Landed Film",
      year: 2026,
      aliases: [],
    };
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        timeoutTransfer: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("landed1", "Landed.Film.1080p.mkv")],
        },
      },
    });
    let transfers = 0;
    const transferError = new Error("simulated timeout after provider transfer");
    const transfer = storage.transfer.bind(storage);
    storage.transfer = async (input) => {
      transfers += 1;
      await transfer(input);
      throw transferError;
    };
    const wrapped = withAcquisitionNaming({
      storage,
      database,
      scope,
      title: movieTitle,
      kind: "movie",
      categoryParentId: "movie_root",
      seasons: [1],
      workflowRunId: "run_transfer_timeout",
      policy: {
        targetRootId: "movie_root",
        kind: "movie",
        matchedConfigIds: [],
        templates: { ...DEFAULT_NAMING_TEMPLATES },
      },
    });
    const movieDirectory = await wrapped.createDirectory({
      name: "落盘电影 (2026)",
      parentId: "movie_root",
    });

    await expect(wrapped.transfer({
      workflowRunId: "run_transfer_timeout",
      directoryId: movieDirectory,
      candidate: candidate("timeoutTransfer"),
    })).rejects.toBe(transferError);

    expect(transfers).toBe(1);
    expect((await storage.listTree({ directoryId: movieDirectory })).map((file) => file.path))
      .toEqual(["Landed.Film.1080p.mkv"]);
    expect(database.files.size).toBe(0);
  });

  it("reconciles a flatten timeout only after the new physical file is visibly flat", async () => {
    const movieTitle: MediaTitle = {
      id: "tmdb_movie_804",
      tmdbId: 804,
      type: "movie",
      title: "扁平电影",
      originalTitle: "Flat Film",
      year: 2026,
      aliases: [],
    };
    const database = new MemoryNamingDatabase();
    const storage = new FakeStorageExecutor({
      transferOutcomes: {
        flat: {
          status: "succeeded",
          providerMessage: "",
          files: [transferredFile("flat1", "Flat.Film.2160p.mkv")],
        },
      },
    });
    const wrapped = withAcquisitionNaming({
      storage,
      database,
      scope,
      title: movieTitle,
      kind: "movie",
      categoryParentId: "movie_root",
      seasons: [1],
      workflowRunId: "run_flatten_timeout",
      policy: {
        targetRootId: "movie_root",
        kind: "movie",
        matchedConfigIds: [],
        templates: { ...DEFAULT_NAMING_TEMPLATES },
      },
    });
    const movieDirectory = await wrapped.createDirectory({
      name: "扁平电影 (2026)",
      parentId: "movie_root",
    });
    await wrapped.transfer({
      workflowRunId: "run_flatten_timeout",
      directoryId: movieDirectory,
      candidate: candidate("flat"),
    });
    let flattens = 0;
    storage.flattenDirectory = async () => {
      flattens += 1;
      throw new Error("simulated timeout after provider flatten");
    };

    const result = await wrapped.flattenDirectory(movieDirectory);

    expect(flattens).toBe(1);
    expect(result.moved).toEqual(["flat1"]);
    expect((await storage.listTree({ directoryId: movieDirectory })).map((file) => file.path))
      .toEqual(["扁平电影 (2026).mkv"]);
  });
});
