import { normalizeCommit } from "./deployment-update";
import { resolveTrackedImageRef, type TrackedImageRef } from "./fork-release";

export type ImageCheckFailureReason =
  | "unauthorized"
  | "not_found"
  | "unreachable"
  | "invalid_ref";

export interface RemoteImageManifestInfo {
  ok: true;
  registry: string;
  repository: string;
  tag: string;
  fullRef: string;
  manifestDigest: string | null;
  configDigest: string;
  commit: string | null;
  version: string | null;
  createdAt: string | null;
  sourceUrl: string | null;
  checkedAt: string;
}

export interface RemoteImageFailureInfo {
  ok: false;
  reason: ImageCheckFailureReason;
  statusCode?: number;
  registry?: string;
  repository?: string;
  tag?: string;
  fullRef?: string;
  checkedAt: string;
}

export type RemoteImageResult = RemoteImageManifestInfo | RemoteImageFailureInfo;

export interface FetchRemoteImageOptions {
  /** Return stale cached entry immediately and trigger background refresh. */
  allowStale?: boolean;
  /** Bypass cache and force a fresh registry check. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const TOTAL_BUDGET_MS = 7_500;
const STEP_TIMEOUT_MS = 5_000;
const OK_TTL_MS = 30 * 60 * 1000;
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
const CONFIG_ERROR_TTL_MS = 10 * 60 * 1000;
export const MANUAL_IMAGE_CHECK_COOLDOWN_MS = 15_000;
const CONFIG_CACHE_MAX = 8;

const INDEX_AND_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const SINGLE_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "mediary-scout-update-check";

interface ParsedImageConfig {
  commit: string | null;
  version: string | null;
  createdAt: string | null;
  sourceUrl: string | null;
}

interface ImageCacheEntry {
  at: number;
  ttl: number;
  result: RemoteImageResult;
}

interface ImageUpdateCacheSlot {
  entries: Map<string, ImageCacheEntry>;
  inFlight: Map<string, Promise<RemoteImageResult>>;
  configCache: Map<string, ParsedImageConfig>;
  generation: number;
  lastManualCheckAt: number;
}

const CACHE_KEY = Symbol.for("mediary-scout.image-update-cache");

function slot(): ImageUpdateCacheSlot {
  const store = globalThis as typeof globalThis & { [CACHE_KEY]?: ImageUpdateCacheSlot };
  store[CACHE_KEY] ??= {
    entries: new Map(),
    inFlight: new Map(),
    configCache: new Map(),
    generation: 0,
    lastManualCheckAt: 0,
  };
  return store[CACHE_KEY];
}

/** Clear cached image results and bump generation so in-flight checks cannot overwrite. */
export function invalidateImageUpdateCache(): void {
  const s = slot();
  s.generation += 1;
  s.entries.clear();
  s.inFlight.clear();
}

/** Check and consume the 15-second manual refresh cooldown slot. */
export function acquireManualImageCheckSlot(
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const s = slot();
  const elapsed = now - s.lastManualCheckAt;
  if (s.lastManualCheckAt > 0 && elapsed >= 0 && elapsed < MANUAL_IMAGE_CHECK_COOLDOWN_MS) {
    return { allowed: false, retryAfterMs: MANUAL_IMAGE_CHECK_COOLDOWN_MS - elapsed };
  }
  s.lastManualCheckAt = now;
  return { allowed: true };
}

/** Test-only: reset all cache, in-flight requests, secondary config cache and cooldown. */
export function __resetImageUpdateCacheForTests(): void {
  const s = slot();
  s.generation = 0;
  s.lastManualCheckAt = 0;
  s.entries.clear();
  s.inFlight.clear();
  s.configCache.clear();
}

function ttlForResult(result: RemoteImageResult): number {
  if (result.ok) return OK_TTL_MS;
  if (result.reason === "unreachable") return UNREACHABLE_TTL_MS;
  return CONFIG_ERROR_TTL_MS;
}

function setConfigCache(digest: string, config: ParsedImageConfig): void {
  const cache = slot().configCache;
  if (cache.has(digest)) {
    cache.delete(digest);
  } else if (cache.size >= CONFIG_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(digest, config);
}

function isHttpsUrl(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHeaderDigest(raw: string | null): string | null {
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function parseHttpsUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return isHttpsUrl(trimmed) ? trimmed : null;
}

function parseIsoDateOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return Number.isFinite(Date.parse(trimmed)) ? trimmed : null;
}

interface BearerChallenge {
  realm: string;
  service?: string;
  scope?: string;
}

function parseBearerChallenge(header: string | null): BearerChallenge | null {
  if (!header) return null;
  const match = /^\s*Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const paramsRaw = match[1];
  if (!paramsRaw) return null;

  const params: Record<string, string> = {};
  const paramRe = /([a-zA-Z0-9_-]+)=("([^"]*)"|([^,\s]+))/g;
  let tokenMatch: RegExpExecArray | null;
  while ((tokenMatch = paramRe.exec(paramsRaw)) !== null) {
    const key = tokenMatch[1]?.toLowerCase();
    const val = tokenMatch[3] ?? tokenMatch[4] ?? "";
    if (key) params[key] = val;
  }

  if (!isHttpsUrl(params.realm)) return null;
  return {
    realm: params.realm,
    ...(params.service ? { service: params.service } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
  };
}

async function fetchWithStepBudget(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  totalSignal: AbortSignal,
): Promise<Response> {
  if (totalSignal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const stepController = new AbortController();
  const onTotalAbort = () => stepController.abort();
  totalSignal.addEventListener("abort", onTotalAbort, { once: true });
  const timer = setTimeout(() => stepController.abort(), STEP_TIMEOUT_MS);
  try {
    return await fetchImpl(url, {
      ...init,
      cache: "no-store",
      signal: stepController.signal,
    });
  } finally {
    clearTimeout(timer);
    totalSignal.removeEventListener("abort", onTotalAbort);
  }
}

async function fetchRegistryToken(
  fetchImpl: typeof fetch,
  url: string,
  totalSignal: AbortSignal,
): Promise<{ ok: true; token: string | null } | { ok: false; reason: ImageCheckFailureReason; statusCode?: number }> {
  const response = await fetchWithStepBudget(
    fetchImpl,
    url,
    {
      headers: {
        "user-agent": USER_AGENT,
        accept: "application/json",
      },
    },
    totalSignal,
  );

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "unauthorized", statusCode: response.status };
  }
  if (response.status === 404) {
    return { ok: false, reason: "not_found", statusCode: 404 };
  }
  if (!response.ok) {
    return { ok: false, reason: "unreachable", statusCode: response.status };
  }

  const body = (await response.json()) as { token?: unknown; access_token?: unknown };
  const token =
    typeof body.token === "string" && body.token.trim()
      ? body.token.trim()
      : typeof body.access_token === "string" && body.access_token.trim()
        ? body.access_token.trim()
        : null;
  return { ok: true, token };
}

interface ManifestDescriptor {
  digest?: unknown;
  platform?: {
    os?: unknown;
    architecture?: unknown;
  };
  annotations?: Record<string, unknown>;
}

interface ManifestBody {
  config?: { digest?: unknown };
  manifests?: ManifestDescriptor[];
}

function selectLinuxAmd64Digest(manifests: ManifestDescriptor[]): string | null {
  for (const entry of manifests) {
    if (entry.annotations?.["vnd.docker.reference.type"] === "attestation-manifest") {
      continue;
    }
    if (entry.platform?.os === "unknown") {
      continue;
    }
    if (entry.platform?.os === "linux" && entry.platform?.architecture === "amd64") {
      if (typeof entry.digest === "string" && entry.digest.trim()) {
        return entry.digest.trim();
      }
    }
  }
  return null;
}

function parseConfigJson(raw: unknown): ParsedImageConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const blob = raw as {
    created?: unknown;
    config?: {
      Labels?: Record<string, unknown> | null;
    } | null;
  };
  const labels = blob.config?.Labels ?? {};
  const revisionRaw = typeof labels["org.opencontainers.image.revision"] === "string"
    ? labels["org.opencontainers.image.revision"]
    : null;
  const versionRaw = typeof labels["org.opencontainers.image.version"] === "string"
    ? labels["org.opencontainers.image.version"].trim()
    : "";
  const createdAt =
    parseIsoDateOrNull(labels["org.opencontainers.image.created"]) ??
    parseIsoDateOrNull(blob.created);
  const sourceUrl = parseHttpsUrlOrNull(labels["org.opencontainers.image.source"]);

