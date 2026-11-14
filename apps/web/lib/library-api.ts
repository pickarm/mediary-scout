import type { NextRequest } from "next/server";
import { requireAuthenticatedAccountId } from "./workflow-runtime";
import { resolveRequestOriginOrNull } from "./request-origin";
import { isDemoMode } from "./demo-mode";
import { LibraryRuntimeError } from "./library-runtime";
import { ScanScopeError, ScanStorageScopeError, ScanStoreInputError } from "@media-track/workflow/library";

export class LibraryApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "LibraryApiError"; }
}

export async function libraryAccount(request: NextRequest, mutation = false): Promise<string> {
  if (mutation) {
    if (isDemoMode()) throw new LibraryApiError(403, "演示站只读");
    const origin = request.headers.get("origin");
    const effective = resolveRequestOriginOrNull(request.headers);
    let supplied: string | null = null;
    try { supplied = origin ? new URL(origin).origin : null; } catch { supplied = null; }
    if (!effective || !supplied || supplied !== effective) throw new LibraryApiError(403, "请求来源校验失败，请刷新页面后重试。");
  }
  try { return await requireAuthenticatedAccountId(); }
  catch { throw new LibraryApiError(401, "登录状态已失效，请重新登录。"); }
}

export async function readJson(request: NextRequest, maxBytes = 32_000): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null && (!/^\d+$/u.test(rawLength) || !Number.isSafeInteger(Number(rawLength)) || Number(rawLength) > maxBytes)) {
    void request.body?.cancel().catch(() => undefined);
    throw new LibraryApiError(400, "请求内容过大。");
  }
  const body = request.body;
  if (!body) throw new LibraryApiError(400, "请求内容无效。");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new LibraryApiError(400, "请求内容过大。");
      }
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof LibraryApiError) throw error;
    throw new LibraryApiError(400, "请求内容无效。");
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), byteLength);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new LibraryApiError(400, "请求格式无效。"); }
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { throw new LibraryApiError(400, "请求格式无效。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new LibraryApiError(400, "请求格式无效。");
  return value as Record<string, unknown>;
}

export function apiErrorResponse(error: unknown): Response {
  if (error instanceof LibraryApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof LibraryRuntimeError) {
    const status = error.code === "storage_frozen" ? 409 : error.code === "storage_credentials_invalid" ? 403 : 404;
    return Response.json({ error: error.message }, { status });
  }
  if (error instanceof ScanScopeError || error instanceof ScanStorageScopeError) return Response.json({ error: error.message }, { status: 404 });
  if (error instanceof ScanStoreInputError) return Response.json({ error: error.message }, { status: 409 });
  return Response.json({ error: "库扫描请求暂时无法完成，请稍后重试。" }, { status: 500 });
}

export function requireString(value: unknown, label: string, maxLength = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength || /[\u0000-\u001f]/u.test(value)) {
    throw new LibraryApiError(400, `${label}无效。`);
  }
  return value.trim();
}

export function parseLimit(value: string | null, fallback: number, max: number): number {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/u.test(value)) throw new LibraryApiError(400, "分页大小无效。");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) throw new LibraryApiError(400, "分页大小超出允许范围。");
  return limit;
}

export function encodeCursor(value: string | null): string | null {
  return value === null ? null : Buffer.from(value, "utf8").toString("base64url");
}

export function decodeCursor(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new LibraryApiError(400, "分页游标无效。");
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  if (!decoded || decoded.length > 1000 || Buffer.from(decoded, "utf8").toString("base64url") !== value) throw new LibraryApiError(400, "分页游标无效。");
  return decoded;
}
