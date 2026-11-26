import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EpisodeState, MediaTitle, TrackedSeason } from "../domain.js";
import { initializeWorkflowPostgresSchema, PostgresWorkflowRepository } from "../postgres.js";
import { LibraryImportConflictError, LibraryStorageScopeError, PostgresLibraryStore } from "./store.js";
import type { ImportExistingMediaInput } from "./types.js";

const adminConnectionString =
  process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL ?? process.env.TEST_POSTGRES_ADMIN;
const integration = describe.skipIf(!adminConnectionString);

integration("PostgresLibraryStore existing-media import", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresLibraryStore;
  let databaseName: string;

  const dbTest = (name: string, test: () => Promise<void>) => it(name, test, 30_000);

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("Integration connection string is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `library_import_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString() });
    pool.on("error", () => {});
    store = new PostgresLibraryStore(pool);
    await initializeWorkflowPostgresSchema(pool);
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

  function makeTitle(type: MediaTitle["type"], tmdbId: number): MediaTitle {
    return {
      id: `tmdb_${type === "anime" ? "tv" : type}_${tmdbId}`,
      tmdbId,
      type,
      title: `${type}-${tmdbId}`,
      originalTitle: `${type}-${tmdbId}`,
      year: 2020,
      aliases: [],
    };
  }

  function makeSeason(title: MediaTitle, status: TrackedSeason["status"] = "active"): TrackedSeason {
    const seasonNumber = title.type === "movie" ? 1 : 1;
    return {
      id: title.type === "movie" ? `${title.id}_movie` : `${title.id}_s${seasonNumber}`,
      mediaTitleId: title.id,
      seasonNumber,
      status,
      qualityPreference: "high",
      storageDirectoryId: `dir_${title.type}_${title.tmdbId}`,
      totalEpisodes: title.type === "movie" ? 1 : 2,
      latestAiredEpisode: title.type === "movie" ? 1 : 2,
      latestAiredSource: "metadata",
    };
  }

  function makeEpisode(season: TrackedSeason, episodeCode: string, obtained = false): EpisodeState {
    return {
      trackedSeasonId: season.id,
      episodeCode,
      airDate: null,
      title: episodeCode,
      airStatus: "aired",
      obtained,
      metadataStatus: "confirmed",
      verifiedFileIds: [],
    };
  }

  function importInput(input: {
    accountId: string;
    connectedStorageId: string;
    title: MediaTitle;
    season: TrackedSeason;
    files?: ImportExistingMediaInput["files"];
    episodes?: ImportExistingMediaInput["episodes"];
    directoryId?: string;
    exclusive?: boolean;
  }): ImportExistingMediaInput {
    const directoryId = input.directoryId ?? `dir_${input.title.type}_${input.title.tmdbId}`;
    return {
      accountId: input.accountId,
      connectedStorageId: input.connectedStorageId,
      title: input.title,
      season: input.season,
      episodes:
        input.episodes ??
        (input.title.type === "movie"
          ? [makeEpisode(input.season, "S01E01")]
          : [makeEpisode(input.season, "S01E01"), makeEpisode(input.season, "S01E02")]),
      files: input.files ?? [],
      directories: [{
        directoryId,
        parentDirectoryId: `parent_${directoryId}`,
        ...(input.exclusive === undefined ? {} : { exclusive: input.exclusive }),
      }],
      now: "2026-11-14T10:00:00.000Z",
    };
  }

  dbTest("imports file IDs once, retains versions, and writes no workflow or transfer record", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23001);
    const season = makeSeason(title);
    const input = importInput({
      ...scope,
      title,
      season,
      files: [
        { fileId: "v1", parentDirectoryId: "season-dir", episodeCode: "S01E01", sizeBytes: 100, quality: "1080p" },
        { fileId: "v2", parentDirectoryId: "season-dir", episodeCode: "S01E01", sizeBytes: 200, quality: "2160p" },
        { fileId: "v3", parentDirectoryId: "season-dir", episodeCode: "S01E02", sizeBytes: 300, quality: "1080p" },
      ],
      directoryId: "season-dir",
      exclusive: true,
    });

    const secondStore = new PostgresLibraryStore(pool);
    const [first, second] = await Promise.all([
      store.importExistingMedia(input),
      secondStore.importExistingMedia(input),
    ]);
    expect(first.importedFiles + second.importedFiles).toBe(3);
    expect(first.alreadyImportedFiles + second.alreadyImportedFiles).toBe(3);
    expect(first.directoryBindings + second.directoryBindings).toBe(2);
    const third = await store.importExistingMedia(input);
    expect(third).toMatchObject({ importedFiles: 0, alreadyImportedFiles: 3, directoryBindings: 1 });

    const copies = await pool.query<{ episode_code: string; file_ids: string[]; size_bytes: string }>(
      "SELECT episode_code, file_ids, size_bytes FROM episode_copies WHERE tracked_season_id = $1 AND storage_id = $2 ORDER BY episode_code",
      [season.id, scope.connectedStorageId],
    );
    expect(copies.rows).toEqual([
      { episode_code: "S01E01", file_ids: ["v1", "v2"], size_bytes: "300" },
      { episode_code: "S01E02", file_ids: ["v3"], size_bytes: "300" },
    ]);

    const states = await pool.query<{ episode_code: string; payload: EpisodeState }>(
      "SELECT episode_code, payload FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2 ORDER BY episode_code",
      [season.id, scope.connectedStorageId],
    );
    expect(states.rows.map((row) => row.payload)).toEqual([
      expect.objectContaining({ obtained: true, verifiedFileIds: ["v1", "v2"] }),
      expect.objectContaining({ obtained: true, verifiedFileIds: ["v3"] }),
    ]);
    const workflowRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM workflow_runs WHERE tracked_season_id = $1",
      [season.id],
    );
    const transferRows = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM transfer_attempts",
    );
    expect(workflowRows.rows[0]?.count).toBe("0");
    expect(transferRows.rows[0]?.count).toBe("0");

    expect(await store.findDirectoryBinding({ ...scope, directoryId: "season-dir" })).toMatchObject({
      mediaTitleId: title.id,
      trackedSeasonId: season.id,
      parentDirectoryId: "parent_season-dir",
      exclusive: true,
    });
    expect(await store.findTitleDirectory({ ...scope, mediaTitleId: title.id, seasonNumber: 1 })).toMatchObject({
      directoryId: "season-dir",
    });
    expect(await store.listPhysicalFileBindings({ ...scope, trackedSeasonId: season.id, limit: 2 })).toHaveLength(2);
    expect(
      await store.listPhysicalFileBindings({ ...scope, trackedSeasonId: season.id, limit: 2, afterFileId: "v2" }),
    ).toMatchObject([{ fileId: "v3", mediaTitleId: title.id }]);
  });

  dbTest("preserves an existing season setting and obtained state across rescans", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23002);
    const season = makeSeason(title, "completed");
    const initial = importInput({
      ...scope,
      title,
      season,
      files: [{ fileId: "original", parentDirectoryId: "original-dir", episodeCode: "S01E01" }],
      directoryId: "original-dir",
    });
    await store.importExistingMedia(initial);
    await store.setSeasonAutoAcquire({
      ...scope,
      trackedSeasonId: season.id,
      autoAcquire: true,
    });

    const changedSeason: TrackedSeason = {
      ...season,
      status: "active",
      storageDirectoryId: "new-scan-directory",
      autoAcquire: false,
    };
    await store.importExistingMedia({
      ...initial,
      season: changedSeason,
      episodes: [makeEpisode(changedSeason, "S01E01", false)],
      files: [],
      directories: [],
    });

    const storedSeason = await pool.query<{ payload: TrackedSeason }>(
      "SELECT payload FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2",
      [season.id, scope.connectedStorageId],
    );
    expect(storedSeason.rows[0]?.payload).toMatchObject({
      status: "completed",
      storageDirectoryId: season.storageDirectoryId,
      autoAcquire: true,
    });
    const episode = await pool.query<{ payload: EpisodeState }>(
      "SELECT payload FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2 AND episode_code = 'S01E01'",
      [season.id, scope.connectedStorageId],
    );
    expect(episode.rows[0]?.payload).toMatchObject({ obtained: true, verifiedFileIds: ["original"] });

    const newTitle = makeTitle("tv", 23003);
    const newSeason = makeSeason(newTitle);
    await store.importExistingMedia(importInput({ ...scope, title: newTitle, season: newSeason }));
    const importedSeason = await pool.query<{ payload: TrackedSeason }>(
      "SELECT payload FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2",
      [newSeason.id, scope.connectedStorageId],
    );
    expect(importedSeason.rows[0]?.payload.autoAcquire).toBe(false);
  });

  dbTest("preserves richer title metadata when a scan sends sparse fields", async () => {
    const scope = await createScope();
    const richTitle: MediaTitle = {
      ...makeTitle("tv", 23008),
      title: "Rich title",
      originalTitle: "Original rich title",
      aliases: ["Alias"],
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      overview: "Existing overview",
      originCountries: ["JP"],
    };
    const season = makeSeason(richTitle);
    await store.importExistingMedia(importInput({ ...scope, title: richTitle, season }));
    const sparseTitle: MediaTitle = {
      ...makeTitle("tv", 23008),
      title: "Sparse scan title",
      originalTitle: "",
      aliases: [],
      posterPath: null,
      backdropPath: null,
      overview: "",
    };
    await store.importExistingMedia(importInput({ ...scope, title: sparseTitle, season }));

    const storedTitle = await pool.query<{ payload: MediaTitle }>("SELECT payload FROM media_titles WHERE id = $1", [
      richTitle.id,
    ]);
    expect(storedTitle.rows[0]?.payload).toMatchObject({
      title: "Rich title",
      originalTitle: "Original rich title",
      aliases: ["Alias"],
      posterPath: "/poster.jpg",
      backdropPath: "/backdrop.jpg",
      overview: "Existing overview",
      originCountries: ["JP"],
    });
  });

  dbTest("leaves an absent legacy auto-acquire field absent during rescan", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23014);
    const season = makeSeason(title);
    const initial = importInput({ ...scope, title, season });
    await store.importExistingMedia(initial);
    await pool.query(
      "UPDATE tracked_seasons SET payload = payload - 'autoAcquire' WHERE id = $1 AND connected_storage_id = $2",
      [season.id, scope.connectedStorageId],
    );
    await store.importExistingMedia({
      ...initial,
      season: { ...season, autoAcquire: false },
      files: [],
      directories: [],
    });

    const stored = await pool.query<{ payload: TrackedSeason }>(
      "SELECT payload FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2",
      [season.id, scope.connectedStorageId],
    );
    expect(Object.hasOwn(stored.rows[0]?.payload ?? {}, "autoAcquire")).toBe(false);
  });

  dbTest("preserves the imported patrol setting through an original workflow snapshot", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23017);
    const importedSeason = makeSeason(title);
    await store.importExistingMedia(importInput({ ...scope, title, season: importedSeason }));
    const legacyShapeSeason: TrackedSeason = {
      id: importedSeason.id,
      mediaTitleId: importedSeason.mediaTitleId,
      seasonNumber: importedSeason.seasonNumber,
      status: importedSeason.status,
      qualityPreference: importedSeason.qualityPreference,
      storageDirectoryId: importedSeason.storageDirectoryId,
      totalEpisodes: importedSeason.totalEpisodes,
      latestAiredEpisode: importedSeason.latestAiredEpisode,
      latestAiredSource: importedSeason.latestAiredSource,
    };
    const repository = new PostgresWorkflowRepository(pool);
    await repository.saveWorkflowRunSnapshot({
      ...scope,
      title,
      season: legacyShapeSeason,
      workflowRun: {
        id: "legacy-snapshot-run",
        kind: "type3_monitor",
        status: "succeeded",
        trackedSeasonId: importedSeason.id,
        startedAt: "2026-11-14T11:00:00.000Z",
        finishedAt: "2026-11-14T11:01:00.000Z",
        auditEvents: [],
      },
      episodes: [makeEpisode(legacyShapeSeason, "S01E01")],
      resourceSnapshots: [],
      decisions: [],
      transferAttempts: [],
      notifications: [],
    });

    expect(await repository.getTrackedSeasonState(importedSeason.id, scope)).toMatchObject({
      season: { autoAcquire: false },
    });
  });

  dbTest("allows multiple movies in one flat directory without treating the root as either movie's target", async () => {
    const scope = await createScope();
    const firstTitle = makeTitle("movie", 23009);
    const firstSeason = makeSeason(firstTitle);
    const secondTitle = makeTitle("movie", 23010);
    const secondSeason = makeSeason(secondTitle);
    await store.importExistingMedia(
      importInput({
        ...scope,
        title: firstTitle,
        season: firstSeason,
        files: [{ fileId: "flat-movie-1", parentDirectoryId: "flat-root", episodeCode: "MOVIE" }],
        directoryId: "flat-root",
        exclusive: true,
      }),
    );
    await store.importExistingMedia(
      importInput({
        ...scope,
        title: secondTitle,
        season: secondSeason,
        files: [{ fileId: "flat-movie-2", parentDirectoryId: "flat-root", episodeCode: "MOVIE" }],
        directoryId: "flat-root",
      }),
    );

    expect(await store.findDirectoryBinding({ ...scope, directoryId: "flat-root" })).toBeNull();
    expect(
      await store.findTitleDirectory({
        ...scope,
        mediaTitleId: firstTitle.id,
        seasonNumber: 1,
      }),
    ).toBeNull();
    expect(
      await store.findTitleDirectory({
        ...scope,
        mediaTitleId: secondTitle.id,
        seasonNumber: 1,
      }),
    ).toBeNull();
    expect(await store.listPhysicalFileBindings({ ...scope, mediaTitleId: firstTitle.id })).toMatchObject([
      { fileId: "flat-movie-1", mediaTitleId: firstTitle.id },
    ]);
    expect(await store.listPhysicalFileBindings({ ...scope, mediaTitleId: secondTitle.id })).toMatchObject([
      { fileId: "flat-movie-2", mediaTitleId: secondTitle.id },
    ]);
    const repository = new PostgresWorkflowRepository(pool);
    expect(await repository.getTrackedSeasonState(firstSeason.id, scope)).toMatchObject({
      season: { id: firstSeason.id },
      episodes: [{ episodeCode: "S01E01", obtained: true, verifiedFileIds: ["flat-movie-1"] }],
    });
    await repository.untrackTitle(
      secondTitle.tmdbId,
      { accountId: scope.accountId, connectedStorageId: scope.connectedStorageId },
      "movie",
    );
    expect(await store.findDirectoryBinding({ ...scope, directoryId: "flat-root" })).toMatchObject({
      mediaTitleId: firstTitle.id,
      exclusive: false,
    });
    expect(
      await store.findTitleDirectory({
        ...scope,
        mediaTitleId: firstTitle.id,
        seasonNumber: 1,
      }),
    ).toBeNull();
  });

  dbTest("does not reuse a directory as a target without explicit exclusivity evidence", async () => {
    const scope = await createScope();
    const title = makeTitle("movie", 23011);
    const season = makeSeason(title);
    await store.importExistingMedia(
      importInput({
        ...scope,
        title,
        season,
        files: [{ fileId: "recognized-movie", parentDirectoryId: "possibly-shared-root", episodeCode: "MOVIE" }],
        directoryId: "possibly-shared-root",
      }),
    );
    expect(await store.findDirectoryBinding({ ...scope, directoryId: "possibly-shared-root" })).toMatchObject({
      exclusive: false,
    });
    expect(
      await store.findTitleDirectory({
        ...scope,
        mediaTitleId: title.id,
        seasonNumber: 1,
      }),
    ).toBeNull();
  });

  dbTest("maps one double-episode file ID to both episode states and copies", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23012);
    const season = makeSeason(title);
    await store.importExistingMedia(
      importInput({
        ...scope,
        title,
        season,
        files: [
          { fileId: "double-episode", parentDirectoryId: "double-dir", episodeCode: "S01E01", sizeBytes: 500 },
          { fileId: "double-episode", parentDirectoryId: "double-dir", episodeCode: "S01E02", sizeBytes: 500 },
        ],
        directoryId: "double-dir",
      }),
    );
    const bindings = await store.listPhysicalFileBindings({ ...scope, trackedSeasonId: season.id });
    expect(bindings).toMatchObject([{ fileId: "double-episode", episodeCodes: ["S01E01", "S01E02"] }]);
    const states = await pool.query<{ episode_code: string; payload: EpisodeState }>(
      "SELECT episode_code, payload FROM episode_states WHERE tracked_season_id = $1 AND connected_storage_id = $2 ORDER BY episode_code",
      [season.id, scope.connectedStorageId],
    );
    expect(states.rows.map((row) => row.payload)).toEqual([
      expect.objectContaining({ obtained: true, verifiedFileIds: ["double-episode"] }),
      expect.objectContaining({ obtained: true, verifiedFileIds: ["double-episode"] }),
    ]);
    const copies = await pool.query<{ episode_code: string; file_ids: string[] }>(
      "SELECT episode_code, file_ids FROM episode_copies WHERE tracked_season_id = $1 AND storage_id = $2 ORDER BY episode_code",
      [season.id, scope.connectedStorageId],
    );
    expect(copies.rows).toEqual([
      { episode_code: "S01E01", file_ids: ["double-episode"] },
      { episode_code: "S01E02", file_ids: ["double-episode"] },
    ]);
  });

  dbTest("cascades imported bindings when the existing untrack lifecycle removes a season", async () => {
    const scope = await createScope();
    const title = makeTitle("tv", 23013);
    const season = makeSeason(title);
    await store.importExistingMedia(
      importInput({
        ...scope,
        title,
        season,
        files: [{ fileId: "keep-on-drive", parentDirectoryId: "untrack-dir", episodeCode: "S01E01" }],
        directoryId: "untrack-dir",
      }),
    );
    const repository = new PostgresWorkflowRepository(pool);
    const untracked = await repository.untrackTitle(
      title.tmdbId,
      { accountId: scope.accountId, connectedStorageId: scope.connectedStorageId },
      "tv",
    );
    expect(untracked).toMatchObject({ status: "untracked", removedSeasons: 1 });
    const directoryRows = await pool.query(
      "SELECT 1 FROM library_directory_bindings WHERE connected_storage_id = $1 AND tracked_season_id = $2",
      [scope.connectedStorageId, season.id],
    );
    const fileRows = await pool.query(
      "SELECT 1 FROM library_file_bindings WHERE connected_storage_id = $1 AND tracked_season_id = $2",
      [scope.connectedStorageId, season.id],
    );
    expect(directoryRows.rowCount).toBe(0);
    expect(fileRows.rowCount).toBe(0);
  });

  dbTest("rolls back title, season, directory, and file writes on an identity conflict", async () => {
    const scope = await createScope();
    const originalTitle = makeTitle("tv", 23004);
    const originalSeason = makeSeason(originalTitle);
    await store.importExistingMedia(
      importInput({
        ...scope,
        title: originalTitle,
        season: originalSeason,
        files: [{ fileId: "collision-file", parentDirectoryId: "original-dir", episodeCode: "S01E01" }],
        directoryId: "original-dir",
      }),
    );

    const conflictingTitle = makeTitle("tv", 23005);
    const conflictingSeason = makeSeason(conflictingTitle);
    const conflictingInput = importInput({
      ...scope,
      title: conflictingTitle,
      season: conflictingSeason,
      files: [{ fileId: "collision-file", parentDirectoryId: "new-dir", episodeCode: "S01E01" }],
      directoryId: "new-dir",
    });
    await expect(store.importExistingMedia(conflictingInput)).rejects.toBeInstanceOf(LibraryImportConflictError);

    const title = await pool.query("SELECT 1 FROM media_titles WHERE id = $1", [conflictingTitle.id]);
    const season = await pool.query("SELECT 1 FROM tracked_seasons WHERE id = $1 AND connected_storage_id = $2", [
      conflictingSeason.id,
      scope.connectedStorageId,
    ]);
    const directory = await pool.query("SELECT 1 FROM library_directory_bindings WHERE directory_id = 'new-dir'");
    expect(title.rowCount).toBe(0);
    expect(season.rowCount).toBe(0);
    expect(directory.rowCount).toBe(0);
  });

  dbTest("keeps same provider IDs isolated by account and storage and separates movie from TV", async () => {
    const firstScope = await createScope();
    const secondScope = await createScope();
    const movieTitle = makeTitle("movie", 23006);
    const movieSeason = makeSeason(movieTitle);
    const tvTitle = makeTitle("tv", 23006);
    const tvSeason = makeSeason(tvTitle);
    const animeTitle = makeTitle("anime", 23016);
    const animeSeason = makeSeason(animeTitle);
    await store.importExistingMedia(
      importInput({
        ...firstScope,
        title: movieTitle,
        season: movieSeason,
        files: [{ fileId: "provider-file-1", parentDirectoryId: "movie-dir", episodeCode: "MOVIE" }],
        directoryId: "movie-dir",
      }),
    );
    await store.importExistingMedia(
      importInput({
        ...secondScope,
        title: tvTitle,
        season: tvSeason,
        files: [{ fileId: "provider-file-1", parentDirectoryId: "tv-dir", episodeCode: "S01E01" }],
        directoryId: "tv-dir",
      }),
    );
    await store.importExistingMedia(importInput({ ...firstScope, title: animeTitle, season: animeSeason }));

    expect(await store.findDirectoryBinding({ ...firstScope, directoryId: "tv-dir" })).toBeNull();
    expect(await store.findDirectoryBinding({ ...secondScope, directoryId: "movie-dir" })).toBeNull();
    expect(await store.listPhysicalFileBindings({ ...firstScope })).toMatchObject([
      { fileId: "provider-file-1", mediaTitleId: movieTitle.id, mediaType: "movie" },
    ]);
    expect(await store.listPhysicalFileBindings({ ...secondScope })).toMatchObject([
      { fileId: "provider-file-1", mediaTitleId: tvTitle.id, mediaType: "tv" },
    ]);
    expect(animeTitle.id).toBe("tmdb_tv_23016");
    const animePayload = await pool.query<{ payload: MediaTitle }>(
      "SELECT payload FROM media_titles WHERE id = $1",
      [animeTitle.id],
    );
    expect(animePayload.rows[0]?.payload.type).toBe("anime");
    await expect(
      store.importExistingMedia({
        ...importInput({ ...firstScope, title: makeTitle("tv", 23007), season: makeSeason(makeTitle("tv", 23007)) }),
        accountId: secondScope.accountId,
      }),
    ).rejects.toBeInstanceOf(LibraryStorageScopeError);
    const titleCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM media_titles WHERE id IN ($1, $2)",
      [movieTitle.id, tvTitle.id],
    );
    expect(titleCount.rows[0]?.count).toBe("2");
  });
});
