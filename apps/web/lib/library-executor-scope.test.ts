import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLibraryStorageExecutor, getWorkerStorageParents, getWorkflowRepository } from "./workflow-runtime";
import type { ConnectedStorage } from "@media-track/workflow";
const drive: ConnectedStorage = { id: "quark-a", accountId: "acct_default", provider: "quark", providerUid: "quark-user", label: "夸克", payload: { cookie: "test-cookie" }, rootCid: "own-root", moviesCid: "own-movies", tvCid: "own-tv", animeCid: "own-anime", status: "active", frozenReason: null, frozenAt: null, createdAt: "2026-11-17T00:00:00.000Z" };
beforeEach(() => {
  vi.stubEnv("MEDIA_TRACK_STORAGE_ADAPTER", "115");
  vi.stubEnv("MEDIA_TRACK_POSTGRES_URL", "postgresql://unused:unused@127.0.0.1:1/unit_test");
  vi.stubEnv("PAN115_COOKIE", "global-cookie");
  vi.stubEnv("MEDIA_TRACK_115_WRITE_SCOPE_CIDS", "global-root");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe("library selected drive scope", () => {
  it("rejects a missing or frozen explicit drive instead of using the account default or global cookie", async () => {
    const read = vi.spyOn(getWorkflowRepository(), "listConnectedStorages").mockResolvedValue([drive]);
    await expect(getLibraryStorageExecutor("acct_default", "unbound-drive")).rejects.toThrow(/指定网盘/);
    await expect(getWorkerStorageParents("acct_default", "unbound-drive", { strictId: true })).rejects.toThrow(/指定网盘/);
    read.mockResolvedValue([{ ...drive, status: "frozen" }]);
    await expect(getLibraryStorageExecutor("acct_default", drive.id)).rejects.toThrow(/冻结/);
  });
  it("uses the non-115 drive's own category roots", async () => {
    vi.spyOn(getWorkflowRepository(), "listConnectedStorages").mockResolvedValue([drive]);
    expect(await getWorkerStorageParents("acct_default", drive.id, { strictId: true })).toEqual({ movies: "own-movies", tv: "own-tv", anime: "own-anime" });
  });
  it("browses an unprovisioned connection without creating category directories", async () => {
    vi.spyOn(getWorkflowRepository(), "listConnectedStorages").mockResolvedValue([{ ...drive, rootCid: null, moviesCid: null, tvCid: null, animeCid: null }]);
    const update = vi.spyOn(getWorkflowRepository(), "upsertConnectedStorage");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ code: 0, metadata: { _total: 0 }, data: { list: [] } })));
    const storage = await getLibraryStorageExecutor("acct_default", drive.id);
    expect(fetch).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(await storage.listDirectoryPage?.({ directoryId: "0", page: 0, pageSize: 100 })).toMatchObject({ items: [], nextPage: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(storage.createDirectory({ parentId: "0", name: "unexpected" })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
