import { describe, expect, it } from "vitest";
import type { VerifiedFile } from "@media-track/workflow";
import {
  extractResourceLink,
  processLinkImport,
  recognizeUserLink,
  type LinkImportDependencies,
  type LinkOrganizationInput,
  type LinkOrganizationResult,
  type LinkPreparedLanding,
  type LinkRefreshInput,
  type LinkScanInput,
  type LinkScanResult,
  type LinkStorageOption,
  type LinkSubmissionReceipt,
  type LinkTransferInput,
  type LinkTransferReconcileInput,
  type LinkTransferReconcileResult,
  type LinkTransferResult,
} from "./link-import";
import type {
  MessagingCandidate,
  MessagingJob,
  MessagingJobPatch,
  MessagingResultInput,
} from "./store";
import type { MessagingConnection } from "./types";

const NOW = "2026-11-17T09:00:00.000Z";

const connection: MessagingConnection = {
  id: "connection-a",
  accountId: "account-a",
  platform: "weixin",
  botId: "bot-a",
  enabled: true,
  senderId: "owner-a",
  defaultStorageId: null,
  credentials: {},
};
const defaultConnection: MessagingConnection = {
  ...connection,
  defaultStorageId: "storage-115-a",
};

function job(input: {
  id?: string;
  text?: string;
  phase?: MessagingJob["phase"];
  candidates?: readonly MessagingCandidate[];
  selectedCandidateIndex?: number | null;
  stopRequested?: boolean;
  receipt?: Record<string, unknown> | null;
  landingStorageId?: string | null;
  landingDirectoryId?: string | null;
} = {}): MessagingJob {
  return {
    id: input.id ?? "job-a",
    connectionId: connection.id,
    accountId: connection.accountId,
    platform: connection.platform,
    platformMessageId: "platform-job-a",
    conversationId: "private-chat",
    senderId: connection.senderId,
    text: input.text ?? "https://115.com/s/abc123?password=good",
    callbackData: null,
    replyToken: null,
    inputKind: "direct_link",
    phase: input.phase ?? "queued",
    candidates: input.candidates ?? [],
    selectedCandidateIndex: input.selectedCandidateIndex ?? null,
    workflowRunId: null,
    scanTaskId: null,
    organizationKey: null,
    landingStorageId: input.landingStorageId ?? null,
    landingDirectoryId: input.landingDirectoryId ?? null,
    receipt: input.receipt ?? null,
    result: null,
    error: null,
    sendStatus: "not_applicable",
    stopRequested: input.stopRequested ?? false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class MemoryStore {
  readonly operations: string[] = [];
  private readonly values = new Map<string, MessagingJob>();

  seed(value: MessagingJob): void {
    this.values.set(value.id, structuredClone(value));
  }

  async get(accountId: string, id: string): Promise<MessagingJob | null> {
    const found = this.values.get(id);
    return found?.accountId === accountId ? structuredClone(found) : null;
  }

  async update(
    accountId: string,
    id: string,
    patch: MessagingJobPatch,
    now: string = NOW,
  ): Promise<boolean> {
    const found = this.values.get(id);
    if (!found || found.accountId !== accountId) return false;
    this.operations.push(`update:${patch.phase ?? "same"}`);
    Object.assign(found, patch, { updatedAt: now });
    return true;
  }

  async saveResult(
    accountId: string,
    id: string,
    input: MessagingResultInput,
    now: string = NOW,
  ): Promise<boolean> {
    const found = this.values.get(id);
    if (!found || found.accountId !== accountId) return false;
    this.operations.push(`result:${input.phase}`);
    found.phase = input.phase;
    found.result = structuredClone(input.result);
    found.error = input.error ?? null;
    found.sendStatus = input.sendStatus;
    found.updatedAt = now;
    return true;
  }

  async replacePendingCandidates(
    accountId: string,
    id: string,
    candidates: readonly MessagingCandidate[],
    now: string = NOW,
  ): Promise<boolean> {
    const found = this.values.get(id);
    if (!found || found.accountId !== accountId) return false;
    this.operations.push("candidates");
    found.candidates = structuredClone([...candidates]);
    found.selectedCandidateIndex = null;
    found.phase = "pending_selection";
    found.updatedAt = now;
    return true;
  }

  require(id = "job-a"): MessagingJob {
    const found = this.values.get(id);
    if (!found) throw new Error(`missing job ${id}`);
    return found;
  }
}

class Ports implements LinkImportDependencies {
  readonly prepareCalls: Parameters<LinkImportDependencies["prepareLanding"]>[0][] = [];
  readonly transferCalls: LinkTransferInput[] = [];
  readonly reconcileCalls: LinkTransferReconcileInput[] = [];
  readonly scanCalls: LinkScanInput[] = [];
  readonly organizeCalls: LinkOrganizationInput[] = [];
  readonly refreshCalls: LinkRefreshInput[] = [];
  storages: readonly LinkStorageOption[] = [
    { id: "storage-115-a", label: "115 主盘", provider: "pan115" },
    { id: "storage-115-b", label: "115 备用盘", provider: "pan115" },
  ];
  transferResult: LinkTransferResult = {
    status: "succeeded",
    providerMessage: "transfer complete",
    receipt: { providerTaskId: "provider-task-a", kind: "115_share", state: "completed" },
    materializedFileIds: ["video-1"],
  };
  reconcileResult: LinkTransferReconcileResult = {
    status: "pending",
    providerMessage: "remote task is still running",
    receipt: {
      kind: "115_share",
      state: "running",
      providerTaskId: "provider-task-a",
    },
    materializedFileIds: [],
  };
  scanResult: LinkScanResult = {
    scanTaskId: "scan-a",
    videos: [video("video-1")],
    identities: [
      { fileId: "video-1", status: "confirmed", identityKey: "account-a|storage-115-a|movie|42" },
    ],
    partial: false,
  };
  organizeResult: LinkOrganizationResult = {
    organizationKey: "org-a",
    status: "completed",
    verifiedNewVideoFileIds: ["video-1"],
    providerMessage: "organized",
  };
  submittedReceipt: LinkSubmissionReceipt | null = null;
  afterSubmitted: (() => Promise<void>) | null = null;
  afterScan: (() => Promise<void>) | null = null;
  afterPrepare: (() => Promise<void>) | null = null;
  beforeTransferCall: (() => void) | null = null;
  beforeRefresh: (() => void) | null = null;

  constructor(readonly store: MemoryStore) {}

  async listStorages(accountId: string): Promise<readonly LinkStorageOption[]> {
    expect(accountId).toBe("account-a");
    return this.storages;
  }

  async prepareLanding(
    input: Parameters<LinkImportDependencies["prepareLanding"]>[0],
  ): Promise<LinkPreparedLanding> {
    this.prepareCalls.push(structuredClone(input));
    if (this.afterPrepare) await this.afterPrepare();
    return { directoryId: "landing-a", name: "消息直转-job-a" };
  }

  async submitTransfer(input: LinkTransferInput): Promise<LinkTransferResult> {
    if (this.beforeTransferCall) this.beforeTransferCall();
    this.transferCalls.push(input);
    if (this.submittedReceipt) {
      await input.onSubmitted(this.submittedReceipt);
      if (this.afterSubmitted) await this.afterSubmitted();
    }
    return this.transferResult;
  }

  async reconcileTransfer(input: LinkTransferReconcileInput): Promise<LinkTransferReconcileResult> {
    this.reconcileCalls.push(input);
    return this.reconcileResult;
  }

  async scanAndIdentify(input: LinkScanInput): Promise<LinkScanResult> {
    this.scanCalls.push(input);
    await input.onScanStarted(this.scanResult.scanTaskId);
    if (this.afterScan) await this.afterScan();
    return this.scanResult;
  }

  async organize(input: LinkOrganizationInput): Promise<LinkOrganizationResult> {
    this.organizeCalls.push(input);
    return this.organizeResult;
  }

  async refresh(input: LinkRefreshInput): Promise<void> {
    if (this.beforeRefresh) this.beforeRefresh();
    this.refreshCalls.push(input);
  }
}

function video(fileId: string): VerifiedFile {
  return {
    id: `library-${fileId}`,
    providerFileId: fileId,
    storageDirectoryId: "landing-a",
    name: `${fileId}.mkv`,
    sizeBytes: 1024,
    episodeCode: null,
  };
}

describe("recognizeUserLink", () => {
  it.each([
    [
      "https://115.com/s/abc123?password=good",
      "115",
      ["pan115"],
    ],
    [
      "https://pan.quark.cn/s/abc123#/list/share",
      "quark",
      ["quark"],
    ],
    [
      "https://drive.uc.cn/s/abc123?pwd=xy99",
      "uc",
      ["uc"],
    ],
    [
      "https://www.123pan.com/s/abc-1?pwd=x8fd",
      "123",
      ["pan123"],
    ],
    [
      "https://cloud.189.cn/t/QzUnmqBvYr2q?accessCode=x8fd",
      "tianyi",
      ["tianyi"],
    ],
    [
      "https://www.guangyapan.com/s/1947864096514232347_amtV6IXLP9l33m6z",
      "guangya",
      ["guangya"],
    ],
    [
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567",
      "magnet",
      ["pan115", "pan123", "guangya"],
    ],
  ] as const)(
    "maps %s to its native resource identity and compatible drives",
    (url, type, compatibleProviders) => {
      expect(recognizeUserLink(`请处理：${url} 谢谢`)).toMatchObject({
        url,
        type,
        compatibleProviders,
      });
    },
  );

  it("trims Chinese sentence punctuation before brand and identity parsing", () => {
    expect(extractResourceLink("请处理：https://pan.quark.cn/s/abc123?pwd=xy99。 谢谢")).toBe(
      "https://pan.quark.cn/s/abc123?pwd=xy99",
    );
    expect(recognizeUserLink("请处理：https://pan.quark.cn/s/abc123?pwd=xy99。 谢谢")).toMatchObject({
      url: "https://pan.quark.cn/s/abc123?pwd=xy99",
      type: "quark",
      linkKey: "quark:abc123",
    });
  });
});

describe("processLinkImport storage selection", () => {
  it("asks for one compatible drive before creating a landing directory when several can serve the link", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome).toMatchObject({
      phase: "pending_selection",
      text: expect.stringContaining("请选择目标网盘"),
    });
    expect(store.require()).toMatchObject({
      phase: "pending_selection",
      candidates: [
        {
          kind: "storage",
          value: "storage-115-a",
          label: "115 主盘",
        },
        {
          kind: "storage",
          value: "storage-115-b",
          label: "115 备用盘",
        },
      ],
      result: {
        kind: "direct_link_storage_selection",
      },
    });
    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
  });

  it("uses the connection default when it is compatible, even when another drive can serve the link", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.transferResult = {
      status: "unknown",
      providerMessage: "提交结果待核实",
      receipt: { providerTaskId: null },
      materializedFileIds: [],
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(
      value,
      { ...connection, defaultStorageId: "storage-115-b" },
      {
        ...portsLike(ports),
        now: () => NOW,
      },
    );

    expect(outcome.phase).toBe("transferring");
    expect(ports.prepareCalls[0]?.storage.id).toBe("storage-115-b");
    expect(ports.transferCalls[0]?.storage.id).toBe("storage-115-b");
  });

  it("persists a clear failure and does not create a landing area when no drive is compatible", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.storages = [{ id: "storage-123", label: "123", provider: "pan123" }];
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome).toMatchObject({
      phase: "failed",
      text: expect.stringContaining("没有兼容"),
    });
    expect(store.require()).toMatchObject({
      phase: "failed",
      error: expect.stringContaining("没有兼容"),
    });
    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
  });
});

