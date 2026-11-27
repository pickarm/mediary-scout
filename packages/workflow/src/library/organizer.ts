import type { Pool } from "pg";
import type { GuangYaClient } from "../guangya-client.js";
import {
  addStableCollisionSuffix,
  DEFAULT_NAMING_TEMPLATES,
  deriveSubtitlePath,
  extractMediaTechTags,
  parseNamingTemplate,
  renderParsedNamingTemplate,
  type NamingTemplateKind,
  type NamingValues,
} from "./naming.js";
import { PostgresOrganizationStore, type OrganizationStore } from "./organization-store.js";

export interface OrganizationScope { accountId: string; connectedStorageId: string; }
export interface OrganizationDirectoryFact { directoryId: string; parentDirectoryId: string | null; name: string; }
export interface OrganizationFileFact { fileId: string; parentDirectoryId: string; name: string; isDirectory: false; }
export interface OrganizationAuthorizedFile extends OrganizationFileFact { confirmed: true; identity: OrganizationIdentity; }
export interface OrganizationIdentity {
  mediaTitleId: string;
  trackedSeasonId: string;
  mediaType: "movie" | "tv" | "anime";
  title: string;
  originalTitle: string;
  year: number;
  tmdbId: number;
  season?: number;
  episode?: number;
  episodeCode?: string;
  resolution?: string;
  edition?: string;
}
export interface OrganizationGraph {
  /** Facts are from a completed, authorized traversal. Paths are intentionally ignored. */
  directories: readonly OrganizationDirectoryFact[];
  files: readonly OrganizationFileFact[];
  /** Configured target roots verified by the mandatory authorization port. */
  authorizedTargetRootIds?: readonly string[];
}
export type OrganizationTaskStatus = "planned" | "running" | "paused" | "completed" | "failed";
export type OrganizationOperationStatus = "planned" | "running" | "verified" | "failed";
export interface OrganizationOperation {
  operationId: string;
  fileId: string;
  originalParentId: string;
  originalName: string;
  targetRootId: string;
  /** Relative directory segments plus the target filename; path separators are normalized `/`. */
  targetRelativePath: string;
  targetParentId: string | null;
  targetName: string;
  /** Persisted identity and video anchor are rechecked against F02 before execution. */
  identity: OrganizationIdentity;
  pairedFileId: string;
  pairedVideoTargetPath: string;
  status: OrganizationOperationStatus;
  error: string | null;
}
export interface OrganizationPlan {
  scope: OrganizationScope;
  taskId: string;
  operationKey: string;
  sourceRootIds: string[];
  targetRootIds: string[];
  targetRootByMediaType: Partial<Record<OrganizationIdentity["mediaType"],string>>;
  status: OrganizationTaskStatus;
  /** Durable user intent. A merely planned preview is never auto-executed. */
  executeRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  operations: OrganizationOperation[];
  skippedFiles: Array<{ fileId: string; reason: string }>;
}
export interface OrganizationPlanInput {
  scope: OrganizationScope;
  taskId: string;
  operationKey: string;
  /** Both source and target roots must occur in this actual traversal graph. */
  sourceRoots: readonly string[];
  targetRoots: readonly string[];
  /** When movie/TV targets differ, map each kind explicitly. */
  targetRootByMediaType?: Partial<Record<OrganizationIdentity["mediaType"], string>>;
  graph: OrganizationGraph;
  confirmedFiles: readonly OrganizationAuthorizedFile[];
  templates?: Partial<Record<NamingTemplateKind, string>>;
  /** Service-derived conservative skips, e.g. a multi-episode file whose full identity cannot be rendered safely. */
  preSkippedFiles?: readonly { fileId: string; reason: string }[];
  /** Required for deterministic plan retries. */
  now?: string;
}
export interface OrganizationStorage {
  list(parentId: string): Promise<readonly { fileId: string; parentId: string; name: string; isDirectory: boolean }[]>;
  read(fileId: string, knownParentIds: readonly string[]): Promise<{ fileId: string; parentId: string; name: string; isDirectory: boolean } | null>;
  createDir(parentId: string, name: string): Promise<string>;
  rename(fileId: string, name: string): Promise<void>;
  move(fileId: string, parentId: string): Promise<void>;
}
export interface OrganizerOptions {
  store: OrganizationStore;
  storage: OrganizationStorage;
  now?: () => string;
  idFactory?: () => string;
  leaseDurationMs?: number;
  dryRun?: boolean;
}
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export interface ExecuteOrganizationOptions {
  dryRun?: boolean;
  maxOperations?: number;
  concurrency?: number;
  maxConsecutiveFailures?: number;
}
export interface OrganizationCircuitBreakerInfo {
  consecutiveFailures: number;
  remainingPlanned: number;
  lastError: string;
}
export interface OrganizationExecutionResult {
  plan: OrganizationPlan;
  verifiedLocations: readonly { fileId: string; parentId: string; name: string }[];
  processed: number;
  circuitBreaker?: OrganizationCircuitBreakerInfo;
}

