import type { Pool } from "pg";
import { classifyMediaType } from "../media-classification.js";
import { createEpisodeStates, episodeCode, movieAnchorSeason, type EpisodeState, type MediaTitle, type TrackedSeason } from "../domain.js";
import { ExistingMediaImportHookError, LibraryImportConflictError, LibraryStorageScopeError, PostgresLibraryStore } from "./store.js";
import type { ScanConfiguration, ScanScope, ScanTask } from "./scanner.js";
import { PostgresScanStore } from "./scan-store.js";
import {
  identifyScanFile,
  type IdentityEvidence,
  type IdentitySuggester,
  type IdentificationResult,
  type IdentificationTmdbPort,
} from "./identification.js";
import {
  IdentificationStoreScopeError,
  PostgresIdentificationStore,
  type IdentificationScanFact,
  type StoredIdentification,
} from "./identification-store.js";

const IDENTIFICATION_BATCH_SIZE = 20;
const JOB_LEASE_MS = 10 * 60_000;
const MAX_CACHED_PROMISES = 256;
const CACHE_JOBS = 10;
const NETWORK_CONCURRENCY = boundedEnv("MEDIA_TRACK_IDENTIFICATION_CONCURRENCY", 5, 1, 20);
const AI_CONCURRENCY = boundedEnv("MEDIA_TRACK_IDENTIFICATION_AI_CONCURRENCY", 2, 1, 10);

export class IdentificationConflictError extends Error {
  constructor(message: string) { super(message); this.name = "IdentificationConflictError"; }
}
export class IdentificationInputError extends Error {
  constructor(message: string) { super(message); this.name = "IdentificationInputError"; }
}

export interface ManualIdentificationInput {
  scope: ScanScope;
  taskId: string;
  fileId: string;
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  seasonNumber?: number;
  episodeNumbers?: number[];
}

export interface IdentificationServiceOptions {
  pool: Pool;
  identificationStore?: PostgresIdentificationStore;
  scanStore?: PostgresScanStore;
  libraryStore?: PostgresLibraryStore;
  tmdb: IdentificationTmdbPort;
  suggester?: IdentitySuggester;
  now?: () => string;
  idFactory?: () => string;
}

/** Durable recognition/import orchestration; external lookups are always outside SQL transactions. */
export class IdentificationService {
  readonly identificationStore: PostgresIdentificationStore;
  private readonly scans: PostgresScanStore;
  private readonly library: PostgresLibraryStore;
  private readonly tmdb: IdentificationTmdbPort;
  private readonly suggester: IdentitySuggester | undefined;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly caches = new Map<string, IdentificationTmdbPort>();
  private activeDrain: Promise<void> | null = null;

  constructor(options: IdentificationServiceOptions) {
    this.identificationStore = options.identificationStore ?? new PostgresIdentificationStore(options.pool);
    this.scans = options.scanStore ?? new PostgresScanStore(options.pool);
    this.library = options.libraryStore ?? new PostgresLibraryStore(options.pool);
    this.tmdb = {
      search: (query, kind) => networkGate.run(() => options.tmdb.search(query, kind)),
      getTitle: (id, type) => networkGate.run(() => options.tmdb.getTitle(id, type)),
      getSeason: (id, season) => networkGate.run(() => options.tmdb.getSeason(id, season)),
    };
    this.suggester = options.suggester ? (input) => aiGate.run(() => options.suggester!(input)) : undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
  }

  async enqueueForScan(scope: ScanScope, taskId: string): Promise<void> {
    await this.identificationStore.enqueueForScan(scope, taskId, this.now());
    this.kickDrain(scope);
  }

  /** Recoverable jobs are fetched from PG; callers may invoke on startup or daily. */
  async drainPending(scope: ScanScope, limit = 10): Promise<void> {
    if (this.activeDrain) return this.activeDrain;
    let continueDraining = false;
    this.activeDrain = (async () => {
      const jobs = await this.identificationStore.drainPending(scope, limit);
      for (const job of jobs) {
        for (let batch = 0; batch < 20; batch += 1) {
          await this.processTaskBatch(job.scope, job.taskId);
          const current = await this.identificationStore.getJob(job.scope, job.taskId);
          if (current?.status !== "pending") break;
          if (batch === 19) continueDraining = true;
        }
      }
    })().finally(() => { this.activeDrain = null; if (continueDraining) this.kickDrain(scope); });
    return this.activeDrain;
  }

