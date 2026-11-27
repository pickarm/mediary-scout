export interface SafeLibraryStorage {
  id: string;
  label: string;
  provider: "pan115" | "quark" | "uc" | "guangya" | "tianyi" | "pan123";
  status: "active" | "frozen";
  rootDirectoryId: string;
  defaultMovieDirectory?: LibraryScanRoot | null;
  defaultTvDirectory?: LibraryScanRoot | null;
}

export interface LibraryDirectoryChoice {
  directoryId: string;
  name: string;
  selectionToken: string;
}

export interface LibraryScanRoot {
  directoryId: string;
  name: string;
}

export interface LibraryScanConfiguration {
  configId: string;
  scope: { accountId: string; connectedStorageId: string };
  sourceRoots: readonly LibraryScanRoot[];
  movieTargetDirectoryId: string | null;
  movieTargetDirectoryName?: string | null;
  tvTargetDirectoryId: string | null;
  tvTargetDirectoryName?: string | null;
  mediaKind: "movie" | "tv" | "mixed";
  dailyScheduleEnabled: boolean;
  dailyScheduleTime: string | null;
  dailyScheduleTimezone: "Asia/Shanghai";
  autoOrganize: boolean;
  organizeConcurrency?: number;
  autoAcquire: false;
  templates: Readonly<Record<string, string>>;
}

export type LibraryScanStatus = "queued" | "running" | "paused" | "cancelling" | "cancelled" | "completed" | "partial" | "failed";

export interface LibraryScanTask {
  taskId: string;
  configId: string;
  status: LibraryScanStatus;
  directoriesDone: number;
  filesDiscovered: number;
  directoriesDiscovered: number;
  failures: readonly { directoryId: string; page: number; message: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface LibraryScanConfigPayload {
  configId?: string;
  storageId: string;
  sourceRoots?: readonly ({ directoryId: string; selectionToken?: string })[];
  useDefaultLibraryDirectories?: boolean;
  movieTargetDirectoryId: string | null;
  movieTargetSelectionToken?: string;
  tvTargetDirectoryId: string | null;
  tvTargetSelectionToken?: string;
  mediaKind: "movie" | "tv" | "mixed";
  dailyScheduleEnabled: boolean;
  dailyScheduleTime: string | null;
  autoOrganize?: boolean;
  organizeConcurrency?: number;
  templates: Readonly<Record<string, string>>;
}

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

export async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  let body: unknown;
  try { body = await response.json() as unknown; }
  catch {
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const message = "服务器返回了无法读取的响应，请重试。";
    throw response.ok ? new Error(message) : new ApiRequestError(message, response.status);
  }
  if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "请求失败，请稍后重试。";
    throw new ApiRequestError(message, response.status);
  }
  return body as T;
}

function storageQuery(storageId: string, extra: Record<string, string> = {}): string {
  const query = new URLSearchParams({ storageId, ...extra });
  return query.toString();
}

export async function loadAllScanConfigurations(storageId: string, signal?: AbortSignal): Promise<LibraryScanConfiguration[]> {
  const configurations: LibraryScanConfiguration[] = [];
  let cursor: string | null = null;
  do {
    const query = storageQuery(storageId, { limit: "50", ...(cursor ? { cursor } : {}) });
    const result = await requestJson<{ items: LibraryScanConfiguration[]; nextCursor: string | null }>(`/api/library/configurations?${query}`, signal ? { signal } : {});
    configurations.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return configurations;
}

export async function loadScanTaskPage(storageId: string, cursor: string | null, signal?: AbortSignal): Promise<{ items: LibraryScanTask[]; nextCursor: string | null; hasMore: boolean }> {
  const query = storageQuery(storageId, { limit: "20", ...(cursor ? { cursor } : {}) });
  return requestJson(`/api/library/scans?${query}`, signal ? { signal } : {});
}

export async function loadDirectoryPage(
  storageId: string,
  parentId: string,
  page: number,
  cursor: string | null = null,
  signal?: AbortSignal,
): Promise<{ items: LibraryDirectoryChoice[]; nextPage: number | null; nextCursor: string | null }> {
  const query = storageQuery(storageId, { parentId, page: String(page), ...(cursor ? { cursor } : {}) });
  return requestJson(`/api/library/directories?${query}`, signal ? { signal } : {});
}

export async function saveScanConfiguration(payload: LibraryScanConfigPayload, signal?: AbortSignal): Promise<LibraryScanConfiguration> {
  const result = await requestJson<{ item: LibraryScanConfiguration }>("/api/library/configurations", {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify(payload),
  });
  return result.item;
}

export async function startLibraryScan(storageId: string, configId: string, signal?: AbortSignal): Promise<LibraryScanTask> {
  const result = await requestJson<{ item: LibraryScanTask }>("/api/library/scans", {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, configId }),
  });
  return result.item;
}

export async function controlLibraryScan(storageId: string, taskId: string, action: "pause" | "resume" | "cancel" | "retry", signal?: AbortSignal): Promise<LibraryScanTask> {
  const result = await requestJson<{ item: LibraryScanTask }>(`/api/library/scans/${encodeURIComponent(taskId)}`, {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, action }),
  });
  return result.item;
}

export async function refreshLibraryScan(storageId: string, taskId: string, signal?: AbortSignal): Promise<LibraryScanTask> {
  const result = await requestJson<{ item: LibraryScanTask }>(`/api/library/scans/${encodeURIComponent(taskId)}?${storageQuery(storageId)}`, signal ? { signal } : {});
  return result.item;
}

