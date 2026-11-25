import { describe, expect, it } from "vitest";
import type { MessagingConnection, MessageReply } from "./types";
import {
  MessagingCommandProcessor,
  type MessagingAcquisitionRequest,
  type MessagingCommandPorts,
  type MessagingCommandStore,
  type MessagingEnqueueInput,
  type MessagingEnqueueResult,
  type MessagingSearchInput,
  type MessagingSearchResult,
  type MessagingStopResult,
  type MessagingStorageChoice,
  type MessagingTaskSummary,
} from "./commands";
import type {
  MessagingCandidate,
  MessagingJob,
  MessagingJobPatch,
  MessagingJobPhase,
  MessagingResultInput,
} from "./store";

const NOW = "2026-11-17T08:00:00.000Z";

const connection: MessagingConnection = {
  id: "connection-weixin",
  accountId: "account-a",
  platform: "weixin",
  botId: "bot-a",
  enabled: true,
  senderId: "owner-a",
  defaultStorageId: null,
  credentials: { token: "secret-must-not-be-replied" },
};

function job(input: {
  id: string;
  text?: string;
  callbackData?: string;
  phase?: MessagingJob["phase"];
  accountId?: string;
  workflowRunId?: string | null;
  conversationId?: string;
}): MessagingJob {
  return {
    id: input.id,
    connectionId: connection.id,
    accountId: input.accountId ?? connection.accountId,
    platform: connection.platform,
    platformMessageId: `platform-${input.id}`,
    conversationId: input.conversationId ?? "private-chat",
    senderId: connection.senderId,
    text: input.text ?? "",
    callbackData: input.callbackData ?? null,
    replyToken: null,
    inputKind: input.callbackData === undefined ? "text" : "selection",
    phase: input.phase ?? "running",
    candidates: [],
    selectedCandidateIndex: null,
    workflowRunId: input.workflowRunId ?? null,
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
  };
}

class MemoryStore implements MessagingCommandStore {
  readonly jobs = new Map<string, MessagingJob>();
  confirmCalls = 0;

  seed(value: MessagingJob): void {
    this.jobs.set(value.id, structuredClone(value));
  }

  async get(accountId: string, id: string): Promise<MessagingJob | null> {
    const found = this.jobs.get(id);
    return found?.accountId === accountId ? structuredClone(found) : null;
  }

  async listRecent(accountId: string): Promise<MessagingJob[]> {
    return [...this.jobs.values()]
      .filter((candidate) => candidate.accountId === accountId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((candidate) => structuredClone(candidate));
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

  async expirePending(
    accountId: string,
    connectionId: string,
    conversationId: string,
    exceptJobId: string,
    now: string,
  ): Promise<number> {
    let count = 0;
    for (const candidate of this.jobs.values()) {
      if (
        candidate.accountId === accountId &&
        candidate.connectionId === connectionId &&
        candidate.conversationId === conversationId &&
        candidate.id !== exceptJobId &&
        candidate.phase === "pending_selection"
      ) {
        candidate.phase = "expired";
        candidate.updatedAt = now;
        count += 1;
      }
    }
    return count;
  }

  async replacePendingCandidates(
    accountId: string,
    id: string,
    candidates: readonly MessagingCandidate[],
    now: string,
  ): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    found.candidates = structuredClone([...candidates]);
    found.selectedCandidateIndex = null;
    found.phase = "pending_selection";
    found.updatedAt = now;
    return true;
  }

  async confirmPending(
    accountId: string,
    id: string,
    index: number,
    now: string,
  ): Promise<boolean> {
    this.confirmCalls += 1;
    const found = this.jobs.get(id);
    if (
      !found ||
      found.accountId !== accountId ||
      found.phase !== "pending_selection" ||
      index < 0 ||
      index >= found.candidates.length
    ) {
      return false;
    }
    found.phase = "queued";
    found.selectedCandidateIndex = index;
    found.updatedAt = now;
    return true;
  }

  async update(accountId: string, id: string, patch: MessagingJobPatch): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    Object.assign(found, patch, { updatedAt: NOW });
    return true;
  }

