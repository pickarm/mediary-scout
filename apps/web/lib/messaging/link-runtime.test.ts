import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FakeStorageExecutor,
  GuangYaStorageExecutor,
  Pan123Client,
  Pan123StorageExecutor,
  TianyiClient,
  TianyiStorageExecutor,
  type GuangYaStorageClient,
  type ResourceCandidate,
  type StorageExecutor,
} from "@media-track/workflow";
import type { PostgresMessagingStore } from "./store";
const mocks = vi.hoisted(() => ({ storage: vi.fn(), parents: vi.fn(), refresh: vi.fn(), services: vi.fn(), identification: vi.fn(), organize: vi.fn(), query: vi.fn() }));
vi.mock("../workflow-runtime", () => ({
  getLibraryStorageExecutor: mocks.storage, getWorkerStorageParents: mocks.parents,
  getWorkflowRepository: () => ({ listConnectedStorages: async () => [] }), getAccountScopedSettings: () => ({ getSetting: async () => null }),
}));
vi.mock("../library-runtime", () => ({ getLibraryServices: mocks.services, getLibraryPool: () => ({ query: mocks.query }) }));
vi.mock("../library-identification-runtime", () => ({ getLibraryIdentificationService: mocks.identification }));
vi.mock("../library-organization-runtime", () => ({ getLibraryOrganizationService: mocks.organize }));
vi.mock("@media-track/workflow", async (original) => ({ ...await original<typeof import("@media-track/workflow")>(), refreshConfiguredMediaServers: mocks.refresh }));
vi.mock("@media-track/workflow/library", async (original) => ({
  ...await original<typeof import("@media-track/workflow/library")>(),
  PostgresIdentificationStore: class { async getJob() { return { status: "completed" }; } },
}));
import { createLinkImportDependencies } from "./link-runtime";
const store = { get: vi.fn(async () => null) } as unknown as PostgresMessagingStore;
const storageOption = { id: "guangya-a", label: "光鸭", provider: "guangya" as const };
const link = { url: "magnet:?xt=urn:btih:123", type: "magnet" as const, linkKey: "magnet:123", compatibleProviders: ["guangya" as const] };
const candidate: ResourceCandidate = { id: "candidate", snapshotId: "snapshot", index: 0, title: "用户链接", source: "messaging", type: "magnet", providerPayload: { url: link.url } };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.storage.mockResolvedValue(new FakeStorageExecutor());
  mocks.parents.mockResolvedValue({ movies: "movies", tv: "tv", anime: "anime" });
  mocks.refresh.mockResolvedValue({ refreshed: [], failures: [] });
  mocks.query.mockResolvedValue({ rows: [{ title_payload: { type: "movie", tmdbId: 42, title: "真实电影", year: 2024 }, season_payload: { seasonNumber: 1 }, episode_codes: ["S01E01"] }] });
  vi.mocked(store.get).mockResolvedValue(null);
});
describe("direct link production bindings", () => {
  it("reuses a deterministic landing and reads back a timed-out creation", async () => {
    const storage: StorageExecutor = new FakeStorageExecutor();
    const create = storage.createDirectory.bind(storage);
    vi.spyOn(storage, "createDirectory").mockImplementation(async (input) => { await create(input); throw new Error("timeout"); });
    mocks.storage.mockResolvedValue(storage);
    const deps = createLinkImportDependencies(store);
    const input = { accountId: "alice", connectionId: "bot", jobId: "job", workflowRunId: "messaging-direct-job", storage: storageOption, link };
    const first = await deps.prepareLanding(input);
    expect(await deps.prepareLanding(input)).toEqual(first);
    expect(storage.createDirectory).toHaveBeenCalledTimes(1);
    expect(mocks.parents).toHaveBeenCalledWith("alice", "guangya-a", { strictId: true });
  });
  it("passes whole-package and persists the provider receipt before waiting", async () => {
    const storage: StorageExecutor = new FakeStorageExecutor();
    const order: string[] = [];
    vi.spyOn(storage, "transfer").mockImplementation(async (input) => {
      expect(input.wholePackage).toBe(true);
      await input.onSubmitted?.({ kind: "guangya_offline", providerTaskId: "remote-1" });
      order.push("poll");
      return { id: "transfer", workflowRunId: input.workflowRunId, candidateId: candidate.id, status: "succeeded", providerMessage: "完成", materializedFileIds: ["file"], receipt: { state: "completed" } };
    });
    mocks.storage.mockResolvedValue(storage);
    const deps = createLinkImportDependencies(store);
    const prepared = await deps.prepareLanding({ accountId: "alice", connectionId: "bot", jobId: "job", workflowRunId: "messaging-direct-job", storage: storageOption, link });
    await deps.submitTransfer({ accountId: "alice", storage: storageOption, landingDirectoryId: prepared.directoryId, workflowRunId: "messaging-direct-job", candidate, link, wholePackage: true, onSubmitted: async () => { order.push("persist"); } });
    expect(order).toEqual(["persist", "poll"]);
    expect(mocks.storage).toHaveBeenLastCalledWith("alice", "guangya-a", [prepared.directoryId]);
  });
  it("rejects submitting to an unverified or forged landing directory outside the authorized movies root", async () => {
    const storage: StorageExecutor = new FakeStorageExecutor();
    const transferSpy = vi.spyOn(storage, "transfer");
    mocks.storage.mockResolvedValue(storage);
    const deps = createLinkImportDependencies(store);
    await expect(
      deps.submitTransfer({ accountId: "alice", storage: storageOption, landingDirectoryId: "forged-dir", workflowRunId: "messaging-direct-job", candidate, link, wholePackage: true, onSubmitted: async () => undefined }),
    ).rejects.toThrow(/授权电影根/);
    expect(transferSpy).not.toHaveBeenCalled();
    expect(mocks.storage).not.toHaveBeenCalledWith("alice", "guangya-a", ["forged-dir"]);
  });
  it("enforces derived write scope on real 123, Tianyi, and GuangYa executors until verified landing is passed", async () => {
    const landingId = "verified-landing";
    const fileSize = 50 * 1024 * 1024;
    const unexpectedFetch = async (): Promise<never> => { throw new Error("unexpected network"); };

    const client123 = new Pan123Client({ token: "t", fetchImpl: unexpectedFetch });
    const list123 = vi.spyOn(client123, "listFiles")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "f-123", name: "Film.2024.mkv", size: fileSize, etag: "e1", isFolder: false }]);
    const save123 = vi.spyOn(client123, "saveShare").mockResolvedValue({ ok: true, message: "" });
    const unverified123 = new Pan123StorageExecutor({ client: client123, writeScopeDirectoryIds: ["movies"], transferSettlePollAttempts: 1, sleep: async () => undefined });
    const verified123 = new Pan123StorageExecutor({ client: client123, writeScopeDirectoryIds: ["movies", landingId], transferSettlePollAttempts: 1, sleep: async () => undefined });
    const cand123: ResourceCandidate = { ...candidate, type: "123", providerPayload: { url: "https://www.123pan.com/s/abc123" } };
    await expect(unverified123.transfer({ workflowRunId: "wf-123", directoryId: landingId, candidate: cand123, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    await expect(verified123.transfer({ workflowRunId: "wf-123", directoryId: "outside-dir", candidate: cand123, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    expect(await verified123.transfer({ workflowRunId: "wf-123", directoryId: landingId, candidate: cand123, wholePackage: true })).toMatchObject({ status: "succeeded", materializedFileIds: ["f-123"] });
    expect(save123).toHaveBeenCalledTimes(1);
    expect(list123).toHaveBeenCalled();

    const clientTianyi = new TianyiClient({ sessionKey: "s", accessToken: "a", refreshToken: "r", fetchImpl: unexpectedFetch });
    const listTianyi = vi.spyOn(clientTianyi, "listFiles")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "f-ty", name: "Film.2024.mkv", size: fileSize, md5: "", isFolder: false }]);
    const saveTianyi = vi.spyOn(clientTianyi, "saveShare").mockResolvedValue({ ok: true, failed: 0, message: "" });
    const unverifiedTianyi = new TianyiStorageExecutor({ client: clientTianyi, writeScopeDirectoryIds: ["movies"] });
    const verifiedTianyi = new TianyiStorageExecutor({ client: clientTianyi, writeScopeDirectoryIds: ["movies", landingId] });
    const candTianyi: ResourceCandidate = { ...candidate, type: "tianyi", providerPayload: { url: "https://cloud.189.cn/t/abc123" } };
    await expect(unverifiedTianyi.transfer({ workflowRunId: "wf-ty", directoryId: landingId, candidate: candTianyi, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    await expect(verifiedTianyi.transfer({ workflowRunId: "wf-ty", directoryId: "outside-dir", candidate: candTianyi, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    expect(await verifiedTianyi.transfer({ workflowRunId: "wf-ty", directoryId: landingId, candidate: candTianyi, wholePackage: true })).toMatchObject({ status: "succeeded", materializedFileIds: ["f-ty"] });
    expect(saveTianyi).toHaveBeenCalledTimes(1);
    expect(listTianyi).toHaveBeenCalled();

    const gyList = vi.fn<GuangYaStorageClient["listFiles"]>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ fileId: "f-gy", parentId: landingId, fileName: "Film.2024.mkv", fileSize, resType: 1 }]);
    const gyCreateTask = vi.fn<GuangYaStorageClient["createTask"]>(async () => "gy-task-1");
    const gyClient: GuangYaStorageClient = {
      listFiles: gyList,
      createDir: vi.fn(async () => "dir"),
      renameFile: vi.fn(async () => undefined),
      deleteFiles: vi.fn(async () => undefined),
      moveFiles: vi.fn(async () => undefined),
      resolveRes: vi.fn(async () => ({ resType: 1 })),
      createTask: gyCreateTask,
      listTask: vi.fn(async () => [{ taskId: "gy-task-1", status: 2, progress: 100, fileId: "" }]),
    };
    const unverifiedGy = new GuangYaStorageExecutor({ client: gyClient, writeScopeDirectoryIds: ["movies"], taskPollMaxPolls: 1, taskPollIntervalMs: 0 });
    const verifiedGy = new GuangYaStorageExecutor({ client: gyClient, writeScopeDirectoryIds: ["movies", landingId], taskPollMaxPolls: 1, taskPollIntervalMs: 0 });
    await expect(unverifiedGy.transfer({ workflowRunId: "wf-gy", directoryId: landingId, candidate, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    await expect(verifiedGy.transfer({ workflowRunId: "wf-gy", directoryId: "outside-dir", candidate, wholePackage: true })).rejects.toThrow(/WRITE_SCOPE_VIOLATION/);
    expect(await verifiedGy.transfer({ workflowRunId: "wf-gy", directoryId: landingId, candidate, wholePackage: true })).toMatchObject({ status: "succeeded", materializedFileIds: ["f-gy"] });
    expect(gyCreateTask).toHaveBeenCalledTimes(1);
  });
  it("restores provider receipt kind and reconciles without a new transfer", async () => {
    const storage = Object.assign(new FakeStorageExecutor(), { getTransferStatus: vi.fn(async () => "running" as const) });
    vi.spyOn(storage, "transfer"); mocks.storage.mockResolvedValue(storage);
    const result = await createLinkImportDependencies(store).reconcileTransfer({ accountId: "alice", storage: storageOption, landingDirectoryId: "landing", workflowRunId: "messaging-direct-job", link, providerTaskId: "remote-1", receipt: { kind: "direct_link_transfer", providerKind: "guangya_offline", providerTaskId: "remote-1" } });
    expect(result.status).toBe("pending");
    expect(storage.getTransferStatus).toHaveBeenCalledWith(expect.objectContaining({ kind: "guangya_offline" }));
    expect(storage.transfer).not.toHaveBeenCalled();
  });
  it("creates a durable original scan rooted only in the verified landing, with autoAcquire off", async () => {
    const task = { status: "completed" };
    const scans = { getTask: vi.fn(async () => null), saveConfiguration: vi.fn(), createTask: vi.fn(async () => task), listTaskFiles: vi.fn(async () => [{ fileId: "file-1", parentDirectoryId: "landing", name: "Film.mkv", isDirectory: false, sizeBytes: 1024 }]) };
    mocks.services.mockResolvedValue({ scanStore: scans, scanner: { resume: vi.fn(), waitForIdle: async () => task }, pool: {} });
    mocks.identification.mockResolvedValue({ enqueueForScan: vi.fn(), drainPending: vi.fn(), list: async () => ({ items: [{ fileId: "file-1", status: "confirmed", importStatus: "imported", mediaType: "movie", tmdbId: 42 }], hasMore: false }) });
    const started = vi.fn();
    const result = await createLinkImportDependencies(store).scanAndIdentify({ accountId: "alice", storage: storageOption, landingDirectoryId: "landing", workflowRunId: "messaging-direct-job", link, autoAcquire: false, onScanStarted: started });
    expect(scans.saveConfiguration).toHaveBeenCalledWith(expect.objectContaining({ sourceRoots: [{ directoryId: "landing", name: "消息转存" }], autoAcquire: false, autoOrganize: false, movieTargetDirectoryId: "movies", tvTargetDirectoryId: "tv" }));
    expect(started).toHaveBeenCalledWith(result.scanTaskId);
    expect(result).toMatchObject({ partial: false, videos: [{ providerFileId: "file-1" }], identities: [{ status: "confirmed" }] });
  });
  it("refreshes only verified newly organized videos and maps real movie/tv metadata without leaking movie anchors", async () => {
    const deps = createLinkImportDependencies(store);
    const input = { accountId: "alice", storage: storageOption, workflowRunId: "messaging-direct-job", organizationKey: "org", verifiedNewVideoFileIds: [] as string[] };
    await deps.refresh(input); expect(mocks.refresh).not.toHaveBeenCalled();
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await deps.refresh({ ...input, verifiedNewVideoFileIds: ["file-missing"] });
    expect(mocks.refresh).not.toHaveBeenCalled();

    mocks.query.mockResolvedValueOnce({
      rows: [
        { title_payload: { type: "tv", tmdbId: 99, title: "真实剧集", year: 2025 }, season_payload: { seasonNumber: 2 }, episode_codes: ["S02E03"] },
      ],
    });
    await deps.refresh({ ...input, verifiedNewVideoFileIds: ["file-tv"] });
    expect(mocks.refresh).toHaveBeenCalledWith(expect.objectContaining({
      items: [{ titleName: "真实剧集", mediaType: "tv", tmdbId: 99, year: 2025, driveLabels: ["光鸭"], seasonLabel: "S02", newlyObtained: ["S02E03"] }],
    }));

    mocks.refresh.mockResolvedValue({ refreshed: [], failures: [{ server: "Emby", error: "连接失败" }] });
    await expect(deps.refresh({ ...input, verifiedNewVideoFileIds: ["file-1"] })).rejects.toThrow("Emby");
    const lastItems = mocks.refresh.mock.calls.at(-1)?.[0] as { items: Array<Record<string, unknown>> };
    expect(lastItems.items).toEqual([{ titleName: "真实电影", mediaType: "movie", tmdbId: 42, year: 2024, driveLabels: ["光鸭"] }]);
    expect(lastItems.items[0]).not.toHaveProperty("newlyObtained");
    expect(JSON.stringify(mocks.refresh.mock.calls)).not.toContain('"newlyObtained":["file-1"]');
  });
  it("retains a skipped subtitle as a partial organization result", async () => {
    const plan = { operationKey: "org-1", status: "completed", skippedFiles: [{ fileId: "subtitle", reason: "字幕配对不唯一" }], operations: [] };
    const requestExecution = vi.fn();
    mocks.organize.mockResolvedValue({ scope: { accountId: "alice", connectedStorageId: "guangya-a" }, preview: async () => plan, store: { requestExecution } });
    const result = await createLinkImportDependencies(store).organize({ accountId: "alice", storage: storageOption, landingDirectoryId: "landing", workflowRunId: "messaging-direct-job", scanTaskId: "scan", videos: [{ id: "video", providerFileId: "video", storageDirectoryId: "landing", name: "Film.mkv", sizeBytes: 1024, episodeCode: null }], identities: [] });
    expect(result.status).toBe("partial");
    expect(result.providerMessage).toContain("字幕配对不唯一");
    expect(requestExecution).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("does not start identification when stopped while the scanner was running", async () => {
    const stopped = { id: "job", connectionId: "bot", accountId: "alice", platform: "telegram", platformMessageId: "1", conversationId: "1", senderId: "1", text: link.url, callbackData: null, replyToken: null, inputKind: "direct_link", phase: "verifying", candidates: [], selectedCandidateIndex: null, workflowRunId: null, scanTaskId: "scan", organizationKey: null, landingStorageId: storageOption.id, landingDirectoryId: "landing", receipt: null, result: null, error: null, sendStatus: "sent", stopRequested: true, createdAt: "2026-11-17T00:00:00.000Z", updatedAt: "2026-11-17T00:00:00.000Z" } as const;
    const task = { status: "completed" };
    mocks.services.mockResolvedValue({ scanStore: { getTask: async () => task }, scanner: { resume: vi.fn(), waitForIdle: async () => { vi.mocked(store.get).mockResolvedValue(stopped); return task; } } });
    expect(await createLinkImportDependencies(store).scanAndIdentify({ accountId: "alice", storage: storageOption, landingDirectoryId: "landing", workflowRunId: "messaging-direct-job", link, autoAcquire: false, onScanStarted: async () => undefined })).toMatchObject({ partial: true });
    expect(mocks.identification).not.toHaveBeenCalled();
  });
});
