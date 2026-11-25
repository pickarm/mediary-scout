import {
  brandOfUrl,
  resourceLinkKey,
  type ResourceCandidate,
  type TransferStatus,
  type VerifiedFile,
} from "@media-track/workflow";
import type {
  MessagingCandidate,
  MessagingJob,
  MessagingJobPhase,
  PostgresMessagingStore,
} from "./store";
import type { MessagingConnection } from "./types";

export type LinkStorageProvider =
  | "pan115"
  | "quark"
  | "uc"
  | "pan123"
  | "tianyi"
  | "guangya";

type RecognizedResourceType = NonNullable<ReturnType<typeof brandOfUrl>>;

export interface RecognizedUserLink {
  url: string;
  type: RecognizedResourceType;
  linkKey: string;
  compatibleProviders: readonly LinkStorageProvider[];
}

export interface LinkStorageOption {
  id: string;
  label: string;
  provider: LinkStorageProvider;
}

export interface LinkPreparedLanding {
  directoryId: string;
  name: string;
}

export type LinkSubmissionReceipt = Record<string, unknown>;

export interface LinkTransferInput {
  accountId: string;
  storage: LinkStorageOption;
  landingDirectoryId: string;
  workflowRunId: string;
  candidate: ResourceCandidate;
  link: RecognizedUserLink;
  wholePackage: true;
  onSubmitted(receipt: LinkSubmissionReceipt): Promise<void>;
}

export interface LinkTransferResult {
  status: TransferStatus | "unknown";
  providerMessage: string;
  receipt: Record<string, unknown>;
  materializedFileIds: readonly string[];
}

export interface LinkTransferReconcileInput {
  accountId: string;
  storage: LinkStorageOption;
  landingDirectoryId: string;
  workflowRunId: string;
  link: RecognizedUserLink;
  providerTaskId: string | null;
  receipt: Record<string, unknown>;
}

export interface LinkTransferReconcileResult {
  status: "pending" | "succeeded" | "failed" | "unknown";
  providerMessage: string;
  receipt: Record<string, unknown>;
  materializedFileIds: readonly string[];
}

export interface LinkIdentityFact {
  fileId: string;
  status: "confirmed" | "ambiguous" | "unresolved";
  identityKey: string | null;
}

export interface LinkScanInput {
  accountId: string;
  storage: LinkStorageOption;
  landingDirectoryId: string;
  workflowRunId: string;
  link: RecognizedUserLink;
  autoAcquire: false;
  onScanStarted(scanTaskId: string): Promise<void>;
}

export interface LinkScanResult {
  scanTaskId: string;
  videos: readonly VerifiedFile[];
  identities: readonly LinkIdentityFact[];
  partial: boolean;
}

export interface LinkOrganizationInput {
  accountId: string;
  storage: LinkStorageOption;
  landingDirectoryId: string;
  workflowRunId: string;
  scanTaskId: string;
  videos: readonly VerifiedFile[];
  identities: readonly LinkIdentityFact[];
}

export interface LinkOrganizationResult {
  organizationKey: string;
  status: "completed" | "partial";
  verifiedNewVideoFileIds: readonly string[];
  providerMessage: string;
}

export interface LinkRefreshInput {
  accountId: string;
  storage: LinkStorageOption;
  workflowRunId: string;
  organizationKey: string;
  verifiedNewVideoFileIds: readonly string[];
}

export type LinkImportStore = Pick<
  PostgresMessagingStore,
  "get" | "update" | "saveResult" | "replacePendingCandidates"
>;

export interface LinkImportDependencies {
  store: LinkImportStore;
  listStorages(accountId: string): Promise<readonly LinkStorageOption[]>;
  prepareLanding(input: {
    accountId: string;
    connectionId: string;
    jobId: string;
    workflowRunId: string;
    storage: LinkStorageOption;
    link: RecognizedUserLink;
  }): Promise<LinkPreparedLanding>;
  submitTransfer(input: LinkTransferInput): Promise<LinkTransferResult>;
  reconcileTransfer(input: LinkTransferReconcileInput): Promise<LinkTransferReconcileResult>;
  scanAndIdentify(input: LinkScanInput): Promise<LinkScanResult>;
  organize(input: LinkOrganizationInput): Promise<LinkOrganizationResult>;
  refresh(input: LinkRefreshInput): Promise<void>;
  now?(): string;
}

