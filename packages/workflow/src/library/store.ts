import type { Pool, PoolClient } from "pg";
import type { EpisodeState, MediaTitle, TrackedSeason } from "../domain.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import type {
  ExistingMediaDirectory,
  FindDirectoryBindingInput,
  FindTitleDirectoryInput,
  ImportExistingMediaInput,
  ImportExistingMediaResult,
  LibraryDirectoryBinding,
  LibraryPhysicalFileBinding,
  LibraryStore,
  ListPhysicalFileBindingsInput,
  SetSeasonAutoAcquireInput,
} from "./types.js";

/** A stable lock key separate from the workflow schema's advisory lock. */
export const LIBRARY_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_142;

/** Sentinel required by episode_copies.run_id for an imported physical copy.
 *  It is provenance only: import never creates a workflow_runs row. */
export const LIBRARY_IMPORT_PROVENANCE = "library-import";

const LIBRARY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS library_directory_bindings (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    directory_id text NOT NULL,
    parent_directory_id text,
    media_title_id text NOT NULL,
    tracked_season_id text NOT NULL,
    media_type text NOT NULL CHECK (media_type IN ('movie', 'tv', 'anime')),
    tmdb_id integer NOT NULL,
    season_number integer NOT NULL,
    exclusive boolean NOT NULL DEFAULT false,
    bound_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, directory_id, media_title_id, tracked_season_id),
    FOREIGN KEY (tracked_season_id, connected_storage_id)
      REFERENCES tracked_seasons (id, connected_storage_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_directory_bindings_title
    ON library_directory_bindings
      (account_id, connected_storage_id, media_title_id, season_number, directory_id);

  CREATE TABLE IF NOT EXISTS library_file_bindings (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    file_id text NOT NULL,
    parent_directory_id text NOT NULL,
    media_title_id text NOT NULL,
    tracked_season_id text NOT NULL,
    media_type text NOT NULL CHECK (media_type IN ('movie', 'tv', 'anime')),
    tmdb_id integer NOT NULL,
    episode_codes jsonb NOT NULL,
    size_bytes bigint,
    quality text,
    bound_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, file_id),
    FOREIGN KEY (tracked_season_id, connected_storage_id)
      REFERENCES tracked_seasons (id, connected_storage_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, connected_storage_id, parent_directory_id, media_title_id, tracked_season_id)
      REFERENCES library_directory_bindings
        (account_id, connected_storage_id, directory_id, media_title_id, tracked_season_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_file_bindings_title
    ON library_file_bindings
      (account_id, connected_storage_id, media_title_id, tracked_season_id, file_id);
`;

interface BoundStorageRow {
  account_id: string;
}

interface TrackedSeasonRow {
  account_id: string;
  media_title_id: string;
  payload: unknown;
}

interface FileBindingIdentityRow {
  media_title_id: string;
  tracked_season_id: string;
  parent_directory_id: string;
  episode_codes: unknown;
}

interface FileAggregateRow {
  file_id: string;
  size_bytes: string | number | null;
  quality: string | null;
}

interface NormalizedPhysicalFile {
  fileId: string;
  parentDirectoryId: string;
  episodeCodes: string[];
  sizeBytes: number | null;
  quality: string | null;
}

interface DirectoryBindingRow {
  account_id: string;
  connected_storage_id: string;
  directory_id: string;
  parent_directory_id: string | null;
  media_title_id: string;
  tracked_season_id: string;
  media_type: string;
  tmdb_id: number | string;
  season_number: number | string;
  exclusive: boolean;
  bound_at: string;
  storage_directory_id?: string | null;
  directory_binding_count?: number | string;
}

interface DirectoryMediaIdentityRow {
  media_title_id: string;
  tracked_season_id: string;
}

interface MediaTitlePayloadRow {
  payload: unknown;
}

interface PhysicalFileBindingRow {
  account_id: string;
  connected_storage_id: string;
  file_id: string;
  parent_directory_id: string;
  media_title_id: string;
  tracked_season_id: string;
  media_type: string;
  tmdb_id: number | string;
  episode_codes: unknown;
  size_bytes: string | number | null;
  quality: string | null;
  bound_at: string;
}

export class LibraryImportInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryImportInputError";
  }
}

export class LibraryStorageScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryStorageScopeError";
  }
}

export class LibraryImportConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryImportConflictError";
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asMediaType(value: string): MediaTitle["type"] {
  if (value === "movie" || value === "tv" || value === "anime") return value;
  throw new LibraryImportConflictError(`Unexpected media type in library binding: ${value}`);
}

function directoryBindingFromRow(row: DirectoryBindingRow): LibraryDirectoryBinding {
  return {
    accountId: row.account_id,
    connectedStorageId: row.connected_storage_id,
    directoryId: row.directory_id,
    parentDirectoryId: row.parent_directory_id,
    mediaTitleId: row.media_title_id,
    trackedSeasonId: row.tracked_season_id,
    mediaType: asMediaType(row.media_type),
    tmdbId: Number(row.tmdb_id),
    seasonNumber: Number(row.season_number),
    exclusive: row.exclusive,
    boundAt: row.bound_at,
  };
}

function physicalBindingFromRow(row: PhysicalFileBindingRow): LibraryPhysicalFileBinding {
  return {
    accountId: row.account_id,
    connectedStorageId: row.connected_storage_id,
    fileId: row.file_id,
    parentDirectoryId: row.parent_directory_id,
    mediaTitleId: row.media_title_id,
    trackedSeasonId: row.tracked_season_id,
    mediaType: asMediaType(row.media_type),
    tmdbId: Number(row.tmdb_id),
    episodeCodes: Array.isArray(row.episode_codes)
      ? row.episode_codes.filter((value): value is string => typeof value === "string")
      : [],
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    quality: row.quality,
    boundAt: row.bound_at,
  };
}

function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new LibraryImportInputError(`${name} must not be empty`);
  return trimmed;
}

function canonicalMediaTitleId(title: MediaTitle): string {
  if (!Number.isSafeInteger(title.tmdbId) || title.tmdbId <= 0) {
    throw new LibraryImportInputError("TMDB ID must be a positive safe integer");
  }
  // The existing TMDB provider models anime as a TV title and has persisted
  // `tmdb_tv_<id>` since before this library import path.
  const namespace = title.type === "anime" ? "tv" : title.type;
  return `tmdb_${namespace}_${title.tmdbId}`;
}

function normalizeEpisodeCode(title: MediaTitle, season: TrackedSeason, rawCode: string): string {
  if (title.type === "movie") {
    if (rawCode === "MOVIE" || rawCode === "S01E01") return "S01E01";
    throw new LibraryImportInputError("Movie file must map to its single S01E01 anchor episode");
  }
  const match = /^S(\d{2})E(\d{2,})$/.exec(rawCode);
  if (!match || Number(match[1]) !== season.seasonNumber) {
    throw new LibraryImportInputError(
      `Episode code ${rawCode} does not belong to season ${season.seasonNumber}`,
    );
  }
  return rawCode;
}

function validateImport(input: ImportExistingMediaInput): {
  directories: ExistingMediaDirectory[];
  files: NormalizedPhysicalFile[];
} {
  nonEmpty(input.accountId, "accountId");
  nonEmpty(input.connectedStorageId, "connectedStorageId");
  const canonicalTitleId = canonicalMediaTitleId(input.title);
  if (input.title.id !== canonicalTitleId) {
    throw new LibraryImportInputError(
      `Media title ID must use the type-scoped TMDB identity ${canonicalTitleId}`,
    );
  }
  if (input.season.mediaTitleId !== input.title.id) {
    throw new LibraryImportInputError("Tracked season must belong to the imported media title");
  }
  if (!Number.isSafeInteger(input.season.seasonNumber) || input.season.seasonNumber < 0) {
    throw new LibraryImportInputError("Season number must be a non-negative safe integer");
  }
  const expectedSeasonId =
    input.title.type === "movie"
      ? `${input.title.id}_movie`
      : `${input.title.id}_s${input.season.seasonNumber}`;
  if (input.season.id !== expectedSeasonId) {
    throw new LibraryImportInputError(`Tracked season ID must be ${expectedSeasonId}`);
  }

  const directoryMap = new Map<string, ExistingMediaDirectory>();
  for (const directory of input.directories ?? []) {
    const directoryId = nonEmpty(directory.directoryId, "directoryId");
    const parentDirectoryId = directory.parentDirectoryId?.trim() || null;
    const exclusive = directory.exclusive === true;
    const previous = directoryMap.get(directoryId);
    if (
      previous &&
      (previous.parentDirectoryId !== parentDirectoryId || previous.exclusive !== exclusive)
    ) {
      throw new LibraryImportInputError(`Conflicting directory facts for ${directoryId}`);
    }
    directoryMap.set(directoryId, { directoryId, parentDirectoryId, exclusive });
  }

  const fileMap = new Map<string, NormalizedPhysicalFile>();
  for (const file of input.files) {
    const fileId = nonEmpty(file.fileId, "fileId");
    const parentDirectoryId = nonEmpty(file.parentDirectoryId, "parentDirectoryId");
    const episodeCode = normalizeEpisodeCode(
      input.title,
      input.season,
      nonEmpty(file.episodeCode, "episodeCode"),
    );
    const sizeBytes = file.sizeBytes ?? null;
    if (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)) {
      throw new LibraryImportInputError(`Invalid file size for ${fileId}`);
    }
    const normalized: NormalizedPhysicalFile = {
      fileId,
      parentDirectoryId,
      episodeCodes: [episodeCode],
      sizeBytes,
      quality: file.quality?.trim() || null,
    };
    const previous = fileMap.get(fileId);
    if (previous) {
      if (
        previous.parentDirectoryId !== normalized.parentDirectoryId ||
        (previous.sizeBytes !== null && normalized.sizeBytes !== null && previous.sizeBytes !== normalized.sizeBytes) ||
        (previous.quality !== null && normalized.quality !== null && previous.quality !== normalized.quality)
      ) {
        throw new LibraryImportInputError(`Conflicting physical facts for provider file ${fileId}`);
      }
      previous.episodeCodes = [...new Set([...previous.episodeCodes, episodeCode])].sort((a, b) =>
        a.localeCompare(b),
      );
      previous.sizeBytes ??= normalized.sizeBytes;
      previous.quality ??= normalized.quality;
    } else {
      fileMap.set(fileId, normalized);
    }
    if (!directoryMap.has(parentDirectoryId)) {
      // The file's parent provider ID is itself a directory identity. The scanner
      // may provide the directory's own parent when it has traversed that fact.
      directoryMap.set(parentDirectoryId, {
        directoryId: parentDirectoryId,
        parentDirectoryId: null,
        exclusive: false,
      });
    }
  }

  const inputEpisodeCodes = new Set<string>();
  for (const episode of input.episodes) {
    if (episode.trackedSeasonId !== input.season.id) {
      throw new LibraryImportInputError("Episode state belongs to another tracked season");
    }
    const episodeCode = nonEmpty(episode.episodeCode, "episodeCode");
    if (normalizeEpisodeCode(input.title, input.season, episodeCode) !== episodeCode) {
      throw new LibraryImportInputError(`Episode metadata must use canonical code ${episodeCode}`);
    }
    if (inputEpisodeCodes.has(episodeCode)) {
      throw new LibraryImportInputError(`Duplicate episode metadata: ${episodeCode}`);
    }
    inputEpisodeCodes.add(episodeCode);
  }

  const files = [...fileMap.values()].sort((left, right) => left.fileId.localeCompare(right.fileId));
  const directories = [...directoryMap.values()].sort((left, right) =>
    left.directoryId.localeCompare(right.directoryId),
  );
  return { directories, files };
}

function episodeStateForImport(
  input: ImportExistingMediaInput,
  episodeCode: string,
  importedFileIds: readonly string[],
): EpisodeState {
  const metadata = input.episodes.find((episode) => episode.episodeCode === episodeCode);
  if (metadata) {
    return {
      ...metadata,
      obtained: importedFileIds.length > 0,
      verifiedFileIds: [...importedFileIds],
    };
  }
  return {
    trackedSeasonId: input.season.id,
    episodeCode,
    airDate: null,
    title: episodeCode,
    airStatus: "unknown",
    obtained: importedFileIds.length > 0,
    metadataStatus: "storage_only",
    verifiedFileIds: [...importedFileIds],
  };
}

function mergeJsonbStringArrays(left: unknown, right: unknown): string[] {
  const collect = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return [...new Set([...collect(left), ...collect(right)])].sort((a, b) => a.localeCompare(b));
}

function mergeMediaTitle(existingPayload: unknown, incoming: MediaTitle): MediaTitle {
  const existing = asObject(existingPayload);
  if (!existing) throw new LibraryImportConflictError("Stored media title payload is invalid");
  if (existing.type !== incoming.type || Number(existing.tmdbId) !== incoming.tmdbId) {
    throw new LibraryImportConflictError("TMDB title ID is already stored with another media identity");
  }
  const stringValue = (key: string): string | undefined =>
    typeof existing[key] === "string" && existing[key] !== "" ? existing[key] : undefined;
  const nullableString = (key: string): string | null | undefined =>
    typeof existing[key] === "string" && existing[key] !== "" ? existing[key] : undefined;
  const merged = {
    ...incoming,
    ...existing,
    id: incoming.id,
    tmdbId: incoming.tmdbId,
    type: incoming.type,
    title: stringValue("title") ?? incoming.title,
    originalTitle: stringValue("originalTitle") ?? incoming.originalTitle,
    year:
      typeof existing.year === "number" && Number.isSafeInteger(existing.year) && existing.year > 0
        ? existing.year
        : incoming.year,
    aliases: mergeJsonbStringArrays(existing.aliases, incoming.aliases),
    originCountries: mergeJsonbStringArrays(existing.originCountries, incoming.originCountries ?? []),
    releaseDate: nullableString("releaseDate") ?? incoming.releaseDate ?? null,
    posterPath: nullableString("posterPath") ?? incoming.posterPath ?? null,
    backdropPath: nullableString("backdropPath") ?? incoming.backdropPath ?? null,
    overview: stringValue("overview") ?? incoming.overview ?? "",
  };
  return merged as unknown as MediaTitle;
}

export class PostgresLibraryStore implements LibraryStore {
  private schemaReady: Promise<void> | undefined;

  constructor(private readonly pool: Pool) {}

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = this.initializeSchema().catch((error: unknown) => {
        this.schemaReady = undefined;
        throw error;
      });
    }
    return this.schemaReady;
  }

  private async initializeSchema(): Promise<void> {
    await initializeWorkflowPostgresSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LIBRARY_SCHEMA_ADVISORY_LOCK_KEY]);
      await client.query(LIBRARY_SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original DDL failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the transaction failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async assertStorageOwnership(
    client: PoolClient,
    accountId: string,
    connectedStorageId: string,
  ): Promise<void> {
    const result = await client.query<BoundStorageRow>(
      "SELECT account_id FROM connected_storages WHERE id = $1 FOR SHARE",
      [connectedStorageId],
    );
    const row = result.rows[0];
    if (!row || row.account_id !== accountId) {
      throw new LibraryStorageScopeError(
        "Connected storage is missing or does not belong to the requested account",
      );
    }
  }

  private async upsertMediaTitle(client: PoolClient, title: MediaTitle): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`library_title:${title.id}`]);
    let existing = await client.query<MediaTitlePayloadRow>(
      "SELECT payload FROM media_titles WHERE id = $1 FOR UPDATE",
      [title.id],
    );
    if (existing.rows[0]) {
      const merged = mergeMediaTitle(existing.rows[0].payload, title);
      await client.query("UPDATE media_titles SET payload = $1::jsonb WHERE id = $2", [
        JSON.stringify(merged),
        title.id,
      ]);
      return;
    }

    const inserted = await client.query(
      "INSERT INTO media_titles (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO NOTHING",
      [title.id, JSON.stringify(title)],
    );
    if (inserted.rowCount === 0) {
      // A concurrent workflow writer may have inserted the shared title while
      // this transaction waited on the unique key. Merge its richer payload.
      existing = await client.query<MediaTitlePayloadRow>(
        "SELECT payload FROM media_titles WHERE id = $1 FOR UPDATE",
        [title.id],
      );
      const racedPayload = existing.rows[0]?.payload;
      if (racedPayload === undefined) throw new LibraryImportConflictError("Media title disappeared during import");
      const merged = mergeMediaTitle(racedPayload, title);
      await client.query("UPDATE media_titles SET payload = $1::jsonb WHERE id = $2", [
        JSON.stringify(merged),
        title.id,
      ]);
    }
  }

  async importExistingMedia(input: ImportExistingMediaInput): Promise<ImportExistingMediaResult> {
    const normalized = validateImport(input);
    await this.ensureSchema();
    const boundAt = input.now ?? new Date().toISOString();
    const { title, season } = input;
    const metadataByCode = new Map(input.episodes.map((episode) => [episode.episodeCode, episode]));
    const filesByCode = new Map<string, NormalizedPhysicalFile[]>();
    for (const file of normalized.files) {
      for (const episodeCode of file.episodeCodes) {
        const list = filesByCode.get(episodeCode) ?? [];
        list.push(file);
        filesByCode.set(episodeCode, list);
      }
    }

    return this.withTransaction(async (client) => {
      await this.assertStorageOwnership(client, input.accountId, input.connectedStorageId);

      await this.upsertMediaTitle(client, title);

      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `library_season:${input.accountId}:${input.connectedStorageId}:${season.id}`,
      ]);
      const existingSeasonResult = await client.query<TrackedSeasonRow>(
        "SELECT account_id, media_title_id, payload FROM tracked_seasons " +
          "WHERE id = $1 AND connected_storage_id = $2 FOR UPDATE",
        [season.id, input.connectedStorageId],
      );
      const existingSeasonRow = existingSeasonResult.rows[0];
      let storedSeason: TrackedSeason;
      if (existingSeasonRow) {
        if (
          existingSeasonRow.account_id !== input.accountId ||
          existingSeasonRow.media_title_id !== title.id
        ) {
          throw new LibraryImportConflictError("Tracked season identity is already bound to another scope");
        }
        const existingPayload = asObject(existingSeasonRow.payload);
        if (!existingPayload) throw new LibraryImportConflictError("Stored tracked season payload is invalid");
        storedSeason = existingPayload as unknown as TrackedSeason;
        if (storedSeason.seasonNumber !== season.seasonNumber) {
          throw new LibraryImportConflictError("Tracked season number conflicts with the existing record");
        }
        // An existing season is authoritative, including an absent legacy flag.
        // Never let a rescan change status, target directory, or auto-acquire.
      } else {
        storedSeason = { ...season, autoAcquire: false };
        await client.query(
          "INSERT INTO tracked_seasons (id, media_title_id, account_id, connected_storage_id, payload) " +
            "VALUES ($1, $2, $3, $4, $5::jsonb)",
          [season.id, title.id, input.accountId, input.connectedStorageId, JSON.stringify(storedSeason)],
        );
      }

      for (const episode of input.episodes) {
        if (episode.trackedSeasonId !== storedSeason.id) {
          throw new LibraryImportInputError("Episode state belongs to another tracked season");
        }
      }

      let directoryBindings = 0;
      for (const directory of normalized.directories) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `library_directory:${input.accountId}:${input.connectedStorageId}:${directory.directoryId}`,
        ]);
        const existingDirectoryBindings = await client.query<DirectoryMediaIdentityRow>(
          "SELECT media_title_id, tracked_season_id FROM library_directory_bindings " +
            "WHERE account_id = $1 AND connected_storage_id = $2 AND directory_id = $3 FOR UPDATE",
          [input.accountId, input.connectedStorageId, directory.directoryId],
        );
        const isAlreadyShared = existingDirectoryBindings.rows.some(
          (row) => row.media_title_id !== title.id || row.tracked_season_id !== season.id,
        );
        const directoryExclusive = directory.exclusive === true && !isAlreadyShared;
        if (isAlreadyShared) {
          await client.query(
            "UPDATE library_directory_bindings SET exclusive = false " +
              "WHERE account_id = $1 AND connected_storage_id = $2 AND directory_id = $3",
            [input.accountId, input.connectedStorageId, directory.directoryId],
          );
        }
        if (directory.parentDirectoryId !== null) {
          await client.query(
            "UPDATE library_directory_bindings SET parent_directory_id = $4 " +
              "WHERE account_id = $1 AND connected_storage_id = $2 AND directory_id = $3 " +
              "AND parent_directory_id IS DISTINCT FROM $4",
            [input.accountId, input.connectedStorageId, directory.directoryId, directory.parentDirectoryId],
          );
        }
        await client.query(
          "INSERT INTO library_directory_bindings " +
            "(account_id, connected_storage_id, directory_id, parent_directory_id, media_title_id, " +
            "tracked_season_id, media_type, tmdb_id, season_number, exclusive, bound_at) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) " +
            "ON CONFLICT (account_id, connected_storage_id, directory_id, media_title_id, tracked_season_id) DO UPDATE SET " +
            "parent_directory_id = COALESCE(EXCLUDED.parent_directory_id, library_directory_bindings.parent_directory_id), " +
            "exclusive = EXCLUDED.exclusive",
          [
            input.accountId,
            input.connectedStorageId,
            directory.directoryId,
            directory.parentDirectoryId ?? null,
            title.id,
            season.id,
            title.type,
            title.tmdbId,
            season.seasonNumber,
            directoryExclusive,
            boundAt,
          ],
        );
        directoryBindings += 1;
      }

      let importedFiles = 0;
      let alreadyImportedFiles = 0;
      for (const file of normalized.files) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `library_file:${input.accountId}:${input.connectedStorageId}:${file.fileId}`,
        ]);
        const existing = await client.query<FileBindingIdentityRow>(
          "SELECT media_title_id, tracked_season_id, parent_directory_id, episode_codes FROM library_file_bindings " +
            "WHERE account_id = $1 AND connected_storage_id = $2 AND file_id = $3 FOR UPDATE",
          [input.accountId, input.connectedStorageId, file.fileId],
        );
        const existingIdentity = existing.rows[0];
        if (
          existingIdentity &&
          (existingIdentity.media_title_id !== title.id ||
            existingIdentity.tracked_season_id !== season.id)
        ) {
          throw new LibraryImportConflictError(`Provider file ${file.fileId} is already bound to another identity`);
        }

        await client.query(
          "INSERT INTO library_file_bindings " +
            "(account_id, connected_storage_id, file_id, parent_directory_id, media_title_id, " +
            "tracked_season_id, media_type, tmdb_id, episode_codes, size_bytes, quality, bound_at) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) " +
            "ON CONFLICT (account_id, connected_storage_id, file_id) DO UPDATE SET " +
            "parent_directory_id = EXCLUDED.parent_directory_id, " +
            "episode_codes = (SELECT COALESCE(jsonb_agg(DISTINCT codes.value ORDER BY codes.value), '[]'::jsonb) " +
            "FROM jsonb_array_elements(library_file_bindings.episode_codes || EXCLUDED.episode_codes) AS codes(value)), " +
            "size_bytes = COALESCE(EXCLUDED.size_bytes, library_file_bindings.size_bytes), " +
            "quality = COALESCE(EXCLUDED.quality, library_file_bindings.quality)",
          [
            input.accountId,
            input.connectedStorageId,
            file.fileId,
            file.parentDirectoryId,
            title.id,
            season.id,
            title.type,
            title.tmdbId,
            JSON.stringify(file.episodeCodes),
            file.sizeBytes ?? null,
            file.quality ?? null,
            boundAt,
          ],
        );
        if (existingIdentity) alreadyImportedFiles += 1;
        else importedFiles += 1;
      }

      const episodeCodes = new Set<string>([...metadataByCode.keys(), ...filesByCode.keys()]);
      for (const episodeCode of [...episodeCodes].sort((left, right) => left.localeCompare(right))) {
        const fileIds = (filesByCode.get(episodeCode) ?? []).map((file) => file.fileId);
        const episode = episodeStateForImport(input, episodeCode, fileIds);
        await client.query(
          "INSERT INTO episode_states (tracked_season_id, connected_storage_id, episode_code, payload) " +
            "VALUES ($1, $2, $3, $4::jsonb) " +
            "ON CONFLICT (tracked_season_id, connected_storage_id, episode_code) DO UPDATE SET payload = " +
            "jsonb_set(" +
            "jsonb_set(episode_states.payload, '{obtained}', " +
            "to_jsonb(COALESCE((episode_states.payload->>'obtained')::boolean, false) OR " +
            "COALESCE((EXCLUDED.payload->>'obtained')::boolean, false)), true), " +
            "'{verifiedFileIds}', " +
            "(SELECT COALESCE(jsonb_agg(DISTINCT ids.item ORDER BY ids.item), '[]'::jsonb) " +
            "FROM jsonb_array_elements(COALESCE(episode_states.payload->'verifiedFileIds', '[]'::jsonb) || " +
            "COALESCE(EXCLUDED.payload->'verifiedFileIds', '[]'::jsonb)) AS ids(item)), true)",
          [season.id, input.connectedStorageId, episodeCode, JSON.stringify(episode)],
        );
      }

      for (const episodeCode of filesByCode.keys()) {
        const result = await client.query<FileAggregateRow>(
          "SELECT file_id, size_bytes, quality FROM library_file_bindings " +
            "WHERE account_id = $1 AND connected_storage_id = $2 AND tracked_season_id = $3 " +
            "AND episode_codes ? $4 ORDER BY file_id",
          [input.accountId, input.connectedStorageId, season.id, episodeCode],
        );
        const allFileIds = result.rows.map((row) => row.file_id);
        const knownSizes = result.rows
          .map((row) => (row.size_bytes === null ? null : Number(row.size_bytes)))
          .filter((value): value is number => value !== null && Number.isSafeInteger(value));
        const sizeBytes = knownSizes.length > 0 ? knownSizes.reduce((sum, value) => sum + value, 0) : null;
        const qualities = [...new Set(result.rows.map((row) => row.quality).filter((value): value is string => !!value))];
        const quality = qualities.length === 1 ? qualities[0] : null;
        const existingCopy = await client.query<{ file_ids: unknown }>(
          "SELECT file_ids FROM episode_copies WHERE tracked_season_id = $1 AND episode_code = $2 AND storage_id = $3 FOR UPDATE",
          [season.id, episodeCode, input.connectedStorageId],
        );
        const combinedFileIds = mergeJsonbStringArrays(
          existingCopy.rows[0]?.file_ids,
          allFileIds,
        );
        await client.query(
          "INSERT INTO episode_copies " +
            "(tracked_season_id, episode_code, storage_id, file_ids, size_bytes, quality, run_id, recorded_at) " +
            "VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8) " +
            "ON CONFLICT (tracked_season_id, episode_code, storage_id) DO UPDATE SET " +
            "file_ids = EXCLUDED.file_ids, " +
            "size_bytes = COALESCE(EXCLUDED.size_bytes, episode_copies.size_bytes), " +
            "quality = COALESCE(EXCLUDED.quality, episode_copies.quality), " +
            "recorded_at = EXCLUDED.recorded_at",
          [
            season.id,
            episodeCode,
            input.connectedStorageId,
            JSON.stringify(combinedFileIds),
            sizeBytes,
            quality,
            LIBRARY_IMPORT_PROVENANCE,
            boundAt,
          ],
        );
      }

      return {
        mediaTitleId: title.id,
        trackedSeasonId: season.id,
        importedFiles,
        alreadyImportedFiles,
        directoryBindings,
      };
    });
  }

  async findDirectoryBinding(input: FindDirectoryBindingInput): Promise<LibraryDirectoryBinding | null> {
    await this.ensureSchema();
    const result = await this.pool.query<DirectoryBindingRow>(
      "SELECT account_id, connected_storage_id, directory_id, parent_directory_id, media_title_id, " +
        "tracked_season_id, media_type, tmdb_id, season_number, exclusive, bound_at " +
        "FROM library_directory_bindings WHERE account_id = $1 AND connected_storage_id = $2 AND directory_id = $3",
      [input.accountId, input.connectedStorageId, input.directoryId],
    );
    return result.rows.length === 1 ? directoryBindingFromRow(result.rows[0]!) : null;
  }

  async findTitleDirectory(input: FindTitleDirectoryInput): Promise<LibraryDirectoryBinding | null> {
    await this.ensureSchema();
    if (
      input.seasonNumber !== undefined &&
      (!Number.isSafeInteger(input.seasonNumber) || input.seasonNumber < 0)
    ) {
      throw new LibraryImportInputError("Season number must be a non-negative safe integer");
    }
    const result = await this.pool.query<DirectoryBindingRow>(
      "SELECT b.account_id, b.connected_storage_id, b.directory_id, b.parent_directory_id, b.media_title_id, " +
        "b.tracked_season_id, b.media_type, b.tmdb_id, b.season_number, b.bound_at, " +
        "b.exclusive, " +
        "(s.payload->>'storageDirectoryId') AS storage_directory_id, " +
        "(SELECT count(*) FROM library_directory_bindings b2 WHERE b2.account_id = b.account_id " +
        "AND b2.connected_storage_id = b.connected_storage_id AND b2.directory_id = b.directory_id) AS directory_binding_count " +
        "FROM library_directory_bindings b " +
        "JOIN tracked_seasons s ON s.id = b.tracked_season_id AND s.connected_storage_id = b.connected_storage_id " +
        "WHERE b.account_id = $1 AND b.connected_storage_id = $2 AND b.media_title_id = $3 " +
        "AND ($4::integer IS NULL OR b.season_number = $4) " +
        "ORDER BY (b.directory_id = (s.payload->>'storageDirectoryId')) DESC, b.directory_id ASC",
      [input.accountId, input.connectedStorageId, input.mediaTitleId, input.seasonNumber ?? null],
    );
    if (result.rows.length === 0) return null;
    const preferred = result.rows.find(
      (row) =>
        row.directory_id === row.storage_directory_id &&
        row.exclusive &&
        Number(row.directory_binding_count) === 1,
    );
    if (preferred) return directoryBindingFromRow(preferred);
    const safeCandidates = result.rows.filter(
      (row) => row.exclusive && Number(row.directory_binding_count) === 1,
    );
    return safeCandidates.length === 1 ? directoryBindingFromRow(safeCandidates[0]!) : null;
  }

  async listPhysicalFileBindings(
    input: ListPhysicalFileBindingsInput,
  ): Promise<LibraryPhysicalFileBinding[]> {
    await this.ensureSchema();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new LibraryImportInputError("Physical file binding page size must be between 1 and 500");
    }
    const filters = ["account_id = $1", "connected_storage_id = $2"];
    const params: Array<string | number> = [input.accountId, input.connectedStorageId];
    const addFilter = (column: string, value: string | undefined) => {
      if (value === undefined) return;
      params.push(value);
      filters.push(`${column} = $${params.length}`);
    };
    addFilter("media_title_id", input.mediaTitleId);
    addFilter("tracked_season_id", input.trackedSeasonId);
    if (input.afterFileId !== undefined) {
      params.push(input.afterFileId);
      filters.push(`file_id > $${params.length}`);
    }
    params.push(limit);
    const result = await this.pool.query<PhysicalFileBindingRow>(
      "SELECT account_id, connected_storage_id, file_id, parent_directory_id, media_title_id, " +
        "tracked_season_id, media_type, tmdb_id, episode_codes, size_bytes, quality, bound_at " +
        `FROM library_file_bindings WHERE ${filters.join(" AND ")} ORDER BY file_id LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(physicalBindingFromRow);
  }

  async setSeasonAutoAcquire(input: SetSeasonAutoAcquireInput): Promise<void> {
    await this.ensureSchema();
    await this.withTransaction(async (client) => {
      await this.assertStorageOwnership(client, input.accountId, input.connectedStorageId);
      const result = await client.query<TrackedSeasonRow>(
        "SELECT account_id, media_title_id, payload FROM tracked_seasons " +
          "WHERE id = $1 AND connected_storage_id = $2 FOR UPDATE",
        [input.trackedSeasonId, input.connectedStorageId],
      );
      const row = result.rows[0];
      if (!row || row.account_id !== input.accountId) {
        throw new LibraryStorageScopeError("Tracked season is missing or outside the requested scope");
      }
      const payload = asObject(row.payload);
      if (!payload) throw new LibraryImportConflictError("Stored tracked season payload is invalid");
      const updated = { ...payload, autoAcquire: input.autoAcquire };
      await client.query(
        "UPDATE tracked_seasons SET payload = $1::jsonb WHERE id = $2 AND connected_storage_id = $3 AND account_id = $4",
        [JSON.stringify(updated), input.trackedSeasonId, input.connectedStorageId, input.accountId],
      );
    });
  }
}
