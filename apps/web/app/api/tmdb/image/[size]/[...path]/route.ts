import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import type { TmdbAccess } from "@media-track/workflow";
import {
  isAllowedTmdbImageSize,
  isValidTmdbImageFilename,
  type TmdbImageSize,
} from "../../../../../../lib/tmdb-image";
import {
  getAccountScopedSettings,
  getCurrentAccountId,
  getTmdbAccesses,
} from "../../../../../../lib/workflow-runtime";

const TMDB_DIRECT_API_BASE_URL = "https://api.themoviedb.org/3";
const TMDB_DIRECT_IMAGE_ORIGIN = "https://image.tmdb.org";

const DIRECT_TIMEOUT_MS = 4500;
const PROXY_TIMEOUT_MS = 8000;
const DIRECT_COOLDOWN_MS = 5 * 60 * 1000;

const MAX_MEMORY_CACHE_ENTRIES = 128;
const MAX_MEMORY_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DISK_CACHE_DIR_NAME = "mediary-tmdb-image-cache";
const MAX_DISK_META_BYTES = 1024;

interface CachedImage {
  bytes: Uint8Array;
  contentType: string;
}

type UpstreamFetchResult =
  | { ok: true; image: CachedImage }
  | { ok: false; status: 404 | 502 };

type RouteContext = {
  params: Promise<{ size: string; path: string[] }>;
};

const memoryCache = new Map<string, CachedImage>();
let memoryCacheBytes = 0;
let directCooldownUntil = 0;
const inFlightRequests = new Map<string, Promise<UpstreamFetchResult>>();

function isSupportedImageContentType(contentType: string | null): contentType is string {
  if (!contentType) return false;
  const normalized = contentType.trim().toLowerCase();
  return normalized.startsWith("image/") && !normalized.startsWith("image/svg");
}

function getMemoryCachedImage(key: string): CachedImage | null {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  memoryCache.delete(key);
  memoryCache.set(key, hit);
  return hit;
}

function setMemoryCachedImage(key: string, image: CachedImage): void {
  const size = image.bytes.byteLength;
  if (size === 0 || size > MAX_IMAGE_BYTES || size > MAX_MEMORY_CACHE_BYTES) {
    return;
  }
  const existing = memoryCache.get(key);
  if (existing) {
    memoryCacheBytes -= existing.bytes.byteLength;
    memoryCache.delete(key);
  }
  while (
    memoryCache.size > 0 &&
    (memoryCache.size >= MAX_MEMORY_CACHE_ENTRIES || memoryCacheBytes + size > MAX_MEMORY_CACHE_BYTES)
  ) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = memoryCache.get(oldestKey);
    memoryCache.delete(oldestKey);
    if (oldest) {
      memoryCacheBytes -= oldest.bytes.byteLength;
    }
  }
  memoryCache.set(key, image);
  memoryCacheBytes += size;
}

function diskCacheFilePath(size: TmdbImageSize, filename: string): string {
  return path.join(os.tmpdir(), DISK_CACHE_DIR_NAME, `${size}__${filename}.cache`);
}

async function readDiskCachedImage(size: TmdbImageSize, filename: string): Promise<CachedImage | null> {
  try {
    const filePath = diskCacheFilePath(size, filename);
    const raw = await readFile(filePath);
    if (raw.byteLength < 6) return null;
    const metaLength = raw.readUInt32BE(0);
    if (metaLength === 0 || metaLength > MAX_DISK_META_BYTES || 4 + metaLength >= raw.byteLength) {
      return null;
    }
    const metaJson = raw.subarray(4, 4 + metaLength).toString("utf8");
    const parsed = JSON.parse(metaJson) as { contentType?: unknown };
    if (typeof parsed.contentType !== "string" || !isSupportedImageContentType(parsed.contentType)) {
      return null;
    }
    const bytes = new Uint8Array(raw.subarray(4 + metaLength));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return null;
    }
    return { bytes, contentType: parsed.contentType };
  } catch {
    return null;
  }
}