describe("processLinkImport recovery", () => {
  it("reconciles a persisted submission without preparing another landing area or resubmitting", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.reconcileResult = {
      status: "pending",
      providerMessage: "remote task is still running",
      receipt: { providerTaskId: "provider-task-existing" },
      materializedFileIds: [],
    };
    const value = job({
      phase: "submitted",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "submitted",
        resourceType: "115",
        resourceLinkKey: "115:abc123",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        providerKind: "115_share",
        state: "running",
        providerTaskId: "provider-task-existing",
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.reconcileCalls).toHaveLength(1);
    expect(ports.reconcileCalls[0]).toMatchObject({
      landingDirectoryId: "landing-existing",
      providerTaskId: "provider-task-existing",
      receipt: {
        kind: "direct_link_transfer",
        stage: "submitted",
        providerKind: "115_share",
        state: "running",
        providerTaskId: "provider-task-existing",
      },
    });
    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
  });

  it("does not scan when reconciliation reports success without a completed provider state", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.reconcileResult = {
      status: "succeeded",
      providerMessage: "adapter inferred success",
      receipt: {
        kind: "115_share",
        providerTaskId: "provider-task-existing",
      },
      materializedFileIds: ["video-1"],
    };
    const value = job({
      phase: "submitted",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "submitted",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        providerKind: "115_share",
        state: "running",
        providerTaskId: "provider-task-existing",
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.scanCalls).toHaveLength(0);
    expect(store.require().receipt).toMatchObject({
      kind: "direct_link_transfer",
      providerKind: "115_share",
      state: "running",
    });
  });

  it("continues from a persisted completed receipt without querying or submitting again", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "submitted",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "submitted",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        providerKind: "115_share",
        state: "completed",
        submittedAt: NOW,
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.reconcileCalls).toHaveLength(0);
    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
    expect(ports.scanCalls).toHaveLength(1);
  });

  it("resumes a proven pre-submit intent by creating and recording its landing area, then submitting once", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "direct_pending",
      landingStorageId: "storage-115-a",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "intent",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        workflowRunId: "messaging-direct-job-a",
        createdAt: NOW,
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.prepareCalls).toHaveLength(1);
    expect(ports.transferCalls).toHaveLength(1);
    expect(store.operations).toContain("update:direct_pending");
    expect(store.require().receipt).toMatchObject({
      stage: "completed",
      landingDirectoryId: "landing-a",
    });
  });

  it("resumes landing_ready by submitting the existing landing without creating another directory", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "direct_pending",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "landing_ready",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
      },
    });
    store.seed(value);

    await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(1);
    expect(ports.transferCalls[0]?.landingDirectoryId).toBe("landing-existing");
  });

  it("queries a persisted submitting receipt and never resubmits after an ambiguous provider call", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "direct_pending",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "submitting",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        submissionStartedAt: NOW,
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.reconcileCalls).toHaveLength(1);
    expect(ports.transferCalls).toHaveLength(0);
    expect(ports.prepareCalls).toHaveLength(0);
  });

  it("does not treat a legacy provider-kind receipt with no direct discriminator as a submitted task", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "submitted",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "pan123_share",
        state: "completed",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.reconcileCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
    expect(ports.scanCalls).toHaveLength(0);
  });

  it("does not query an empty provider receipt when only a landing directory survived", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "direct_pending",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: null,
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.reconcileCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
    expect(store.require().receipt).toMatchObject({
      kind: "direct_link_transfer",
      stage: "submission_unknown",
      state: "unknown",
      landingDirectoryId: "landing-existing",
    });
  });
});