  async saveResult(accountId: string, id: string, input: MessagingResultInput): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    found.phase = input.phase;
    found.result = structuredClone(input.result);
    found.error = input.error ?? null;
    found.sendStatus = input.sendStatus;
    found.updatedAt = NOW;
    return true;
  }

  async requestStop(accountId: string, id: string): Promise<boolean> {
    const found = this.jobs.get(id);
    if (!found || found.accountId !== accountId) return false;
    found.stopRequested = true;
    found.updatedAt = NOW;
    return true;
  }

  require(id: string): MessagingJob {
    const found = this.jobs.get(id);
    if (!found) throw new Error(`missing job ${id}`);
    return found;
  }
}

class Ports implements MessagingCommandPorts {
  searchCalls: MessagingSearchInput[] = [];
  enqueueCalls: MessagingEnqueueInput[] = [];
  stopCalls: string[] = [];
  storageCalls: string[] = [];
  preEnqueuePhases: MessagingJobPhase[] = [];
  preEnqueueHook: (input: MessagingEnqueueInput) => Promise<void> = async () => undefined;
  associationHook: (
    input: MessagingEnqueueInput,
    result: MessagingEnqueueResult,
  ) => Promise<void> = async () => undefined;
  enqueueHandler: ((input: MessagingEnqueueInput) => Promise<MessagingEnqueueResult>) | null = null;
  searchHandler: (input: MessagingSearchInput) => Promise<MessagingSearchResult> = async () => ({
    choices: [],
  });
  queryHandler: (accountId: string, id?: string) => Promise<readonly MessagingTaskSummary[]> = async () => [];
  stopHandler: (accountId: string, id: string) => Promise<MessagingStopResult> = async (_accountId, id) => ({
    taskId: id,
    stopped: false,
    reason: "not_found",
  });
  storages: readonly MessagingStorageChoice[] = [{ id: "storage-a", label: "主网盘" }];

  async search(input: MessagingSearchInput): Promise<MessagingSearchResult> {
    this.searchCalls.push(structuredClone(input));
    return this.searchHandler(input);
  }

  async enqueue(input: MessagingEnqueueInput): Promise<MessagingEnqueueResult> {
    this.enqueueCalls.push(structuredClone(input));
    await this.preEnqueueHook(input);
    const result: MessagingEnqueueResult = this.enqueueHandler
      ? await this.enqueueHandler(input)
      : {
          status: "queued",
          workflowRunId: "run-enqueued",
          reused: false,
          associationCommitted: true,
        };
    await this.associationHook(input, result);
    return result;
  }

  async query(input: { accountId: string; id?: string }): Promise<readonly MessagingTaskSummary[]> {
    return this.queryHandler(input.accountId, input.id);
  }

  async stop(input: { accountId: string; id: string }): Promise<MessagingStopResult> {
    this.stopCalls.push(input.id);
    return this.stopHandler(input.accountId, input.id);
  }

  async listStorages(accountId: string): Promise<readonly MessagingStorageChoice[]> {
    this.storageCalls.push(accountId);
    return this.storages;
  }
}

function processor(store: MemoryStore, ports: Ports): MessagingCommandProcessor {
  ports.preEnqueueHook = async (input) => {
    const current = await store.get(input.accountId, input.messagingJobId);
    ports.preEnqueuePhases.push(current?.phase ?? "failed");
    await store.update(input.accountId, input.messagingJobId, {
      phase: "queued",
      landingStorageId: input.storageId,
      result: {
        kind: "enqueue_request",
        request: input.request,
        storageId: input.storageId,
      },
    });
  };
  ports.associationHook = async (input, result) => {
    if (result.status !== "already_tracked") {
      await store.update(input.accountId, input.messagingJobId, {
        workflowRunId: result.workflowRunId,
      });
    }
  };
  return new MessagingCommandProcessor(store, ports, {
    now: () => NOW,
  });
}

