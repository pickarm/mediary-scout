import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetImageUpdateCacheForTests,
  acquireManualImageCheckSlot,
  fetchRemoteImageStatus,
  invalidateImageUpdateCache,
} from "./image-update-server";

const REMOTE_COMMIT = "a".repeat(40);
const CHILD_DIGEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const MANIFEST_DIGEST = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const CONFIG_DIGEST = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function headerGet(init: RequestInit | undefined, name: string): string | null {
  if (!init?.headers) return null;
  const headers = new Headers(init.headers);
  return headers.get(name);
}

describe("image-update-server", () => {
  beforeEach(() => {
    __resetImageUpdateCacheForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches GHCR token, single-arch manifest, follows 307 without Authorization, and extracts OCI labels", async () => {
    const calls: Array<{ url: string; auth: string | null; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        auth: headerGet(init, "authorization"),
        redirect: init?.redirect,
      });

      if (url === "https://ghcr.io/token?service=ghcr.io&scope=repository:pickarm/mediary-scout:pull") {
        return jsonResponse({ token: "ghcr-anon-token" });
      }
      if (url === "https://ghcr.io/v2/pickarm/mediary-scout/manifests/latest") {
        return jsonResponse(
          {
            schemaVersion: 2,
            config: { digest: CONFIG_DIGEST },
          },
          200,
          { "docker-content-digest": MANIFEST_DIGEST },
        );
      }
      if (url === `https://ghcr.io/v2/pickarm/mediary-scout/blobs/${encodeURIComponent(CONFIG_DIGEST)}`) {
        return new Response(null, {
          status: 307,
          headers: {
            location: "https://pkg-containers.githubusercontent.com/blobs/config.json?sig=abc",
          },
        });
      }
      if (url === "https://pkg-containers.githubusercontent.com/blobs/config.json?sig=abc") {
        return jsonResponse({
          created: "2026-11-26T08:00:00Z",
          config: {
            Labels: {
              "org.opencontainers.image.revision": REMOTE_COMMIT.toUpperCase(),
              "org.opencontainers.image.version": " v2026.11.26 ",
              "org.opencontainers.image.source": "https://github.com/pickarm/mediary-scout",
            },
          },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await fetchRemoteImageStatus({
      fetchImpl,
      env: {},
      now: () => 1_700_000_000_000,
    });

    expect(result).toEqual({
      ok: true,
      registry: "ghcr.io",
      repository: "pickarm/mediary-scout",
      tag: "latest",
      fullRef: "ghcr.io/pickarm/mediary-scout:latest",
      manifestDigest: MANIFEST_DIGEST,
      configDigest: CONFIG_DIGEST,
      commit: REMOTE_COMMIT,
      version: "v2026.11.26",
      createdAt: "2026-11-26T08:00:00Z",
      sourceUrl: "https://github.com/pickarm/mediary-scout",
      checkedAt: new Date(1_700_000_000_000).toISOString(),
    });

    expect(calls[1]?.auth).toBe("Bearer ghcr-anon-token");
    expect(calls[2]?.redirect).toBe("manual");
    expect(calls[2]?.auth).toBe("Bearer ghcr-anon-token");
    expect(calls[3]?.url).toBe("https://pkg-containers.githubusercontent.com/blobs/config.json?sig=abc");
    expect(calls[3]?.auth).toBeNull();
  });

  it("filters attestation manifests in OCI Image Index and picks linux/amd64", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://ghcr.io/token")) {
        return jsonResponse({ access_token: "tok" });
      }
      if (url.endsWith("/manifests/edge")) {
        return jsonResponse(
          {
            manifests: [
              {
                digest: "sha256:arm64",
                platform: { os: "linux", architecture: "arm64" },
              },
              {
                digest: "sha256:attestation",
                platform: { os: "unknown", architecture: "unknown" },
                annotations: { "vnd.docker.reference.type": "attestation-manifest" },
              },
              {
                digest: "sha256:attestation-with-amd64",
                platform: { os: "linux", architecture: "amd64" },
                annotations: { "vnd.docker.reference.type": "attestation-manifest" },
              },
              {
                digest: CHILD_DIGEST,
                platform: { os: "linux", architecture: "amd64" },
              },
            ],
          },
          200,
          { "docker-content-digest": MANIFEST_DIGEST },
        );
      }
      if (url.endsWith(`/manifests/${encodeURIComponent(CHILD_DIGEST)}`)) {
        return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      }
      if (url.includes("/blobs/")) {
        return jsonResponse({
          config: {
            Labels: {
              "org.opencontainers.image.revision": REMOTE_COMMIT,
              "org.opencontainers.image.created": "2026-11-26T10:00:00Z",
            },
          },
          created: "2026-11-25T00:00:00Z",
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const result = await fetchRemoteImageStatus({
      fetchImpl,
      env: { MEDIA_TRACK_IMAGE_TAG: "edge" },
    });

    expect(result).toMatchObject({
      ok: true,
      tag: "edge",
      manifestDigest: MANIFEST_DIGEST,
      commit: REMOTE_COMMIT,
      createdAt: "2026-11-26T10:00:00Z",
    });
  });

  it("returns not_found when OCI index has no linux/amd64 platform manifest", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://ghcr.io/token")) return jsonResponse({ token: "t" });
      return jsonResponse({
        manifests: [{ digest: "sha256:arm64", platform: { os: "linux", architecture: "arm64" } }],
      });
    }) as typeof fetch;

    const result = await fetchRemoteImageStatus({ fetchImpl, env: {} });
    expect(result).toMatchObject({ ok: false, reason: "not_found", statusCode: 404 });
  });

  it("supports non-ghcr mirror direct 200 and 401 WWW-Authenticate Bearer challenge", async () => {
    const directFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://ghcr.nju.edu.cn/v2/pickarm/mediary-scout/manifests/latest") {
        return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      }
      if (url.includes("/blobs/")) {
        return jsonResponse({ config: { Labels: { "org.opencontainers.image.revision": REMOTE_COMMIT } } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const direct = await fetchRemoteImageStatus({
      fetchImpl: directFetch,
      env: { MEDIA_TRACK_IMAGE: "ghcr.nju.edu.cn/pickarm/mediary-scout" },
    });
    expect(direct).toMatchObject({ ok: true, registry: "ghcr.nju.edu.cn", commit: REMOTE_COMMIT });

    __resetImageUpdateCacheForTests();
    let manifestCalls = 0;
    const challengeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://mirror.example.com/v2/pickarm/mediary-scout/manifests/latest") {
        manifestCalls += 1;
        if (manifestCalls === 1) {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer realm="https://auth.example.com/token",service="mirror.example.com",scope="repository:pickarm/mediary-scout:pull"',
            },
          });
        }
        expect(headerGet(init, "authorization")).toBe("Bearer mirror-token");
        return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      }
      if (url.startsWith("https://auth.example.com/token")) {
        return jsonResponse({ token: "mirror-token" });
      }
      if (url.includes("/blobs/")) {
        return jsonResponse({ config: { Labels: { "org.opencontainers.image.revision": REMOTE_COMMIT } } });
      }
      throw new Error(`unexpected URL: ${url}`);
    }) as typeof fetch;

    const challenged = await fetchRemoteImageStatus({
      fetchImpl: challengeFetch,
      env: { MEDIA_TRACK_IMAGE: "mirror.example.com/pickarm/mediary-scout" },
    });
    expect(challenged).toMatchObject({ ok: true, registry: "mirror.example.com", commit: REMOTE_COMMIT });
  });

  it("rejects insecure http realm or redirect location", async () => {
    const httpRealmFetch = vi.fn(async () => {
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Bearer realm="http://evil.local/token"' },
      });
    }) as typeof fetch;
    const res1 = await fetchRemoteImageStatus({
      fetchImpl: httpRealmFetch,
      env: { MEDIA_TRACK_IMAGE: "mirror.example.com/pickarm/mediary-scout" },
    });
    expect(res1).toMatchObject({ ok: false, reason: "unauthorized" });

    __resetImageUpdateCacheForTests();
    const httpRedirectFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token")) return jsonResponse({ token: "t" });
      if (url.includes("/manifests/")) return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      return new Response(null, { status: 307, headers: { location: "http://cdn.insecure/blob" } });
    }) as typeof fetch;
    const res2 = await fetchRemoteImageStatus({ fetchImpl: httpRedirectFetch, env: {} });
    expect(res2).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("classifies GHCR 401/403 after 200 token, 404, invalid_ref, missing revision, and timeout", async () => {
    const unauthFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/token")) return jsonResponse({ token: "anon" });
      return new Response(null, { status: 401 });
    }) as typeof fetch;
    expect(await fetchRemoteImageStatus({ fetchImpl: unauthFetch, env: {} })).toMatchObject({
      ok: false,
      reason: "unauthorized",
      statusCode: 401,
    });

    __resetImageUpdateCacheForTests();
    const notFoundFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/token")) return jsonResponse({ token: "anon" });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    expect(await fetchRemoteImageStatus({ fetchImpl: notFoundFetch, env: {} })).toMatchObject({
      ok: false,
      reason: "not_found",
      statusCode: 404,
    });

    const invalidRefFetch = vi.fn() as typeof fetch;
    expect(
      await fetchRemoteImageStatus({
        fetchImpl: invalidRefFetch,
        env: { MEDIA_TRACK_IMAGE: "ghcr.io/../evil" },
      }),
    ).toMatchObject({ ok: false, reason: "invalid_ref" });
    expect(invalidRefFetch).not.toHaveBeenCalled();

    __resetImageUpdateCacheForTests();
    const noRevisionFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token")) return jsonResponse({ token: "t" });
      if (url.includes("/manifests/")) return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      return jsonResponse({ config: { Labels: {} } });
    }) as typeof fetch;
    expect(await fetchRemoteImageStatus({ fetchImpl: noRevisionFetch, env: {} })).toMatchObject({
      ok: true,
      commit: null,
    });

    __resetImageUpdateCacheForTests();
    vi.useFakeTimers();
    const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const pending = fetchRemoteImageStatus({ fetchImpl: hangingFetch, env: {} });
    await vi.advanceTimersByTimeAsync(7_500);
    expect(await pending).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("caches tiered TTLs, deduplicates singleflight, supports SWR, guards generation, and caches configDigest", async () => {
    let clock = 1_700_000_000_000;
    const now = () => clock;
    let blobCalls = 0;
    let manifestCalls = 0;
    let revision = REMOTE_COMMIT;

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token")) return jsonResponse({ token: "t" });
      if (url.includes("/manifests/")) {
        manifestCalls += 1;
        return jsonResponse({ config: { digest: CONFIG_DIGEST } });
      }
      if (url.includes("/blobs/")) {
        blobCalls += 1;
        return jsonResponse({ config: { Labels: { "org.opencontainers.image.revision": revision } } });
      }
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;

    // Concurrent singleflight -> only 1 manifest call
    const [a, b] = await Promise.all([
      fetchRemoteImageStatus({ fetchImpl, env: {}, now }),
      fetchRemoteImageStatus({ fetchImpl, env: {}, now }),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(manifestCalls).toBe(1);
    expect(blobCalls).toBe(1);

    // Within 30min TTL -> cached
    clock += 29 * 60 * 1000;
    await fetchRemoteImageStatus({ fetchImpl, env: {}, now });
    expect(manifestCalls).toBe(1);

    // Past 30min TTL with allowStale -> immediately returns cached, triggers background refresh (configDigest hits cache!)
    clock += 2 * 60 * 1000;
    const stale = await fetchRemoteImageStatus({ fetchImpl, env: {}, now, allowStale: true });
    expect(stale).toMatchObject({ ok: true, commit: REMOTE_COMMIT });
    await vi.waitFor(() => {
      expect(manifestCalls).toBe(2);
    });
    expect(blobCalls).toBe(1); // configDigest secondary cache skipped blob download!

    // Failure TTL: unreachable = 5min, unauthorized/not_found = 10min
    __resetImageUpdateCacheForTests();
    let failCalls = 0;
    const failFetch = vi.fn(async () => {
      failCalls += 1;
      throw new Error("network down");
    }) as typeof fetch;
    await fetchRemoteImageStatus({ fetchImpl: failFetch, env: {}, now });
    clock += 4 * 60 * 1000;
    await fetchRemoteImageStatus({ fetchImpl: failFetch, env: {}, now });
    expect(failCalls).toBe(1);
    clock += 2 * 60 * 1000;
    await fetchRemoteImageStatus({ fetchImpl: failFetch, env: {}, now });
    expect(failCalls).toBe(2);

    __resetImageUpdateCacheForTests();
    let authCalls = 0;
    const authFailFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/token")) return jsonResponse({ token: "t" });
      authCalls += 1;
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    await fetchRemoteImageStatus({ fetchImpl: authFailFetch, env: {}, now });
    clock += 9 * 60 * 1000;
    await fetchRemoteImageStatus({ fetchImpl: authFailFetch, env: {}, now });
    expect(authCalls).toBe(1);
    clock += 2 * 60 * 1000;
    await fetchRemoteImageStatus({ fetchImpl: authFailFetch, env: {}, now });
    expect(authCalls).toBe(2);

    // Generation guard: invalidated in-flight request must not poison cache
    __resetImageUpdateCacheForTests();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowFetchCount = 0;
    const raceFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token")) return jsonResponse({ token: "t" });
      if (url.includes("/manifests/")) {
        slowFetchCount += 1;
        if (slowFetchCount === 1) await slowGate;
        return jsonResponse({ config: { digest: `sha256:gen${slowFetchCount}` } });
      }
      return jsonResponse({
        config: {
          Labels: {
            "org.opencontainers.image.revision": slowFetchCount === 1 ? "1".repeat(40) : "2".repeat(40),
          },
        },
      });
    }) as typeof fetch;

    const first = fetchRemoteImageStatus({ fetchImpl: raceFetch, env: {}, now });
    await Promise.resolve();
    invalidateImageUpdateCache();
    const second = await fetchRemoteImageStatus({ fetchImpl: raceFetch, env: {}, now });
    expect(second).toMatchObject({ ok: true, commit: "2".repeat(40) });
    releaseSlow();
    await first;
    const cachedAfter = await fetchRemoteImageStatus({ fetchImpl: raceFetch, env: {}, now });
    expect(cachedAfter).toMatchObject({ ok: true, commit: "2".repeat(40) });
    revision = REMOTE_COMMIT;
    expect(revision).toBe(REMOTE_COMMIT);
  });

  it("enforces 15-second manual check cooldown", () => {
    expect(acquireManualImageCheckSlot(1_000)).toEqual({ allowed: true });
    expect(acquireManualImageCheckSlot(10_000)).toEqual({ allowed: false, retryAfterMs: 6_000 });
    expect(acquireManualImageCheckSlot(16_000)).toEqual({ allowed: true });
  });
});