describe("processLinkImport stop", () => {
  it("stops a queued link before creating an intent, landing area, or provider task", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({ stopRequested: true });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome).toMatchObject({
      phase: "stopped",
      text: expect.stringContaining("尚未提交"),
    });
    expect(store.require()).toMatchObject({
      phase: "stopped",
      receipt: null,
      result: {
        kind: "direct_link_result",
        stage: "stopped_before_submit",
      },
    });
    expect(ports.prepareCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
  });

  it("stops after a submitted receipt while retaining the remote-completion warning", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "submitted",
      stopRequested: true,
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "submitted",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        providerKind: "115_share",
        state: "running",
        providerTaskId: "provider-task-existing",
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome).toMatchObject({
      phase: "stopped",
      text: expect.stringContaining("远端任务可能仍会完成"),
    });
    expect(ports.scanCalls).toHaveLength(0);
    expect(ports.organizeCalls).toHaveLength(0);
    expect(ports.transferCalls).toHaveLength(0);
  });

  it.each(["intent", "landing_ready"] as const)(
    "stops a direct_pending %s task before any landing or provider write while preserving its facts",
    async (stage) => {
      const store = new MemoryStore();
      const ports = new Ports(store);
      const landingDirectoryId = stage === "landing_ready" ? "landing-existing" : null;
      const value = job({
        phase: "direct_pending",
        stopRequested: true,
        landingStorageId: "storage-115-a",
        landingDirectoryId,
        receipt: {
          kind: "direct_link_transfer",
          version: 1,
          stage,
          resourceType: "115",
          resourceLinkKey: "115:abc123",
          storageId: "storage-115-a",
          ...(landingDirectoryId === null ? {} : { landingDirectoryId }),
          workflowRunId: "messaging-direct-job-a",
        },
      });
      store.seed(value);

      const outcome = await processLinkImport(value, connection, {
        ...portsLike(ports),
        now: () => NOW,
      });

      expect(outcome.phase).toBe("stopped");
      expect(ports.prepareCalls).toHaveLength(0);
      expect(ports.transferCalls).toHaveLength(0);
      expect(ports.reconcileCalls).toHaveLength(0);
      expect(store.require().receipt).toMatchObject({
        kind: "direct_link_transfer",
        stage: "stopped_before_submit",
        resourceLinkKey: "115:abc123",
        storageId: "storage-115-a",
        workflowRunId: "messaging-direct-job-a",
      });
    },
  );

  it("stops after landing preparation but before provider submission", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.afterPrepare = async () => {
      await store.update(
        "account-a",
        "job-a",
        { stopRequested: true },
        NOW,
      );
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("stopped");
    expect(ports.prepareCalls).toHaveLength(1);
    expect(ports.transferCalls).toHaveLength(0);
    expect(store.require().receipt).toMatchObject({
      kind: "direct_link_transfer",
      stage: "stopped_before_submit",
      landingDirectoryId: "landing-a",
    });
  });
});

