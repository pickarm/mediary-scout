import { brandOfUrl } from "@media-track/workflow";
import { extractResourceLink } from "./link-import";
import type { MessageReply, MessagingConnection } from "./types";
import type {
  MessagingCandidate,
  MessagingJob,
  MessagingJobPatch,
  MessagingJobPhase,
  MessagingResultInput,
} from "./store";

export interface MessagingAcquisitionRequest {
  titleId: string;
  mediaType: "movie" | "tv";
  seasonNumber: number | null;
  title: string;
}

export interface MessagingSearchInput {
  accountId: string;
  connectionId: string;
  conversationId: string;
  query: string;
  history: readonly MessagingCandidateHistoryEntry[];
}

export type MessagingCandidateHistoryEntry = {
  kind: "title" | "season";
  value: string;
};

export interface MessagingSearchResult {
  choices: readonly MessagingCandidate[];
  request?: MessagingAcquisitionRequest;
}

export interface MessagingStorageChoice {
  id: string;
  label: string;
}

export interface MessagingEnqueueInput {
  /**
   * The production port must first persist this request/storage and CAS the job
   * from running|queued to queued, then invoke the native queue transaction.
   * The persisted input must be sufficient to retry after a process crash.
   */
  accountId: string;
  messagingJobId: string;
  request: MessagingAcquisitionRequest;
  storageId: string;
}

export interface MessagingQueuedEnqueueResult {
  status?: "queued";
  workflowRunId: string;
  reused: boolean;
  /**
   * The production adapter returns this only after reserveWorkflowRun and the
   * messaging_jobs.workflow_run_id UPDATE committed in the same transaction.
   */
  associationCommitted: true;
}

export interface MessagingAlreadyTrackedEnqueueResult {
  status: "already_tracked";
  workflowRunId: null;
  reused: true;
  trackedSeasonId?: string;
  associationCommitted: true;
}

export type MessagingEnqueueResult =
  | MessagingQueuedEnqueueResult
  | MessagingAlreadyTrackedEnqueueResult;

export type MessagingTaskStatus =
  | "queued"
  | "running"
  | "reserved"
  | "direct_pending"
  | "submitted"
  | "transferring"
  | "verifying"
  | "identifying"
  | "organizing"
  | "succeeded"
  | "completed"
  | "partial"
  | "no_coverage"
  | "failed"
  | "stopped";

export interface MessagingTaskSummary {
  id: string;
  title: string;
  status: MessagingTaskStatus;
  source: "acquisition" | "direct_transfer";
  activity?: string;
  result?: Record<string, unknown>;
  error?: string | null;
  messagingJobId?: string;
}

export interface MessagingStopResult {
  taskId: string;
  stopped: boolean;
  reason: "queued_cancelled" | "running_original" | "finished" | "not_found";
}

/**
 * Small application ports consumed by the shared command handler. The main
 * integration owns account scoping and the original reserveWorkflowRun
 * transaction. In particular, enqueue must associate messagingJobId with the
 * reserved or reused workflow run before returning.
 */
export interface MessagingCommandPorts {
  search(input: MessagingSearchInput): Promise<MessagingSearchResult>;
  enqueue(input: MessagingEnqueueInput): Promise<MessagingEnqueueResult>;
  query(input: { accountId: string; id?: string }): Promise<readonly MessagingTaskSummary[]>;
  stop(input: { accountId: string; id: string }): Promise<MessagingStopResult>;
  listStorages(accountId: string): Promise<readonly MessagingStorageChoice[]>;
}

