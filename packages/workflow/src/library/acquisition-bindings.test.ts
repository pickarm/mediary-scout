import { describe, expect, it } from "vitest";
import { FakeStorageExecutor } from "../fakes.js";
import type { VerifiedFile } from "../domain.js";
import { ensureMediaLibraryDirectory } from "../media-library-folder.js";
import { ensureSeasonAcquisitionDirectories } from "../acquisition-v2/directory-lifecycle.js";
import {
  AcquisitionBindingSafetyError,
  protectExistingFromPlan,
  resolveAcquisitionBindingPlan,
  withBoundAcquisitionDirectories,
} from "./acquisition-bindings.js";
import type {
  LibraryDirectoryBinding,
  LibraryPhysicalFileBinding,
  LibraryStore,
} from "./types.js";

const NOW = "2026-11-16T00:00:00.000Z";

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

function binding(input: {
  directoryId: string;
  parentDirectoryId: string | null;
  mediaTitleId?: string;
  trackedSeasonId?: string;
  mediaType?: "tv" | "movie" | "anime";
  tmdbId?: number;
  seasonNumber?: number;
  exclusive?: boolean;
}): LibraryDirectoryBinding {
  return {
    accountId: "acct",
    connectedStorageId: "drive",
    directoryId: input.directoryId,
    parentDirectoryId: input.parentDirectoryId,
    mediaTitleId: input.mediaTitleId ?? "tmdb_tv_1",
    trackedSeasonId: input.trackedSeasonId ?? "tmdb_tv_1_s1",
    mediaType: input.mediaType ?? "tv",
    tmdbId: input.tmdbId ?? 1,
    seasonNumber: input.seasonNumber ?? 1,
    exclusive: input.exclusive ?? false,
    boundAt: NOW,
  };
}

function fileBinding(input: {
  fileId: string;
  parentDirectoryId: string;
  episodeCodes: string[];
  mediaTitleId?: string;
  trackedSeasonId?: string;
  mediaType?: "tv" | "movie" | "anime";
  tmdbId?: number;
}): LibraryPhysicalFileBinding {
  return {
    accountId: "acct",
    connectedStorageId: "drive",
    fileId: input.fileId,
    parentDirectoryId: input.parentDirectoryId,
    mediaTitleId: input.mediaTitleId ?? "tmdb_tv_1",
    trackedSeasonId: input.trackedSeasonId ?? "tmdb_tv_1_s1",
    mediaType: input.mediaType ?? "tv",
    tmdbId: input.tmdbId ?? 1,
    episodeCodes: input.episodeCodes,
    sizeBytes: 100,
    quality: null,
    boundAt: NOW,
  };
}

function fakeLibrary(input: {
  files: LibraryPhysicalFileBinding[];
  bindings: Record<string, LibraryDirectoryBinding | null>;
}): Pick<LibraryStore, "findDirectoryBinding" | "listPhysicalFileBindings"> {
  return {
    async listPhysicalFileBindings(query) {
      const after = query.afterFileId;
      const limit = query.limit ?? 100;
      const candidates = input.files
        .filter((file) => file.mediaTitleId === query.mediaTitleId)
        .filter((file) => after === undefined || file.fileId > after)
        .sort((left, right) => left.fileId.localeCompare(right.fileId));
      return candidates.slice(0, limit);
    },
    async findDirectoryBinding(query) {
      return input.bindings[query.directoryId] ?? null;
    },
  };
}