async function writeDiskCachedImage(
  size: TmdbImageSize,
  filename: string,
  image: CachedImage,
): Promise<void> {
  if (image.bytes.byteLength === 0 || image.bytes.byteLength > MAX_IMAGE_BYTES) {
    return;
  }
  try {
    const targetPath = diskCacheFilePath(size, filename);
    const dirPath = path.dirname(targetPath);
    await mkdir(dirPath, { recursive: true });
    const metaBuffer = Buffer.from(JSON.stringify({ contentType: image.contentType }), "utf8");
    if (metaBuffer.byteLength === 0 || metaBuffer.byteLength > MAX_DISK_META_BYTES) {
      return;
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(metaBuffer.byteLength, 0);
    const payload = Buffer.concat([header, metaBuffer, image.bytes]);
    const tempPath = `${targetPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tempPath, payload);
    await rename(tempPath, targetPath);
  } catch {
    // 临时磁盘缓存为最佳努力降级，任何读写失败均静默忽略。
  }
}

async function fetchImageFromUrl(
  url: string,
  timeoutMs: number,
): Promise<{ kind: "ok"; image: CachedImage } | { kind: "not_found" } | { kind: "error" }> {
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    const contentType = response.headers.get("content-type");
    if (!response.ok || !isSupportedImageContentType(contentType)) {
      return { kind: "error" };
    }
    const rawLength = response.headers.get("content-length");
    if (rawLength !== null) {
      const declaredLength = Number(rawLength);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
        return { kind: "error" };
      }
    }
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
      return { kind: "error" };
    }
    return {
      kind: "ok",
      image: { bytes, contentType: contentType.trim() },
    };
  } catch {
    return { kind: "error" };
  }
}

async function resolveProxyBaseUrls(): Promise<string[]> {
  let accesses: Array<TmdbAccess & { type?: string }> = [];
  try {
    const accountId = await getCurrentAccountId();
    accesses = await getTmdbAccesses(getAccountScopedSettings(accountId));
  } catch {
    try {
      accesses = await getTmdbAccesses({ getSetting: async () => null });
    } catch {
      accesses = [];
    }
  }

  const seen = new Set<string>();
  const proxyBases: string[] = [];
  for (const access of accesses) {
    if (!access || typeof access.baseURL !== "string") continue;
    const trimmed = access.baseURL.trim().replace(/\/+$/, "");
    if (!trimmed) continue;
    const isProxy =
      access.type !== undefined
        ? access.type === "proxy"
        : access.readToken === undefined && trimmed !== TMDB_DIRECT_API_BASE_URL;
    if (!isProxy || seen.has(trimmed)) continue;
    seen.add(trimmed);
    proxyBases.push(trimmed);
  }
  return proxyBases;
}

function buildCustomImageUrl(baseUrl: string, size: TmdbImageSize, filename: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/t/p")) {
    return `${normalized}/${size}/${filename}`;
  }
  return `${normalized}/t/p/${size}/${filename}`;
}

async function loadImageFromDiskOrUpstream(
  size: TmdbImageSize,
  filename: string,
  cacheKey: string,
): Promise<UpstreamFetchResult> {
  const diskHit = await readDiskCachedImage(size, filename);
  if (diskHit) {
    setMemoryCachedImage(cacheKey, diskHit);
    return { ok: true, image: diskHit };
  }

  let sawNotFound = false;
  const customBase = process.env.TMDB_IMAGE_BASE_URL?.trim();

  if (customBase) {
    const customResult = await fetchImageFromUrl(
      buildCustomImageUrl(customBase, size, filename),
      DIRECT_TIMEOUT_MS,
    );
    if (customResult.kind === "ok") {
      setMemoryCachedImage(cacheKey, customResult.image);
      await writeDiskCachedImage(size, filename, customResult.image);
      return { ok: true, image: customResult.image };
    }
    if (customResult.kind === "not_found") {
      sawNotFound = true;
    }
  } else if (Date.now() >= directCooldownUntil) {
    const directResult = await fetchImageFromUrl(
      `${TMDB_DIRECT_IMAGE_ORIGIN}/t/p/${size}/${filename}`,
      DIRECT_TIMEOUT_MS,
    );
    if (directResult.kind === "ok") {
      setMemoryCachedImage(cacheKey, directResult.image);
      await writeDiskCachedImage(size, filename, directResult.image);
      return { ok: true, image: directResult.image };
    }
    if (directResult.kind === "not_found") {
      return { ok: false, status: 404 };
    }
    // 直连超时、网络错误、5xx 或被劫持返回非图片响应时进入 5 分钟进程级冷却。
    directCooldownUntil = Date.now() + DIRECT_COOLDOWN_MS;
  }

  const proxyBases = await resolveProxyBaseUrls();
  for (const proxyBase of proxyBases) {
    const proxyResult = await fetchImageFromUrl(
      `${proxyBase}/img/t/p/${size}/${filename}`,
      PROXY_TIMEOUT_MS,
    );
    if (proxyResult.kind === "ok") {
      setMemoryCachedImage(cacheKey, proxyResult.image);
      await writeDiskCachedImage(size, filename, proxyResult.image);
      return { ok: true, image: proxyResult.image };
    }
    if (proxyResult.kind === "not_found") {
      sawNotFound = true;
    }
  }

  return { ok: false, status: sawNotFound ? 404 : 502 };
}

function buildImageResponse(image: CachedImage): Response {
  const body = new Uint8Array(image.bytes.byteLength);
  body.set(image.bytes);
  return new Response(body.buffer, {
    status: 200,
    headers: {
      "Content-Type": image.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(_request: NextRequest, context: RouteContext): Promise<Response> {
  const { size, path: pathSegments } = await context.params;
  if (!isAllowedTmdbImageSize(size)) {
    return new Response("Invalid image size", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (!Array.isArray(pathSegments) || pathSegments.length !== 1) {
    return new Response("Invalid image path", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const filename = pathSegments[0];
  if (typeof filename !== "string" || !isValidTmdbImageFilename(filename)) {
    return new Response("Invalid image filename", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const cacheKey = `${size}/${filename}`;
  const memoryHit = getMemoryCachedImage(cacheKey);
  if (memoryHit) {
    return buildImageResponse(memoryHit);
  }

  let loader = inFlightRequests.get(cacheKey);
  if (!loader) {
    loader = loadImageFromDiskOrUpstream(size, filename, cacheKey).finally(() => {
      inFlightRequests.delete(cacheKey);
    });
    inFlightRequests.set(cacheKey, loader);
  }

  const result = await loader;
  if (!result.ok) {
    return new Response(result.status === 404 ? "Image not found" : "Image upstream unavailable", {
      status: result.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return buildImageResponse(result.image);
}