export interface MessagingCommandStore {
  get(accountId: string, id: string): Promise<MessagingJob | null>;
  listRecent(accountId: string, limit?: number): Promise<MessagingJob[]>;
  findLatestPending(
    accountId: string,
    connectionId: string,
    conversationId: string,
  ): Promise<MessagingJob | null>;
  expirePending(
    accountId: string,
    connectionId: string,
    conversationId: string,
    exceptJobId: string,
    now?: string,
  ): Promise<number>;
  replacePendingCandidates(
    accountId: string,
    id: string,
    candidates: readonly MessagingCandidate[],
    now?: string,
  ): Promise<boolean>;
  confirmPending(
    accountId: string,
    id: string,
    index: number,
    now?: string,
  ): Promise<boolean>;
  update(accountId: string, id: string, patch: MessagingJobPatch, now?: string): Promise<boolean>;
  saveResult(
    accountId: string,
    id: string,
    input: MessagingResultInput,
    now?: string,
  ): Promise<boolean>;
  requestStop(accountId: string, id: string, now?: string): Promise<boolean>;
}

export interface MessagingCommandProcessorOptions {
  now?: () => string;
}

/**
 * Shared rules for all three chat platforms. Transports only deliver and send;
 * this class decides help, search, selection, query, stop, and link intake.
 */
export class MessagingCommandProcessor {
  private readonly now: () => string;

