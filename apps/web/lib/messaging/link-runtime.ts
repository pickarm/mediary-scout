import { createHash } from "node:crypto";
import { isRegisteredStorageProvider, refreshConfiguredMediaServers, type LandedMediaItem, type MediaTitle, type TrackedSeason, type StorageExecutor, type VerifiedFile } from "@media-track/workflow";
import { DEFAULT_NAMING_TEMPLATES, PostgresIdentificationStore, withStorageWriteTask, type ScanConfiguration } from "@media-track/workflow/library";
import { getAccountScopedSettings, getLibraryStorageExecutor, getWorkerStorageParents, getWorkflowRepository } from "../workflow-runtime";
import { getLibraryPool, getLibraryServices } from "../library-runtime";
import { getLibraryIdentificationService } from "../library-identification-runtime";
import { getLibraryOrganizationService } from "../library-organization-runtime";
import type {
  LinkImportDependencies,
  LinkIdentityFact,
  LinkOrganizationInput,
  LinkOrganizationResult,
  LinkPreparedLanding,
  LinkRefreshInput,
  LinkScanInput,
  LinkScanResult,
  LinkStorageOption,
  LinkTransferInput,
  LinkTransferReconcileInput,
  LinkTransferReconcileResult,
  LinkTransferResult,
} from "./link-import";
import type { PostgresMessagingStore } from "./store";

/** Thin production bindings to the original transfer, scan/import and organizer. */
export function createLinkImportDependencies(store: PostgresMessagingStore): LinkImportDependencies {
  return {
    store,
    listStorages: listActiveLinkStorages,
    prepareLanding: prepareDirectLanding,
    submitTransfer: submitDirectTransfer,
    reconcileTransfer: reconcileDirectTransfer,
    scanAndIdentify: (input) => scanAndIdentify(store, input),
    organize: (input) => organizeDirectLanding(store, input),
    refresh: refreshLandedMedia,
  };
}

async function listActiveLinkStorages(accountId: string): Promise<readonly LinkStorageOption[]> {
  return (await getWorkflowRepository().listConnectedStorages(accountId))
    .filter((s) => s.status === "active" && isRegisteredStorageProvider(s.provider))
    .map((s) => ({
      id: s.id,
      label: s.label ?? s.provider,
      provider: s.provider as "pan115" | "quark" | "uc" | "pan123" | "tianyi" | "guangya",
    }));
}

async function prepareDirectLanding(
  input: Parameters<LinkImportDependencies["prepareLanding"]>[0],
): Promise<LinkPreparedLanding> {
  assertWritable();
  const parents = await getWorkerStorageParents(input.accountId, input.storage.id, { strictId: true });
  const storage = await getLibraryStorageExecutor(input.accountId, input.storage.id);
  const name = `消息转存-${input.jobId}`;
  const directoryId = await withStorageWriteTask([storage], () => findOrCreate(storage, parents.movies, name));
  return { directoryId, name };
}

async function submitDirectTransfer(input: LinkTransferInput): Promise<LinkTransferResult> {
  assertWritable();
  const storage = await landingExecutor(
    input.accountId,
    input.storage.id,
    input.storage.provider,
    input.landingDirectoryId,
    input.workflowRunId,
  );
  const attempt = await withStorageWriteTask([storage], () =>
    storage.transfer({
      workflowRunId: input.workflowRunId,
      directoryId: input.landingDirectoryId,
      candidate: input.candidate,
      wholePackage: true,
      onSubmitted: input.onSubmitted,
    }),
  );
  return {
    status: attempt.status,
    providerMessage: attempt.providerMessage,
    receipt: attempt.receipt ?? {},
    materializedFileIds: attempt.materializedFileIds,
  };
}

async function reconcileDirectTransfer(input: LinkTransferReconcileInput): Promise<LinkTransferReconcileResult> {
  const storage = await getLibraryStorageExecutor(input.accountId, input.storage.id);
  // The message row wraps the provider receipt; restore its original discriminator.
  const receipt: Record<string, unknown> = {
    ...input.receipt,
    ...(typeof input.receipt.providerKind === "string" ? { kind: input.receipt.providerKind } : {}),
  };
  const status = receipt.state === "completed" ? "completed" : await storage.getTransferStatus?.(receipt) ?? "unknown";
  return {
    status: status === "completed" ? "succeeded" : status === "running" ? "pending" : status,
    providerMessage: status === "unknown" ? "提交结果待核实" : status === "completed" ? "远端任务已完成" : "远端任务尚未完成",
    receipt: { ...receipt, state: status },
    materializedFileIds: [],
  };
}