function buttonValues(reply: MessageReply): string[] {
  return (reply.choices ?? []).map((choice) => choice.value);
}

describe("MessagingCommandProcessor", () => {
  it("answers help and identity without exposing connection credentials", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const commands = processor(store, ports);
    const help = job({ id: "help", text: "帮助" });
    const identity = job({ id: "identity", text: "身份" });
    store.seed(help);
    store.seed(identity);

    const helpReply = await commands.handle(help, connection);
    const identityReply = await commands.handle(identity, connection);

    expect(helpReply.text).toContain("可用命令");
    expect(helpReply.text).toContain("我想看");
    expect(identityReply.text).toContain("account-a");
    expect(identityReply.text).toContain("微信");
    expect(identityReply.text).not.toContain("secret-must-not-be-replied");
    expect(store.require("help")).toMatchObject({ phase: "completed", sendStatus: "pending" });
    expect(store.require("identity")).toMatchObject({ phase: "completed", sendStatus: "pending" });
  });

  it("searches a plain title, stores ambiguity with job-bound indexes, and enqueues once after CAS", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const request: MessagingAcquisitionRequest = {
      titleId: "tmdb_movie_42",
      mediaType: "movie",
      seasonNumber: null,
      title: "流浪地球",
    };
    ports.searchHandler = async (input) =>
      input.history.length === 0
        ? {
            choices: [
              { kind: "title", value: "tmdb_movie_42", label: "流浪地球（2019）" },
              { kind: "title", value: "tmdb_movie_99", label: "流浪地球（同名）" },
            ],
          }
        : { choices: [], request };
    const commands = processor(store, ports);
    const search = job({ id: "search", text: "我想看 流浪地球" });
    store.seed(search);

    const menu = await commands.handle(search, connection);
    expect(menu.text).toContain("请选择");
    expect(menu.text).toContain("1.");
    expect(buttonValues(menu)).toEqual(["msg:search:0", "msg:search:1"]);
    expect(store.require("search")).toMatchObject({
      phase: "pending_selection",
      candidates: [
        { kind: "title", value: "tmdb_movie_42" },
        { kind: "title", value: "tmdb_movie_99" },
      ],
    });

    const selection = job({ id: "selection", callbackData: "msg:search:0" });
    const duplicate = job({ id: "duplicate", callbackData: "msg:search:0" });
    store.seed(selection);
    store.seed(duplicate);

    const queued = await commands.handle(selection, connection);
    await commands.handle(duplicate, connection);

    expect(queued.text).toContain("已排队");
    expect(ports.enqueueCalls).toHaveLength(1);
    expect(ports.enqueueCalls[0]).toMatchObject({
      accountId: "account-a",
      messagingJobId: "search",
      storageId: "storage-a",
      request,
    });
    expect(store.require("search")).toMatchObject({
      phase: "queued",
      selectedCandidateIndex: 0,
      workflowRunId: "run-enqueued",
    });
    expect(store.require("duplicate").result).toMatchObject({ kind: "selection_expired" });
    expect(store.confirmCalls).toBe(1);
  });

  it("takes a unique request through the queued-first enqueue boundary", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const request: MessagingAcquisitionRequest = {
      titleId: "tmdb_movie_77",
      mediaType: "movie",
      seasonNumber: null,
      title: "唯一匹配",
    };
    ports.searchHandler = async () => ({ choices: [], request });
    ports.enqueueHandler = async (input) => {
      expect(await store.get(input.accountId, input.messagingJobId)).toMatchObject({
        phase: "queued",
        landingStorageId: input.storageId,
        result: {
          kind: "enqueue_request",
          request,
          storageId: input.storageId,
        },
      });
      return {
        status: "queued",
        workflowRunId: "run-enqueued",
        reused: false,
        associationCommitted: true,
      };
    };
    const commands = processor(store, ports);
    const search = job({ id: "unique-search", text: "唯一匹配" });
    store.seed(search);

    const reply = await commands.handle(search, connection);

    expect(reply.text).toContain("已排队");
    expect(ports.preEnqueuePhases).toEqual(["running"]);
    expect(ports.enqueueCalls).toHaveLength(1);
    expect(store.require("unique-search")).toMatchObject({
      phase: "queued",
      workflowRunId: "run-enqueued",
      landingStorageId: "storage-a",
    });
  });

  it("completes already-tracked enqueue results without a fabricated workflow run or failure", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    ports.searchHandler = async () => ({
      choices: [],
      request: {
        titleId: "tmdb_movie_88",
        mediaType: "movie",
        seasonNumber: null,
        title: "已经追踪",
      },
    });
    ports.enqueueHandler = async (input) => {
      expect(await store.get(input.accountId, input.messagingJobId)).toMatchObject({
        phase: "queued",
        landingStorageId: input.storageId,
      });
      return {
        status: "already_tracked",
        workflowRunId: null,
        reused: true,
        associationCommitted: true,
      };
    };
    const commands = processor(store, ports);
    const search = job({ id: "already-tracked", text: "已经追踪" });
    store.seed(search);

    const reply = await commands.handle(search, connection);

    expect(reply.text).toContain("已在追踪");
    expect(reply.text).toContain("无需重复入队");
    expect(reply.text).not.toContain("失败");
    expect(store.require("already-tracked")).toMatchObject({
      phase: "completed",
      workflowRunId: null,
      sendStatus: "pending",
      result: { kind: "already_tracked" },
    });
  });

  it("expires the previous pending menu when the private chat starts a new search", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    ports.searchHandler = async (input) => ({
      choices: [{ kind: "title", value: `title-${input.query}`, label: `${input.query} 结果` }],
    });
    const commands = processor(store, ports);
    const first = job({ id: "first-search", text: "阿凡达" });
    const second = job({ id: "second-search", text: "沙丘" });
    store.seed(first);
    store.seed(second);

    await commands.handle(first, connection);
    await commands.handle(second, connection);

    expect(store.require("first-search").phase).toBe("expired");
    expect(store.require("second-search").phase).toBe("pending_selection");
  });

  it("rejects a callback from a different private conversation", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    ports.searchHandler = async () => ({
      choices: [
        { kind: "title", value: "tmdb_movie_1", label: "作品一" },
        { kind: "title", value: "tmdb_movie_2", label: "作品二" },
      ],
    });
    const commands = processor(store, ports);
    const pending = job({ id: "chat-a-pending", text: "作品", conversationId: "chat-a" });
    const foreignCallback = job({
      id: "chat-b-callback",
      callbackData: "msg:chat-a-pending:0",
      conversationId: "chat-b",
    });
    store.seed(pending);
    store.seed(foreignCallback);
    await commands.handle(pending, connection);
    const searchCallsBefore = ports.searchCalls.length;

    const reply = await commands.handle(foreignCallback, connection);

    expect(reply.text).toContain("已经失效");
    expect(ports.searchCalls).toHaveLength(searchCallsBefore);
    expect(ports.enqueueCalls).toHaveLength(0);
    expect(store.require("chat-a-pending").phase).toBe("pending_selection");
    expect(store.require("chat-b-callback").result).toMatchObject({
      kind: "selection_expired",
    });
  });

  it("asks for a target storage after the work choice and enqueues only after that second selection", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const request: MessagingAcquisitionRequest = {
      titleId: "tmdb_tv_8",
      mediaType: "tv",
      seasonNumber: 1,
      title: "漫长季节",
    };
    ports.storages = [
      { id: "storage-a", label: "网盘 A" },
      { id: "storage-b", label: "网盘 B" },
    ];
    ports.searchHandler = async (input) => {
      expect(input.query).toBe("漫长的季节");
      return input.history.length === 0
        ? {
            choices: [
              { kind: "title", value: "tmdb_tv_8", label: "漫长的季节" },
              { kind: "title", value: "tmdb_tv_9", label: "同名作品" },
            ],
          }
        : { choices: [], request };
    };
    const commands = processor(store, ports);
    const search = job({ id: "storage-search", text: "我想看 漫长的季节" });
    const titleSelection = job({ id: "title-selection", callbackData: "msg:storage-search:0" });
    const storageSelection = job({ id: "storage-selection", callbackData: "msg:storage-search:1" });
    store.seed(search);
    store.seed(titleSelection);
    store.seed(storageSelection);

    await commands.handle(search, connection);
    const storageMenu = await commands.handle(titleSelection, connection);
    expect(storageMenu.text).toContain("请选择目标网盘");
    expect(buttonValues(storageMenu)).toEqual(["msg:storage-search:0", "msg:storage-search:1"]);
    expect(ports.enqueueCalls).toHaveLength(0);

    const queued = await commands.handle(storageSelection, connection);
    expect(queued.text).toContain("已排队");
    expect(ports.enqueueCalls).toHaveLength(1);
    expect(ports.enqueueCalls[0]).toMatchObject({ storageId: "storage-b", request });
    expect(store.require("storage-search")).toMatchObject({
      phase: "queued",
      selectedCandidateIndex: 1,
    });
  });

  it("queries only the connection account and handles queued, running, and submitted direct stops", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const commands = processor(store, ports);
    ports.queryHandler = async (accountId, id) => {
      expect(accountId).toBe("account-a");
      const tasks: readonly MessagingTaskSummary[] = [
        { id: "run-queued", title: "排队作品", status: "queued", source: "acquisition" },
        { id: "run-running", title: "运行作品", status: "running", source: "acquisition" },
        {
          id: "run-direct",
          title: "直转作品",
          status: "submitted",
          source: "direct_transfer",
          messagingJobId: "direct-job",
        },
      ];
      return id ? tasks.filter((task) => task.id === id) : tasks;
    };
    ports.stopHandler = async (_accountId, id) =>
      id === "run-queued"
        ? { taskId: id, stopped: true, reason: "queued_cancelled" }
        : { taskId: id, stopped: false, reason: "running_original" };
    const direct = job({
      id: "direct-job",
      phase: "submitted",
      workflowRunId: "run-direct",
    });
    store.seed(direct);

    const progress = job({ id: "progress", text: "查询最近任务" });
    const queuedStop = job({ id: "stop-queued", text: "停止 run-queued" });
    const runningStop = job({ id: "stop-running", text: "停止 run-running" });
    const directStop = job({ id: "stop-direct", text: "停止 run-direct" });
    store.seed(progress);
    store.seed(queuedStop);
    store.seed(runningStop);
    store.seed(directStop);

    const progressReply = await commands.handle(progress, connection);
    const queuedReply = await commands.handle(queuedStop, connection);
    const runningReply = await commands.handle(runningStop, connection);
    const directReply = await commands.handle(directStop, connection);

    expect(progressReply.text).toContain("排队作品");
    expect(progressReply.text).toContain("直转作品");
    expect(queuedReply.text).toContain("已取消");
    expect(runningReply.text).toContain("运行中");
    expect(runningReply.text).toContain("不能取消");
    expect(directReply.text).toContain("停止后续识别整理");
    expect(directReply.text).toContain("远端仍可能完成");
    expect(store.require("direct-job").stopRequested).toBe(true);
    expect(ports.stopCalls).toEqual(["run-queued", "run-running"]);
  });

  it("queries and stops a direct task reported in direct_pending", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    ports.queryHandler = async () => [
      {
        id: "run-direct-pending",
        title: "待转存作品",
        status: "direct_pending",
        source: "direct_transfer",
        activity: "待转存",
        messagingJobId: "direct-pending-job",
      },
    ];
    const commands = processor(store, ports);
    const direct = job({
      id: "direct-pending-job",
      phase: "direct_pending",
      workflowRunId: "run-direct-pending",
    });
    store.seed(direct);

    const queryReply = await commands.handle(
      job({ id: "query-direct-pending", text: "查询 run-direct-pending" }),
      connection,
    );
    expect(queryReply.text).toContain("待转存作品");
    expect(queryReply.text).toContain("状态：待转存");
    expect(queryReply.text).not.toContain("待转存 · 待转存");

    const reply = await commands.handle(
      job({ id: "stop-direct-pending", text: "停止 run-direct-pending" }),
      connection,
    );

    expect(reply.text).toContain("停止后续识别整理");
    expect(store.require("direct-pending-job").stopRequested).toBe(true);
    expect(ports.stopCalls).toHaveLength(0);
  });

  it("recognizes an existing share brand as deferred direct transfer and never runs title search", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const commands = processor(store, ports);
    const link = job({ id: "link", text: "https://115.com/s/abc123?password=good" });
    store.seed(link);

    const reply = await commands.handle(link, connection);

    expect(reply.text).toContain("115 分享链接");
    expect(reply.text).toContain("直转");
    expect(ports.searchCalls).toHaveLength(0);
    expect(ports.enqueueCalls).toHaveLength(0);
    expect(store.require("link")).toMatchObject({
      phase: "direct_pending",
      inputKind: "direct_link",
      result: { kind: "direct_link", brand: "115" },
    });
  });

  it("recognizes a Chinese-punctuated share and keeps the access code outside the URL", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    const commands = processor(store, ports);
    const link = job({
      id: "punctuated-link",
      text: "请处理：https://pan.quark.cn/s/abc123?pwd=xy99。提取码：abcd！谢谢",
    });
    store.seed(link);

    const reply = await commands.handle(link, connection);

    expect(reply.text).toContain("识别为 夸克 分享链接");
    expect(ports.searchCalls).toHaveLength(0);
    expect(store.require("punctuated-link").result).toMatchObject({
      kind: "direct_link",
      brand: "quark",
    });
  });

  it("continues a direct link after selecting an active compatible storage without TMDB search", async () => {
    const store = new MemoryStore();
    const ports = new Ports();
    ports.storages = [
      { id: "storage-115-a", label: "115 主盘" },
      { id: "storage-115-b", label: "115 备用盘" },
    ];
    const commands = processor(store, ports);
    const pending: MessagingJob = {
      ...job({ id: "direct-selection", text: "https://115.com/s/abc123?password=good", phase: "pending_selection" }),
      inputKind: "direct_link",
      candidates: [
        { kind: "storage", value: "storage-115-a", label: "115 主盘" },
        { kind: "storage", value: "storage-115-b", label: "115 备用盘" },
      ],
      result: {
        kind: "direct_link_storage_selection",
        resourceType: "115",
        resourceLinkKey: "115:abc123",
      },
    };
    const selection = job({ id: "direct-selection-callback", callbackData: "msg:direct-selection:1" });
    const duplicate = job({ id: "direct-selection-duplicate", callbackData: "msg:direct-selection:1" });
    store.seed(pending);
    store.seed(selection);
    store.seed(duplicate);

    const reply = await commands.handle(selection, connection);
    await commands.handle(duplicate, connection);

    expect(reply.text).toContain("已选择 115 备用盘");
    expect(reply.text).toContain("继续直转");
    expect(ports.searchCalls).toHaveLength(0);
    expect(ports.enqueueCalls).toHaveLength(0);
    expect(store.confirmCalls).toBe(1);
    expect(store.require("direct-selection")).toMatchObject({
      inputKind: "direct_link",
      phase: "queued",
      selectedCandidateIndex: 1,
      landingStorageId: "storage-115-b",
      result: {
        kind: "direct_link_storage_confirmed",
        storageId: "storage-115-b",
        text: expect.stringContaining("继续直转"),
      },
    });
    expect(store.require("direct-selection-callback")).toMatchObject({
      phase: "completed",
      result: { kind: "direct_link_storage_confirmed" },
    });
    expect(store.require("direct-selection-duplicate").result).toMatchObject({
      kind: "selection_expired",
    });
  });
});