export interface LinkImportOutcome {
  phase: MessagingJobPhase;
  text: string;
  result: Record<string, unknown>;
  choices?: readonly MessagingCandidate[];
}

export function recognizeUserLink(text: string): RecognizedUserLink | null {
  const url = extractResourceLink(text);
  if (!url) return null;
  const type = brandOfUrl(url);
  const linkKey = resourceLinkKey(url);
  if (!type || !linkKey) return null;
  return {
    url,
    type,
    linkKey,
    compatibleProviders: compatibleProvidersFor(type),
  };
}

export async function processLinkImport(
  job: MessagingJob,
  connection: MessagingConnection,
  deps: LinkImportDependencies,
): Promise<LinkImportOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const link = requireOwnedLink(job, connection);
  const existingReceipt = directTransferReceipt(job.receipt);
  if (job.stopRequested) {
    if (hasSubmissionEvidence(existingReceipt) || rawSubmissionEvidence(job.receipt)) {
      return stopAfterSubmission(job, link, deps, now);
    }
    return stopBeforeSubmission(job, link, existingReceipt, deps, now);
  }
  const storages = await deps.listStorages(connection.accountId);
  const compatible = storages.filter((storage) =>
    link.compatibleProviders.includes(storage.provider),
  );
  const selectedIndex = job.selectedCandidateIndex;
  const selectedStorage =
    selectedIndex === null ? null : storageFromJobCandidate(job, selectedIndex, compatible);
  const defaultStorage =
    compatible.find((storage) => storage.id === connection.defaultStorageId) ?? null;
  const persistedStorageId =
    stringField(existingReceipt?.["storageId"]) ?? job.landingStorageId;
  const persistedStorage =
    persistedStorageId === null
      ? null
      : compatible.find((storage) => storage.id === persistedStorageId) ?? null;
  const storage =
    persistedStorage ??
    selectedStorage ??
    defaultStorage ??
    (compatible.length === 1 ? compatible[0]! : null);

  if (!storage) {
    if (compatible.length > 1) {
      const candidates = compatible.map(
        (option): MessagingCandidate => ({
          kind: "storage",
          value: option.id,
          label: option.label,
        }),
      );
      const saved = await deps.store.replacePendingCandidates(
        job.accountId,
        job.id,
        candidates,
        now(),
      );
      if (!saved) throw new Error("直转网盘选择保存失败");
      const text = [
        "请选择目标网盘：",
        ...candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`),
        "",
        "回复序号，或点击按钮。",
      ].join("\n");
      const result = {
        kind: "direct_link_storage_selection",
        resourceType: link.type,
        resourceLinkKey: link.linkKey,
        text,
      };
      await deps.store.saveResult(
        job.accountId,
        job.id,
        { phase: "pending_selection", result, sendStatus: "pending" },
        now(),
      );
      return { phase: "pending_selection", text, result, choices: candidates };
    }
    return persistFinal(deps.store, job, {
      phase: "failed",
      result: {
        kind: "direct_link_result",
        stage: "no_compatible_storage",
        resourceType: link.type,
        resourceLinkKey: link.linkKey,
        text: "当前账号没有兼容该链接的网盘，请先添加对应网盘。",
      },
      error: "当前账号没有兼容该链接的网盘",
    }, null, now);
  }

  if (existingReceipt) {
    const stage = receiptStage(existingReceipt);
    if (stage === "intent" || stage === "landing_ready") {
      return continuePreSubmitTransfer(job, storage, link, existingReceipt, deps, now);
    }
    return reconcileExistingTransfer(job, storage, link, existingReceipt, deps, now);
  }
  if (job.landingDirectoryId) {
    return persistSubmissionUnknown(job, storage, link, deps, now);
  }

  return continuePreSubmitTransfer(job, storage, link, null, deps, now);
}

async function continuePreSubmitTransfer(
  job: MessagingJob,
  storage: LinkStorageOption,
  link: RecognizedUserLink,
  existingReceipt: Record<string, unknown> | null,
  deps: LinkImportDependencies,
  now: () => string,
): Promise<LinkImportOutcome> {
  const workflowRunId =
    stringField(existingReceipt?.["workflowRunId"]) ??
    job.workflowRunId ??
    `messaging-direct-${job.id}`;
  const intentReceipt: Record<string, unknown> = {
    ...(existingReceipt ?? {}),
    kind: "direct_link_transfer",
    version: 1,
    stage: "intent",
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
    storageId: storage.id,
    workflowRunId,
    createdAt: stringField(existingReceipt?.["createdAt"]) ?? now(),
  };
  const intentResult = {
    kind: "direct_link_result",
    stage: "intent",
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
    storageId: storage.id,
    text: "已登记直转意图，正在创建独立落地区。",
  };
  if (existingReceipt === null) {
    await mustUpdate(deps.store, job, {
      inputKind: "direct_link",
      phase: "direct_pending",
      landingStorageId: storage.id,
      receipt: intentReceipt,
      result: intentResult,
      error: null,
    }, now());
  }

  const persistedLandingId =
    stringField(existingReceipt?.["landingDirectoryId"]) ?? job.landingDirectoryId;
  const landing = persistedLandingId === null
    ? await deps.prepareLanding({
        accountId: job.accountId,
        connectionId: job.connectionId,
        jobId: job.id,
        workflowRunId,
        storage,
        link,
      })
    : {
        directoryId: persistedLandingId,
        name:
          stringField(existingReceipt?.["landingDirectoryName"]) ??
          `消息直转-${job.id}`,
      };
  const landingReceipt: Record<string, unknown> = {
    ...intentReceipt,
    stage: "landing_ready",
    landingDirectoryId: landing.directoryId,
    landingDirectoryName: landing.name,
  };
  const landingResult = {
    ...intentResult,
    stage: "landing_ready",
    landingDirectoryId: landing.directoryId,
    text: "落地区已创建，正在提交直转。",
  };
  await mustUpdate(deps.store, job, {
    phase: "direct_pending",
    landingDirectoryId: landing.directoryId,
    receipt: landingReceipt,
    result: landingResult,
  }, now());

  const afterLanding = await requireJob(deps.store, job);
  if (afterLanding.stopRequested) {
    return stopBeforeSubmission(job, link, landingReceipt, deps, now);
  }

  const candidate = candidateForUserLink(job, link);
  const submittingReceipt: Record<string, unknown> = {
    ...landingReceipt,
    stage: "submitting",
    submissionStartedAt: now(),
  };
  await mustUpdate(deps.store, job, {
    phase: "direct_pending",
    receipt: submittingReceipt,
    result: {
      ...landingResult,
      stage: "submitting",
      text: "落地区已确认，正在向网盘提交直转。",
    },
  }, stringField(submittingReceipt["submissionStartedAt"]) ?? now());

  const beforeSubmit = await requireJob(deps.store, job);
  if (beforeSubmit.stopRequested) {
    return stopBeforeSubmission(job, link, submittingReceipt, deps, now);
  }

  const transfer = await deps.submitTransfer({
    accountId: job.accountId,
    storage,
    landingDirectoryId: landing.directoryId,
    workflowRunId,
    candidate,
    link,
    wholePackage: true,
    onSubmitted: async (submitted) => {
      const submittedReceipt: Record<string, unknown> = {
        ...landingReceipt,
        stage: "submitted",
        ...submitted,
        kind: "direct_link_transfer",
        providerKind: stringField(submitted["kind"]),
        providerTaskId: stringField(submitted["providerTaskId"]),
        submittedAt: stringField(submitted["submittedAt"]) ?? now(),
      };
      const providerTaskId = stringField(submittedReceipt["providerTaskId"]);
      await mustUpdate(deps.store, job, {
        phase: "submitted",
        receipt: submittedReceipt,
        result: {
          ...landingResult,
          stage: "submitted",
          ...(providerTaskId === null ? {} : { providerTaskId }),
          text: `已提交到 ${storage.label}，等待网盘完成转存。`,
        },
      }, stringField(submittedReceipt["submittedAt"]) ?? now());
    },
  });

  const latest = await requireJob(deps.store, job);
  const latestReceipt = recordOrEmpty(latest.receipt);
  const providerKind =
    stringField(transfer.receipt["kind"]) ??
    stringField(transfer.receipt["providerKind"]) ??
    stringField(latestReceipt["providerKind"]);
  const completedReceipt: Record<string, unknown> = {
    ...latestReceipt,
    ...transfer.receipt,
    kind: "direct_link_transfer",
    ...(providerKind === null ? {} : { providerKind }),
    stage: transfer.status === "failed" ? "failed" : transfer.status,
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
    storageId: storage.id,
    landingDirectoryId: landing.directoryId,
    workflowRunId,
  };
  const submittedState = transferState(completedReceipt);
  if (
    submittedState === "failed" ||
    (submittedState === null && transfer.status === "failed")
  ) {
    return persistFinal(deps.store, job, {
      phase: "failed",
      result: {
        kind: "direct_link_result",
        stage: "transfer_failed",
        storageId: storage.id,
        landingDirectoryId: landing.directoryId,
        providerMessage: transfer.providerMessage,
        text: `转存失败：${transfer.providerMessage}`,
      },
      error: transfer.providerMessage,
    }, completedReceipt, now);
  }
  if (submittedState === "completed") {
    return continueAfterConfirmedTransfer(
      job,
      storage,
      link,
      landing.directoryId,
      workflowRunId,
      deps,
      {
        ...completedReceipt,
        stage: "transfer_completed",
      },
      now,
    );
  }
  return persistFinal(deps.store, job, {
    phase: "transferring",
    result: {
      kind: "direct_link_result",
      stage: transfer.status === "unknown" ? "submitted_unknown" : "transferring",
      storageId: storage.id,
      landingDirectoryId: landing.directoryId,
      providerMessage: transfer.providerMessage,
      text:
        transfer.status === "unknown"
          ? "直转提交结果尚未确认；后续只核对回执和落盘目录，不会重复提交。"
          : "已提交直转；后续只核对回执和落盘目录，不会重复提交。",
    },
  }, completedReceipt, now);
}

export function extractResourceLink(text: string): string | null {
  const magnet = /magnet:\?[^\s。！？；，、：]+/i.exec(text);
  if (magnet) return magnet[0];
  const web = /https?:\/\/[^\s。！？；，、：]+/i.exec(text);
  return web?.[0] ?? null;
}

function compatibleProvidersFor(
  type: RecognizedResourceType,
): readonly LinkStorageProvider[] {
  switch (type) {
    case "115":
      return ["pan115"];
    case "quark":
      return ["quark"];
    case "uc":
      return ["uc"];
    case "123":
      return ["pan123"];
    case "tianyi":
      return ["tianyi"];
    case "guangya":
      return ["guangya"];
    case "magnet":
      return ["pan115", "pan123", "guangya"];
  }
}

function requireOwnedLink(
  job: MessagingJob,
  connection: MessagingConnection,
): RecognizedUserLink {
  if (
    job.accountId !== connection.accountId ||
    job.connectionId !== connection.id ||
    job.senderId !== connection.senderId
  ) {
    throw new Error("消息任务不属于当前账号连接");
  }
  const link = recognizeUserLink(job.text);
  if (!link) throw new Error("消息中没有可直转的受支持链接");
  return link;
}

function storageFromJobCandidate(
  job: MessagingJob,
  index: number,
  compatible: readonly LinkStorageOption[],
): LinkStorageOption | null {
  const candidate = job.candidates[index];
  if (!candidate || candidate.kind !== "storage") return null;
  return compatible.find((storage) => storage.id === candidate.value) ?? null;
}

function candidateForUserLink(
  job: MessagingJob,
  link: RecognizedUserLink,
): ResourceCandidate {
  const accessCode = extractLabeledAccessCode(job.text, link.url);
  return {
    id: `messaging:${job.id}`,
    snapshotId: `messaging:${job.id}`,
    index: 0,
    title: "用户消息直达链接",
    type: link.type,
    source: "user_message",
    providerPayload: {
      url: link.url,
      resourceLinkKey: link.linkKey,
      ...(accessCode === null ? {} : { password: accessCode }),
    },
  };
}

function extractLabeledAccessCode(text: string, url: string): string | null {
  const outsideUrl = text.replace(url, " ");
  return /(?:提取码|访问码|密码)\s*[:：]\s*([A-Za-z0-9]{1,32})/u.exec(outsideUrl)?.[1] ?? null;
}

async function requireJob(
  store: LinkImportStore,
  job: MessagingJob,
): Promise<MessagingJob> {
  const current = await store.get(job.accountId, job.id);
  if (!current) throw new Error("消息任务不存在或不属于当前账号");
  return current;
}

async function mustUpdate(
  store: LinkImportStore,
  job: MessagingJob,
  patch: Parameters<LinkImportStore["update"]>[2],
  now: string,
): Promise<void> {
  if (!(await store.update(job.accountId, job.id, patch, now))) {
    throw new Error("消息任务状态更新失败");
  }
}

async function persistFinal(
  store: LinkImportStore,
  job: MessagingJob,
  input: {
    phase: MessagingJobPhase;
    result: Record<string, unknown>;
    error?: string | null;
  },
  receipt: Record<string, unknown> | null,
  now: () => string,
): Promise<LinkImportOutcome> {
  const timestamp = now();
  if (receipt) await mustUpdate(store, job, { receipt }, timestamp);
  const text = typeof input.result.text === "string" ? input.result.text : "直转状态已更新。";
  if (
    !(await store.saveResult(
      job.accountId,
      job.id,
      {
        phase: input.phase,
        result: input.result,
        sendStatus: "pending",
        ...(input.error === undefined ? {} : { error: input.error }),
      },
      timestamp,
    ))
  ) {
    throw new Error("消息任务结果保存失败");
  }
  return {
    phase: input.phase,
    text,
    result: input.result,
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function directTransferReceipt(value: unknown): Record<string, unknown> | null {
  const receipt = recordOrEmpty(value);
  return receipt["kind"] === "direct_link_transfer" ? receipt : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function receiptStage(receipt: Record<string, unknown> | null): string | null {
  return stringField(receipt?.["stage"]);
}

function hasSubmissionEvidence(receipt: Record<string, unknown> | null): boolean {
  if (!receipt) return false;
  const stage = receiptStage(receipt);
  if (
    stringField(receipt["providerKind"]) !== null ||
    stringField(receipt["providerTaskId"]) !== null ||
    stringField(receipt["infoHash"]) !== null ||
    transferState(receipt) !== null
  ) {
    return true;
  }
  if (stage === "intent" || stage === "landing_ready") return false;
  return stage !== null;
}

function rawSubmissionEvidence(value: unknown): boolean {
  if (directTransferReceipt(value)) return false;
  const receipt = recordOrEmpty(value);
  if (receipt["kind"] === undefined && receiptStage(receipt) === null) return false;
  const stage = receiptStage(receipt);
  return stage === "submitting" || stage === "submitted" ||
    stringField(receipt["providerKind"]) !== null ||
    stringField(receipt["providerTaskId"]) !== null ||
    stringField(receipt["infoHash"]) !== null ||
    transferState(receipt) !== null;
}

async function stopBeforeSubmission(
  job: MessagingJob,
  link: RecognizedUserLink,
  receipt: Record<string, unknown> | null,
  deps: LinkImportDependencies,
  now: () => string,
): Promise<LinkImportOutcome> {
  const storageId = stringField(receipt?.["storageId"]) ?? job.landingStorageId;
  const landingDirectoryId =
    stringField(receipt?.["landingDirectoryId"]) ?? job.landingDirectoryId;
  const stoppedReceipt = receipt === null && storageId === null && landingDirectoryId === null
    ? null
    : {
        ...(receipt ?? {}),
        kind: "direct_link_transfer",
        version: 1,
        stage: "stopped_before_submit",
        resourceType: link.type,
        resourceLinkKey: link.linkKey,
        ...(storageId === null ? {} : { storageId }),
        ...(landingDirectoryId === null ? {} : { landingDirectoryId }),
        workflowRunId: job.workflowRunId ?? `messaging-direct-${job.id}`,
        stoppedAt: now(),
      };
  return persistFinal(deps.store, job, {
    phase: "stopped",
    result: {
      kind: "direct_link_result",
      stage: "stopped_before_submit",
      resourceType: link.type,
      resourceLinkKey: link.linkKey,
      ...(storageId === null ? {} : { storageId }),
      ...(landingDirectoryId === null ? {} : { landingDirectoryId }),
      text: "任务尚未提交，已停止；远端没有创建新的直转任务。",
    },
  }, stoppedReceipt, now);
}

async function stopAfterSubmission(
  job: MessagingJob,
  link: RecognizedUserLink,
  deps: LinkImportDependencies,
  now: () => string,
): Promise<LinkImportOutcome> {
  const rawReceipt = directTransferReceipt(job.receipt) ?? recordOrEmpty(job.receipt);
  const rawKind = stringField(rawReceipt["kind"]);
  const providerKind =
    stringField(rawReceipt["providerKind"]) ??
    (rawKind === null || rawKind === "direct_link_transfer" ? null : rawKind);
  const storageId = stringField(rawReceipt["storageId"]) ?? job.landingStorageId;
  const landingDirectoryId =
    stringField(rawReceipt["landingDirectoryId"]) ?? job.landingDirectoryId;
  const stoppedReceipt: Record<string, unknown> = {
    ...rawReceipt,
    kind: "direct_link_transfer",
    ...(providerKind === null ? {} : { providerKind }),
    stage: "stopped_after_submit",
    stoppedAt: now(),
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
  };
  return persistFinal(deps.store, job, {
    phase: "stopped",
    result: {
      kind: "direct_link_result",
      stage: "stopped_after_submit",
      resourceType: link.type,
      resourceLinkKey: link.linkKey,
      ...(storageId === null ? {} : { storageId }),
      ...(landingDirectoryId === null ? {} : { landingDirectoryId }),
      text: "已停止后续识别和整理；远端任务可能仍会完成，已落盘文件不会删除。",
    },
  }, stoppedReceipt, now);
}

async function persistSubmissionUnknown(
  job: MessagingJob,
  storage: LinkStorageOption,
  link: RecognizedUserLink,
  deps: LinkImportDependencies,
  now: () => string,
): Promise<LinkImportOutcome> {
  const workflowRunId = job.workflowRunId ?? `messaging-direct-${job.id}`;
  const receipt: Record<string, unknown> = {
    kind: "direct_link_transfer",
    version: 1,
    stage: "submission_unknown",
    state: "unknown",
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
    storageId: storage.id,
    landingDirectoryId: job.landingDirectoryId,
    workflowRunId,
  };
  return persistFinal(deps.store, job, {
    phase: "transferring",
    result: {
      kind: "direct_link_result",
      stage: "submitted_unknown",
      resourceType: link.type,
      resourceLinkKey: link.linkKey,
      storageId: storage.id,
      landingDirectoryId: job.landingDirectoryId,
      text: "落地区存在但缺少提交阶段回执；只保留文件并等待人工核实，不会重复提交。",
    },
  }, receipt, now);
}

function transferState(
  receipt: Record<string, unknown> | null,
): "running" | "completed" | "failed" | "unknown" | null {
  const state = receipt?.["state"];
  return state === "running" ||
    state === "completed" ||
    state === "failed" ||
    state === "unknown"
    ? state
    : null;
}

async function reconcileExistingTransfer(
  job: MessagingJob,
  storage: LinkStorageOption,
  link: RecognizedUserLink,
  receipt: Record<string, unknown> | null,
  deps: LinkImportDependencies,
  now: () => string,
): Promise<LinkImportOutcome> {
  const workflowRunId =
    stringField(receipt?.["workflowRunId"]) ??
    job.workflowRunId ??
    `messaging-direct-${job.id}`;
  let landingDirectoryId =
    stringField(receipt?.["landingDirectoryId"]) ?? job.landingDirectoryId;
  if (!landingDirectoryId) {
    const landing = await deps.prepareLanding({
      accountId: job.accountId,
      connectionId: job.connectionId,
      jobId: job.id,
      workflowRunId,
      storage,
      link,
    });
    landingDirectoryId = landing.directoryId;
  }
  const state = transferState(receipt);
  if (state === "completed") {
    return continueAfterConfirmedTransfer(
      job,
      storage,
      link,
      landingDirectoryId,
      workflowRunId,
      deps,
      {
        ...(receipt ?? {}),
        kind: "direct_link_transfer",
        version: 1,
        stage: "transfer_completed",
        resourceType: link.type,
        resourceLinkKey: link.linkKey,
        storageId: storage.id,
        landingDirectoryId,
        workflowRunId,
      },
      now,
    );
  }
  if (state === "failed") {
    return persistFinal(deps.store, job, {
      phase: "failed",
      result: {
        kind: "direct_link_result",
        stage: "transfer_failed",
        storageId: storage.id,
        landingDirectoryId,
        text: "远端转存回执为失败；不会重复提交。",
      },
      error: "远端转存回执为失败",
    }, receipt, now);
  }
  const result = await deps.reconcileTransfer({
    accountId: job.accountId,
    storage,
    landingDirectoryId,
    workflowRunId,
    link,
    providerTaskId: stringField(receipt?.["providerTaskId"]),
    receipt: receipt ?? {},
  });
  const reconciledReceipt: Record<string, unknown> = {
    ...(receipt ?? {}),
    ...result.receipt,
    kind: "direct_link_transfer",
    providerKind:
      stringField(result.receipt["kind"]) ??
      stringField(receipt?.["providerKind"]),
    version: 1,
    stage: `reconciled_${result.status}`,
    resourceType: link.type,
    resourceLinkKey: link.linkKey,
    storageId: storage.id,
    landingDirectoryId,
    workflowRunId,
    reconciledAt: now(),
  };
  const reconciledState = transferState(reconciledReceipt);
  if (result.status === "failed" || reconciledState === "failed") {
    return persistFinal(deps.store, job, {
      phase: "failed",
      result: {
        kind: "direct_link_result",
        stage: "transfer_failed",
        storageId: storage.id,
        landingDirectoryId,
        providerMessage: result.providerMessage,
        text: `转存失败：${result.providerMessage}`,
      },
      error: result.providerMessage,
    }, reconciledReceipt, now);
  }
  if (reconciledState !== "completed") {
    return persistFinal(deps.store, job, {
      phase: "transferring",
      result: {
        kind: "direct_link_result",
        stage: "submitted_unknown",
        storageId: storage.id,
        landingDirectoryId,
        providerMessage: result.providerMessage,
        text: "远端转存仍待确认；只核对既有回执和落盘目录，不会重复提交。",
      },
    }, reconciledReceipt, now);
  }
  return continueAfterConfirmedTransfer(
    job,
    storage,
    link,
    landingDirectoryId,
    workflowRunId,
    deps,
    {
      ...reconciledReceipt,
      stage: "transfer_completed",
    },
    now,
  );
}

async function continueAfterConfirmedTransfer(
  job: MessagingJob,
  storage: LinkStorageOption,
  link: RecognizedUserLink,
  landingDirectoryId: string,
  workflowRunId: string,
  deps: LinkImportDependencies,
  transferReceipt: Record<string, unknown>,
  now: () => string,
): Promise<LinkImportOutcome> {
  const afterTransfer = await requireJob(deps.store, job);
  if (afterTransfer.stopRequested) {
    return persistFinal(deps.store, job, {
      phase: "stopped",
      result: {
        kind: "direct_link_result",
        stage: "stopped_after_submit",
        storageId: storage.id,
        landingDirectoryId,
        text: "已停止后续识别和整理；远端任务可能仍会完成，已落盘文件不会删除。",
      },
    }, {
      ...transferReceipt,
      stage: "stopped_after_submit",
    }, now);
  }

  const verifyingReceipt: Record<string, unknown> = {
    ...transferReceipt,
    stage: "verifying_landing",
  };
  await mustUpdate(deps.store, job, {
    phase: "verifying",
    receipt: verifyingReceipt,
    result: {
      kind: "direct_link_result",
      stage: "verifying_landing",
      storageId: storage.id,
      landingDirectoryId,
      text: "远端已回执完成，正在扫描独立落地区并核实实际落盘文件。",
    },
  }, now());

  let scanStartedReceipt = verifyingReceipt;
  const scan = await deps.scanAndIdentify({
    accountId: job.accountId,
    storage,
    landingDirectoryId,
    workflowRunId,
    link,
    autoAcquire: false,
    onScanStarted: async (scanTaskId) => {
      scanStartedReceipt = {
        ...verifyingReceipt,
        stage: "scan_started",
        scanTaskId,
      };
      await mustUpdate(deps.store, job, {
        phase: "identifying",
        scanTaskId,
        receipt: scanStartedReceipt,
        result: {
          kind: "direct_link_result",
          stage: "scan_started",
          scanTaskId,
          storageId: storage.id,
          landingDirectoryId,
          autoAcquire: false,
          text: "已扫描落地区，正在识别文件身份。",
        },
      }, now());
    },
  });
  const afterScan = await requireJob(deps.store, job);
  if (afterScan.stopRequested) {
    return persistFinal(deps.store, job, {
      phase: "stopped",
      result: {
        kind: "direct_link_result",
        stage: "stopped_after_submit",
        scanTaskId: scan.scanTaskId,
        storageId: storage.id,
        landingDirectoryId,
        text: "扫描已结束；收到停止请求，未继续识别和整理，已落盘文件不会删除。",
      },
    }, {
      ...scanStartedReceipt,
      stage: "stopped_after_submit",
      scanTaskId: scan.scanTaskId,
      stoppedAt: now(),
    }, now);
  }
  const scanReceipt: Record<string, unknown> = {
    ...scanStartedReceipt,
    stage: "identified",
    scanTaskId: scan.scanTaskId,
    identityFileCount: scan.identities.length,
  };
  const identityByFileId = new Map(
    scan.identities.map((identity) => [identity.fileId, identity] as const),
  );
  const pendingIdentityFileIds = scan.videos
    .filter((videoFile) => identityByFileId.get(videoFile.providerFileId)?.status !== "confirmed")
    .map((videoFile) => videoFile.providerFileId);
  if (scan.videos.length === 0) {
    pendingIdentityFileIds.push("no_video_found");
  }
  if (scan.partial || pendingIdentityFileIds.length > 0) {
    return persistFinal(deps.store, job, {
      phase: "partial",
      result: {
        kind: "direct_link_result",
        stage: "identity_partial",
        scanTaskId: scan.scanTaskId,
        storageId: storage.id,
        landingDirectoryId,
        pendingIdentityFileIds,
        autoAcquire: false,
        text: "部分文件身份尚未确认，文件保留在原落地区，未执行整理。",
      },
    }, {
      ...scanReceipt,
      stage: "identity_partial",
    }, now);
  }

  const organizingReceipt: Record<string, unknown> = {
    ...scanReceipt,
    stage: "organizing",
  };
  await mustUpdate(deps.store, job, {
    phase: "organizing",
    scanTaskId: scan.scanTaskId,
    receipt: organizingReceipt,
    result: {
      kind: "direct_link_result",
      stage: "organizing",
      scanTaskId: scan.scanTaskId,
      storageId: storage.id,
      landingDirectoryId,
      autoAcquire: false,
      text: "文件身份已确认，正在按原整理规则处理视频和字幕。",
    },
  }, now());
  const organization = await deps.organize({
    accountId: job.accountId,
    storage,
    landingDirectoryId,
    workflowRunId,
    scanTaskId: scan.scanTaskId,
    videos: scan.videos,
    identities: scan.identities,
  });
  const organizedReceipt: Record<string, unknown> = {
    ...organizingReceipt,
    stage: `organized_${organization.status}`,
    organizationKey: organization.organizationKey,
    verifiedNewVideoFileIds: organization.verifiedNewVideoFileIds,
  };
  await mustUpdate(deps.store, job, {
    organizationKey: organization.organizationKey,
    receipt: organizedReceipt,
  }, now());
  let refreshStatus: "refreshed" | "skipped" | "failed" | "unknown" = "skipped";
  let refreshError: string | null = null;
  let finalReceipt = organizedReceipt;
  if (
    organization.status === "completed" &&
    organization.verifiedNewVideoFileIds.length > 0
  ) {
    if (stringField(organizedReceipt["refreshStartedAt"]) !== null) {
      refreshStatus = "unknown";
    } else {
      const refreshStartedAt = now();
      finalReceipt = {
        ...organizedReceipt,
        stage: "refresh_pending",
        refreshStartedAt,
        refreshFileIds: [...organization.verifiedNewVideoFileIds],
      };
      await mustUpdate(deps.store, job, {
        receipt: finalReceipt,
      }, refreshStartedAt);
      try {
        await deps.refresh({
          accountId: job.accountId,
          storage,
          workflowRunId,
          organizationKey: organization.organizationKey,
          verifiedNewVideoFileIds: organization.verifiedNewVideoFileIds,
        });
        refreshStatus = "refreshed";
      } catch (error) {
        refreshStatus = "failed";
        refreshError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  finalReceipt = {
    ...finalReceipt,
    stage: organization.status === "completed" ? "completed" : "organization_partial",
    refreshStatus,
    ...(refreshError === null ? {} : { refreshError }),
  };
  return persistFinal(deps.store, job, {
    phase: organization.status,
    result: {
      kind: "direct_link_result",
      stage:
        organization.status === "completed" ? "completed" : "organization_partial",
      scanTaskId: scan.scanTaskId,
      organizationKey: organization.organizationKey,
      storageId: storage.id,
      landingDirectoryId,
      verifiedNewVideoFileIds: organization.verifiedNewVideoFileIds,
      refreshStatus,
      ...(organization.status === "partial"
        ? { providerMessage: organization.providerMessage }
        : {}),
      autoAcquire: false,
      text:
        organization.status === "partial"
          ? `整理未全部完成：${organization.providerMessage}`
          : refreshStatus === "refreshed"
            ? "直转、识别和整理均已完成，原媒体库已刷新。"
            : refreshStatus === "unknown"
              ? "直转、识别和整理均已完成；刷新请求状态未知，本次不重复调用。"
              : "直转、识别和整理均已完成。",
    },
    error: refreshError,
  }, finalReceipt, now);
}