async function organizeDirectLanding(store: PostgresMessagingStore, input: LinkOrganizationInput): Promise<LinkOrganizationResult> {
  assertWritable();
  const service = await getLibraryOrganizationService(input.accountId, input.storage.id);
  const verified = new Set<string>();
  const keys: string[] = [];
  const skippedReasons = new Set<string>();
  let partial = false;
  // Each batch uses the existing bounded preview and persisted operation journal.
  for (let offset = 0; offset < input.videos.length; offset += 20) {
    if (await stopRequested(store, input.workflowRunId, input.accountId)) {
      partial = true;
      break;
    }
    const videos = input.videos.slice(offset, offset + 20);
    let plan = await service.preview(input.scanTaskId, { fileIds: videos.map((f) => f.providerFileId), limit: 20 });
    keys.push(plan.operationKey);
    if (plan.status !== "completed" && plan.status !== "failed") {
      await service.store.requestExecution(service.scope, input.scanTaskId, plan.operationKey, new Date().toISOString());
      while (plan.status !== "completed" && plan.status !== "failed") {
        if (await stopRequested(store, input.workflowRunId, input.accountId)) {
          await service.store.pause(service.scope, input.scanTaskId, plan.operationKey, new Date().toISOString());
          partial = true;
          break;
        }
        plan = await service.executeSlice(input.scanTaskId, plan.operationKey);
        if (plan.status === "paused") {
          partial = true;
          break;
        }
      }
    }
    const videoIds = new Set(videos.map((f) => f.providerFileId));
    for (const op of plan.operations) {
      if (
        op.status === "verified" &&
        videoIds.has(op.fileId) &&
        (op.originalParentId !== op.targetParentId || op.originalName !== op.targetName)
      ) {
        verified.add(op.fileId);
      }
    }
    for (const skipped of plan.skippedFiles) {
      const reason = skipped.reason.trim();
      if (reason) skippedReasons.add(reason);
    }
    if (plan.status !== "completed" || plan.skippedFiles.length > 0) partial = true;
  }
  const providerMessage = partial
    ? skippedReasons.size > 0
      ? `部分文件跳过（${[...skippedReasons].slice(0, 3).join("；")}），可在媒体库中查看整理记录`
      : "部分文件待确认，可在媒体库中查看整理记录"
    : "视频和配对字幕已核实整理";
  return {
    organizationKey: keys.join(","),
    status: partial ? "partial" : "completed",
    verifiedNewVideoFileIds: [...verified],
    providerMessage,
  };
}

async function refreshLandedMedia(input: LinkRefreshInput): Promise<void> {
  if (!input.verifiedNewVideoFileIds.length) return;
  const items = await landedMediaItems(input.accountId, input.storage.id, input.storage.label, input.verifiedNewVideoFileIds);
  if (!items.length) return;
  const result = await refreshConfiguredMediaServers({
    repository: getAccountScopedSettings(input.accountId),
    items,
  });
  if (result.failures.length) throw new Error(result.failures.map((f) => `${f.server}: ${f.error}`).join("；"));
}

function assertWritable(): void {
  if (process.env.MEDIA_TRACK_REHEARSAL === "1") throw new Error("演练模式禁止真实网盘写入");
}

async function findOrCreate(storage: StorageExecutor, parentId: string, name: string): Promise<string> {
  const find = async () => {
    const matches = (await storage.listChildDirectories(parentId)).filter((d) => d.name === name);
    if (matches.length > 1) throw new Error("存在重名消息落地区，请在网盘中确认");
    return matches[0]?.id;
  };
  const existing = await find();
  if (existing) return existing;
  try { return await storage.createDirectory({ parentId, name }); }
  catch (error) { const readBack = await find(); if (readBack) return readBack; throw error; }
}