describe("F14a acquisition directory bindings", () => {
  it("resolves a custom-named show/season and reuses both IDs instead of creating canonical twins", async () => {
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "我的自定义剧名", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "特别季目录", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [
      video("f1", seasonId, "E01.mkv"),
      video("f2", seasonId, "E02.mkv"),
    ]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "f1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
        fileBinding({ fileId: "f2", parentDirectoryId: seasonId, episodeCodes: ["S01E02"] }),
      ],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      kind: "tv",
      showDirectoryId: showId,
      seasonDirectoryIds: { 1: seasonId },
      importedEpisodeCodes: ["S01E01", "S01E02"],
      multiVersionEpisodeCodes: [],
    });
    expect(protectExistingFromPlan(plan)).toEqual({ episodes: "unknown" });

    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "tv_root",
      plan: plan!,
    });
    const directories = await ensureSeasonAcquisitionDirectories({
      executor: decorated,
      categoryParentId: "tv_root",
      showName: "规范标题",
      year: 2024,
      tmdbId: 1,
      seasons: [1],
      workflowRunId: "run-1",
    });
    expect(directories.showDirectoryId).toBe(showId);
    expect(directories.seasonDirectoryIds[1]).toBe(seasonId);

    const categoryChildren = await storage.listChildDirectories("tv_root");
    expect(categoryChildren.map((child) => child.name)).toEqual(["我的自定义剧名"]);
    const showChildren = await storage.listChildDirectories(showId);
    expect(showChildren.map((child) => child.name)).toContain("特别季目录");
    expect(showChildren.map((child) => child.name)).not.toContain("规范标题 (2024) {tmdb-1}");
  });

  it("does not redirect a new temporary directory under the acquisition root to the bound title", async () => {
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "我的自定义剧名", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "特别季目录", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("f1", seasonId, "E01.mkv")]);

    const library = fakeLibrary({
      files: [fileBinding({ fileId: "f1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] })],
      bindings: { [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }) },
    });
    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
      categoryParentId: "tv_root",
      seasons: [1],
    });
    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "tv_root",
      plan: plan!,
    });

    // A recovery/temp directory under the SAME category root must be created
    // normally; only the canonical/legacy title name reuses the imported ID.
    const temporaryId = await decorated.createDirectory({ name: "恢复临时目录", parentId: "tv_root" });
    expect(temporaryId).not.toBe(showId);
    expect((await storage.listChildDirectories("tv_root")).map((child) => child.id)).toEqual(
      expect.arrayContaining([showId, temporaryId]),
    );

    // The title root's own canonical name is still redirected to the existing ID.
    expect(await decorated.createDirectory({ name: "规范标题 (2024) {tmdb-1}", parentId: "tv_root" })).toBe(showId);

    // A run-scoped staging directory under the show dir is likewise created,
    // not confused with a season or the show itself.
    const stagingId = await decorated.createDirectory({ name: "staging-run-2", parentId: showId });
    expect(stagingId).not.toBe(showId);
    expect(stagingId).not.toBe(seasonId);
  });

  it("reuses a nested show and season through verified multi-level template paths", async () => {
    const storage = new FakeStorageExecutor();
    const intermediateId = await storage.createDirectory({ name: "多级模板", parentId: "tv_root" });
    const showId = await storage.createDirectory({ name: "我的嵌套剧目录", parentId: intermediateId });
    const seasonId = await storage.createDirectory({ name: "特别季目录", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("nested-1", seasonId, "E01.mkv")]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "nested-1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
      ],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
        [showId]: binding({ directoryId: showId, parentDirectoryId: intermediateId }),
        [intermediateId]: binding({ directoryId: intermediateId, parentDirectoryId: "tv_root" }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      showDirectoryId: showId,
      titleRootParentDirectoryId: intermediateId,
      seasonDirectoryIds: { 1: seasonId },
    });

    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "tv_root",
      plan: plan!,
    });
    const directories = await ensureSeasonAcquisitionDirectories({
      executor: decorated,
      categoryParentId: "tv_root",
      showName: "规范标题",
      year: 2024,
      tmdbId: 1,
      seasons: [1],
      workflowRunId: "run-nested",
    });
    expect(directories.showDirectoryId).toBe(showId);
    expect(directories.seasonDirectoryIds[1]).toBe(seasonId);

    // The nested title root is reusable from its real parent too. A temporary
    // directory at that parent still goes through the original executor.
    expect(await decorated.createDirectory({ name: "规范标题 (2024) {tmdb-1}", parentId: intermediateId })).toBe(
      showId,
    );
    const temporaryId = await decorated.createDirectory({ name: "恢复临时目录", parentId: intermediateId });
    expect(temporaryId).not.toBe(showId);

    expect((await storage.listChildDirectories("tv_root")).map((child) => child.id)).toEqual([intermediateId]);
    expect((await storage.listChildDirectories(intermediateId)).map((child) => child.id)).toEqual(
      expect.arrayContaining([showId, temporaryId]),
    );
    expect((await storage.listChildDirectories(showId)).map((child) => child.id)).toEqual(
      expect.arrayContaining([seasonId, directories.stagingDirectoryId]),
    );
    expect((await storage.listChildDirectories(showId)).map((child) => child.name)).not.toContain("Season 01");
  });

  it("falls back to a bounded real walk when persisted ancestor hints are incomplete", async () => {
    const storage = new FakeStorageExecutor();
    const intermediateId = await storage.createDirectory({ name: "A", parentId: "tv_root" });
    const deeperId = await storage.createDirectory({ name: "B", parentId: intermediateId });
    const showId = await storage.createDirectory({ name: "自定义作品目录", parentId: deeperId });
    const seasonId = await storage.createDirectory({ name: "特别季", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("walk-1", seasonId, "E01.mkv")]);

    // Only the target season has a persisted parent. The show/intermediate
    // ancestors must be discovered from actual listings, never trusted by ID.
    const library = fakeLibrary({
      files: [fileBinding({ fileId: "walk-1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] })],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      showDirectoryId: showId,
      titleRootParentDirectoryId: deeperId,
      seasonDirectoryIds: { 1: seasonId },
    });

    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "tv_root",
      plan: plan!,
    });
    const directories = await ensureSeasonAcquisitionDirectories({
      executor: decorated,
      categoryParentId: "tv_root",
      showName: "规范标题",
      year: 2024,
      tmdbId: 1,
      seasons: [1],
      workflowRunId: "run-walk",
    });
    expect(directories.showDirectoryId).toBe(showId);
    expect(directories.seasonDirectoryIds[1]).toBe(seasonId);
    expect((await storage.listChildDirectories("tv_root")).map((child) => child.id)).toEqual([intermediateId]);
    expect((await storage.listChildDirectories(showId)).map((child) => child.name)).not.toContain("Season 01");
  });

  it("rejects a scanned binding outside the acquisition category without creating a duplicate", async () => {
    const storage = new FakeStorageExecutor();
    const unrelatedRoot = await storage.createDirectory({ name: "其他扫描根", parentId: "root" });
    const showId = await storage.createDirectory({ name: "外部剧目录", parentId: unrelatedRoot });
    const seasonId = await storage.createDirectory({ name: "S01", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("outside-1", seasonId, "E01.mkv")]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "outside-1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
      ],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
      },
    });

    await expect(
      resolveAcquisitionBindingPlan({
        storage,
        library,
        accountId: "acct",
        connectedStorageId: "drive",
        title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
        categoryParentId: "tv_root",
        seasons: [1],
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_BINDING_OUTSIDE_SANDBOX" });
    expect(await storage.listChildDirectories("tv_root")).toEqual([]);
  });

  it("rejects a directory whose F02 binding is missing or shared", async () => {
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "剧目录", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "Season 01", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("shared-1", seasonId, "E01.mkv")]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "shared-1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
      ],
      bindings: { [seasonId]: null },
    });

    await expect(
      resolveAcquisitionBindingPlan({
        storage,
        library,
        accountId: "acct",
        connectedStorageId: "drive",
        title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
        categoryParentId: "tv_root",
        seasons: [1],
      }),
    ).rejects.toBeInstanceOf(AcquisitionBindingSafetyError);
  });

  it("does not treat a directory with an unbound video as exclusive evidence", async () => {
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "剧目录", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "Season 01", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [
      video("known-1", seasonId, "E01.mkv"),
      video("foreign-1", seasonId, "另一部剧.mkv"),
    ]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "known-1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
      ],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
      },
    });

    await expect(
      resolveAcquisitionBindingPlan({
        storage,
        library,
        accountId: "acct",
        connectedStorageId: "drive",
        title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
        categoryParentId: "tv_root",
        seasons: [1],
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_BINDING_NOT_EXCLUSIVE" });
  });

  it("marks imported multi-version episodes for protectExisting", async () => {
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "多版本剧", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "S1", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [
      video("v1", seasonId, "E01.1080p.mkv"),
      video("v2", seasonId, "E01.4K.mkv"),
    ]);

    const library = fakeLibrary({
      files: [
        fileBinding({ fileId: "v1", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
        fileBinding({ fileId: "v2", parentDirectoryId: seasonId, episodeCodes: ["S01E01"] }),
      ],
      bindings: {
        [seasonId]: binding({ directoryId: seasonId, parentDirectoryId: showId }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_tv_1", type: "tv", title: "规范标题", year: 2024, tmdbId: 1 },
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan?.multiVersionEpisodeCodes).toEqual(["S01E01"]);
    expect(protectExistingFromPlan(plan)).toEqual({ episodes: ["S01E01"] });
  });

  it("reuses a custom movie directory through the original ensureMediaLibraryDirectory path", async () => {
    const storage = new FakeStorageExecutor();
    const movieDirectoryId = await storage.createDirectory({ name: "我的电影目录", parentId: "movies_root" });
    storage.seedDirectoryFiles(movieDirectoryId, [video("movie-file", movieDirectoryId, "Movie.mkv")]);

    const library = fakeLibrary({
      files: [
        fileBinding({
          fileId: "movie-file",
          parentDirectoryId: movieDirectoryId,
          episodeCodes: ["MOVIE"],
          mediaTitleId: "tmdb_movie_2",
          trackedSeasonId: "tmdb_movie_2_movie",
          mediaType: "movie",
          tmdbId: 2,
        }),
      ],
      bindings: {
        [movieDirectoryId]: binding({
          directoryId: movieDirectoryId,
          parentDirectoryId: "movies_root",
          mediaTitleId: "tmdb_movie_2",
          trackedSeasonId: "tmdb_movie_2_movie",
          mediaType: "movie",
          tmdbId: 2,
        }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_movie_2", type: "movie", title: "规范电影", year: 2020, tmdbId: 2 },
      categoryParentId: "movies_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({ kind: "movie", movieDirectoryId, showDirectoryId: null });

    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "movies_root",
      plan: plan!,
    });
    const resolved = await ensureMediaLibraryDirectory({
      executor: decorated,
      parentId: "movies_root",
      title: "规范电影",
      year: 2020,
      tmdbId: 2,
    });
    expect(resolved).toBe(movieDirectoryId);
    expect((await storage.listChildDirectories("movies_root")).map((child) => child.name)).toEqual([
      "我的电影目录",
    ]);
  });

  it("reuses a nested movie directory without creating a canonical twin", async () => {
    const storage = new FakeStorageExecutor();
    const intermediateId = await storage.createDirectory({ name: "电影多级模板", parentId: "movies_root" });
    const movieDirectoryId = await storage.createDirectory({ name: "我的嵌套电影目录", parentId: intermediateId });
    storage.seedDirectoryFiles(movieDirectoryId, [video("nested-movie", movieDirectoryId, "Movie.mkv")]);

    const library = fakeLibrary({
      files: [
        fileBinding({
          fileId: "nested-movie",
          parentDirectoryId: movieDirectoryId,
          episodeCodes: ["MOVIE"],
          mediaTitleId: "tmdb_movie_3",
          trackedSeasonId: "tmdb_movie_3_movie",
          mediaType: "movie",
          tmdbId: 3,
        }),
      ],
      bindings: {
        [movieDirectoryId]: binding({
          directoryId: movieDirectoryId,
          parentDirectoryId: intermediateId,
          mediaTitleId: "tmdb_movie_3",
          trackedSeasonId: "tmdb_movie_3_movie",
          mediaType: "movie",
          tmdbId: 3,
        }),
        [intermediateId]: binding({
          directoryId: intermediateId,
          parentDirectoryId: "movies_root",
          mediaTitleId: "tmdb_movie_3",
          trackedSeasonId: "tmdb_movie_3_movie",
          mediaType: "movie",
          tmdbId: 3,
        }),
      },
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library,
      accountId: "acct",
      connectedStorageId: "drive",
      title: { id: "tmdb_movie_3", type: "movie", title: "规范电影", year: 2021, tmdbId: 3 },
      categoryParentId: "movies_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      kind: "movie",
      movieDirectoryId,
      titleRootParentDirectoryId: intermediateId,
    });

    const decorated = withBoundAcquisitionDirectories({
      storage,
      categoryParentId: "movies_root",
      plan: plan!,
    });
    const resolved = await ensureMediaLibraryDirectory({
      executor: decorated,
      parentId: "movies_root",
      title: "规范电影",
      year: 2021,
      tmdbId: 3,
    });
    expect(resolved).toBe(movieDirectoryId);
    expect(await decorated.createDirectory({ name: "规范电影 (2021) {tmdb-3}", parentId: intermediateId })).toBe(
      movieDirectoryId,
    );
    const temporaryId = await decorated.createDirectory({ name: "恢复临时目录", parentId: intermediateId });
    expect(temporaryId).not.toBe(movieDirectoryId);

    expect((await storage.listChildDirectories("movies_root")).map((child) => child.id)).toEqual([intermediateId]);
    expect((await storage.listChildDirectories(intermediateId)).map((child) => child.id)).toEqual(
      expect.arrayContaining([movieDirectoryId, temporaryId]),
    );
  });
});