export class OrganizationAuthorizationError extends Error { constructor(message: string) { super(message); this.name = "OrganizationAuthorizationError"; } }
export class OrganizationConflictError extends Error { constructor(message: string) { super(message); this.name = "OrganizationConflictError"; } }

const DEFAULT_LEASE_MS = 120_000;
const PAGE_SIZE = 500;
const MAX_PAGES = 10_000;
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".m2ts", ".webm"]);
const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".vtt", ".sup", ".sub", ".idx"]);

/** Planner and resumable executor. It only touches file IDs proven by the supplied graph. */
export class LibraryOrganizer {
  private readonly activePlans = new Map<string, Promise<OrganizationExecutionResult>>();
  private readonly activePlanCreations = new Map<string, Promise<OrganizationPlan>>();
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly leaseDurationMs: number;
  constructor(private readonly options: OrganizerOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => globalThis.crypto.randomUUID());
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs < 1_000 || this.leaseDurationMs > 3_600_000) throw new RangeError("leaseDurationMs must be between 1000 and 3600000");
  }

  async plan(input: OrganizationPlanInput): Promise<OrganizationPlan> {
    const key = scopeKey(input.scope, input.taskId, input.operationKey);
    const creating = this.activePlanCreations.get(key);
    if (creating) return creating;
    const creation = this.planExclusive(input);
    this.activePlanCreations.set(key,creation);
    try { return await creation; } finally { if (this.activePlanCreations.get(key) === creation) this.activePlanCreations.delete(key); }
  }

  private async planExclusive(input: OrganizationPlanInput): Promise<OrganizationPlan> {
    const key = scopeKey(input.scope, input.taskId, input.operationKey);
    const active = this.activePlans.get(key);
    if (active) await active;
    const existing = await this.options.store.get(input.scope,input.taskId,input.operationKey);
    if (existing) {
      if (existing.status !== "completed") await this.options.store.authorizeExecution(existing);
      return existing;
    }
    const authorizedInput = await this.options.store.authorizePlan(input);
    const plan = buildOrganizationPlan(authorizedInput, this.idFactory);
    return this.options.store.createOrGet({ plan, operationKey: input.operationKey });
  }

  /** Executes at most maxOperations; call again to continue. Existing running operations are reconciled first. */
  async execute(scope: OrganizationScope, taskId: string, operationKey: string, options: ExecuteOrganizationOptions = {}): Promise<OrganizationExecutionResult> {
    const key = scopeKey(scope, taskId, operationKey);
    const active = this.activePlans.get(key);
    if (active) return active;
    const running = this.executeExclusive(scope, taskId, operationKey, options);
    this.activePlans.set(key, running);
    try { return await running; } finally { if (this.activePlans.get(key) === running) this.activePlans.delete(key); }
  }

  resume(scope: OrganizationScope, taskId: string, operationKey: string, options: ExecuteOrganizationOptions = {}): Promise<OrganizationExecutionResult> {
    return this.execute(scope, taskId, operationKey, options);
  }

  runNext(scope: OrganizationScope, taskId: string, operationKey: string): Promise<OrganizationExecutionResult> {
    return this.execute(scope, taskId, operationKey, { maxOperations:1 });
  }

  private async executeExclusive(scope: OrganizationScope, taskId: string, operationKey: string, options: ExecuteOrganizationOptions): Promise<OrganizationExecutionResult> {
    let plan = await this.options.store.get(scope, taskId, operationKey);
    if (!plan) throw new OrganizationConflictError("整理清单不存在");
    if (plan.status === "completed") return { plan,verifiedLocations:plan.operations.filter((operation) => operation.status === "verified" && operation.targetParentId !== null).map((operation) => ({fileId:operation.fileId,parentId:operation.targetParentId!,name:operation.targetName})),processed:0 };
    await this.options.store.authorizeExecution(plan);
    if (options.dryRun ?? this.options.dryRun ?? false) return { plan, verifiedLocations: [], processed: 0 };
    const leaseId = this.idFactory();
    const now = this.now();
    const leaseExpiresAt = new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
    if (!(await this.options.store.claim(scope, taskId, operationKey, leaseId, now, leaseExpiresAt))) throw new OrganizationConflictError("整理清单正由其他执行器运行，或已进入终态");
    let processed = 0;
    const maxOperations = options.maxOperations === undefined ? Number.MAX_SAFE_INTEGER : bounded(options.maxOperations, 1, 1_000_000);
    const concurrency = options.concurrency === undefined ? 1 : bounded(options.concurrency, 1, 10);
    const maxConsecutiveFailures = options.maxConsecutiveFailures === undefined ? DEFAULT_MAX_CONSECUTIVE_FAILURES : bounded(options.maxConsecutiveFailures, 1, 100);
    const locations: { fileId: string; parentId: string; name: string }[] = [];
    const dirInFlight = new Map<string, { name: string; promise: Promise<string> }>();
    try {
      plan = (await this.options.store.get(scope, taskId, operationKey))!;
      const pending: OrganizationOperation[] = [];
      for (const original of plan.operations) {
        if (original.status === "verified") {
          locations.push({ fileId: original.fileId, parentId: original.targetParentId!, name: original.targetName });
          continue;
        }
        if (pending.length < maxOperations) pending.push(original);
      }

      let cursor = 0;
      let leaseLost = false;
      let consecutiveFailures = 0;
      let tripped = false;
      let lastFailureError = "";
      const runOne = async (original: OrganizationOperation): Promise<void> => {
        const renewNow = this.now();
        if (!(await this.options.store.renew(scope, taskId, operationKey, leaseId, renewNow, new Date(Date.parse(renewNow) + this.leaseDurationMs).toISOString()))) {
          leaseLost = true;
          return;
        }
        const operation: OrganizationOperation = { ...original, status: "running", error: null };
        await this.persist(scope, taskId, operationKey, leaseId, operation);
        try {
          const target = await this.ensureTarget(operation, dirInFlight);
          operation.targetParentId = target.parentId;
          const targetListing = await this.options.storage.list(target.parentId);
          const collision = targetListing.find((item) => item.name.toLocaleLowerCase("en-US") === operation.targetName.toLocaleLowerCase("en-US") && item.fileId !== operation.fileId);
          if (collision) throw new OrganizationConflictError(`目标文件名已被其他provider ID占用：${operation.targetName}`);
          const result = await this.reconcileAndExecute(operation, target.parentId);
          if (result.parentId !== target.parentId || result.name !== operation.targetName) throw new OrganizationConflictError("回读位置或文件名与整理目标不符");
          operation.targetParentId = result.parentId;
          operation.status = "verified";
          operation.error = null;
          await this.persist(scope, taskId, operationKey, leaseId, operation);
          consecutiveFailures = 0;
          locations.push({ fileId: operation.fileId, parentId: result.parentId, name: result.name });
        } catch (error) {
          if (error instanceof OrganizationConflictError && error.message.includes("整理租约已失效")) {
            leaseLost = true;
            throw error;
          }
          const message = safeError(error);
          operation.status = "failed";
          operation.error = message;
          await this.persist(scope, taskId, operationKey, leaseId, operation);
          consecutiveFailures += 1;
          lastFailureError = message;
          if (consecutiveFailures >= maxConsecutiveFailures) {
            tripped = true;
          }
        }
        processed += 1;
      };

      const workerCount = Math.min(concurrency, pending.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (!leaseLost && !tripped) {
          const index = cursor;
          if (index >= pending.length) return;
          cursor += 1;
          await runOne(pending[index]!);
        }
      });
      await Promise.all(workers);

      const fresh = (await this.options.store.get(scope, taskId, operationKey))!;
      const statuses = fresh.operations.map(({status}) => status);
      const remainingPlanned = statuses.filter((status) => status === "planned").length;
      const taskStatus: OrganizationTaskStatus = tripped
        ? "failed"
        : statuses.every((status) => status === "verified")
          ? "completed"
          : statuses.some((status) => status === "failed")
            ? "failed"
            : "paused";
      await this.options.store.finish(scope, taskId, operationKey, leaseId, taskStatus, this.now());
      const finalPlan = (await this.options.store.get(scope, taskId, operationKey))!;
      const circuitBreaker: OrganizationCircuitBreakerInfo | undefined = tripped
        ? {
            consecutiveFailures,
            remainingPlanned,
            lastError: lastFailureError,
          }
        : undefined;
      return {
        plan: finalPlan,
        verifiedLocations: locations,
        processed,
        ...(circuitBreaker ? { circuitBreaker } : {}),
      };
    } catch (error) {
      await this.options.store.finish(scope, taskId, operationKey, leaseId, "failed", this.now()).catch(() => false);
      throw error;
    }
  }

  private async persist(scope: OrganizationScope, taskId: string, key: string, lease: string, operation: OrganizationOperation): Promise<void> {
    if (!(await this.options.store.updateOperation(scope, taskId, key, lease, operation, this.now()))) throw new OrganizationConflictError("整理租约已失效，操作状态未提交");
  }

  private async ensureTarget(
    operation: OrganizationOperation,
    dirInFlight: Map<string, { name: string; promise: Promise<string> }>,
  ): Promise<{ parentId: string }> {
    const segments = operation.targetRelativePath.split("/");
    if (segments.length < 1 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) throw new OrganizationAuthorizationError("目标相对路径无效");
    let parentId = operation.targetRootId;
    for (const name of segments.slice(0, -1)) parentId = await this.findOrCreateDirectorySingleFlight(parentId, name, dirInFlight);
    return { parentId };
  }

  private async findOrCreateDirectorySingleFlight(
    parentId: string,
    name: string,
    dirInFlight: Map<string, { name: string; promise: Promise<string> }>,
  ): Promise<string> {
    const cacheKey = `${parentId}\0${name.toLocaleLowerCase("en-US")}`;
    const cached = dirInFlight.get(cacheKey);
    if (cached) {
      if (cached.name !== name) throw new OrganizationConflictError(`目标目录“${name}”与大小写不同的同名项冲突`);
      return cached.promise;
    }
    const promise = this.findOrCreateDirectory(parentId, name).catch((error) => {
      if (dirInFlight.get(cacheKey)?.promise === promise) dirInFlight.delete(cacheKey);
      throw error;
    });
    dirInFlight.set(cacheKey, { name, promise });
    return promise;
  }

  private async findOrCreateDirectory(parentId: string, name: string): Promise<string> {
    const initialListing = await this.options.storage.list(parentId);
    const normalizedMatches = initialListing.filter((item) => item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US") && item.parentId === parentId);
    if (normalizedMatches.some((item) => item.name !== name)) throw new OrganizationConflictError(`目标目录“${name}”与大小写不同的同名项冲突`);
    const initial = normalizedMatches;
    if (initial.some((item) => !item.isDirectory)) throw new OrganizationConflictError(`目标路径组件“${name}”已被文件占用`);
    let matches = initial;
    if (matches.length > 1) throw new OrganizationConflictError(`目标目录“${name}”存在多个同名项，无法安全选择`);
    if (matches.length === 1) return matches[0]!.fileId;
    let createError: unknown;
    try { await this.options.storage.createDir(parentId, name); } catch (error) { createError = error; }
    // Regardless of the API response, only the fresh parent listing is evidence that creation succeeded.
    const afterListing = await this.options.storage.list(parentId);
    const afterCreate = afterListing.filter((item) => item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US") && item.parentId === parentId);
    if (afterCreate.some((item) => item.name !== name)) throw new OrganizationConflictError(`创建后目标目录“${name}”与大小写不同的同名项冲突`);
    if (afterCreate.some((item) => !item.isDirectory)) throw new OrganizationConflictError(`创建后目标路径组件“${name}”与文件冲突`);
    matches = afterCreate;
    if (matches.length > 1) throw new OrganizationConflictError(`创建后目标目录“${name}”出现多个同名项`);
    if (matches.length === 1) return matches[0]!.fileId;
    if (createError) throw createError;
    throw new OrganizationConflictError(`创建目标目录“${name}”后回读未发现目录`);
  }

  private async reconcileAndExecute(operation: OrganizationOperation, targetParentId: string): Promise<{ parentId: string; name: string }> {
    // The provider has no get-by-ID/breadcrumb API. Read back by listing only known source/target parents.
    let current = await this.options.storage.read(operation.fileId, unique([operation.originalParentId, targetParentId]));
    if (!current) throw new OrganizationConflictError("源文件ID未能在已知父目录读回，拒绝执行");
    if (current.isDirectory) throw new OrganizationConflictError("整理对象变成目录，拒绝执行");
    if (current.parentId === targetParentId && current.name === operation.targetName) return { parentId: current.parentId, name: current.name };
    const sourceKnown = current.parentId === operation.originalParentId;
    const targetKnown = current.parentId === targetParentId;
    if (!sourceKnown && !targetKnown) throw new OrganizationConflictError("文件已移到源/目标授权位置之外，拒绝改动");
    if (sourceKnown && current.name !== operation.originalName && current.name !== operation.targetName) throw new OrganizationConflictError("源文件名已变化，拒绝覆盖或改名");
    if (targetKnown && current.name !== operation.originalName) throw new OrganizationConflictError("目标目录已有不同名称状态，无法安全恢复");
    try {
      if (current.name !== operation.targetName) {
        await this.options.storage.rename(operation.fileId, operation.targetName);
        current = { ...current, name: operation.targetName };
      }
      if (current.parentId !== targetParentId) await this.options.storage.move(operation.fileId, targetParentId);
    } catch (error) {
      // A timeout is an unknown result. Never repeat writes before reconciling actual listing facts.
      const reconciled = await this.options.storage.read(operation.fileId, unique([operation.originalParentId, targetParentId]));
      if (reconciled?.parentId === targetParentId && reconciled.name === operation.targetName) return { parentId: reconciled.parentId, name: reconciled.name };
      throw error;
    }
    const verified = await this.options.storage.read(operation.fileId, unique([operation.originalParentId, targetParentId]));
    if (verified?.parentId !== targetParentId || verified.name !== operation.targetName) throw new OrganizationConflictError("网盘写操作已返回，但按ID和已知父目录回读未证实目标状态");
    return { parentId: verified.parentId, name: verified.name };
  }
}

export function buildOrganizationPlan(input: OrganizationPlanInput, idFactory: () => string = () => globalThis.crypto.randomUUID()): OrganizationPlan {
  validateInput(input);
  const templates = { ...DEFAULT_NAMING_TEMPLATES, ...input.templates };
  const parsed = Object.fromEntries(Object.entries(templates).map(([kind, template]) => {
    const result = parseNamingTemplate(template);
    if (!result.ok) throw new OrganizationConflictError(`模板 ${kind} 无效：${result.errors.join("；")}`);
    return [kind, result.template];
  })) as Record<NamingTemplateKind, ReturnType<typeof parseNamingTemplate> extends { ok:true; template: infer T } ? T : never>;
  const dirById = new Map(input.graph.directories.map((directory) => [directory.directoryId, directory]));
  const existingNames = new Set<string>();
  for (const targetRoot of input.targetRoots) {
    const directoryPaths = new Map<string, string>([[targetRoot, ""]]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const directory of input.graph.directories) {
        if (directoryPaths.has(directory.directoryId) || directory.parentDirectoryId === null) continue;
        const parentPath = directoryPaths.get(directory.parentDirectoryId);
        if (parentPath !== undefined) { directoryPaths.set(directory.directoryId, parentPath ? `${parentPath}/${directory.name}` : directory.name); changed = true; }
      }
    }
    for (const file of input.graph.files) {
      const parentPath = directoryPaths.get(file.parentDirectoryId);
      if (parentPath !== undefined) existingNames.add(`${targetRoot.toLowerCase()}\0${parentPath ? `${parentPath}/` : ""}${file.name}`.toLocaleLowerCase("en-US"));
    }
  }
  const targetNames = new Set<string>();
  const videos = input.confirmedFiles.filter((file) => isVideo(file.name));
  const confirmedVideoIds = new Set(videos.map(({fileId}) => fileId));
  const subtitleAssignments = new Map<string,OrganizationFileFact[]>();
  const skippedFiles: Array<{fileId:string;reason:string}> = [...(input.preSkippedFiles ?? [])];
  const scannedVideos = input.graph.files.filter((candidate) => isVideo(candidate.name));
  for (const subtitle of input.graph.files.filter((candidate) => isSubtitle(candidate.name))) {
    const candidates = scannedVideos.filter((video) => video.parentDirectoryId === subtitle.parentDirectoryId && subtitleMatchesVideoName(subtitle.name,video.name));
    if (!candidates.length) continue;
    const longest = Math.max(...candidates.map((video) => stripExtension(video.name).stem.length));
    const winners = candidates.filter((video) => stripExtension(video.name).stem.length === longest);
    if (winners.length !== 1) {
      skippedFiles.push({fileId:subtitle.fileId,reason:`字幕同时匹配多个同长度视频basename（${winners.map(({fileId}) => fileId).sort().join("、")}），已保留原位`});
      continue;
    }
    const video = winners[0]!;
    if (!confirmedVideoIds.has(video.fileId)) {
      skippedFiles.push({fileId:subtitle.fileId,reason:"匹配视频尚未确认身份，已保留原位"});
      continue;
    }
    const siblings = subtitleAssignments.get(video.fileId) ?? [];
    siblings.push(subtitle);
    subtitleAssignments.set(video.fileId,siblings);
  }
  const operations: OrganizationOperation[] = [];
  const targetRootByMediaType: Partial<Record<OrganizationIdentity["mediaType"],string>> = {};
  // Persist the authorized targets for every confirmed media type, including
  // files that already match the naming rules and therefore need no operation.
  for (const file of input.confirmedFiles) {
    targetRootByMediaType[file.identity.mediaType] = selectTargetRoot(input, file.identity.mediaType);
  }
  for (const video of videos) {
    const identity = video.identity;
    const values = namingValues(identity, video.name);
    const isMovie = identity.mediaType === "movie";
    const dirKind: NamingTemplateKind = isMovie ? "movieDirectory" : "tvDirectory";
    const directoryPath = renderParsedNamingTemplate(parsed[dirKind], values);
    const relativeDirectory = isMovie ? directoryPath : `${directoryPath}/${renderParsedNamingTemplate(parsed.seasonDirectory, values)}`;
    const filePath = renderParsedNamingTemplate(isMovie ? parsed.movieFile : parsed.episodeFile, values);
    if (filePath.includes("/")) throw new OrganizationConflictError("文件模板只能渲染单个文件名，不能包含目录层级");
    const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
    assertSameExtension(video.name, fileName);
    const desired = `${relativeDirectory}/${fileName}`;
    const targetRootId = targetRootByMediaType[identity.mediaType]!;
    const currentRelativeDir = directoryRelativePath(video.parentDirectoryId,targetRootId,dirById);
    const uniquePath = currentRelativeDir === relativeDirectory && video.name === fileName
      ? desired
      : collisionFreePath(desired, video.fileId, targetRootId, existingNames, targetNames);
    if (!(currentRelativeDir === relativeDirectory && video.name === fileName)) {
      operations.push(createOperation(video, targetRootId, uniquePath, video.identity, video.fileId, uniquePath, idFactory));
      targetNames.add(`${targetRootId}\0${uniquePath}`.toLocaleLowerCase("en-US"));
    }
    const subtitles = subtitleAssignments.get(video.fileId) ?? [];
    for (const subtitle of subtitles) {
      const subtitlePath = deriveSubtitlePath(video.name, subtitle.name, uniquePath);
      if (!subtitlePath) continue;
      const subtitleDirectory = subtitlePath.slice(0,subtitlePath.lastIndexOf("/"));
      const subtitleName = subtitlePath.slice(subtitlePath.lastIndexOf("/")+1);
      const subtitleAlreadyCompliant = directoryRelativePath(subtitle.parentDirectoryId,targetRootId,dirById) === subtitleDirectory && subtitle.name === subtitleName;
      if (subtitleAlreadyCompliant) continue;
      const subtitleUniquePath = collisionFreePath(subtitlePath, subtitle.fileId, targetRootId, existingNames, targetNames);
      operations.push(createOperation(subtitle, targetRootId, subtitleUniquePath, video.identity, video.fileId, uniquePath, idFactory));
      targetNames.add(`${targetRootId}\0${subtitleUniquePath}`.toLocaleLowerCase("en-US"));
    }
  }
  return { scope: input.scope, taskId: input.taskId, operationKey: input.operationKey, sourceRootIds: [...input.sourceRoots], targetRootIds: [...new Set(Object.values(targetRootByMediaType).filter((value): value is string => typeof value === "string"))],targetRootByMediaType,status: "planned", createdAt: input.now ?? new Date().toISOString(), updatedAt: input.now ?? new Date().toISOString(), operations,skippedFiles };
}