  /** Processes one bounded page and releases the lease for the next worker tick. */
  async processTaskBatch(scope: ScanScope, taskId: string): Promise<void> {
    const leaseId = this.idFactory();
    const now = this.now();
    if (!(await this.identificationStore.claimJob(scope, taskId, leaseId, now, new Date(Date.parse(now) + JOB_LEASE_MS).toISOString()))) return;
    const job = await this.identificationStore.getJob(scope, taskId);
    const task = await this.scans.getTask(scope, taskId);
    if (!job || !task) { await this.identificationStore.finishJob(scope, taskId, leaseId, "failed", this.now(), "扫描任务不存在"); return; }
    if (task.status === "cancelled") { await this.identificationStore.finishJob(scope, taskId, leaseId, "cancelled", this.now()); return; }
    if (task.status === "failed") { await this.identificationStore.finishJob(scope, taskId, leaseId, "failed", this.now(), "扫描任务失败；可在确认已遍历内容后手动重试识别"); return; }
    if (task.status !== "completed" && task.status !== "partial") {
      await this.identificationStore.finishJob(scope, taskId, leaseId, "waiting", this.now());
      return;
    }
    const config = await this.scans.getConfiguration(scope, task.configId);
    if (!config) { await this.identificationStore.finishJob(scope, taskId, leaseId, "failed", this.now(), "扫描配置不存在"); return; }

    try {
      const after = job.afterFileId;
      const files = await this.identificationStore.listNextUnidentifiedFiles(scope, taskId, after, IDENTIFICATION_BATCH_SIZE + 1);
      const batch = files.slice(0, IDENTIFICATION_BATCH_SIZE);
      const records = await mapConcurrent(batch, NETWORK_CONCURRENCY, async (file) => {
        try {
          const current = await this.scans.getTask(scope, taskId);
          if (!current || current.status === "cancelled") return null;
          const ancestors = await this.identificationStore.listAncestors(scope, taskId, file.parentDirectoryId);
          const directoryMap = new Map(ancestors.map((directory) => [directory.directoryId, directory]));
          const orderedAncestors = [...directoryMap.values()];
          const parentDirectoryName = orderedAncestors[0]?.name;
          const result = await identifyScanFile({
            file: { fileId: file.fileId, parentDirectoryId: file.parentDirectoryId, name: file.name, path: file.path, sizeBytes: file.sizeBytes, modifiedAt: file.modifiedAt, isDirectory: file.isDirectory },
            ...(parentDirectoryName === undefined ? {} : { parentDirectoryName }),
            ancestorDirectoryNames: orderedAncestors.map((directory) => directory.name),
            mediaKind: config.mediaKind,
          }, { tmdb: this.cachedTmdb(scope, taskId), ...(this.suggester ? { suggester: this.suggester } : {}) });
          return { result, ancestors: orderedAncestors };
        } catch (error) {
          if (error instanceof ExistingMediaImportHookError) throw error;
          return { failure: true };
        }
      });
      let cancelled = false;
      for (const [index, prepared] of records.entries()) {
        if (prepared === undefined) return;
        if (!prepared) { cancelled = true; continue; }
        const file = batch[index]!;
        const record = "failure" in prepared
          ? { fileId: file.fileId, status: "failed", reason: "识别服务暂不可用，可稍后重试", evidence: [], candidates: [], mediaType: null, tmdbId: null, seasonNumber: null, episodeCodes: [], importStatus: "not_applicable", manual: false, updatedAt: this.now() } satisfies StoredIdentification
          : await this.toStoredResult(scope, task, leaseId, file, prepared.ancestors, prepared.result);
        if (record === undefined) return;
        if (!record) { cancelled = true; continue; }
        if (cancelled && !(record.status === "confirmed" && record.importStatus === "imported")) continue;
        const saved = await this.identificationStore.saveResult({ scope, taskId, leaseId, ...record, now: this.now() });
        if (!saved && !(record.status === "confirmed" && record.importStatus === "imported")) return;
        if (cancelled) continue;
        if (!(await this.identificationStore.advanceJob(scope, taskId, leaseId, file.fileId, this.now()))) return;
      }
      if (cancelled) { await this.identificationStore.finishJob(scope, taskId, leaseId, "cancelled", this.now()); return; }
      const more = files.length > IDENTIFICATION_BATCH_SIZE;
      await this.identificationStore.finishJob(scope, taskId, leaseId, more ? "pending" : "completed", this.now());
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith("识别") ? error.message : "识别服务暂不可用，可稍后重试";
      await this.identificationStore.finishJob(scope, taskId, leaseId, "failed", this.now(), message);
    }
  }

