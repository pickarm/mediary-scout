import { requestJson } from "./library-scan-client";

export type OrganizationPlanStatus = "planned" | "running" | "paused" | "completed" | "failed";
export type OrganizationOperationStatus = "planned" | "running" | "verified" | "failed";
export interface OrganizationPlanSummary {
  operationKey: string;
  status: OrganizationPlanStatus;
  executeRequested?: boolean;
  createdAt: string;
  updatedAt: string;
  operationCount: number;
  skippedFiles: readonly { fileId: string; reason: string }[];
}
export interface OrganizationOperation {
  operationId: string;
  fileId: string;
  originalParentId: string;
  originalName: string;
  targetRootId: string;
  targetRelativePath: string;
  targetParentId: string | null;
  targetName: string;
  pairedFileId: string;
  pairedVideoTargetPath: string;
  status: OrganizationOperationStatus;
  error: string | null;
}
export interface OrganizationPlansPage { plans: OrganizationPlanSummary[]; nextCursor: string | null }
export interface OrganizationOperationsPage { plan: OrganizationPlanSummary; operations: OrganizationOperation[]; nextCursor: string | null }
export interface OrganizationControlResult { operationKey: string; status: "queued" | "paused"; accepted: boolean }

export class OrganizationPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrganizationPayloadError";
  }
}

const planStatuses = new Set<OrganizationPlanStatus>(["planned", "running", "paused", "completed", "failed"]);
const operationStatuses = new Set<OrganizationOperationStatus>(["planned", "running", "verified", "failed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(message: string): never {
  throw new OrganizationPayloadError(message);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) invalidPayload(`服务器返回的${label}无效。`);
  return value;
}

function normalizePlanStatus(value: unknown): OrganizationPlanStatus {
  if (typeof value !== "string" || !planStatuses.has(value as OrganizationPlanStatus)) invalidPayload("服务器返回的整理清单状态无效。");
  return value as OrganizationPlanStatus;
}

function normalizeOperationStatus(value: unknown): OrganizationOperationStatus {
  if (typeof value !== "string" || !operationStatuses.has(value as OrganizationOperationStatus)) invalidPayload("服务器返回的整理操作状态无效。");
  return value as OrganizationOperationStatus;
}

function normalizeCursor(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, "分页游标");
}

function normalizePlan(value: unknown): OrganizationPlanSummary {
  if (!isRecord(value)) invalidPayload("服务器返回的整理清单格式无效。");
  const skipped = value.skippedFiles;
  if (skipped !== undefined && skipped !== null && !Array.isArray(skipped)) invalidPayload("服务器返回的跳过文件列表格式无效。");
  const skippedFiles = Array.isArray(skipped) ? skipped.flatMap((item) => isRecord(item) && typeof item.fileId === "string" && typeof item.reason === "string"
    ? [{ fileId: item.fileId, reason: item.reason }] : []) : [];
  const operationCount = typeof value.operationCount === "number" && Number.isFinite(value.operationCount) && value.operationCount >= 0
    ? Math.floor(value.operationCount) : 0;
  return {
    operationKey: requiredString(value.operationKey, "整理清单键"),
    status: normalizePlanStatus(value.status),
    ...(typeof value.executeRequested === "boolean" ? { executeRequested: value.executeRequested } : {}),
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    operationCount,
    skippedFiles,
  };
}

function normalizeOperation(value: unknown): OrganizationOperation {
  if (!isRecord(value)) invalidPayload("服务器返回的整理操作格式无效。");
  const fileId = requiredString(value.fileId, "整理文件 ID");
  const targetRelativePath = requiredString(value.targetRelativePath, "整理目标路径");
  return {
    operationId: requiredString(value.operationId, "整理操作 ID"),
    fileId,
    originalParentId: requiredString(value.originalParentId, "原始目录 ID"),
    originalName: requiredString(value.originalName, "原始文件名"),
    targetRootId: requiredString(value.targetRootId, "目标根目录 ID"),
    targetRelativePath,
    targetParentId: typeof value.targetParentId === "string" ? value.targetParentId : null,
    targetName: requiredString(value.targetName, "目标文件名"),
    pairedFileId: typeof value.pairedFileId === "string" ? value.pairedFileId : fileId,
    pairedVideoTargetPath: typeof value.pairedVideoTargetPath === "string" ? value.pairedVideoTargetPath : targetRelativePath,
    status: normalizeOperationStatus(value.status),
    error: typeof value.error === "string" ? value.error : null,
  };
}

function normalizePlansPage(value: unknown): OrganizationPlansPage {
  if (!isRecord(value) || !Array.isArray(value.plans)) invalidPayload("服务器返回的整理清单列表格式无效。");
  return {
    plans: value.plans.filter((item) => item !== null && item !== undefined).map(normalizePlan),
    nextCursor: normalizeCursor(value.nextCursor),
  };
}

function normalizeOperationsPage(value: unknown): OrganizationOperationsPage {
  if (!isRecord(value) || value.plan === null || value.plan === undefined) invalidPayload("服务器返回的整理清单缺少清单摘要。");
  if (!Array.isArray(value.operations)) invalidPayload("服务器返回的整理操作列表格式无效。");
  return {
    plan: normalizePlan(value.plan),
    operations: value.operations.filter((item) => item !== null && item !== undefined).map(normalizeOperation),
    nextCursor: normalizeCursor(value.nextCursor),
  };
}

