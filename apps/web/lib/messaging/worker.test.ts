import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersistedWorkflowRunSnapshot } from "@media-track/workflow";
import { clearUpdateHold, setUpdateHold } from "../update-hold";
import {
  MessagingCommandProcessor,
  type MessagingCommandPorts,
} from "./commands";
import { PostgresMessagingStore, type MessagingJob, type MessagingJobPatch, type MessagingResultInput } from "./store";
import type { InboundMessage, MessageReply, MessagingConnection, MessagingSink, MessagingTransport } from "./types";
import {
  __resetMessagingWorkerForTests,
  createMessagingWorker,
  startMessagingWorker,
  type MessagingWorkerRuntime,
} from "./worker";

const NOW = "2026-11-17T09:00:00.000Z";

const connection: MessagingConnection = {
  id: "connection-a",
  accountId: "account-a",
  platform: "weixin",
  botId: "bot-a",
  enabled: true,
  senderId: "owner-a",
  defaultStorageId: "storage-a",
  credentials: { token: "secret-token" },
};

function job(input: Partial<MessagingJob> & Pick<MessagingJob, "id">): MessagingJob {
  const { id, ...overrides } = input;
  return {
    id,
    connectionId: connection.id,
    accountId: connection.accountId,
    platform: connection.platform,
    platformMessageId: `platform-${input.id}`,
    conversationId: "private-chat",
    senderId: connection.senderId,
    text: "帮助",
    callbackData: null,
    replyToken: "token-from-inbound",
    inputKind: "text",
    phase: "received",
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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class MemoryMessagingStore {
  readonly jobs = new Map<string, MessagingJob>();
  readonly latestTokens = new Map<string, string>();

  seed(value: MessagingJob): void {
    this.jobs.set(value.id, structuredClone(value));
  }

  async ensureSchema(): Promise<void> {}

  async accept(
    owner: MessagingConnection,
    messages: readonly InboundMessage[],
    _cursor?: string,
  ): Promise<MessagingJob[]> {
    return messages.map((message) => {
      const accepted = job({
        id: `inbound-${message.messageId}`,
        connectionId: owner.id,
        accountId: owner.accountId,
        platform: owner.platform,
        platformMessageId: message.messageId,
        conversationId: message.conversationId,
        senderId: message.senderId,
        text: message.text,
        replyToken: message.replyToken ?? null,
      });
      this.seed(accepted);
      if (accepted.replyToken) this.latestTokens.set(accepted.conversationId, accepted.replyToken);
      return structuredClone(accepted);
    });
  }

  async claimNext(): Promise<MessagingJob | null> {
    const next = [...this.jobs.values()]
      .filter((candidate) => candidate.phase === "received")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];
    if (!next) return null;
    next.phase = "running";
    next.updatedAt = NOW;
    return structuredClone(next);
  }

  async get(accountId: string, id: string): Promise<MessagingJob | null> {
    const found = this.jobs.get(id);
    return found?.accountId === accountId ? structuredClone(found) : null;
  }

  async findLatestPending(
    accountId: string,
    connectionId: string,
    conversationId: string,
  ): Promise<MessagingJob | null> {
    const found = [...this.jobs.values()]
      .filter(
        (candidate) =>
          candidate.accountId === accountId &&
          candidate.connectionId === connectionId &&
          candidate.conversationId === conversationId &&
          candidate.phase === "pending_selection",
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return found ? structuredClone(found) : null;
  }

  async loadLatestReplyToken(
    _accountId: string,
    _connectionId: string,
    conversationId: string,
  ): Promise<string | null> {
    return this.latestTokens.get(conversationId) ?? null;
  }

  async update(
    accountId: string,
    id: string,
    patch: MessagingJobPatch,
    now = NOW,
  ): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    Object.assign(found, structuredClone(patch), { updatedAt: now });
    return true;
  }

  async saveResult(
    accountId: string,
    id: string,
    input: MessagingResultInput,
    now = NOW,
  ): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    found.phase = input.phase;
    found.result = structuredClone(input.result);
    found.error = input.error ?? null;
    found.sendStatus = input.sendStatus;
    found.updatedAt = now;
    return true;
  }

  require(id: string): MessagingJob {
    const found = this.jobs.get(id);
    if (!found) throw new Error(`Missing job ${id}`);
    return found;
  }
}

