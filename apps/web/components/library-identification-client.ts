import { requestJson } from "./library-scan-client";

export type IdentificationFilter = "all" | "pending" | "confirmed" | "ignored" | "failed";
export type IdentificationStatus = Exclude<IdentificationFilter, "all">;
export interface IdentityCandidate {
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  title: string;
  originalTitle: string;
  year: number;
  reason: string;
}
export interface IdentityEvidence { kind: string; value: string; source: string }
export interface IdentificationResultItem {
  fileId: string;
  status: IdentificationStatus;
  reason: string;
  evidence: IdentityEvidence[];
  candidates: IdentityCandidate[];
  mediaType: string | null;
  tmdbId: number | null;
  seasonNumber: number | null;
  episodeCodes: string[];
  importStatus: "not_applicable" | "pending" | "imported";
  manual: boolean;
  updatedAt: string;
  file: { fileId: string; parentDirectoryId: string; name: string; isDirectory: boolean; sizeBytes: number | null; path: string; modifiedAt: string | null } | null;
  tracking: { trackedSeasonId: string; autoAcquire: boolean | null } | null;
}
export interface IdentificationPage {
  summary: { status: "waiting" | "pending" | "running" | "completed" | "cancelled" | "failed"; scanStatus: string; afterFileId: string | null; attempts: number; lastError: string | null } | null;
  counts: { total: number; confirmed: number; pending: number; ignored: number; failed: number; imported: number };
  items: IdentificationResultItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

function query(storageId: string, limit: number, cursor: string | null, filter: IdentificationFilter): string {
  const params = new URLSearchParams({ storageId, limit: String(limit), ...(cursor ? { cursor } : {}), ...(filter === "all" ? {} : { status: filter }) });
  return params.toString();
}

export function loadIdentificationPage(storageId: string, taskId: string, limit = 30, cursor: string | null = null, filter: IdentificationFilter = "all", signal?: AbortSignal): Promise<IdentificationPage> {
  return requestJson(`/api/library/scans/${encodeURIComponent(taskId)}/identifications?${query(storageId, limit, cursor, filter)}`, signal ? { signal } : {});
}

export async function startIdentification(storageId: string, taskId: string, action: "start" | "retry", signal?: AbortSignal): Promise<{ status: string }> {
  return requestJson(`/api/library/scans/${encodeURIComponent(taskId)}/identifications`, {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, action }),
  });
}

export interface ConfirmIdentityInput {
  tmdbId: number;
  mediaType: "movie" | "tv" | "anime";
  seasonNumber?: number;
  episodeNumbers?: number[];
}

export function validateEpisodeNumbers(value: string): { numbers?: number[]; error?: string } {
  const input = value.trim();
  if (!input) return { error: "请输入至少一个集号。" };
  const numbers = new Set<number>();
  for (const token of input.split(/[，,\s]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const first = Number(range[1]); const last = Number(range[2]);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first || last - first > 49) return { error: "集号范围无效；请输入正整数，且单次最多 50 集。" };
      for (let number = first; number <= last; number += 1) numbers.add(number);
    } else {
      const number = Number(token);
      if (!/^\d+$/.test(token) || !Number.isSafeInteger(number) || number < 1) return { error: "集号请使用正整数，可用逗号或范围表示。" };
      numbers.add(number);
    }
    if (numbers.size > 50) return { error: "单次最多确认 50 集。" };
  }
  return { numbers: [...numbers].sort((a, b) => a - b) };
}

export async function confirmIdentity(storageId: string, taskId: string, fileId: string, input: ConfirmIdentityInput, signal?: AbortSignal): Promise<void> {
  await requestJson(`/api/library/scans/${encodeURIComponent(taskId)}/identifications/${encodeURIComponent(fileId)}`, {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, ...input }),
  });
}

export async function setSeasonAutoAcquire(storageId: string, trackedSeasonId: string, autoAcquire: boolean, signal?: AbortSignal): Promise<void> {
  await requestJson("/api/library/tracking", {
    method: "POST", ...(signal ? { signal } : {}), body: JSON.stringify({ storageId, trackedSeasonId, autoAcquire }),
  });
}

export function parseIdentityCandidate(value: unknown): IdentityCandidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.tmdbId !== "number" || !Number.isSafeInteger(item.tmdbId) || item.tmdbId < 1) return null;
  if (item.mediaType !== "movie" && item.mediaType !== "tv" && item.mediaType !== "anime") return null;
  if (typeof item.title !== "string" || typeof item.originalTitle !== "string" || typeof item.year !== "number" || typeof item.reason !== "string") return null;
  return { tmdbId: item.tmdbId, mediaType: item.mediaType, title: item.title, originalTitle: item.originalTitle, year: item.year, reason: item.reason };
}

export function parseIdentityEvidence(value: unknown): IdentityEvidence | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.kind !== "string" || typeof item.value !== "string" || typeof item.source !== "string") return null;
  return { kind: item.kind, value: item.value, source: item.source };
}