function validateInput(input: OrganizationPlanInput): void {
  if (!input.scope.accountId.trim() || !input.scope.connectedStorageId.trim() || !input.taskId.trim() || !input.operationKey.trim()) throw new OrganizationConflictError("整理清单账号/网盘/任务/幂等键不能为空");
  if (!input.sourceRoots.length || (!input.targetRoots.length && (input.confirmedFiles.length > 0 || !(input.preSkippedFiles?.length)))) throw new OrganizationAuthorizationError("必须提供已授权的来源根和目标根，或明确的安全跳过项");
  const dirs = new Map(input.graph.directories.map((directory) => [directory.directoryId,directory]));
  const files = new Map(input.graph.files.map((file) => [file.fileId,file]));
  if (dirs.size !== input.graph.directories.length || files.size !== input.graph.files.length || [...dirs.keys()].some((id) => files.has(id))) throw new OrganizationAuthorizationError("授权图包含重复 provider ID");
  for (const directory of input.graph.directories) {
    if (!directory.directoryId || !directory.name || (directory.parentDirectoryId !== null && !dirs.has(directory.parentDirectoryId))) throw new OrganizationAuthorizationError("授权目录图不完整");
    const seen = new Set<string>();
    let current: string | null = directory.directoryId;
    while (current !== null) {
      if (seen.has(current)) throw new OrganizationAuthorizationError("授权目录图包含父子循环");
      seen.add(current);
      current = dirs.get(current)?.parentDirectoryId ?? null;
    }
  }
  for (const file of input.graph.files) if (!file.fileId || !file.name || !dirs.has(file.parentDirectoryId)) throw new OrganizationAuthorizationError("授权文件缺少真实父目录关系");
  for (const root of input.sourceRoots) if (!dirs.has(root)) throw new OrganizationAuthorizationError(`来源根目录 ${root} 不在已遍历关系图中`);
  for (const root of input.targetRoots) if (!dirs.has(root) && !input.graph.authorizedTargetRootIds?.includes(root)) throw new OrganizationAuthorizationError(`目标根目录 ${root} 不在扫描图或持久化配置授权中`);
  const authorized = (directoryId: string, roots: readonly string[]): boolean => {
    let current: string | null = directoryId;
    const seen = new Set<string>();
    while (current !== null) { if (roots.includes(current)) return true; if (seen.has(current)) return false; seen.add(current); current = dirs.get(current)?.parentDirectoryId ?? null; }
    return false;
  };
  for (const file of input.confirmedFiles) {
    const actual = files.get(file.fileId);
    if (!file.confirmed || !actual || actual.parentDirectoryId !== file.parentDirectoryId || actual.name !== file.name || actual.isDirectory) throw new OrganizationAuthorizationError(`文件 ${file.fileId} 的确认事实与扫描图不匹配`);
    if (!authorized(file.parentDirectoryId,input.sourceRoots)) throw new OrganizationAuthorizationError(`文件 ${file.fileId} 的父目录不在授权来源根下`);
    if (!file.identity.mediaTitleId.trim() || !file.identity.trackedSeasonId.trim() || !Number.isSafeInteger(file.identity.tmdbId) || file.identity.tmdbId < 1 || !file.identity.title.trim() || !file.identity.originalTitle.trim() || !Number.isSafeInteger(file.identity.year) || file.identity.year < 0) throw new OrganizationConflictError(`文件 ${file.fileId} 缺少可靠确认身份`);
    if (file.identity.mediaType !== "movie" && (file.identity.season === undefined || file.identity.episodeCode === undefined)) throw new OrganizationConflictError(`剧集文件 ${file.fileId} 缺少季/集信息`);
  }
}

