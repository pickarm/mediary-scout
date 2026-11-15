import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmIdentity, loadIdentificationPage, parseIdentityCandidate, setSeasonAutoAcquire,
  startIdentification, validateEpisodeNumbers,
} from "./library-identification-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("library identification browser API", () => {
  it("loads bounded, filtered cursor pages without loading the full result history", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ fileId: "f1" }], nextCursor: "cursor-1", hasMore: true, counts: { total: 41 }, summary: null }))
      .mockResolvedValueOnce(response({ items: [{ fileId: "f2" }], nextCursor: null, hasMore: false, counts: { total: 41 }, summary: null }));
    globalThis.fetch = fetchMock;
    const first = await loadIdentificationPage("storage/a", "task-1", 30, null, "pending");
    const second = await loadIdentificationPage("storage/a", "task-1", 30, first.nextCursor, "pending");
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=30");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("status=pending");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=cursor-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("posts only the chosen identity and validated tracking switch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ item: {} })).mockResolvedValueOnce(response({}));
    globalThis.fetch = fetchMock;
    await confirmIdentity("storage-1", "task-1", "file/1", { tmdbId: 333, mediaType: "tv", seasonNumber: 0, episodeNumbers: [2, 3] });
    await setSeasonAutoAcquire("storage-1", "season-real-id", false);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/library/scans/task-1/identifications/file%2F1");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ storageId: "storage-1", tmdbId: 333, mediaType: "tv", seasonNumber: 0, episodeNumbers: [2, 3] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ storageId: "storage-1", trackedSeasonId: "season-real-id", autoAcquire: false });
  });

  it("starts and retries only through the explicit task action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ status: "pending" }, 202));
    globalThis.fetch = fetchMock;
    await startIdentification("storage-1", "task-1", "retry");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ storageId: "storage-1", action: "retry" });
  });

  it("parses candidate values defensively and validates bounded TV episode lists and ranges", () => {
    expect(parseIdentityCandidate({ tmdbId: 4, mediaType: "movie", title: "片名", originalTitle: "Title", year: 2020, reason: "匹配" })?.tmdbId).toBe(4);
    expect(parseIdentityCandidate({ tmdbId: "4", mediaType: "movie", title: "x", originalTitle: "x", year: 2020, reason: "x" })).toBeNull();
    expect(validateEpisodeNumbers("1-3, 5，7")).toEqual({ numbers: [1, 2, 3, 5, 7] });
    expect(validateEpisodeNumbers("").error).toContain("至少一个集号");
    expect(validateEpisodeNumbers("0,2").error).toContain("正整数");
    expect(validateEpisodeNumbers("1-51").error).toContain("50");
    expect(validateEpisodeNumbers("999999999999999999999").error).toContain("正整数");
    expect(validateEpisodeNumbers(Array.from({ length: 51 }, (_, index) => String(index + 1)).join(",")).error).toContain("50");
  });

  it("surfaces API write errors so the UI can retain the previous setting and offer retry", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(response({ error: "当前文件身份存在冲突" }, 409));
    await expect(confirmIdentity("storage-1", "task-1", "file-1", { tmdbId: 4, mediaType: "movie" })).rejects.toThrow("当前文件身份存在冲突");
  });
});
