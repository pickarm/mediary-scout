import type { EpisodeState, MediaTitle, TrackedSeason } from "../domain.js";

/** The provider ID of a directory bound to one identified title/season. */
export interface LibraryDirectoryBinding {
  accountId: string;
  connectedStorageId: string;
  directoryId: string;
  /** Provider ID of this directory's parent, when the traversal supplied it. */
  parentDirectoryId: string | null;
  mediaTitleId: string;
  trackedSeasonId: string;
  mediaType: MediaTitle["type"];
  tmdbId: number;
  seasonNumber: number;
  /** Explicit proof that this directory is safe to reuse as an acquisition target. */
  exclusive: boolean;
  boundAt: string;
}

/** One episode association for an already-existing provider file. Repeated file IDs
 *  with the same title/season and parent merge into a single physical binding, so a
 *  dual-episode video can be associated with both episode states. Names are absent. */
export interface ExistingMediaFile {
  fileId: string;
  /** Actual provider ID of the directory currently containing this file. */
  parentDirectoryId: string;
  episodeCode: string;
  sizeBytes?: number | null;
  quality?: string | null;
}

/** Provider directory facts learned by an authorized traversal. */
export interface ExistingMediaDirectory {
  directoryId: string;
  parentDirectoryId?: string | null;
  /** Defaults to false; only full traversal evidence may set this true. */
  exclusive?: boolean;
}

/** A confirmed identity and its existing files, ready for the dedicated import transaction. */
export interface ImportExistingMediaInput {
  accountId: string;
  connectedStorageId: string;
  title: MediaTitle;
  season: TrackedSeason;
  /** Metadata states for this season. Existing obtained state is never downgraded. */
  episodes: readonly EpisodeState[];
  files: readonly ExistingMediaFile[];
  /** Directory facts from traversal. File parent directories are also bound when omitted. */
  directories?: readonly ExistingMediaDirectory[];
  now?: string;
}

export interface ImportExistingMediaResult {
  mediaTitleId: string;
  trackedSeasonId: string;
  importedFiles: number;
  alreadyImportedFiles: number;
  directoryBindings: number;
}

export interface FindDirectoryBindingInput {
  accountId: string;
  connectedStorageId: string;
  directoryId: string;
}

export interface FindTitleDirectoryInput {
  accountId: string;
  connectedStorageId: string;
  mediaTitleId: string;
  seasonNumber?: number;
}

export interface ListPhysicalFileBindingsInput {
  accountId: string;
  connectedStorageId: string;
  mediaTitleId?: string;
  trackedSeasonId?: string;
  limit?: number;
  /** Exclusive lexical cursor over provider file IDs. */
  afterFileId?: string;
}

export interface LibraryPhysicalFileBinding {
  accountId: string;
  connectedStorageId: string;
  fileId: string;
  parentDirectoryId: string;
  mediaTitleId: string;
  trackedSeasonId: string;
  mediaType: MediaTitle["type"];
  tmdbId: number;
  /** A provider file can contain a double episode and map to multiple states. */
  episodeCodes: string[];
  sizeBytes: number | null;
  quality: string | null;
  boundAt: string;
}

export interface SetSeasonAutoAcquireInput {
  accountId: string;
  connectedStorageId: string;
  trackedSeasonId: string;
  autoAcquire: boolean;
}

export interface LibraryStore {
  importExistingMedia(input: ImportExistingMediaInput): Promise<ImportExistingMediaResult>;
  findDirectoryBinding(input: FindDirectoryBindingInput): Promise<LibraryDirectoryBinding | null>;
  /** Returns null when no safe unique directory can be selected. */
  findTitleDirectory(input: FindTitleDirectoryInput): Promise<LibraryDirectoryBinding | null>;
  listPhysicalFileBindings(
    input: ListPhysicalFileBindingsInput,
  ): Promise<LibraryPhysicalFileBinding[]>;
  setSeasonAutoAcquire(input: SetSeasonAutoAcquireInput): Promise<void>;
}