function selectTargetRoot(input: OrganizationPlanInput, mediaType: OrganizationIdentity["mediaType"]): string {
  const mapped = input.targetRootByMediaType?.[mediaType];
  if (mapped) {
    if (!input.targetRoots.includes(mapped)) throw new OrganizationAuthorizationError(`媒体类型 ${mediaType} 的目标根未列入授权根`);
    return mapped;
  }
  if (input.targetRoots.length !== 1) throw new OrganizationAuthorizationError(`多个目标根必须为 ${mediaType} 显式指定目标`);
  return input.targetRoots[0]!;
}
function directoryRelativePath(directoryId: string, targetRootId: string, directories: Map<string, OrganizationDirectoryFact>): string | null {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: string | null = directoryId;
  while (current !== null && current !== targetRootId) {
    if (seen.has(current)) return null;
    seen.add(current);
    const directory = directories.get(current);
    if (!directory || directory.parentDirectoryId === null) return null;
    segments.unshift(directory.name);
    current = directory.parentDirectoryId;
  }
  return current === targetRootId ? segments.join("/") : null;
}
function namingValues(identity: OrganizationIdentity, fileName: string): NamingValues {
  const { stem, extension } = stripExtension(fileName);
  const tech = extractMediaTechTags(fileName, {
    resolution: identity.resolution,
    edition: identity.edition,
  });
  return {
    title: identity.title,
    originalTitle: identity.originalTitle,
    year: identity.year,
    tmdbId: identity.tmdbId,
    season: identity.season,
    episode: identity.episode,
    episodeCode: identity.episodeCode,
    ...tech,
    originalName: stem,
    ext: extension,
  };
}
function createOperation(file: OrganizationFileFact, targetRootId: string, path: string, identity: OrganizationIdentity, pairedFileId: string, pairedVideoTargetPath: string, idFactory: () => string): OrganizationOperation {
  const slash = path.lastIndexOf("/");
  void idFactory;
  return { operationId:stableOperationId(file.fileId,targetRootId,path),fileId:file.fileId,originalParentId:file.parentDirectoryId,originalName:file.name,targetRootId,targetRelativePath:path,targetParentId:null,targetName:path.slice(slash+1),identity:{...identity},pairedFileId,pairedVideoTargetPath,status:"planned",error:null };
}
function stableOperationId(fileId: string, rootId: string, path: string): string {
  const value = `${fileId}\0${rootId}\0${path}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) { hash ^= value.charCodeAt(index); hash = Math.imul(hash,0x01000193); }
  return `org_${(hash >>> 0).toString(16).padStart(8,"0")}`;
}
function collisionFreePath(path: string, fileId: string, rootId: string, existing: Set<string>, reserved: Set<string>): string {
  const key = `${rootId.toLowerCase()}\0${path}`.toLocaleLowerCase("en-US");
  if (!existing.has(key) && !reserved.has(key)) return path;
  const suffixed = addStableCollisionSuffix(path,fileId);
  const suffixKey = `${rootId.toLowerCase()}\0${suffixed}`.toLocaleLowerCase("en-US");
  if (existing.has(suffixKey) || reserved.has(suffixKey)) throw new OrganizationConflictError("稳定fileID后缀仍发生名称碰撞，拒绝覆盖");
  return suffixed;
}
function assertSameExtension(source: string, target: string): void {
  const sourceExt = stripExtension(source).extension;
  const targetExt = stripExtension(target).extension;
  if (sourceExt !== targetExt) throw new OrganizationConflictError("模板必须保留原文件扩展名及大小写");
}
function stripExtension(name: string): { stem: string; extension: string } { const index = name.lastIndexOf("."); return index > 0 ? { stem:name.slice(0,index),extension:name.slice(index) } : { stem:name,extension:"" }; }
function isVideo(name: string): boolean { return VIDEO_EXTENSIONS.has(stripExtension(name).extension.toLowerCase()); }
function isSubtitle(name: string): boolean { return SUBTITLE_EXTENSIONS.has(stripExtension(name).extension.toLowerCase()); }
function subtitleMatchesVideoName(subtitleName: string, videoName: string): boolean {
  const subtitleStem = stripExtension(subtitleName).stem.toLocaleLowerCase("en-US");
  const videoStem = stripExtension(videoName).stem.toLocaleLowerCase("en-US");
  if (subtitleStem === videoStem) return true;
  return subtitleStem.startsWith(videoStem) && /[._ -]/u.test(subtitleStem[videoStem.length] ?? "");
}
function unique(values: string[]): string[] { return [...new Set(values)]; }
function bounded(value: number, min: number, max: number): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`value must be between ${min} and ${max}`); return value; }
function scopeKey(scope: OrganizationScope, taskId: string, operationKey: string): string { return `${scope.accountId}\0${scope.connectedStorageId}\0${taskId}\0${operationKey}`; }
function safeError(error: unknown): string { return error instanceof Error ? error.message.slice(0,1000) : "整理失败：未知错误"; }

export function createGuangYaOrganizationStorage(client: Pick<GuangYaClient,"listFilesPage"|"createDir"|"renameFile"|"moveFiles">): OrganizationStorage {
  const list = async (parentId: string) => {
    const result: { fileId:string; parentId:string; name:string; isDirectory:boolean }[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await client.listFilesPage(parentId,page,PAGE_SIZE);
      result.push(...response.items.map((item) => ({ fileId:item.fileId,parentId:item.parentId,name:item.fileName,isDirectory:item.resType === 2 })));
      if (!response.hasMore) return result;
    }
    throw new Error("目标目录分页超过安全上限");
  };
  return {
    list,
    async read(fileId, knownParentIds) {
      const matches: { fileId:string; parentId:string; name:string; isDirectory:boolean }[] = [];
      for (const parentId of knownParentIds) matches.push(...(await list(parentId)).filter((item) => item.fileId === fileId && item.parentId === parentId));
      if (matches.length > 1) throw new OrganizationConflictError("按已知父目录回读到重复fileID，无法确定实际位置");
      return matches[0] ?? null;
    },
    createDir: (parentId,name) => client.createDir(parentId,name),
    rename: (fileId,name) => client.renameFile(fileId,name),
    move: (fileId,parentId) => client.moveFiles([fileId],parentId),
  };
}

export function createPostgresLibraryOrganizer(pool: Pool, client: Pick<GuangYaClient,"listFilesPage"|"createDir"|"renameFile"|"moveFiles">, options: Omit<OrganizerOptions,"store"|"storage"> = {}): LibraryOrganizer {
  return new LibraryOrganizer({ ...options,store:new PostgresOrganizationStore(pool),storage:createGuangYaOrganizationStorage(client) });
}