interface RuntimeFixture {
  runtime: MessagingWorkerRuntime;
  store: MemoryMessagingStore;
  starts: { connection: MessagingConnection; sink: MessagingSink; signal: AbortSignal }[];
  sends: { connection: MessagingConnection; reply: MessageReply }[];
  processDirect: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  snapshots: ReturnType<typeof vi.fn>;
}

function runtimeFixture(input: {
  store?: MemoryMessagingStore;
  recoverableIds?: readonly string[];
  held?: boolean;
  sendError?: Error;
  connections?: readonly MessagingConnection[];
  snapshot?: PersistedWorkflowRunSnapshot | null;
  direct?: (target: MessagingJob, owner: MessagingConnection) => Promise<{
    phase: MessagingJob["phase"];
    text: string;
    result: Record<string, unknown>;
  }>;
  enqueueHandler?: MessagingCommandPorts["enqueue"];
  enqueueResult?: Awaited<ReturnType<MessagingCommandPorts["enqueue"]>>;
} = {}): RuntimeFixture {
  const store = input.store ?? new MemoryMessagingStore();
  const starts: RuntimeFixture["starts"] = [];
  const sends: RuntimeFixture["sends"] = [];
  const processDirect = vi.fn(
    input.direct ??
      (async (target: MessagingJob) => {
        await store.update(target.accountId, target.id, { phase: "completed" });
        return {
          phase: "completed" as const,
          text: "直转完成",
          result: { kind: "direct_link_result", text: "直转完成" },
        };
      }),
  );
  const enqueue = vi.fn<MessagingCommandPorts["enqueue"]>(
    input.enqueueHandler ??
      (async () =>
        input.enqueueResult ?? {
          status: "queued" as const,
          workflowRunId: "run-recovered",
          reused: false,
          associationCommitted: true as const,
        }),
  );
  const snapshots = vi.fn(async () => input.snapshot ?? null);
  const commandPorts: MessagingCommandPorts = {
    search: async () => ({ choices: [] }),
    enqueue,
    query: async () => [],
    stop: async ({ id }) => ({ taskId: id, stopped: false, reason: "not_found" }),
    listStorages: async () => [{ id: "storage-a", label: "主网盘" }],
  };
  const commandProcessor = new MessagingCommandProcessor(
    store as unknown as PostgresMessagingStore,
    commandPorts,
    { now: () => NOW },
  );
  const runtime: MessagingWorkerRuntime = {
    store: store as unknown as PostgresMessagingStore,
    commandProcessor,
    application: commandPorts,
    loadConnections: async () => input.connections ?? [connection],
    transportFor: () => ({
      async start(owner, sink, signal) {
        starts.push({ connection: owner, sink, signal });
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async send(owner, reply) {
        sends.push({ connection: owner, reply });
        if (input.sendError) throw input.sendError;
      },
    }),
    getWorkflowRunSnapshot: snapshots,
    listRecoverableJobIds: async () =>
      (input.recoverableIds ?? []).map((id) => ({ accountId: connection.accountId, id })),
    processDirectLink: processDirect,
    isUpdateHoldActive: () => input.held ?? false,
    whileInFlight: async (work) => work(),
    now: () => NOW,
  };
  return { runtime, store, starts, sends, processDirect, enqueue, snapshots };
}

afterEach(() => {
  clearUpdateHold();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __resetMessagingWorkerForTests();
});

describe("startMessagingWorker", () => {
  it.each([
    ["in-process workers disabled", "MEDIA_TRACK_INPROCESS_WORKER", "0"],
    ["rehearsal", "MEDIA_TRACK_REHEARSAL", "1"],
    ["demo mode", "MEDIA_TRACK_DEMO_MODE", "1"],
  ])("does not load the runtime when %s", async (_label, key, value) => {
    vi.useFakeTimers();
    vi.stubEnv(key, value);
    const runtimeFactory = vi.fn(async () => runtimeFixture().runtime);

    startMessagingWorker({ runtimeFactory, pollMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("retries runtime creation after a factory rejection", async () => {
    vi.useFakeTimers();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = runtimeFixture();
    const runtimeFactory = vi
      .fn<() => Promise<MessagingWorkerRuntime>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(fixture.runtime);

    startMessagingWorker({ runtimeFactory, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtimeFactory).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);

    expect(runtimeFactory).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
  });

  it("does not load the runtime while an update hold is active", async () => {
    vi.useFakeTimers();
    const runtimeFactory = vi.fn(async () => runtimeFixture().runtime);
    setUpdateHold(Date.now(), 10_000);

    startMessagingWorker({ runtimeFactory, pollMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(runtimeFactory).not.toHaveBeenCalled();

    clearUpdateHold();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtimeFactory).toHaveBeenCalledTimes(1);
  });
});

describe("messaging worker tick", () => {
  it("commits an accepted batch before claiming or answering its job", async () => {
    const order: string[] = [];
    const store = new MemoryMessagingStore();
    const fixture = runtimeFixture({ store });
    const command = fixture.runtime.commandProcessor.handle.bind(fixture.runtime.commandProcessor);
    fixture.runtime.commandProcessor = {
      handle: vi.fn(async (target, owner) => {
        order.push("handle");
        return command(target, owner);
      }),
    };
    const worker = createMessagingWorker(fixture.runtime);
    await worker.tick();
    const receiver = fixture.starts[0];
    expect(receiver).toBeDefined();

    await receiver!.sink.accept(
      [
        {
          connectionId: connection.id,
          platform: connection.platform,
          botId: connection.botId,
          messageId: "message-1",
          conversationId: "private-chat",
          senderId: connection.senderId,
          text: "帮助",
          replyToken: "latest-token",
        },
      ],
      "cursor-1",
    );
    order.push("accepted");
    expect(order).toEqual(["accepted"]);

    await worker.tick();

    expect(order).toEqual(["accepted", "handle"]);
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.reply.replyToken).toBe("latest-token");
    expect(store.require("inbound-message-1")).toMatchObject({
      phase: "completed",
      sendStatus: "sent",
    });
    worker.stop();
  });

  it("keeps the durable reply and marks a failed send without retrying it", async () => {
    const store = new MemoryMessagingStore();
    store.seed(job({ id: "help-job" }));
    const fixture = runtimeFixture({ store, sendError: new Error("transport offline") });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(fixture.sends).toHaveLength(1);
    expect(store.require("help-job")).toMatchObject({
      phase: "completed",
      sendStatus: "failed",
      error: "transport offline",
      result: { kind: "help" },
    });
    expect(store.require("help-job").result?.text).toContain("可用命令");
    worker.stop();
  });

  it("sends the original acquisition's terminal result only after its persisted run finishes", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "native-job",
        phase: "queued",
        workflowRunId: "run-native",
        result: { kind: "acquisition_request" },
      }),
    );
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["native-job"],
      snapshot: {
        accountId: connection.accountId,
        connectedStorageId: "storage-a",
        title: {
          id: "tmdb_movie_1",
          tmdbId: 1,
          type: "movie",
          title: "测试电影",
          originalTitle: "Test Movie",
          year: 2026,
          aliases: [],
        },
        season: {
          id: "tmdb_movie_1_movie",
          mediaTitleId: "tmdb_movie_1",
          seasonNumber: 0,
          status: "completed",
          qualityPreference: "4K",
          storageDirectoryId: "",
          totalEpisodes: 1,
          latestAiredEpisode: 1,
          latestAiredSource: "metadata",
        },
        workflowRun: {
          id: "run-native",
          kind: "movie_init",
          status: "succeeded",
          trackedSeasonId: "tmdb_movie_1_movie",
          startedAt: NOW,
          finishedAt: NOW,
          auditEvents: [],
        },
        episodes: [],
        resourceSnapshots: [],
        decisions: [],
        transferAttempts: [],
        notifications: [
          {
            id: "notification-1",
            workflowRunId: "run-native",
            kind: "acquisition_finished",
            title: "获取完成",
            body: "《测试电影》已入库。",
            createdAt: NOW,
          },
        ],
        obtainedEpisodes: [],
        providerAheadEpisodes: [],
      },
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(fixture.snapshots).toHaveBeenCalledWith("run-native", connection.accountId);
    expect(fixture.sends[0]?.reply.text).toContain("《测试电影》已入库");
    expect(store.require("native-job")).toMatchObject({
      phase: "completed",
      sendStatus: "sent",
    });
    worker.stop();
  });

  it("converges a missing linked run to stopped instead of polling forever", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "missing-linked-run",
        phase: "queued",
        workflowRunId: "run-already-removed",
        result: { kind: "acquisition_request" },
      }),
    );
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["missing-linked-run"],
      snapshot: null,
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.reply.text).toBe("原获取任务已取消或已移除");
    expect(store.require("missing-linked-run")).toMatchObject({
      phase: "stopped",
      stopRequested: true,
      sendStatus: "sent",
      result: {
        kind: "acquisition_stopped",
        workflowRunId: "run-already-removed",
        text: "原获取任务已取消或已移除",
      },
    });
    worker.stop();
  });

  it("resumes a persisted acquisition request through the idempotent enqueue port", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "recovery-job",
        phase: "queued",
        result: {
          kind: "acquisition_request",
          request: {
            titleId: "tmdb_movie_2",
            mediaType: "movie",
            seasonNumber: null,
            title: "恢复测试",
          },
          storageId: "storage-a",
        },
      }),
    );
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["recovery-job"],
      snapshot: null,
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(fixture.enqueue).toHaveBeenCalledTimes(1);
    expect(fixture.enqueue).toHaveBeenCalledWith({
      accountId: connection.accountId,
      messagingJobId: "recovery-job",
      request: {
        titleId: "tmdb_movie_2",
        mediaType: "movie",
        seasonNumber: null,
        title: "恢复测试",
      },
      storageId: "storage-a",
    });
    expect(store.require("recovery-job")).toMatchObject({
      phase: "queued",
      workflowRunId: "run-recovered",
    });
    worker.stop();
  });

  it("does not let one failing recovery block later recoveries or incoming commands", async () => {
    const store = new MemoryMessagingStore();
    const poisonReceipt = {
      stage: "provider_submitted",
      providerTaskId: "unknown-provider-task",
    };
    store.seed(
      job({
        id: "poison-recovery",
        phase: "queued",
        receipt: poisonReceipt,
        result: {
          kind: "acquisition_request",
          request: {
            titleId: "tmdb_movie_3",
            mediaType: "movie",
            seasonNumber: null,
            title: "永久失败",
          },
          storageId: "storage-a",
        },
      }),
    );
    store.seed(
      job({
        id: "later-recovery",
        phase: "queued",
        result: {
          kind: "acquisition_request",
          request: {
            titleId: "tmdb_movie_4",
            mediaType: "movie",
            seasonNumber: null,
            title: "后续恢复",
          },
          storageId: "storage-a",
        },
      }),
    );
    store.seed(job({ id: "incoming-after-poison", text: "帮助" }));
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["poison-recovery", "later-recovery"],
      enqueueHandler: async (input) => {
        if (input.request.title === "永久失败") throw new Error("drive remains frozen");
        return {
          status: "queued",
          workflowRunId: "run-after-poison",
          reused: false,
          associationCommitted: true,
        };
      },
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(fixture.enqueue).toHaveBeenCalledTimes(2);
    expect(store.require("poison-recovery")).toMatchObject({
      phase: "queued",
      receipt: poisonReceipt,
      error: "drive remains frozen",
      result: { kind: "acquisition_request" },
    });
    expect(store.require("later-recovery")).toMatchObject({
      phase: "queued",
      workflowRunId: "run-after-poison",
    });
    expect(store.require("incoming-after-poison")).toMatchObject({
      phase: "completed",
      sendStatus: "sent",
    });
    worker.stop();
  });

  it("sends an atomically persisted already-tracked reply once after restart", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "already-tracked-pending",
        phase: "completed",
        sendStatus: "pending",
        result: {
          kind: "already_tracked",
          text: "该作品已在追踪，无需重复入队。",
        },
      }),
    );
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["already-tracked-pending"],
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();
    await worker.tick();

    expect(fixture.enqueue).not.toHaveBeenCalled();
    expect(fixture.sends).toHaveLength(1);
    expect(fixture.sends[0]?.reply.text).toContain("已在追踪");
    expect(store.require("already-tracked-pending")).toMatchObject({
      phase: "completed",
      sendStatus: "sent",
      result: { kind: "already_tracked" },
    });
    worker.stop();
  });

  it("continues claiming received commands after one handler throws", async () => {
    const store = new MemoryMessagingStore();
    store.seed(job({ id: "poison-command", text: "触发失败" }));
    store.seed(job({ id: "later-command", text: "帮助" }));
    const fixture = runtimeFixture({ store });
    const handle = fixture.runtime.commandProcessor.handle.bind(fixture.runtime.commandProcessor);
    fixture.runtime.commandProcessor = {
      handle: vi.fn(async (target, owner) => {
        if (target.id === "poison-command") throw new Error("command remains unavailable");
        return handle(target, owner);
      }),
    };
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();

    expect(store.require("poison-command")).toMatchObject({
      phase: "running",
      error: "command remains unavailable",
    });
    expect(store.require("later-command")).toMatchObject({
      phase: "completed",
      sendStatus: "sent",
    });
    worker.stop();
  });

  it("hands a direct link to the link importer once while that job is in flight", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "direct-job",
        inputKind: "direct_link",
        phase: "direct_pending",
        text: "https://115.com/s/abc",
      }),
    );
    let release: (() => void) | undefined;
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["direct-job"],
      direct: async (target) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await store.update(target.accountId, target.id, { phase: "completed" });
        return {
          phase: "completed",
          text: "直转完成",
          result: { kind: "direct_link_result", text: "直转完成" },
        };
      },
    });
    const worker = createMessagingWorker(fixture.runtime);

    const first = worker.tick();
    await vi.waitFor(() => expect(fixture.processDirect).toHaveBeenCalledTimes(1));
    await worker.tick();
    expect(fixture.processDirect).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    await worker.tick();

    expect(fixture.processDirect).toHaveBeenCalledTimes(1);
    expect(fixture.sends[0]?.reply).toMatchObject({
      conversationId: "private-chat",
      text: "直转完成",
    });
    worker.stop();
  });

  it("claims a stop command while a direct operation is still in flight", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "slow-direct",
        inputKind: "direct_link",
        phase: "direct_pending",
        text: "https://115.com/s/slow",
      }),
    );
    store.seed(job({ id: "query-during-direct", text: "帮助" }));
    let release: (() => void) | undefined;
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["slow-direct"],
      direct: async (target) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await store.update(target.accountId, target.id, { phase: "completed" });
        return {
          phase: "completed",
          text: "直转完成",
          result: { kind: "direct_link_result", text: "直转完成" },
        };
      },
    });
    const command = fixture.runtime.commandProcessor.handle.bind(fixture.runtime.commandProcessor);
    const handle = vi.fn(command);
    fixture.runtime.commandProcessor = { handle };
    const worker = createMessagingWorker(fixture.runtime);
    const ticking = worker.tick();

    try {
      await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));
      expect(store.require("query-during-direct").sendStatus).toBe("sent");
    } finally {
      release?.();
      await ticking;
      worker.stop();
    }
  });

  it("does not resend an unchanged pending direct stage on every poll", async () => {
    const store = new MemoryMessagingStore();
    store.seed(
      job({
        id: "pending-direct",
        inputKind: "direct_link",
        phase: "direct_pending",
        text: "https://115.com/s/pending",
      }),
    );
    const fixture = runtimeFixture({
      store,
      recoverableIds: ["pending-direct"],
      direct: async (target) => {
        const result = {
          kind: "direct_link_result",
          stage: "transferring",
          text: "转存仍在进行，等待网盘回执。",
        };
        await store.update(target.accountId, target.id, {
          phase: "transferring",
          result,
        });
        return { phase: "transferring", result, text: result.text };
      },
    });
    const worker = createMessagingWorker(fixture.runtime);

    await worker.tick();
    await vi.waitFor(() => expect(fixture.sends).toHaveLength(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await worker.tick();
    await vi.waitFor(() => expect(fixture.processDirect).toHaveBeenCalledTimes(2));

    expect(fixture.sends).toHaveLength(1);
    expect(store.require("pending-direct").sendStatus).toBe("sent");
    worker.stop();
  });
});
