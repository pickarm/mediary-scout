import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  getCurrentAccountId: vi.fn<() => Promise<string>>(),
  getAccountScopedSettings: vi.fn(),
  getTmdbAccesses: vi.fn(),
}));

vi.mock("../../../../../../lib/workflow-runtime", () => runtimeMocks);

const DISK_CACHE_DIR = path.join(os.tmpdir(), "mediary-tmdb-image-cache");
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

let fileSeq = 0;
function uniqueName(ext = "jpg"): string {
  fileSeq += 1;
  return `test_poster_${Date.now()}_${fileSeq}.${ext}`;
}

function makeRequest(size: string, segments: string[]): [NextRequest, { params: Promise<{ size: string; path: string[] }> }] {
  const req = new NextRequest(`http://localhost/api/tmdb/image/${size}/${segments.join("/")}`);
  return [req, { params: Promise.resolve({ size, path: segments }) }];
}

async function loadFreshGet() {
  vi.resetModules();
  const mod = await import("./route");
  return mod.GET;
}

describe("GET /api/tmdb/image/[size]/[...path]", () => {
  const originalTmdbImageBaseUrl = process.env.TMDB_IMAGE_BASE_URL;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.TMDB_IMAGE_BASE_URL;
    await rm(DISK_CACHE_DIR, { recursive: true, force: true }).catch(() => undefined);
    runtimeMocks.getCurrentAccountId.mockResolvedValue("acct_default");
    runtimeMocks.getAccountScopedSettings.mockReturnValue({ getSetting: vi.fn().mockResolvedValue(null) });
    runtimeMocks.getTmdbAccesses.mockResolvedValue([
      { baseURL: "https://api.themoviedb.org/3", readToken: "user-token" },
      { baseURL: "https://tmdb-proxy.example.com" },
    ]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalTmdbImageBaseUrl === undefined) {
      delete process.env.TMDB_IMAGE_BASE_URL;
    } else {
      process.env.TMDB_IMAGE_BASE_URL = originalTmdbImageBaseUrl;
    }
    await rm(DISK_CACHE_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  it("fetches direct TMDB image and hits memory cache on subsequent request", async () => {
    const filename = uniqueName("png");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const first = await GET(...makeRequest("w342", [filename]));
    expect(first.status).toBe(200);
    expect(first.headers.get("Content-Type")).toBe("image/png");
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://image.tmdb.org/t/p/w342/${filename}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });

    // Second request hits in-memory LRU cache with zero extra upstream fetch calls.
    const second = await GET(...makeRequest("w342", [filename]));
    expect(second.status).toBe(200);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads from disk cache when memory cache is cold", async () => {
    const filename = uniqueName("jpg");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JPEG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const GET1 = await loadFreshGet();
    const res1 = await GET1(...makeRequest("w500", [filename]));
    expect(res1.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Reload module to clear memory cache while keeping disk cache intact.
    const GET2 = await loadFreshGet();
    const res2 = await GET2(...makeRequest("w500", [filename]));
    expect(res2.status).toBe(200);
    expect(res2.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await res2.arrayBuffer())).toEqual(JPEG_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent requests for the same image via singleflight", async () => {
    const filename = uniqueName("jpg");
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const p1 = GET(...makeRequest("w342", [filename]));
    const p2 = GET(...makeRequest("w342", [filename]));
    const p3 = GET(...makeRequest("w342", [filename]));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(
      new Response(JPEG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    );

    const responses = await Promise.all([p1, p2, p3]);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("prefers TMDB_IMAGE_BASE_URL when configured", async () => {
    process.env.TMDB_IMAGE_BASE_URL = "https://img-cdn.example.com/";
    const filename = uniqueName("webp");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(PNG_BYTES, {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const res = await GET(...makeRequest("w780", [filename]));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://img-cdn.example.com/t/p/w780/${filename}`);
  });

  it("falls back to workers/tmdb-proxy format after direct timeout and skips dead direct during cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T00:00:00Z"));

    const file1 = uniqueName("jpg");
    const file2 = uniqueName("jpg");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://image.tmdb.org/")) {
        const timeoutErr = new Error("The operation timed out");
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      if (url.startsWith("https://tmdb-proxy.example.com/img/t/p/")) {
        return new Response(JPEG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      throw new Error(`unexpected url: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const first = await GET(...makeRequest("w342", [file1]));
    expect(first.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://image.tmdb.org/t/p/w342/${file1}`);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://tmdb-proxy.example.com/img/t/p/w342/${file1}`);

    // During 5-minute cooldown, direct origin is skipped and proxy is queried directly.
    vi.advanceTimersByTime(60_000);
    const second = await GET(...makeRequest("w500", [file2]));
    expect(second.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`https://tmdb-proxy.example.com/img/t/p/w500/${file2}`);
  });

  it("falls back safely to env-only getTmdbAccesses when DB/account lookup fails", async () => {
    const filename = uniqueName("jpg");
    runtimeMocks.getCurrentAccountId.mockRejectedValue(new Error("MEDIA_TRACK_POSTGRES_URL is required"));
    runtimeMocks.getTmdbAccesses.mockResolvedValue([
      { type: "proxy", baseURL: "https://fallback-proxy.example.com" },
    ]);

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://image.tmdb.org/")) {
        return new Response("gateway error", { status: 502 });
      }
      if (url === `https://fallback-proxy.example.com/img/t/p/w342/${filename}`) {
        return new Response(JPEG_BYTES, {
          status: 200,
          headers: { "Content-Type": "image/jpeg" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const res = await GET(...makeRequest("w342", [filename]));
    expect(res.status).toBe(200);
    expect(runtimeMocks.getTmdbAccesses).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not crash when no proxy access is available and returns 502", async () => {
    const filename = uniqueName("jpg");
    runtimeMocks.getTmdbAccesses.mockResolvedValue([]);
    const fetchMock = vi.fn().mockRejectedValue(new Error("network unreachable"));
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const res = await GET(...makeRequest("w342", [filename]));
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects non-image upstream responses such as HTML error pages and does not cache them", async () => {
    const filename = uniqueName("jpg");
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response("<html><body>Blocked</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const res1 = await GET(...makeRequest("w342", [filename]));
    expect(res1.status).toBe(502);
    expect(res1.headers.get("Cache-Control")).toBe("no-store");

    // Not cached — subsequent request still queries upstream rather than serving stale HTML.
    const res2 = await GET(...makeRequest("w342", [filename]));
    expect(res2.status).toBe(502);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["invalid size", "w999", ["poster.jpg"]],
    ["size traversal", "..", ["poster.jpg"]],
    ["multi-segment path", "w342", ["sub", "poster.jpg"]],
    ["empty path segments", "w342", []],
    ["parent traversal segment", "w342", [".."]],
    ["traversal inside filename", "w342", ["..%2fposter.jpg"]],
    ["query injection in filename", "w342", ["poster.jpg?url=evil"]],
    ["unsupported extension", "w342", ["poster.svg"]],
  ])("rejects %s with zero upstream fetch calls", async (_label, size, segments) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const GET = await loadFreshGet();
    const res = await GET(...makeRequest(size, segments));
    expect([400, 404]).toContain(res.status);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