  return {
    commit: normalizeCommit(revisionRaw),
    version: versionRaw || null,
    createdAt,
    sourceUrl,
  };
}

function makeFailure(
  ref: Extract<TrackedImageRef, { ok: true }>,
  reason: ImageCheckFailureReason,
  checkedAt: string,
  statusCode?: number,
): RemoteImageFailureInfo {
  return {
    ok: false,
    reason,
    ...(statusCode !== undefined ? { statusCode } : {}),
    registry: ref.registry,
    repository: ref.repository,
    tag: ref.tag,
    fullRef: ref.fullRef,
    checkedAt,
  };
}

function mapHttpError(
  ref: Extract<TrackedImageRef, { ok: true }>,
  status: number,
  checkedAt: string,
): RemoteImageFailureInfo {
  if (status === 401 || status === 403) {
    return makeFailure(ref, "unauthorized", checkedAt, status);
  }
  if (status === 404) {
    return makeFailure(ref, "not_found", checkedAt, 404);
  }
  return makeFailure(ref, "unreachable", checkedAt, status);
}

async function fetchManifestResponse(
  fetchImpl: typeof fetch,
  url: string,
  accept: string,
  token: string | null,
  totalSignal: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept,
    "user-agent": USER_AGENT,
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return fetchWithStepBudget(fetchImpl, url, { headers }, totalSignal);
}