  async retryFailed(scope: ScanScope, taskId: string): Promise<boolean> {
    const changed = await this.identificationStore.retryFailed(scope, taskId, this.now());
    if (changed) this.kickDrain(scope);
    return changed;
  }

  async list(scope: ScanScope, taskId: string, input: { limit: number; afterFileId?: string; status?: StoredIdentification["status"] }): Promise<{ summary: Awaited<ReturnType<PostgresIdentificationStore["getSummary"]>>; items: Array<StoredIdentification & { file: IdentificationScanFact | null }>; nextCursor: string | null; hasMore: boolean }> {
    if (!(await this.scans.getTask(scope, taskId))) throw new IdentificationStoreScopeError("扫描任务不存在或不属于当前账号与网盘");
    const summary = await this.identificationStore.getSummary(scope, taskId);
    const rows = await this.identificationStore.listResults(scope, taskId, input);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const facts = await this.identificationStore.listUnidentifiedFiles(scope, taskId, page.map((row) => row.fileId));
    const factById = new Map(facts.map((fact) => [fact.fileId, fact]));
    const items = page.map((row) => ({ ...row, file: factById.get(row.fileId) ?? null }));
    return { summary, items, nextCursor: hasMore && page.length ? page[page.length - 1]!.fileId : null, hasMore };
  }