  constructor(
    private readonly store: MessagingCommandStore,
    private readonly ports: MessagingCommandPorts,
    options: MessagingCommandProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async handle(job: MessagingJob, connection: MessagingConnection): Promise<MessageReply> {
    if (!jobBelongsToConnection(job, connection)) {
      return this.replyForJob(job, "这条消息不属于当前连接，已忽略。", "completed", {
        kind: "ownership_rejected",
      });
    }

    try {
      if (job.callbackData) {
        return await this.handleCallback(job, connection);
      }
      if (/^[1-9]\d*$/.test(job.text.trim())) {
        return await this.handleNumericSelection(job, connection);
      }

      const command = normalizeCommand(job.text);
      if (isHelp(command)) return await this.help(job);
      if (isIdentity(command)) return await this.identity(job, connection);
      if (isQuery(command)) return await this.query(job);
      if (isStop(command)) return await this.stop(job);

      const directLink = extractResourceLink(job.text);
      const directBrand = directLink ? brandOfUrl(directLink) : null;
      if (directBrand !== null) {
        return await this.deferDirectLink(job, directBrand);
      }

      const query = stripWatchPrefix(job.text);
      if (!query) {
        return this.replyForJob(job, "请发送片名，或使用“我想看 片名”。", "completed", {
          kind: "search_needs_title",
        });
      }
      await this.store.expirePending(
        job.accountId,
        job.connectionId,
        job.conversationId,
        job.id,
        this.now(),
      );
      return await this.continueSearch(job, connection, query, []);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store
        .update(job.accountId, job.id, { phase: "failed", error: message }, this.now())
        .catch(() => false);
      return this.replyForJob(job, `处理失败：${message}`, "failed", {
        kind: "processing_error",
      }, message);
    }
  }

  private async help(job: MessagingJob): Promise<MessageReply> {
    return this.replyForJob(
      job,
      [
        "可用命令：",
        "• 直接发送片名，或“我想看 片名”",
        "• 查询 / 查询最近任务 / 查询 任务ID",
        "• 停止 / 停止 任务ID",
        "• 帮助 / 身份",
        "也可以直接发送已支持的网盘分享链接或磁力链接。",
      ].join("\n"),
      "completed",
      { kind: "help" },
    );
  }

  private async identity(job: MessagingJob, connection: MessagingConnection): Promise<MessageReply> {
    return this.replyForJob(
      job,
      [
        `账号：${connection.accountId}`,
        `连接：${platformLabel(connection.platform)} / ${connection.id}`,
        `默认网盘：${connection.defaultStorageId ?? "未设置"}`,
      ].join("\n"),
      "completed",
      { kind: "identity", platform: connection.platform, connectionId: connection.id },
    );
  }

  private async handleCallback(job: MessagingJob, connection: MessagingConnection): Promise<MessageReply> {
    const callback = /^msg:([^:]+):(\d+)$/.exec(job.callbackData ?? "");
    if (!callback?.[1] || callback[2] === undefined) {
      return this.replyForJob(job, "这个按钮已经失效，请重新发送片名。", "completed", {
        kind: "selection_expired",
      });
    }
    const targetId = callback[1];
    const index = Number(callback[2]);
    const target = await this.store.get(connection.accountId, targetId);
    if (
      !target ||
      target.phase !== "pending_selection" ||
      target.connectionId !== connection.id ||
      target.conversationId !== job.conversationId
    ) {
      return this.replyForJob(job, "这个选项已经失效，请重新发送片名。", "completed", {
        kind: "selection_expired",
      });
    }
    return this.selectCandidate(job, target, connection, index);
  }

  private async handleNumericSelection(
    job: MessagingJob,
    connection: MessagingConnection,
  ): Promise<MessageReply> {
    const target = await this.store.findLatestPending(
      connection.accountId,
      connection.id,
      job.conversationId,
    );
    if (!target) {
      return this.replyForJob(job, "当前没有待选项目，请重新发送片名。", "completed", {
        kind: "selection_expired",
      });
    }
    return this.selectCandidate(job, target, connection, Number(job.text.trim()) - 1);
  }

  private async selectCandidate(
    sourceJob: MessagingJob,
    target: MessagingJob,
    connection: MessagingConnection,
    index: number,
  ): Promise<MessageReply> {
    const candidate = target.candidates[index];
    if (!candidate || !Number.isInteger(index) || index < 0) {
      return this.replyForJob(sourceJob, "编号无效，请按菜单中的序号重新选择。", "completed", {
        kind: "selection_invalid",
      });
    }
    if (candidate.kind === "storage") {
      if (
        target.inputKind === "direct_link" &&
        target.result?.kind === "direct_link_storage_selection"
      ) {
        return this.selectDirectLinkStorage(sourceJob, target, connection, candidate, index);
      }
      return this.selectStorage(sourceJob, target, connection, candidate, index);
    }
    const history = [
      ...(candidate.history ?? []),
      { kind: candidate.kind, value: candidate.value },
    ];
    return this.continueSearch(sourceJob, connection, stripWatchPrefix(target.text), history, {
      target,
      index,
    });
  }

  private async selectDirectLinkStorage(
    sourceJob: MessagingJob,
    target: MessagingJob,
    connection: MessagingConnection,
    selected: MessagingCandidate,
    index: number,
  ): Promise<MessageReply> {
    const activeStorages = await this.ports.listStorages(connection.accountId);
    const storage = activeStorages.find((candidate) => candidate.id === selected.value);
    if (!storage) {
      return this.replyForJob(sourceJob, "所选网盘已不可用，请重新发送链接。", "completed", {
        kind: "storage_expired",
        storageId: selected.value,
      });
    }
    const confirmed = await this.store.confirmPending(
      connection.accountId,
      target.id,
      index,
      this.now(),
    );
    if (!confirmed) {
      return this.replyForJob(sourceJob, "这个选项已经失效，请重新发送链接。", "completed", {
        kind: "selection_expired",
      });
    }
    const text = `已选择 ${storage.label}，继续直转。`;
    const result = {
      ...(target.result ?? {}),
      kind: "direct_link_storage_confirmed",
      storageId: storage.id,
      text,
    };
    await this.store.update(
      connection.accountId,
      target.id,
      {
        inputKind: "direct_link",
        phase: "queued",
        landingStorageId: storage.id,
        result,
        error: null,
        sendStatus: "pending",
      },
      this.now(),
    );
    return this.replyForJob(sourceJob, text, "completed", result);
  }

  private async continueSearch(
    job: MessagingJob,
    connection: MessagingConnection,
    query: string,
    history: readonly MessagingCandidateHistoryEntry[],
    continuation: { target: MessagingJob; index: number } | null = null,
  ): Promise<MessageReply> {
    const result = await this.ports.search({
      accountId: connection.accountId,
      connectionId: connection.id,
      conversationId: job.conversationId,
      query,
      history: [...history],
    });
    if (result.request) {
      return this.resolveStorage(job, connection, result.request, history, continuation);
    }
    const choices = result.choices.filter(
      (candidate): candidate is MessagingCandidate & { kind: "title" | "season" } =>
        candidate.kind === "title" || candidate.kind === "season",
    );
    if (choices.length === 0) {
      return this.replyForJob(job, `没有找到“${query}”的匹配作品。`, "completed", {
        kind: "search_empty",
        query,
      });
    }
    const storedChoices = choices.map(
      (choice): MessagingCandidate => ({
        ...choice,
        history: [...history],
      }),
    );
    const saved = await this.store.replacePendingCandidates(
      connection.accountId,
      job.id,
      storedChoices,
      this.now(),
    );
    if (!saved) {
      return this.replyForJob(job, "待选列表保存失败，请重新发送片名。", "failed", {
        kind: "selection_store_failed",
      });
    }
    const reply = selectionReply(job, storedChoices, "找到多个匹配项，请选择：");
    await this.saveReply(job, reply, "pending_selection", { kind: "selection_menu" });
    return reply;
  }

  private async selectStorage(
    sourceJob: MessagingJob,
    target: MessagingJob,
    connection: MessagingConnection,
    selected: MessagingCandidate,
    index: number,
  ): Promise<MessageReply> {
    const history = selected.history ?? [];
    const result = await this.ports.search({
      accountId: connection.accountId,
      connectionId: connection.id,
      conversationId: target.conversationId,
      query: stripWatchPrefix(target.text),
      history: [...history],
    });
    if (!result.request) {
      return this.replyForJob(sourceJob, "作品选择已失效，请重新发送片名。", "completed", {
        kind: "selection_expired",
      });
    }
    return this.resolveStorage(sourceJob, connection, result.request, history, {
      target,
      index,
      storageId: selected.value,
    });
  }

  private async resolveStorage(
    sourceJob: MessagingJob,
    connection: MessagingConnection,
    request: MessagingAcquisitionRequest,
    history: readonly MessagingCandidateHistoryEntry[],
    confirmation: { target: MessagingJob; index: number; storageId?: string } | null,
  ): Promise<MessageReply> {
    const target = confirmation?.target ?? null;
    const storages = await this.ports.listStorages(connection.accountId);
    if (storages.length === 0) {
      return this.replyForJob(sourceJob, "当前账号没有可用网盘，请先在巡影中添加网盘。", "failed", {
        kind: "storage_missing",
      });
    }

    let storageId = confirmation?.storageId;
    if (storageId !== undefined && !storages.some((storage) => storage.id === storageId)) {
      return this.replyForJob(sourceJob, "所选网盘已不可用，请重新发送片名。", "completed", {
        kind: "storage_expired",
      });
    }
    if (storageId === undefined) {
      const defaultStorage = connection.defaultStorageId;
      storageId =
        storages.find((storage) => storage.id === defaultStorage)?.id ??
        (storages.length === 1 ? storages[0]?.id : undefined);
    }

    if (storageId === undefined) {
      const storageChoices = storages.map(
        (storage): MessagingCandidate => ({
          kind: "storage",
          value: storage.id,
          label: storage.label,
          history: [...history],
        }),
      );
      const jobId = target?.id ?? sourceJob.id;
      const jobForMenu: MessagingJob = target ?? sourceJob;
      const saved = await this.store.replacePendingCandidates(
        connection.accountId,
        jobId,
        storageChoices,
        this.now(),
      );
      if (!saved) {
        return this.replyForJob(sourceJob, "网盘列表保存失败，请重新发送片名。", "failed", {
          kind: "storage_store_failed",
        });
      }
      const reply = selectionReply(jobForMenu, storageChoices, "请选择目标网盘：");
      await this.saveReply(sourceJob, reply, "pending_selection", { kind: "storage_menu" });
      return reply;
    }

    if (confirmation) {
      const confirmed = await this.store.confirmPending(
        connection.accountId,
        confirmation.target.id,
        confirmation.index,
        this.now(),
      );
      if (!confirmed) {
        return this.replyForJob(sourceJob, "这个选项已经失效，请重新发送片名。", "completed", {
          kind: "selection_expired",
        });
      }
    }
    return this.enqueue(target ?? sourceJob, sourceJob, request, storageId);
  }

  private async enqueue(
    associationJob: MessagingJob,
    sourceJob: MessagingJob,
    request: MessagingAcquisitionRequest,
    storageId: string,
  ): Promise<MessageReply> {
    try {
      const queued = await this.ports.enqueue({
        accountId: associationJob.accountId,
        messagingJobId: associationJob.id,
        request,
        storageId,
      });
      if (queued.status === "already_tracked") {
        const result = {
          kind: "already_tracked",
          ...(queued.trackedSeasonId === undefined
            ? {}
            : { trackedSeasonId: queued.trackedSeasonId }),
        };
        await this.store.update(
          associationJob.accountId,
          associationJob.id,
          {
            phase: "completed",
            workflowRunId: null,
            landingStorageId: storageId,
            error: null,
            result,
            sendStatus: "pending",
          },
          this.now(),
        );
        const reply: MessageReply = {
          conversationId: sourceJob.conversationId,
          text: `该作品《${request.title}》已在追踪，无需重复入队。`,
        };
        if (sourceJob.id !== associationJob.id) {
          await this.saveReply(sourceJob, reply, "completed", result);
        }
        return reply;
      }
      await this.store.update(
        associationJob.accountId,
        associationJob.id,
        {
          phase: "queued",
          landingStorageId: storageId,
          error: null,
          result: {
            kind: "acquisition_queued",
            workflowRunId: queued.workflowRunId,
            reused: queued.reused,
          },
          sendStatus: "pending",
        },
        this.now(),
      );
      const reply: MessageReply = {
        conversationId: sourceJob.conversationId,
        text:
          `已排队获取《${request.title}》。\n` +
          `任务：${queued.workflowRunId}${queued.reused ? "\n已有同作品任务，已合并关联。" : ""}`,
      };
      if (sourceJob.id !== associationJob.id) {
        await this.saveReply(sourceJob, reply, "completed", {
          kind: "acquisition_queued",
          workflowRunId: queued.workflowRunId,
        });
      }
      return reply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.update(
        associationJob.accountId,
        associationJob.id,
        { phase: "failed", error: message, sendStatus: "pending" },
        this.now(),
      );
      return {
        conversationId: sourceJob.conversationId,
        text: `排队失败：${message}`,
      };
    }
  }

  private async deferDirectLink(
    job: MessagingJob,
    brand: NonNullable<ReturnType<typeof brandOfUrl>>,
  ): Promise<MessageReply> {
    const result = { kind: "direct_link", brand };
    await this.store.update(
      job.accountId,
      job.id,
      {
        inputKind: "direct_link",
        phase: "direct_pending",
        result,
        sendStatus: "pending",
      },
      this.now(),
    );
    return {
      conversationId: job.conversationId,
      text: `已识别为 ${brandLabel(brand)} 分享链接，已登记直转，后续将异步转存并反馈结果。`,
    };
  }

  private async query(job: MessagingJob): Promise<MessageReply> {
    const id = commandArgument(job.text, ["查询", "进度", "结果", "/status"]);
    const tasks = await this.ports.query({
      accountId: job.accountId,
      ...(id ? { id } : {}),
    });
    const recentJobs = await this.store.listRecent(job.accountId);
    if (tasks.length === 0) {
      const stored = id
        ? recentJobs.find((candidate) => candidate.id === id || candidate.workflowRunId === id)
        : recentJobs.find((candidate) => candidate.result !== null);
      if (!stored?.result) {
        return this.replyForJob(
          job,
          id ? `没有找到任务 ${id}。` : "还没有可查询的任务。",
          "completed",
          { kind: "query_empty" },
        );
      }
      return this.replyForJob(job, formatStoredResult(stored), "completed", {
        kind: "query_result",
        taskId: id ?? stored.id,
      });
    }
    const lines = tasks.map(formatTaskSummary);
    return this.replyForJob(job, lines.join("\n\n"), "completed", {
      kind: "query_result",
      taskIds: tasks.map((task) => task.id),
    });
  }

  private async stop(job: MessagingJob): Promise<MessageReply> {
    let targetId = commandArgument(job.text, ["停止", "/stop"]);
    if (!targetId) {
      const latest = await this.ports.query({ accountId: job.accountId });
      targetId = latest[0]?.id ?? null;
    }
    if (!targetId) {
      return this.replyForJob(job, "没有找到可停止的任务。", "completed", {
        kind: "stop_not_found",
      });
    }

    const [summaryList, recentJobs] = await Promise.all([
      this.ports.query({ accountId: job.accountId, id: targetId }),
      this.store.listRecent(job.accountId),
    ]);
    const summary = summaryList.find((task) => task.id === targetId);
    const messagingJob =
      recentJobs.find((candidate) => candidate.workflowRunId === targetId) ??
      recentJobs.find((candidate) => candidate.id === targetId);

    if (summary?.source === "direct_transfer") {
      const directJobId = summary.messagingJobId ?? messagingJob?.id;
      if (directJobId && isDirectStopState(summary.status)) {
        await this.store.requestStop(job.accountId, directJobId, this.now());
        return this.replyForJob(
          job,
          "已设置停止后续识别整理；远端仍可能完成转存，不会删除已落盘文件。",
          "completed",
          { kind: "direct_stop_requested", taskId: targetId },
        );
      }
      return this.replyForJob(job, "该直转任务当前不能停止。", "completed", {
        kind: "direct_stop_unavailable",
        taskId: targetId,
      });
    }

    const stopped = await this.ports.stop({ accountId: job.accountId, id: targetId });
    if (stopped.reason === "queued_cancelled") {
      return this.replyForJob(job, `已取消排队任务 ${targetId}。`, "completed", {
        kind: "queued_cancelled",
        taskId: targetId,
      });
    }
    if (stopped.reason === "running_original") {
      return this.replyForJob(
        job,
        "该原获取任务运行中，现有流程不能取消；请在结果页查看进度。",
        "completed",
        { kind: "running_original", taskId: targetId },
      );
    }
    if (stopped.reason === "finished") {
      return this.replyForJob(job, "该任务已经结束，无需停止。", "completed", {
        kind: "already_finished",
        taskId: targetId,
      });
    }
    return this.replyForJob(job, `没有找到任务 ${targetId}。`, "completed", {
      kind: "stop_not_found",
      taskId: targetId,
    });
  }

  private async saveReply(
    job: MessagingJob,
    reply: MessageReply,
    phase: MessagingJobPhase,
    result: Record<string, unknown>,
    error: string | null = null,
  ): Promise<void> {
    await this.store.saveResult(
      job.accountId,
      job.id,
      { phase, result: { ...result, text: reply.text }, error, sendStatus: "pending" },
      this.now(),
    );
  }

  private async replyForJob(
    job: MessagingJob,
    text: string,
    phase: MessagingJobPhase,
    result: Record<string, unknown>,
    error: string | null = null,
  ): Promise<MessageReply> {
    const reply: MessageReply = { conversationId: job.conversationId, text };
    await this.saveReply(job, reply, phase, result, error);
    return reply;
  }
}

function jobBelongsToConnection(job: MessagingJob, connection: MessagingConnection): boolean {
  return (
    job.accountId === connection.accountId &&
    job.connectionId === connection.id &&
    job.senderId === connection.senderId
  );
}

function normalizeCommand(text: string): string {
  return text.trim().toLocaleLowerCase("zh-CN");
}

function isHelp(command: string): boolean {
  return command === "帮助" || command === "菜单" || command === "/help";
}

function isIdentity(command: string): boolean {
  return command === "身份" || command === "/id";
}

function isQuery(command: string): boolean {
  return /^(?:查询(?:最近任务)?|最近任务|进度|结果|\/status)(?:\s|$)/.test(command);
}

function isStop(command: string): boolean {
  return /^(?:停止|\/stop)(?:\s|$)/.test(command);
}

function stripWatchPrefix(text: string): string {
  return text.trim().replace(/^(?:我想看|想看)\s*[:：]?\s*/u, "").trim();
}

function commandArgument(text: string, commands: readonly string[]): string | null {
  const trimmed = text.trim();
  const command = commands.find(
    (candidate) => trimmed === candidate || trimmed.startsWith(`${candidate} `),
  );
  if (!command || trimmed === command) return null;
  const argument = trimmed.slice(command.length).trim();
  return argument || null;
}

function selectionReply(
  job: MessagingJob,
  choices: readonly MessagingCandidate[],
  heading: string,
): MessageReply {
  const lines = choices.map((choice, index) => `${index + 1}. ${choice.label}${choice.hint ? ` · ${choice.hint}` : ""}`);
  return {
    conversationId: job.conversationId,
    text: `${heading}\n${lines.join("\n")}\n\n回复序号，或点击按钮。`,
    choices: choices.map((choice, index) => ({
      label: choice.label,
      value: `msg:${job.id}:${index}`,
    })),
  };
}

function platformLabel(platform: MessagingConnection["platform"]): string {
  switch (platform) {
    case "weixin":
      return "微信";
    case "feishu":
      return "飞书";
    case "telegram":
      return "Telegram";
  }
}

function brandLabel(brand: NonNullable<ReturnType<typeof brandOfUrl>>): string {
  switch (brand) {
    case "115":
      return "115";
    case "quark":
      return "夸克";
    case "uc":
      return "UC";
    case "123":
      return "123";
    case "tianyi":
      return "天翼";
    case "guangya":
      return "光鸭";
    case "magnet":
      return "磁力";
  }
}

function formatTaskSummary(task: MessagingTaskSummary): string {
  const status = taskStatusLabel(task.status);
  const activity = task.activity?.trim();
  const error = task.error?.trim();
  const resultText =
    task.result && typeof task.result.text === "string" ? task.result.text.trim() : null;
  return [
    `${task.title}（${task.id}）`,
    `状态：${status}${activity && activity !== status ? ` · ${activity}` : ""}`,
    task.source === "direct_transfer" ? "来源：链接直转" : "来源：搜片获取",
    ...(resultText ? [`结果：${resultText}`] : []),
    ...(error ? [`错误：${error}`] : []),
  ].join("\n");
}

function formatStoredResult(job: MessagingJob): string {
  const text = typeof job.result?.text === "string" ? job.result.text : JSON.stringify(job.result);
  return `任务 ${job.workflowRunId ?? job.id}：\n${text}`;
}

function taskStatusLabel(status: MessagingTaskStatus): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "reserved":
      return "等待上映";
    case "direct_pending":
      return "待转存";
    case "submitted":
      return "已提交直转";
    case "transferring":
      return "转存中";
    case "verifying":
      return "核实中";
    case "identifying":
      return "识别中";
    case "organizing":
      return "整理中";
    case "succeeded":
    case "completed":
      return "已完成";
    case "partial":
      return "部分完成";
    case "no_coverage":
      return "未找到资源";
    case "failed":
      return "失败";
    case "stopped":
      return "已停止";
  }
}

function isDirectStopState(status: MessagingTaskStatus): boolean {
  return (
    status === "direct_pending" ||
    status === "submitted" ||
    status === "transferring" ||
    status === "verifying" ||
    status === "identifying" ||
    status === "organizing"
  );
}