async function loadRemoteImageStatus(
  ref: Extract<TrackedImageRef, { ok: true }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<RemoteImageResult> {
  const totalController = new AbortController();
  const totalTimer = setTimeout(() => totalController.abort(), TOTAL_BUDGET_MS);
  const checkedAt = () => new Date(now()).toISOString();

  try {
    let token: string | null = null;
    if (ref.registry === "ghcr.io") {
      const tokenUrl = `https://ghcr.io/token?service=ghcr.io&scope=repository:${ref.repository}:pull`;
      const tokenRes = await fetchRegistryToken(fetchImpl, tokenUrl, totalController.signal);
      if (!tokenRes.ok) {
        return makeFailure(ref, tokenRes.reason, checkedAt(), tokenRes.statusCode);
      }
      token = tokenRes.token;
    }

    const baseManifestUrl = `https://${ref.registry}/v2/${ref.repository}/manifests/${encodeURIComponent(ref.tag)}`;
    let manifestRes = await fetchManifestResponse(
      fetchImpl,
      baseManifestUrl,
      INDEX_AND_MANIFEST_ACCEPT,
      token,
      totalController.signal,
    );

    if (ref.registry !== "ghcr.io" && manifestRes.status === 401) {
      const challenge = parseBearerChallenge(manifestRes.headers.get("www-authenticate"));
      if (!challenge) {
        return makeFailure(ref, "unauthorized", checkedAt(), 401);
      }
      const tokenUrl = new URL(challenge.realm);
      if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
      tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${ref.repository}:pull`);
      const tokenRes = await fetchRegistryToken(fetchImpl, tokenUrl.toString(), totalController.signal);
      if (!tokenRes.ok) {
        return makeFailure(ref, tokenRes.reason, checkedAt(), tokenRes.statusCode);
      }
      token = tokenRes.token;
      manifestRes = await fetchManifestResponse(
        fetchImpl,
        baseManifestUrl,
        INDEX_AND_MANIFEST_ACCEPT,
        token,
        totalController.signal,
      );
    }

    if (!manifestRes.ok) {
      return mapHttpError(ref, manifestRes.status, checkedAt());
    }

    let manifestDigest = normalizeHeaderDigest(manifestRes.headers.get("docker-content-digest"));
    const topBody = (await manifestRes.json()) as ManifestBody;

    let configDigest: string | null =
      typeof topBody?.config?.digest === "string" && topBody.config.digest.trim()
        ? topBody.config.digest.trim()
        : null;

    if (!configDigest && Array.isArray(topBody?.manifests)) {
      const childDigest = selectLinuxAmd64Digest(topBody.manifests);
      if (!childDigest) {
        return makeFailure(ref, "not_found", checkedAt(), 404);
      }
      const childUrl = `https://${ref.registry}/v2/${ref.repository}/manifests/${encodeURIComponent(childDigest)}`;
      const childRes = await fetchManifestResponse(
        fetchImpl,
        childUrl,
        SINGLE_MANIFEST_ACCEPT,
        token,
        totalController.signal,
      );
      if (!childRes.ok) {
        return mapHttpError(ref, childRes.status, checkedAt());
      }
      manifestDigest ??= normalizeHeaderDigest(childRes.headers.get("docker-content-digest")) ?? childDigest;
      const childBody = (await childRes.json()) as ManifestBody;
      configDigest =
        typeof childBody?.config?.digest === "string" && childBody.config.digest.trim()
          ? childBody.config.digest.trim()
          : null;
    }

    if (!configDigest) {
      return makeFailure(ref, "unreachable", checkedAt());
    }

    const cachedConfig = slot().configCache.get(configDigest);
    if (cachedConfig) {
      return {
        ok: true,
        registry: ref.registry,
        repository: ref.repository,
        tag: ref.tag,
        fullRef: ref.fullRef,
        manifestDigest,
        configDigest,
        ...cachedConfig,
        checkedAt: checkedAt(),
      };
    }

    const blobUrl = `https://${ref.registry}/v2/${ref.repository}/blobs/${encodeURIComponent(configDigest)}`;
    const blobHeaders: Record<string, string> = {
      "user-agent": USER_AGENT,
    };
    if (token) {
      blobHeaders.authorization = `Bearer ${token}`;
    }

    let blobRes = await fetchWithStepBudget(
      fetchImpl,
      blobUrl,
      {
        headers: blobHeaders,
        redirect: "manual",
      },
      totalController.signal,
    );

    if (REDIRECT_STATUSES.has(blobRes.status)) {
      const location = blobRes.headers.get("location")?.trim();
      if (!isHttpsUrl(location)) {
        return makeFailure(ref, "unreachable", checkedAt());
      }
      // Strip Authorization on cross-origin redirect to CDN/object storage.
      blobRes = await fetchWithStepBudget(
        fetchImpl,
        location,
        {
          headers: { "user-agent": USER_AGENT },
        },
        totalController.signal,
      );
    }

    if (!blobRes.ok) {
      return mapHttpError(ref, blobRes.status, checkedAt());
    }

    const parsedConfig = parseConfigJson(await blobRes.json());
    if (!parsedConfig) {
      return makeFailure(ref, "unreachable", checkedAt());
    }
    setConfigCache(configDigest, parsedConfig);

    return {
      ok: true,
      registry: ref.registry,
      repository: ref.repository,
      tag: ref.tag,
      fullRef: ref.fullRef,
      manifestDigest,
      configDigest,
      ...parsedConfig,
      checkedAt: checkedAt(),
    };
  } catch {
    return makeFailure(ref, "unreachable", checkedAt());
  } finally {
    clearTimeout(totalTimer);
  }
}

function startRefresh(
  cacheKey: string,
  ref: Extract<TrackedImageRef, { ok: true }>,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<RemoteImageResult> {
  const s = slot();
  const existing = s.inFlight.get(cacheKey);
  if (existing) return existing;

  const startedGeneration = s.generation;
  const pending = loadRemoteImageStatus(ref, fetchImpl, now)
    .then((result) => {
      if (s.generation === startedGeneration) {
        s.entries.set(cacheKey, {
          at: now(),
          ttl: ttlForResult(result),
          result,
        });
      }
      return result;
    })
    .finally(() => {
      if (s.inFlight.get(cacheKey) === pending) {
        s.inFlight.delete(cacheKey);
      }
    });

  s.inFlight.set(cacheKey, pending);
  return pending;
}

/**
 * Fetch remote container image metadata from an OCI Registry v2 / GHCR endpoint.
 * Uses process-wide `globalThis` caching with tiered TTLs, singleflight deduplication,
 * stale-while-revalidate for polling, and a 7500ms total timeout budget.
 */
export async function fetchRemoteImageStatus(
  options: FetchRemoteImageOptions = {},
): Promise<RemoteImageResult> {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ref = resolveTrackedImageRef(options.env);

  if (!ref.ok) {
    return {
      ok: false,
      reason: "invalid_ref",
      checkedAt: new Date(now()).toISOString(),
    };
  }

  const s = slot();
  const cacheKey = ref.fullRef;

  if (options.force) {
    s.generation += 1;
    s.entries.delete(cacheKey);
    s.inFlight.delete(cacheKey);
  } else {
    const hit = s.entries.get(cacheKey);
    if (hit) {
      const fresh = now() - hit.at < hit.ttl;
      if (fresh) {
        return hit.result;
      }
      if (options.allowStale) {
        void startRefresh(cacheKey, ref, fetchImpl, now);
        return hit.result;
      }
    }
  }

  return startRefresh(cacheKey, ref, fetchImpl, now);
}
