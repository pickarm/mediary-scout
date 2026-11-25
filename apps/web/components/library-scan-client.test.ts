import { afterEach, describe, expect, it, vi } from "vitest";
import {
  controlLibraryScan,
  loadAllScanConfigurations,
  loadDirectoryPage,
  loadScanTaskPage,
  requestJson,
  saveScanConfiguration,
  startLibraryScan,
  type LibraryScanConfiguration,
  type LibraryScanTask,
} from "./library-scan-client";

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const task: LibraryScanTask = {
  taskId: "task_a", configId: "config_a", status: "running", directoriesDone: 3,
  filesDiscovered: 12, directoriesDiscovered: 5, failures: [],
  createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:01:00.000Z",
};

const configuration: LibraryScanConfiguration = {
  configId: "config_a", scope: { accountId: "acct_1", connectedStorageId: "storage_a" },
  sourceRoots: [{ directoryId: "dir_a", name: "电影" }], movieTargetDirectoryId: null,
  tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false,
  dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false,
  autoAcquire: false, templates: { movieDirectory: "{title}" },
};

describe("library scan browser API", () => {
  it("loads nested directory pages using the server nextPage cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [{ directoryId: "d1", name: "电影", selectionToken: "ticket-1" }], nextPage: 1, nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(response({ items: [{ directoryId: "d2", name: "剧集", selectionToken: "ticket-2" }], nextPage: null, nextCursor: null }));
    globalThis.fetch = fetchMock;
    const first = await loadDirectoryPage("storage_a", "parent/one", 0);
    const second = await loadDirectoryPage("storage_a", "parent/one", first.nextPage!, first.nextCursor);
    expect(first.items[0]?.selectionToken).toBe("ticket-1");
    expect(second.items[0]?.directoryId).toBe("d2");
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/library/directories?storageId=storage_a&parentId=parent%2Fone&page=0",
      "/api/library/directories?storageId=storage_a&parentId=parent%2Fone&page=1&cursor=cursor-1",
    ]);
  });

  it("restores every saved configuration page and preserves the selected server values", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ items: [configuration], nextCursor: "cursor-1", hasMore: true }))
      .mockResolvedValueOnce(response({ items: [{ ...configuration, configId: "config_b" }], nextCursor: null, hasMore: false }));
    globalThis.fetch = fetchMock;
    const configs = await loadAllScanConfigurations("storage_a");
    expect(configs.map((item) => item.configId)).toEqual(["config_a", "config_b"]);
    expect(configs[0]).toEqual(configuration);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=cursor-1");
  });

  it("saves selected IDs with selection tickets and starts a scan for that storage", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ item: configuration }, 201))
      .mockResolvedValueOnce(response({ item: task }, 202));
    globalThis.fetch = fetchMock;
    const saved = await saveScanConfiguration({
      storageId: "storage_a", sourceRoots: [{ directoryId: "dir_a", selectionToken: "ticket-a" }],
      movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed",
      dailyScheduleEnabled: false, dailyScheduleTime: null, templates: configuration.templates,
    });
    const started = await startLibraryScan("storage_a", saved.configId);
    expect(started.status).toBe("running");
    const saveBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { storageId: string; sourceRoots: Array<{ directoryId: string; selectionToken: string }> };
    expect(saveBody).toMatchObject({ storageId: "storage_a", sourceRoots: [{ directoryId: "dir_a", selectionToken: "ticket-a" }] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ storageId: "storage_a", configId: "config_a" });
  });

  it("uses the selected storage for task actions and can retry partial failures explicitly", async () => {
    const partial = { ...task, status: "partial" as const, failures: [{ directoryId: "dir_bad", page: 2, message: "临时限流" }] };
    const fetchMock = vi.fn().mockResolvedValue(response({ item: { ...partial, status: "queued", failures: [] } }, 202));
    globalThis.fetch = fetchMock;
    const retried = await controlLibraryScan("storage_b", partial.taskId, "retry");
    expect(retried.status).toBe("queued");
    expect(fetchMock).toHaveBeenCalledWith("/api/library/scans/task_a", expect.objectContaining({
      method: "POST", body: JSON.stringify({ storageId: "storage_b", action: "retry" }),
    }));
  });

  it("propagates an abort signal when the current storage request is superseded", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    globalThis.fetch = fetchMock;
    const pending = requestJson("/api/library/scans?storageId=old-storage", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
  });

  it("does not return a successfully parsed response after its scope signal was aborted", async () => {
    const controller = new AbortController();
    let resolveJson: ((value: unknown) => void) | undefined;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => new Promise<unknown>((resolve) => { resolveJson = resolve; }),
    });
    globalThis.fetch = fetchMock;
    const pending = requestJson<{ value: string }>("/api/library/scans?storageId=old-storage", { signal: controller.signal });
    await vi.waitFor(() => expect(resolveJson).toBeDefined());
    controller.abort();
    resolveJson?.({ value: "stale" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("retains the HTTP status and server message on a rejected request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ error: "整理清单状态冲突。" }, 409));
    globalThis.fetch = fetchMock;
    await expect(requestJson("/api/library/scans/task/organization", { method: "POST" })).rejects.toMatchObject({
      name: "ApiRequestError",
      status: 409,
      message: "整理清单状态冲突。",
    });
  });

  it("supports pause, resume and cancel without starting another task", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ item: { ...task, status: "paused" } }, 202))
      .mockResolvedValueOnce(response({ item: { ...task, status: "running" } }, 202))
      .mockResolvedValueOnce(response({ item: { ...task, status: "cancelled" } }, 202));
    globalThis.fetch = fetchMock;
    await controlLibraryScan("storage_a", task.taskId, "pause");
    await controlLibraryScan("storage_a", task.taskId, "resume");
    await controlLibraryScan("storage_a", task.taskId, "cancel");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).action)).toEqual(["pause", "resume", "cancel"]);
  });

  it("uses a cursor for persisted task pagination", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ items: [task], nextCursor: "next", hasMore: true }));
    globalThis.fetch = fetchMock;
    const page = await loadScanTaskPage("storage_a", "after-task");
    expect(page.hasMore).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("cursor=after-task");
  });
});
