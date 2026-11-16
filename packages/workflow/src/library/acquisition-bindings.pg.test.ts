import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EpisodeState, MediaTitle, TrackedSeason, VerifiedFile } from "../domain.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { FakeStorageExecutor } from "../fakes.js";
import {
  protectExistingFromPlan,
  resolveAcquisitionBindingPlan,
} from "./acquisition-bindings.js";
import { PostgresLibraryStore } from "./store.js";
import type { ImportExistingMediaInput } from "./types.js";

const adminConnectionString =
  process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL ?? process.env.TEST_POSTGRES_ADMIN;
const integration = describe.skipIf(!adminConnectionString);

integration("F14a acquisition bindings from the real library schema", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresLibraryStore;
  let databaseName: string;

  const dbTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `acquisition_bindings_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    await initializeWorkflowPostgresSchema(pool);
    store = new PostgresLibraryStore(pool);
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  }, 30_000);

  async function createScope(): Promise<{ accountId: string; connectedStorageId: string }> {
    const suffix = randomUUID().replaceAll("-", "");
    const accountId = `acct_${suffix}`;
    const connectedStorageId = `storage_${suffix}`;
    await pool.query(
      "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, '', false, now()::text)",
      [accountId, `user_${suffix}`],
    );
    await pool.query(
      "INSERT INTO connected_storages " +
        "(id, account_id, provider, provider_uid, payload, created_at) VALUES ($1, $2, 'quark', $3, '{}'::jsonb, now()::text)",
      [connectedStorageId, accountId, `uid_${suffix}`],
    );
    return { accountId, connectedStorageId };
  }

  function makeTitle(tmdbId: number): MediaTitle {
    return {
      id: `tmdb_tv_${tmdbId}`,
      tmdbId,
      type: "tv",
      title: `自定义剧 ${tmdbId}`,
      originalTitle: `Custom Show ${tmdbId}`,
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
      storageDirectoryId: `storage_dir_${title.tmdbId}`,
      totalEpisodes: 2,
      latestAiredEpisode: 2,
      latestAiredSource: "metadata",
    };
  }

  function makeEpisode(season: TrackedSeason, code: string): EpisodeState {
    return {
      trackedSeasonId: season.id,
      episodeCode: code,
      airDate: null,
      title: code,
      airStatus: "aired",
      obtained: false,
      metadataStatus: "confirmed",
      verifiedFileIds: [],
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

  dbTest("reuses a custom-named imported season by provider ID and protects multi-version episodes", async () => {
    const scope = await createScope();
    const title = makeTitle(24101);
    const season = makeSeason(title);
    const storage = new FakeStorageExecutor();
    const showId = await storage.createDirectory({ name: "我的自定义剧名", parentId: "tv_root" });
    const seasonId = await storage.createDirectory({ name: "特别季目录", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [
      video("v1080", seasonId, "E01.1080p.mkv"),
      video("v4k", seasonId, "E01.4K.mkv"),
      video("v2", seasonId, "E02.mkv"),
    ]);

    const input: ImportExistingMediaInput = {
      ...scope,
      title,
      season,
      episodes: [makeEpisode(season, "S01E01"), makeEpisode(season, "S01E02")],
      files: [
        { fileId: "v1080", parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 100, quality: "1080p" },
        { fileId: "v4k", parentDirectoryId: seasonId, episodeCode: "S01E01", sizeBytes: 200, quality: "2160p" },
        { fileId: "v2", parentDirectoryId: seasonId, episodeCode: "S01E02", sizeBytes: 300, quality: "1080p" },
      ],
      // No explicit exclusive flag: the plan must prove it from the real files.
      directories: [{ directoryId: seasonId, parentDirectoryId: showId }],
      now: "2026-11-16T00:00:00.000Z",
    };
    const imported = await store.importExistingMedia(input);
    expect(imported).toMatchObject({ importedFiles: 3, directoryBindings: 1 });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library: store,
      accountId: scope.accountId,
      connectedStorageId: scope.connectedStorageId,
      title,
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      kind: "tv",
      showDirectoryId: showId,
      seasonDirectoryIds: { 1: seasonId },
      importedEpisodeCodes: ["S01E01", "S01E02"],
      multiVersionEpisodeCodes: ["S01E01"],
    });
    expect(protectExistingFromPlan(plan)).toEqual({ episodes: ["S01E01"] });
  });

  dbTest("reuses a nested custom show when every real schema ancestor edge is verified", async () => {
    const scope = await createScope();
    const title = makeTitle(24103);
    const season = makeSeason(title);
    const storage = new FakeStorageExecutor();
    const intermediateId = await storage.createDirectory({ name: "多级模板", parentId: "tv_root" });
    const showId = await storage.createDirectory({ name: "我的嵌套剧目录", parentId: intermediateId });
    const seasonId = await storage.createDirectory({ name: "特别季目录", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("nested-pg", seasonId, "E01.mkv")]);

    await store.importExistingMedia({
      ...scope,
      title,
      season,
      episodes: [makeEpisode(season, "S01E01")],
      files: [{ fileId: "nested-pg", parentDirectoryId: seasonId, episodeCode: "S01E01" }],
      // The scanner can persist the real ancestor facts too. Every one is used
      // only as a hint; resolveAcquisitionBindingPlan still lists each edge.
      directories: [
        { directoryId: seasonId, parentDirectoryId: showId },
        { directoryId: showId, parentDirectoryId: intermediateId },
        { directoryId: intermediateId, parentDirectoryId: "tv_root" },
      ],
      now: "2026-11-16T00:00:00.000Z",
    });

    const plan = await resolveAcquisitionBindingPlan({
      storage,
      library: store,
      accountId: scope.accountId,
      connectedStorageId: scope.connectedStorageId,
      title,
      categoryParentId: "tv_root",
      seasons: [1],
    });
    expect(plan).toMatchObject({
      kind: "tv",
      showDirectoryId: showId,
      titleRootParentDirectoryId: intermediateId,
      seasonDirectoryIds: { 1: seasonId },
      importedEpisodeCodes: ["S01E01"],
    });
  });

  dbTest("rejects an imported binding outside the acquisition root without creating a twin", async () => {
    const scope = await createScope();
    const title = makeTitle(24102);
    const season = makeSeason(title);
    const storage = new FakeStorageExecutor();
    const otherRoot = await storage.createDirectory({ name: "其他扫描根", parentId: "root" });
    const showId = await storage.createDirectory({ name: "外部剧目录", parentId: otherRoot });
    const seasonId = await storage.createDirectory({ name: "S01", parentId: showId });
    storage.seedDirectoryFiles(seasonId, [video("outside", seasonId, "E01.mkv")]);
    await store.importExistingMedia({
      ...scope,
      title,
      season,
      episodes: [makeEpisode(season, "S01E01")],
      files: [{ fileId: "outside", parentDirectoryId: seasonId, episodeCode: "S01E01" }],
      directories: [{ directoryId: seasonId, parentDirectoryId: showId }],
      now: "2026-11-16T00:00:00.000Z",
    });

    await expect(
      resolveAcquisitionBindingPlan({
        storage,
        library: store,
        accountId: scope.accountId,
        connectedStorageId: scope.connectedStorageId,
        title,
        categoryParentId: "tv_root",
        seasons: [1],
      }),
    ).rejects.toMatchObject({ code: "ACQUISITION_BINDING_OUTSIDE_SANDBOX" });
    expect(await storage.listChildDirectories("tv_root")).toEqual([]);
  });
});