export async function loadOrganizationPlans(storageId: string, taskId: string, cursor: string | null, signal?: AbortSignal): Promise<OrganizationPlansPage> {
  const query = new URLSearchParams({ storageId, limit: "20", ...(cursor ? { cursor } : {}) });
  return normalizePlansPage(await requestJson<unknown>(`/api/library/scans/${encodeURIComponent(taskId)}/organization?${query}`, signal ? { signal } : {}));
}

export async function loadOrganizationOperations(storageId: string, taskId: string, operationKey: string, cursor: string | null, signal?: AbortSignal): Promise<OrganizationOperationsPage> {
  const query = new URLSearchParams({ storageId, limit: "20", ...(cursor ? { cursor } : {}) });
  return normalizeOperationsPage(await requestJson<unknown>(`/api/library/scans/${encodeURIComponent(taskId)}/organization/${encodeURIComponent(operationKey)}?${query}`, signal ? { signal } : {}));
}

export async function createOrganizationPreview(storageId: string, taskId: string, fileIds: readonly string[], signal?: AbortSignal): Promise<OrganizationPlanSummary> {
  const result = await requestJson<unknown>(`/api/library/scans/${encodeURIComponent(taskId)}/organization`, {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, fileIds }),
  });
  if (!isRecord(result) || result.plan === null || result.plan === undefined) invalidPayload("服务器未返回整理清单。");
  return normalizePlan(result.plan);
}

export async function controlOrganizationPlan(storageId: string, taskId: string, operationKey: string, action: "execute" | "pause", signal?: AbortSignal): Promise<OrganizationControlResult> {
  const result = await requestJson<unknown>(`/api/library/scans/${encodeURIComponent(taskId)}/organization/${encodeURIComponent(operationKey)}`, {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, action }),
  });
  if (!isRecord(result) || typeof result.accepted !== "boolean" || (result.status !== "queued" && result.status !== "paused")) {
    invalidPayload("服务器返回的整理操作确认格式无效。");
  }
  return { operationKey: requiredString(result.operationKey, "整理清单键"), status: result.status, accepted: result.accepted };
}

export type OrganizationHistoryStatusFilter = "all" | "active" | "planned" | "running" | "verified" | "failed";

export interface OrganizationHistoryIdentity {
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

export interface OrganizationHistoryItem {
  taskId: string;
  operationKey: string;
  operationId: string;
  fileId: string;
  originalParentId: string;
  originalName: string;
  targetRootId: string;
  targetRelativePath: string;
  targetParentId: string | null;
  targetName: string;
  identity: OrganizationHistoryIdentity | null;
  pairedFileId: string;
  pairedVideoTargetPath: string;
  status: OrganizationOperationStatus;
  error: string | null;
  updatedAt: string;
}

export interface OrganizationHistoryActiveScan {
  taskId: string;
  configId: string;
  status: string;
  directoriesDone: number;
  directoriesDiscovered: number;
  filesDiscovered: number;
  updatedAt: string;
}

export interface OrganizationHaltNotice {
  taskId: string;
  operationKey: string;
  consecutiveFailures: number;
  remainingPlanned: number;
  lastError: string;
  haltedAt: string;
}

export interface OrganizationHistoryPage {
  items: OrganizationHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: {
    all: number;
    running: number;
    planned: number;
    verified: number;
    failed: number;
  };
  activeSummary: {
    hasActiveWork: boolean;
    latestScanTask: OrganizationHistoryActiveScan | null;
    activePlanCount: number;
    haltNotice: OrganizationHaltNotice | null;
  };
}

export async function loadOrganizationHistory(
  storageId: string,
  input: { page: number; pageSize: number; status: OrganizationHistoryStatusFilter },
  signal?: AbortSignal,
): Promise<OrganizationHistoryPage> {
  const query = new URLSearchParams({
    storageId,
    page: String(input.page),
    pageSize: String(input.pageSize),
    status: input.status,
  });
  return requestJson<OrganizationHistoryPage>(`/api/library/organization-history?${query}`, signal ? { signal } : {});
}

export async function retryFailedOrganizations(
  storageId: string,
  signal?: AbortSignal,
): Promise<{ retriedPlans: number; accepted: boolean }> {
  return requestJson<{ retriedPlans: number; accepted: boolean }>("/api/library/organization-history", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ storageId, action: "retry_failed" }),
  });
}

export async function stopOrganizations(
  storageId: string,
  signal?: AbortSignal,
): Promise<{
  stoppedPlans: number;
  stoppedScanTasks: number;
  stoppedIdentificationJobs: number;
  stoppedAutoTasks: number;
  stopped: boolean;
}> {
  return requestJson<{
    stoppedPlans: number;
    stoppedScanTasks: number;
    stoppedIdentificationJobs: number;
    stoppedAutoTasks: number;
    stopped: boolean;
  }>("/api/library/organization-history", {
    method: "POST",
    ...(signal ? { signal } : {}),
    body: JSON.stringify({ storageId, action: "stop" }),
  });
}
