import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingJob, PostgresMessagingStore } from "./store";
const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), cancel: vi.fn(), query: vi.fn() }));
vi.mock("../workflow-runtime", () => ({
  getWorkflowRepository: () => ({ getWorkflowRunSnapshot: mocks.snapshot, cancelQueuedWorkflowRun: mocks.cancel }),
  getAccountScopedSettings: vi.fn(), getTmdbAccesses: vi.fn(), queueCandidateTrackingForAccount: vi.fn(),
}));
vi.mock("../library-runtime", () => ({ getLibraryPool: () => ({ query: mocks.query }) }));
import { createMessagingApplication } from "./application";
const store = { get: async () => null, listRecent: async () => [] } as unknown as PostgresMessagingStore;
beforeEach(() => vi.clearAllMocks());
describe("message acquisition cancellation", () => {
  it("updates every account-owned association when cancellation uses the displayed native run ID", async () => {
    mocks.snapshot.mockResolvedValue({ workflowRun: { status: "queued" } });
    mocks.cancel.mockResolvedValue({ status: "cancelled" });
    expect(await createMessagingApplication(store).stop({ accountId: "alice", id: "native-run" })).toMatchObject({ stopped: true, reason: "queued_cancelled" });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("workflow_run_id=$2"), ["alice", "native-run", expect.stringContaining('"status":"stopped"'), expect.any(String)]);
  });
  it("reads the current state when a worker claims the run while cancellation is pending", async () => {
    mocks.snapshot.mockResolvedValueOnce({ workflowRun: { status: "queued" } }).mockResolvedValueOnce({ workflowRun: { status: "running" } });
    mocks.cancel.mockResolvedValue({ status: "not_cancellable" });
    expect(await createMessagingApplication(store).stop({ accountId: "alice", id: "native-run" })).toMatchObject({ stopped: false, reason: "running_original" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("messaging task status query", () => {
  it("preserves direct_pending status and Chinese activity label for direct_link jobs", async () => {
    const directJob: MessagingJob = {
      id: "direct-job-1",
      connectionId: "conn-1",
      accountId: "alice",
      platform: "telegram",
      platformMessageId: "msg-1",
      conversationId: "chat-1",
      senderId: "user-1",
      text: "https://115.com/s/abc123",
      callbackData: null,
      replyToken: null,
      inputKind: "direct_link",
      phase: "direct_pending",
      candidates: [],
      selectedCandidateIndex: null,
      workflowRunId: null,
      scanTaskId: null,
      organizationKey: null,
      landingStorageId: null,
      landingDirectoryId: null,
      receipt: null,
      result: null,
      error: null,
      sendStatus: "not_applicable",
      stopRequested: false,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    };
    const queryStore = {
      get: async () => directJob,
      listRecent: async () => [directJob],
    } as unknown as PostgresMessagingStore;
    const tasks = await createMessagingApplication(queryStore).query({ accountId: "alice" });
    expect(tasks).toEqual([
      expect.objectContaining({
        id: "direct-job-1",
        messagingJobId: "direct-job-1",
        status: "direct_pending",
        source: "direct_transfer",
        activity: "待转存",
      }),
    ]);
  });
});