  async confirmFile(input: ManualIdentificationInput): Promise<{ item: StoredIdentification }> {
    if (!Number.isSafeInteger(input.tmdbId) || input.tmdbId < 1) throw new IdentificationInputError("TMDB ID 无效");
    const task = await this.scans.getTask(input.scope, input.taskId);
    if (!task) throw new IdentificationStoreScopeError("扫描任务不存在或不属于当前账号与网盘");
    if (task.status !== "completed" && task.status !== "partial") throw new IdentificationConflictError("扫描尚未完成，暂不能确认身份");
    const facts = await this.identificationStore.listUnidentifiedFiles(input.scope, input.taskId, [input.fileId]);
    const file = facts[0];
    if (!file || file.isDirectory) throw new IdentificationStoreScopeError("扫描文件不存在或不属于当前任务");
    const ancestors = await this.identificationStore.listAncestors(input.scope, input.taskId, file.parentDirectoryId);
    const mediaKind = input.mediaType === "movie" ? "movie" : "tv";
    const details = await this.cachedTmdb(input.scope, input.taskId).getTitle(input.tmdbId, mediaKind);
    if (details.id !== input.tmdbId || details.year < 1800 || !details.title.trim()) throw new IdentificationInputError("TMDB 未能核实所选作品");
    const resolvedType = details.mediaType === "movie" ? "movie" : classifyMediaType({ baseType: "tv", genreIds: details.genreIds, originCountries: details.originCountries });
    if (resolvedType !== input.mediaType) throw new IdentificationInputError("所选媒体类型与 TMDB 作品类型不一致");
    const titleId = (resolvedType === "movie" ? "tmdb_movie_" : "tmdb_tv_") + details.id;
    const title: MediaTitle = { id: titleId, tmdbId: details.id, type: resolvedType, title: details.title, originalTitle: details.originalTitle || details.title,
      year: details.year, aliases: [...new Set([details.title, details.originalTitle].filter(Boolean))], originCountries: details.originCountries,
      ...(details.releaseDate === undefined ? {} : { releaseDate: details.releaseDate }), posterPath: details.posterPath, backdropPath: details.backdropPath, overview: details.overview };
    let season: TrackedSeason;
    let episodes: EpisodeState[];
    let episodeCodes: string[];
    if (resolvedType === "movie") {
      if (input.seasonNumber !== undefined || input.episodeNumbers !== undefined) throw new IdentificationInputError("电影确认不能包含季集号");
      season = movieAnchorSeason({ titleId, qualityPreference: "", storageDirectoryId: file.parentDirectoryId });
      episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 });
      episodeCodes = ["S01E01"];
    } else {
      if (input.seasonNumber === undefined || !Number.isSafeInteger(input.seasonNumber) || input.seasonNumber < 0 || input.seasonNumber > 99) throw new IdentificationInputError("剧集确认需要有效季号");
      const seasonInfo = details.seasons.find((entry) => entry.seasonNumber === input.seasonNumber);
      if (!seasonInfo) throw new IdentificationInputError("TMDB 未列出所选季");
      const seasonMetadata = await this.cachedTmdb(input.scope, input.taskId).getSeason(details.id, input.seasonNumber);
      if (!Array.isArray(input.episodeNumbers) || input.episodeNumbers.length < 1 || input.episodeNumbers.length > 50) throw new IdentificationInputError("剧集确认需要 1 到 50 个集号");
      const numbers = [...new Set(input.episodeNumbers)];
      if (numbers.length !== input.episodeNumbers.length || numbers.some((n) => !Number.isSafeInteger(n) || n < 1 || !seasonMetadata.some((episode) => episode.episodeNumber === n))) throw new IdentificationInputError("所选集号不在 TMDB 季集资料中");
      const total = Math.max(seasonInfo?.episodeCount ?? 0, ...seasonMetadata.map((episode) => episode.episodeNumber));
      const aired = seasonMetadata.filter((episode) => !episode.airDate || episode.airDate <= this.now().slice(0, 10)).map((episode) => episode.episodeNumber);
      const seasonNo = input.seasonNumber;
      season = { id: titleId + "_s" + seasonNo, mediaTitleId: titleId, seasonNumber: seasonNo, status: "active", qualityPreference: "", storageDirectoryId: file.parentDirectoryId,
        totalEpisodes: total, latestAiredEpisode: Math.max(0, ...aired), latestAiredSource: "metadata", autoAcquire: false };
      episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: seasonNo, totalEpisodes: total, latestAiredEpisode: season.latestAiredEpisode }).map((state) => {
        const number = Number(state.episodeCode.match(/E(\d+)$/)?.[1]);
        const metadata = seasonMetadata.find((episode) => episode.episodeNumber === number);
        return metadata ? { ...state, airDate: metadata.airDate, title: metadata.title || state.title } : state;
      });
      episodeCodes = numbers.map((number) => episodeCode(season.seasonNumber, number));
    }
    const evidence: IdentityEvidence[] = [{ kind: "manual_confirmation", value: `tmdb_${resolvedType === "movie" ? "movie" : "tv"}_${details.id}`, source: "metadata" }];
    const importFiles = episodeCodes.map((code) => ({ fileId: file.fileId, parentDirectoryId: file.parentDirectoryId, episodeCode: code, sizeBytes: file.sizeBytes, quality: null }));
    const result: StoredIdentification = { fileId: file.fileId, status: "confirmed", reason: "用户已确认身份，TMDB 季集资料已核实", evidence, candidates: [], mediaType: resolvedType, tmdbId: details.id,
      seasonNumber: season.seasonNumber, episodeCodes, importStatus: "imported", manual: true, updatedAt: this.now() };
    await this.library.importExistingMediaWithTransactionHooks({ accountId: input.scope.accountId, connectedStorageId: input.scope.connectedStorageId, title, season, episodes,
      files: importFiles, directories: ancestors.map((dir) => ({ directoryId: dir.directoryId, parentDirectoryId: dir.parentDirectoryId, exclusive: false })), now: result.updatedAt }, {
      accountId: input.scope.accountId, connectedStorageId: input.scope.connectedStorageId, fileIds: [file.fileId],
      beforeImport: async (client) => {
        const taskRow = await client.query<{ status: string }>("SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId]);
        if (taskRow.rows[0]?.status !== "completed" && taskRow.rows[0]?.status !== "partial") throw new IdentificationConflictError("扫描尚未完成，暂不能确认身份");
        const prior = await client.query<{ status: string; manual: boolean; media_type: string | null; tmdb_id: number | null; episode_codes: unknown }>("SELECT status,manual,media_type,tmdb_id,episode_codes FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId, file.fileId]);
        const row = prior.rows[0];
        if (row?.status === "confirmed" && (row.media_type !== result.mediaType || row.tmdb_id !== result.tmdbId || JSON.stringify(Array.isArray(row.episode_codes) ? [...row.episode_codes as string[]].sort() : []) !== JSON.stringify([...result.episodeCodes].sort()))) throw new LibraryImportConflictError("该文件已绑定其他作品或集号，请先核对已有结果");
        const binding = await client.query<{ media_type: string; tmdb_id: number; episode_codes: unknown }>("SELECT media_type,tmdb_id,episode_codes FROM library_file_bindings WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, file.fileId]);
        const bound = binding.rows[0];
        if (bound && (bound.media_type !== result.mediaType || bound.tmdb_id !== result.tmdbId || JSON.stringify(Array.isArray(bound.episode_codes) ? [...bound.episode_codes as string[]].sort() : []) !== JSON.stringify([...result.episodeCodes].sort()))) throw new LibraryImportConflictError("该文件已导入绑定到其他作品或集号，请先核对已有结果");
        return true;
      },
      afterImport: async (client) => this.identificationStore.saveManualResultInTransaction(client, input.scope, input.taskId, result),
    });
    return { item: result };
  }

  async setTracking(input: { scope: ScanScope; trackedSeasonId: string; autoAcquire: boolean }): Promise<void> {
    await this.library.setSeasonAutoAcquire({ accountId: input.scope.accountId, connectedStorageId: input.scope.connectedStorageId, trackedSeasonId: input.trackedSeasonId, autoAcquire: input.autoAcquire });
  }

  private async toStoredResult(scope: ScanScope, task: ScanTask, leaseId: string, file: { fileId: string; parentDirectoryId: string; sizeBytes: number | null }, ancestors: readonly { directoryId: string; parentDirectoryId: string | null }[], result: IdentificationResult): Promise<StoredIdentification | null | undefined> {
    const mediaType = result.title?.type ?? null;
    const episodeCodes = result.existingMediaFiles.map((existing) => existing.episodeCode);
    let importStatus: StoredIdentification["importStatus"] = result.status === "confirmed" ? "pending" : "not_applicable";
    if (result.status === "confirmed" && result.title && result.season) {
      try {
        const stored: StoredIdentification = { fileId: file.fileId, status: result.status, reason: result.reason, evidence: result.evidence, candidates: result.candidates.slice(0, 20), mediaType,
          tmdbId: result.title.tmdbId, seasonNumber: result.season.seasonNumber, episodeCodes, importStatus: "imported", manual: false, updatedAt: this.now() };
        let accepted = false;
        await this.library.importExistingMediaWithTransactionHooks({ accountId: scope.accountId, connectedStorageId: scope.connectedStorageId, title: result.title, season: result.season,
          episodes: result.episodes, files: result.existingMediaFiles,
          directories: ancestors.map((dir) => ({ directoryId: dir.directoryId, parentDirectoryId: dir.parentDirectoryId, exclusive: false })), now: stored.updatedAt }, {
          accountId: scope.accountId, connectedStorageId: scope.connectedStorageId, fileIds: [file.fileId],
          beforeImport: async (client) => {
            const job = await client.query<{ status: string; lease_id: string | null; lease_expires_at: string | null }>("SELECT status,lease_id,lease_expires_at FROM library_identification_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [scope.accountId, scope.connectedStorageId, task.taskId]);
            const lease = job.rows[0];
            if (lease?.status !== "running" || lease.lease_id !== leaseId || !lease.lease_expires_at || lease.lease_expires_at <= this.now()) return false;
            const scan = await client.query<{ status: string }>("SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [scope.accountId, scope.connectedStorageId, task.taskId]);
            if (scan.rows[0]?.status !== "completed" && scan.rows[0]?.status !== "partial") return false;
            const prior = await client.query<{ status: string; manual: boolean; media_type: string | null; tmdb_id: number | null; episode_codes: unknown }>("SELECT status,manual,media_type,tmdb_id,episode_codes FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 FOR UPDATE", [scope.accountId, scope.connectedStorageId, task.taskId, file.fileId]);
            const existing = prior.rows[0];
            if (existing?.manual) return false;
            if (existing?.status === "confirmed" && (existing.media_type !== stored.mediaType || existing.tmdb_id !== stored.tmdbId || JSON.stringify(Array.isArray(existing.episode_codes) ? [...existing.episode_codes as string[]].sort() : []) !== JSON.stringify([...stored.episodeCodes].sort()))) throw new LibraryImportConflictError("该文件已绑定其他作品或集号");
            const binding = await client.query<{ media_type: string; tmdb_id: number; episode_codes: unknown }>("SELECT media_type,tmdb_id,episode_codes FROM library_file_bindings WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3 FOR UPDATE", [scope.accountId, scope.connectedStorageId, file.fileId]);
            const bound = binding.rows[0];
            if (bound && (bound.media_type !== stored.mediaType || bound.tmdb_id !== stored.tmdbId || JSON.stringify(Array.isArray(bound.episode_codes) ? [...bound.episode_codes as string[]].sort() : []) !== JSON.stringify([...stored.episodeCodes].sort()))) throw new LibraryImportConflictError("该文件已导入绑定到其他作品或集号");
            return true;
          },
          afterImport: async (client) => { accepted = await this.identificationStore.commitAutomaticResultInTransaction(client, { scope, taskId: task.taskId, leaseId, ...stored, now: stored.updatedAt }); },
        });
        if (!accepted) return undefined;
        importStatus = "imported";
      } catch (error) {
        if (error instanceof ExistingMediaImportHookError) throw error;
        const reason = error instanceof LibraryImportConflictError ? "该文件已关联到其他作品，需人工核对" : error instanceof LibraryStorageScopeError ? "网盘或账号范围校验失败" : "作品导入失败，可重试识别";
        return { fileId: file.fileId, status: "pending", reason, evidence: result.evidence, candidates: result.candidates.slice(0, 20), mediaType, tmdbId: result.title.tmdbId,
          seasonNumber: result.season.seasonNumber, episodeCodes, importStatus: "not_applicable", manual: false, updatedAt: this.now() };
      }
    }
    return { fileId: file.fileId, status: result.status, reason: result.reason, evidence: result.evidence, candidates: result.candidates.slice(0, 20), mediaType,
      tmdbId: result.title?.tmdbId ?? null, seasonNumber: result.season?.seasonNumber ?? null, episodeCodes, importStatus, manual: false, updatedAt: this.now() };
  }

  private cachedTmdb(scope: ScanScope, taskId: string): IdentificationTmdbPort {
    const key = `${scope.accountId}\0${scope.connectedStorageId}\0${taskId}`;
    const existing = this.caches.get(key);
    if (existing) return existing;
    if (this.caches.size >= CACHE_JOBS) this.caches.delete(this.caches.keys().next().value!);
    const cache = new Map<string, Promise<unknown>>();
    const memo = <T>(cacheKey: string, load: () => Promise<T>): Promise<T> => {
      let value = cache.get(cacheKey);
      if (!value) {
        value = load().catch((error: unknown) => { cache.delete(cacheKey); throw error; }); cache.set(cacheKey, value);
        if (cache.size > MAX_CACHED_PROMISES) cache.delete(cache.keys().next().value!);
      }
      return value as Promise<T>;
    };
    const port: IdentificationTmdbPort = {
      search: (query, kind) => memo(`q:${kind}:${query.toLocaleLowerCase()}`, () => this.tmdb.search(query, kind)),
      getTitle: (id, type) => memo(`t:${type}:${id}`, () => this.tmdb.getTitle(id, type)),
      getSeason: (id, season) => memo(`s:${id}:${season}`, () => this.tmdb.getSeason(id, season)),
    };
    this.caches.set(key, port);
    return port;
  }

  private kickDrain(scope: ScanScope): void {
    setTimeout(() => { void this.drainPending(scope).catch(() => undefined); }, 0);
  }
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || !/^\d+$/u.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try { return await work(); }
    finally { this.active -= 1; this.waiters.shift()?.(); }
  }
}

const networkGate = new Semaphore(NETWORK_CONCURRENCY);
const aiGate = new Semaphore(AI_CONCURRENCY);

async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const result = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      result[index] = await work(items[index]!);
    }
  });
  await Promise.all(workers);
  return result;
}