async function scanAndIdentify(store: PostgresMessagingStore, input: LinkScanInput): Promise<LinkScanResult> {
  const scope = { accountId: input.accountId, connectedStorageId: input.storage.id };
  const services = await getLibraryServices(scope);
  const digest = createHash("sha256").update(input.workflowRunId).digest("hex").slice(0, 32);
  const taskId = `msg_scan_${digest}`;
  let task = await services.scanStore.getTask(scope, taskId);
  if (!task) {
    const parents = await getWorkerStorageParents(input.accountId, input.storage.id, { strictId: true });
    const config: ScanConfiguration = {
      configId: `msg_${digest}`, scope, sourceRoots: [{ directoryId: input.landingDirectoryId, name: "消息转存" }],
      movieTargetDirectoryId: parents.movies, tvTargetDirectoryId: parents.tv, mediaKind: "mixed",
      dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai",
      autoOrganize: false, autoAcquire: false, templates: DEFAULT_NAMING_TEMPLATES,
    };
    await services.scanStore.saveConfiguration(config);
    task = await services.scanStore.createTask({ taskId, scope, configuration: config, roots: config.sourceRoots, now: new Date().toISOString() });
  }
  await input.onScanStarted(taskId);
  await services.scanner.resume(scope, taskId);
  task = await services.scanner.waitForIdle(scope, taskId);
  if (task.status !== "completed" && task.status !== "partial") throw new Error("扫描尚未完成，请在媒体库中检查任务后恢复");
  const stoppedScan = (): LinkScanResult => ({ scanTaskId: taskId, videos: [], identities: [], partial: true });
  if (await stopRequested(store, input.workflowRunId, input.accountId)) return stoppedScan();
  const identification = await getLibraryIdentificationService(scope);
  const identificationStore = new PostgresIdentificationStore(services.pool);
  await identification.enqueueForScan(scope, taskId);
  await identification.drainPending(scope, 1);
  let identificationJob = await identificationStore.getJob(scope, taskId);
  while (identificationJob?.status === "pending" || identificationJob?.status === "running" || identificationJob?.status === "waiting") {
    if (await stopRequested(store, input.workflowRunId, input.accountId)) {
      await services.pool.query("UPDATE library_identification_jobs SET status='cancelled',lease_id=NULL,lease_expires_at=NULL WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status<>'completed'", [scope.accountId, scope.connectedStorageId, taskId]);
      return stoppedScan();
    }
    await identification.processTaskBatch(scope, taskId);
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    identificationJob = await identificationStore.getJob(scope, taskId);
  }
  const videos: VerifiedFile[] = [];
  let afterFileId: string | undefined;
  do {
    const files = await services.scanStore.listTaskFiles(scope, taskId, { limit: 1000, ...(afterFileId ? { afterFileId } : {}) });
    for (const file of files) {
      if (!file.isDirectory && /\.(?:mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm)$/i.test(file.name)) videos.push({
        id: `msg_file_${file.fileId}`, providerFileId: file.fileId, storageDirectoryId: file.parentDirectoryId,
        name: file.name, sizeBytes: file.sizeBytes ?? 0, episodeCode: null,
      });
    }
    afterFileId = files.length === 1000 ? files.at(-1)?.fileId : undefined;
  } while (afterFileId);
  const identities: LinkIdentityFact[] = [];
  let cursor: string | undefined;
  do {
    const page = await identification.list(scope, taskId, { limit: 100, ...(cursor ? { afterFileId: cursor } : {}) });
    for (const item of page.items) identities.push({
      fileId: item.fileId,
      status: item.status === "confirmed" && item.importStatus === "imported" ? "confirmed" : item.status === "pending" ? "ambiguous" : "unresolved",
      identityKey: item.status === "confirmed" ? `${scope.accountId}:${scope.connectedStorageId}:${item.mediaType}:${item.tmdbId}` : null,
    });
    cursor = page.hasMore ? page.nextCursor ?? undefined : undefined;
  } while (cursor);
  return { scanTaskId: taskId, videos, identities, partial: task.status !== "completed" || identificationJob?.status !== "completed" };
}

async function stopRequested(store: PostgresMessagingStore, workflowRunId: string, accountId: string): Promise<boolean> {
  const id = workflowRunId.replace(/^messaging-direct-/, "");
  return (await store.get(accountId, id))?.stopRequested === true;
}

async function landingExecutor(accountId: string, storageId: string, provider: string, directoryId: string, workflowRunId: string): Promise<StorageExecutor> {
  const parents = await getWorkerStorageParents(accountId, storageId, { strictId: true, provisionMissingDirs: false });
  const reader = await getLibraryStorageExecutor(accountId, storageId);
  const expectedName = `消息转存-${workflowRunId.replace(/^messaging-direct-/, "")}`;
  const matching = (await reader.listChildDirectories(parents.movies)).filter((d) => d.id === directoryId && d.name === expectedName);
  if (matching.length !== 1) throw new Error("消息落地区不在所选网盘的授权电影根下");
  return ["pan123", "tianyi", "guangya"].includes(provider)
    ? getLibraryStorageExecutor(accountId, storageId, [directoryId]) : reader;
}

async function landedMediaItems(accountId: string, storageId: string, label: string, fileIds: readonly string[]): Promise<LandedMediaItem[]> {
  const result = await getLibraryPool().query<{ title_payload: MediaTitle; season_payload: TrackedSeason; episode_codes: unknown }>(
    `SELECT t.payload AS title_payload,s.payload AS season_payload,b.episode_codes FROM library_file_bindings b
      JOIN media_titles t ON t.id=b.media_title_id
      JOIN tracked_seasons s ON s.id=b.tracked_season_id AND s.connected_storage_id=b.connected_storage_id AND s.account_id=b.account_id
      WHERE b.account_id=$1 AND b.connected_storage_id=$2 AND b.file_id=ANY($3::text[])`,
    [accountId, storageId, [...fileIds]],
  );
  const groups = new Map<string, LandedMediaItem>();
  for (const row of result.rows) {
    const title = row.title_payload;
    const season = row.season_payload;
    const key = `${title.type}:${title.tmdbId}:${season.seasonNumber}`;
    const current = groups.get(key) ?? { titleName: title.title, mediaType: title.type, tmdbId: title.tmdbId, year: title.year, driveLabels: [label], ...(title.type === "movie" ? {} : { seasonLabel: `S${String(season.seasonNumber).padStart(2, "0")}` }) };
    const episodeCodes = Array.isArray(row.episode_codes)
      ? row.episode_codes.filter((code): code is string => typeof code === "string" && code.trim().length > 0)
      : [];
    if (title.type !== "movie" && episodeCodes.length > 0) {
      current.newlyObtained = [...new Set([...(current.newlyObtained ?? []), ...episodeCodes])];
    }
    groups.set(key, current);
  }
  return [...groups.values()];
}