describe("processLinkImport persistence and processing", () => {
  it("persists the provider task id inside onSubmitted before the transfer call returns", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.transferResult = {
      status: "unknown",
      providerMessage: "waiting for provider",
      receipt: { providerTaskId: "provider-task-immediate" },
      materializedFileIds: [],
    };
    ports.submittedReceipt = {
      kind: "115_share",
      state: "running",
      providerTaskId: "provider-task-immediate",
      submittedAt: NOW,
    };
    ports.afterSubmitted = async () => {
      expect(store.require()).toMatchObject({
        phase: "submitted",
        receipt: { providerTaskId: "provider-task-immediate" },
      });
    };
    ports.beforeTransferCall = () => {
      expect(store.require().receipt).toMatchObject({
        kind: "direct_link_transfer",
        stage: "submitting",
        submissionStartedAt: NOW,
      });
    };
    const value = job();
    store.seed(value);

    await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(store.operations).toEqual(
      expect.arrayContaining(["update:direct_pending", "update:submitted"]),
    );
    expect(ports.transferCalls[0]?.wholePackage).toBe(true);
  });

  it("scans and identifies confirmed landed files before organizing and refreshing the original library", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.scanCalls[0]).toMatchObject({
      landingDirectoryId: "landing-a",
      autoAcquire: false,
    });
    expect(ports.organizeCalls).toHaveLength(1);
    expect(ports.refreshCalls).toEqual([
      {
        accountId: "account-a",
        storage: {
          id: "storage-115-a",
          label: "115 主盘",
          provider: "pan115",
        },
        workflowRunId: "messaging-direct-job-a",
        organizationKey: "org-a",
        verifiedNewVideoFileIds: ["video-1"],
      },
    ]);
    expect(store.require()).toMatchObject({
      phase: "completed",
      scanTaskId: "scan-a",
      organizationKey: "org-a",
      receipt: {
        kind: "direct_link_transfer",
        providerKind: "115_share",
        state: "completed",
      },
      result: {
        kind: "direct_link_result",
        stage: "completed",
        autoAcquire: false,
        scanTaskId: "scan-a",
        organizationKey: "org-a",
      },
    });
  });

  it("does not scan when the provider status has no completed-state proof", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.transferResult = {
      status: "succeeded",
      providerMessage: "directory changed, remote state omitted",
      receipt: { kind: "115_share", providerTaskId: "provider-task-no-state" },
      materializedFileIds: ["video-1"],
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("transferring");
    expect(ports.scanCalls).toHaveLength(0);
    expect(ports.organizeCalls).toHaveLength(0);
    expect(store.require().receipt).toMatchObject({
      kind: "direct_link_transfer",
      providerKind: "115_share",
      providerTaskId: "provider-task-no-state",
    });
  });

  it("passes a plain labeled access code to the transfer candidate after trimming the URL punctuation", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.storages = [{ id: "storage-quark", label: "夸克", provider: "quark" }];
    ports.transferResult = {
      status: "unknown",
      providerMessage: "submitted",
      receipt: { kind: "quark_share", state: "running" },
      materializedFileIds: [],
    };
    const value = job({
      text: "请处理：https://pan.quark.cn/s/abc123。提取码：xy99！谢谢",
    });
    store.seed(value);

    await processLinkImport(
      value,
      { ...connection, defaultStorageId: "storage-quark" },
      { ...portsLike(ports), now: () => NOW },
    );

    expect(ports.transferCalls[0]?.link.url).toBe("https://pan.quark.cn/s/abc123");
    expect(ports.transferCalls[0]?.candidate.providerPayload).toMatchObject({
      url: "https://pan.quark.cn/s/abc123",
      password: "xy99",
    });
  });

  it("keeps the landing area and marks partial when any video identity is not confirmed", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.scanResult = {
      scanTaskId: "scan-partial",
      videos: [video("video-1"), video("video-2")],
      identities: [
        { fileId: "video-1", status: "confirmed", identityKey: "account-a|storage-115-a|movie|42" },
        { fileId: "video-2", status: "ambiguous", identityKey: null },
      ],
      partial: false,
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("partial");
    expect(store.require()).toMatchObject({
      phase: "partial",
      landingDirectoryId: "landing-a",
      result: {
        stage: "identity_partial",
        pendingIdentityFileIds: ["video-2"],
        autoAcquire: false,
      },
    });
    expect(ports.organizeCalls).toHaveLength(0);
    expect(ports.refreshCalls).toHaveLength(0);
  });

  it("does not refresh the media library when organization verifies no new video file", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.organizeResult = {
      organizationKey: "org-no-new-video",
      status: "completed",
      verifiedNewVideoFileIds: [],
      providerMessage: "nothing new",
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.refreshCalls).toHaveLength(0);
    expect(store.require().result).toMatchObject({
      stage: "completed",
      refreshStatus: "skipped",
    });
  });

  it("does not refresh when organization is partial even if one verified video would otherwise qualify", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.organizeResult = {
      organizationKey: "org-partial",
      status: "partial",
      verifiedNewVideoFileIds: ["video-1"],
      providerMessage: "字幕未能唯一配对，保留原位",
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("partial");
    expect(ports.refreshCalls).toHaveLength(0);
    expect(store.require().result).toMatchObject({
      stage: "organization_partial",
      verifiedNewVideoFileIds: ["video-1"],
      refreshStatus: "skipped",
    });
  });

  it("does not repeat refresh after the durable pre-call crash marker survives a resume", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    const value = job({
      phase: "verifying",
      landingStorageId: "storage-115-a",
      landingDirectoryId: "landing-existing",
      receipt: {
        kind: "direct_link_transfer",
        version: 1,
        stage: "refresh_pending",
        resourceType: "115",
        resourceLinkKey: "115:115",
        storageId: "storage-115-a",
        landingDirectoryId: "landing-existing",
        workflowRunId: "messaging-direct-job-a",
        providerKind: "115_share",
        state: "completed",
        refreshStartedAt: NOW,
        refreshFileIds: ["video-1"],
      },
    });
    store.seed(value);

    const outcome = await processLinkImport(value, connection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.refreshCalls).toHaveLength(0);
    expect(store.require().receipt).toMatchObject({
      stage: "completed",
      refreshStartedAt: NOW,
      refreshStatus: "unknown",
    });
  });

  it("persists refresh_pending before invoking the external refresh helper", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.beforeRefresh = () => {
      expect(store.require().receipt).toMatchObject({
        stage: "refresh_pending",
        state: "completed",
        refreshStartedAt: NOW,
        refreshFileIds: ["video-1"],
      });
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("completed");
    expect(ports.refreshCalls).toHaveLength(1);
    expect(store.require().receipt).toMatchObject({
      stage: "completed",
      refreshStatus: "refreshed",
    });
  });

  it("stops after scan returns and does not classify identities when stop arrives during the wait", async () => {
    const store = new MemoryStore();
    const ports = new Ports(store);
    ports.afterScan = async () => {
      await store.update(
        "account-a",
        "job-a",
        { stopRequested: true },
        NOW,
      );
    };
    const value = job();
    store.seed(value);

    const outcome = await processLinkImport(value, defaultConnection, {
      ...portsLike(ports),
      now: () => NOW,
    });

    expect(outcome.phase).toBe("stopped");
    expect(store.require()).toMatchObject({
      phase: "stopped",
      scanTaskId: "scan-a",
      result: {
        stage: "stopped_after_submit",
        scanTaskId: "scan-a",
      },
    });
    expect(ports.organizeCalls).toHaveLength(0);
    expect(ports.refreshCalls).toHaveLength(0);
  });
});

function portsLike(ports: Ports): LinkImportDependencies {
  return {
    store: ports.store,
    listStorages: (accountId) => ports.listStorages(accountId),
    prepareLanding: (input) => ports.prepareLanding(input),
    submitTransfer: (input) => ports.submitTransfer(input),
    reconcileTransfer: (input) => ports.reconcileTransfer(input),
    scanAndIdentify: (input) => ports.scanAndIdentify(input),
    organize: (input) => ports.organize(input),
    refresh: (input) => ports.refresh(input),
  };
}

