import type { Pool } from "pg";
import type { PersistedWorkflowRunSnapshot, WorkflowStatus } from "@media-track/workflow";
import { isDemoMode } from "../demo-mode";
import { getLibraryPool } from "../library-runtime";
import { isUpdateHoldActive, whileInFlight } from "../update-hold";
import { getWorkflowRepository } from "../workflow-runtime";
import {
  createMessagingApplication,
  messagingPhaseLabel,
} from "./application";
import {
  MessagingCommandProcessor,
  type MessagingCommandPorts,
  type MessagingEnqueueInput,
} from "./commands";
import { readMessagingConnections } from "./config";
import { createFeishuTransport } from "./feishu";
import {
  processLinkImport,
  type LinkImportOutcome,
} from "./link-import";
import { createLinkImportDependencies } from "./link-runtime";
import {
  PostgresMessagingStore,
  type MessagingJob,
  type MessagingJobPhase,
} from "./store";
import { createTelegramTransport } from "./telegram";
import type {
  InboundMessage,
  MessageReply,
  MessagingConnection,
  MessagingSink,
  MessagingTransport,
} from "./types";
import { createWeixinTransport } from "./weixin";

const DEFAULT_POLL_MS = 2_000;
const DIRECT_PHASES: readonly MessagingJobPhase[] = [
  "direct_pending",
  "queued",
  "submitted",
  "transferring",
  "verifying",
  "identifying",
  "organizing",
];

export interface RecoverableMessagingJobRef {
  accountId: string;
  id: string;
}

export interface MessagingWorkerRuntime {
  store: PostgresMessagingStore;
  commandProcessor: Pick<MessagingCommandProcessor, "handle">;
  application: Pick<MessagingCommandPorts, "enqueue">;
  loadConnections(): Promise<readonly MessagingConnection[]>;
  transportFor(connection: MessagingConnection): MessagingTransport;
  getWorkflowRunSnapshot(
    workflowRunId: string,
    accountId: string,
  ): Promise<PersistedWorkflowRunSnapshot | null>;
  listRecoverableJobIds(): Promise<readonly RecoverableMessagingJobRef[]>;
  processDirectLink(
    job: MessagingJob,
    connection: MessagingConnection,
    store: PostgresMessagingStore,
  ): Promise<LinkImportOutcome>;
  isUpdateHoldActive(): boolean;
  whileInFlight<T>(work: () => Promise<T>): Promise<T>;
  now(): string;
}

export interface MessagingWorker {
  tick(): Promise<void>;
  stop(): void;
}

export interface StartMessagingWorkerOptions {
  pollMs?: number;
  runtimeFactory?: () => Promise<MessagingWorkerRuntime>;
}

interface ActiveReceiver {
  controller: AbortController;
  signature: string;
  transport: MessagingTransport;
}

let workerStarted = false;
let stopStartedWorker: (() => void) | null = null;

/**
 * Start the single in-process messaging loop. Next instrumentation may call this
 * more than once; only one receiver and processing loop exists per process.
 */
export function startMessagingWorker(options: StartMessagingWorkerOptions = {}): void {
  if (
    workerStarted ||
    process.env.MEDIA_TRACK_INPROCESS_WORKER === "0" ||
    process.env.MEDIA_TRACK_REHEARSAL === "1" ||
    isDemoMode()
  ) {
    return;
  }

  workerStarted = true;
  const pollMs = Math.max(100, Math.trunc(options.pollMs ?? DEFAULT_POLL_MS));
  const runtimeFactory = options.runtimeFactory ?? createDefaultRuntime;
  let runtimePromise: Promise<MessagingWorkerRuntime> | null = null;
  let worker: MessagingWorker | null = null;
  let stopped = false;

  const tick = async (): Promise<void> => {
    if (stopped || isUpdateHoldActive(Date.now())) return;
    try {
      runtimePromise ??= runtimeFactory();
      const runtime = await runtimePromise;
      worker ??= createMessagingWorker(runtime);
      await worker.tick();
    } catch {
      if (!worker) runtimePromise = null;
      // Keep polling after a transient database or network failure. Never include
      // connection objects in worker logs; they contain platform credentials.
      console.error("[messaging-worker] tick failed");
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, pollMs);
  timer.unref?.();
  stopStartedWorker = () => {
    stopped = true;
    clearInterval(timer);
    worker?.stop();
  };
  void tick();
}

/** Test-only: release the singleton guard and stop its timer. */
export function __resetMessagingWorkerForTests(): void {
  stopStartedWorker?.();
  stopStartedWorker = null;
  workerStarted = false;
}

export function createMessagingWorker(runtime: MessagingWorkerRuntime): MessagingWorker {
  const activeReceivers = new Map<string, ActiveReceiver>();
  const knownConnections = new Map<string, MessagingConnection>();
  const directInFlight = new Map<string, Promise<void>>();
  let running = false;
  let stopped = false;

  const connectionKey = (connection: Pick<MessagingConnection, "accountId" | "id">): string =>
    `${connection.accountId}\u0000${connection.id}`;

  const currentConnection = (job: MessagingJob): MessagingConnection | null =>
    knownConnections.get(`${job.accountId}\u0000${job.connectionId}`) ?? null;

  const recordJobError = async (
    job: Pick<MessagingJob, "accountId" | "id"> & Partial<Pick<MessagingJob, "connectionId">>,
    error: unknown,
  ): Promise<void> => {
    const connection = job.connectionId
      ? knownConnections.get(`${job.accountId}\u0000${job.connectionId}`) ?? null
      : null;
    const message = safeErrorMessage(error, connection);
    await runtime.store
      .update(job.accountId, job.id, { error: message }, runtime.now())
      .catch(() => false);
  };

  const refreshConnections = async (): Promise<void> => {
    const loaded = await runtime.loadConnections();
    const next = new Map<string, MessagingConnection>();
    for (const connection of loaded) next.set(connectionKey(connection), connection);

    for (const [key, receiver] of activeReceivers) {
      const nextConnection = next.get(key);
      if (
        !nextConnection ||
        !nextConnection.enabled ||
        receiver.signature !== connectionSignature(nextConnection)
      ) {
        receiver.controller.abort();
        activeReceivers.delete(key);
      }
    }

    knownConnections.clear();
    for (const [key, connection] of next) knownConnections.set(key, connection);

    for (const [key, connection] of next) {
      if (!connection.enabled || activeReceivers.has(key)) continue;
      const transport = runtime.transportFor(connection);
      const controller = new AbortController();
      const signature = connectionSignature(connection);
      const receiver: ActiveReceiver = { controller, signature, transport };
      activeReceivers.set(key, receiver);
      const sink: MessagingSink = {
        loadCursor: (connectionId) => runtime.store.loadCursor(connectionId),
        accept: async (messages, cursor) => {
          await runtime.store.accept(connection, messages, cursor);
        },
      };
      void transport
        .start(connection, sink, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (activeReceivers.get(key) === receiver) activeReceivers.delete(key);
        });
    }
  };

  const sendReply = async (
    job: MessagingJob,
    connection: MessagingConnection,
    reply: MessageReply,
    targetIds: readonly string[],
  ): Promise<boolean> => {
    const replyToken =
      connection.platform === "weixin"
        ? await runtime.store.loadLatestReplyToken(
            connection.accountId,
            connection.id,
            job.conversationId,
          )
        : null;
    const outbound: MessageReply = {
      ...reply,
      ...(replyToken ? { replyToken } : {}),
    };
    const active = activeReceivers.get(connectionKey(connection));
    const transport =
      active?.signature === connectionSignature(connection)
        ? active.transport
        : runtime.transportFor(connection);
    try {
      await transport.send(connection, outbound);
      await Promise.all(
        [...new Set(targetIds)].map((id) =>
          runtime.store.update(connection.accountId, id, { sendStatus: "sent" }),
        ),
      );
      return true;
    } catch (error) {
      const message = safeErrorMessage(error, connection);
      await Promise.all(
        [...new Set(targetIds)].map((id) =>
          runtime.store.update(connection.accountId, id, {
            sendStatus: "failed",
            error: message,
          }),
        ),
      );
      return false;
    }
  };

  const storedReply = (job: MessagingJob): MessageReply | null => {
    const text = stringField(job.result?.["text"]);
    if (!text) return null;
    return {
      conversationId: job.conversationId,
      text,
      ...(job.candidates.length > 0
        ? {
            choices: job.candidates.map((choice, index) => ({
              label: choice.label,
              value: `msg:${job.id}:${index}`,
            })),
          }
        : {}),
    };
  };

  const replyTargetsBeforeHandling = async (job: MessagingJob): Promise<string[]> => {
    const ids = new Set<string>([job.id]);
    const callbackTarget = /^msg:([^:]+):\d+$/.exec(job.callbackData ?? "")?.[1];
    if (callbackTarget) ids.add(callbackTarget);
    if (/^[1-9]\d*$/.test(job.text.trim())) {
      const pending = await runtime.store.findLatestPending(
        job.accountId,
        job.connectionId,
        job.conversationId,
      );
      if (pending) ids.add(pending.id);
    }
    return [...ids];
  };

  const handleCommand = async (
    job: MessagingJob,
    connection: MessagingConnection,
  ): Promise<void> => {
    const targetIds = await replyTargetsBeforeHandling(job);
    const commandConnection = { ...connection, enabled: true };
    const reply = await runtime.commandProcessor.handle(job, commandConnection);
    await sendReply(job, commandConnection, reply, targetIds);
  };

  const handleDirect = async (
    job: MessagingJob,
    connection: MessagingConnection,
  ): Promise<void> => {
    const outcome = await runtime.processDirectLink(job, connection, runtime.store);
    const current = await runtime.store.get(job.accountId, job.id);
    if (!current) return;
    const senderConnection = currentConnection(job);
    if (!senderConnection) {
      await runtime.store.update(
        job.accountId,
        job.id,
        {
          sendStatus: "failed",
          error: "消息连接已解除，结果已保留但无法发送。",
        },
        runtime.now(),
      );
      return;
    }
    const unchanged =
      job.phase === outcome.phase &&
      stringField(job.result?.["text"]) === outcome.text &&
      stringField(job.result?.["stage"]) === stringField(outcome.result["stage"]);
    if (unchanged) {
      if (current.sendStatus !== job.sendStatus) {
        await runtime.store.update(
          job.accountId,
          job.id,
          { sendStatus: job.sendStatus },
          runtime.now(),
        );
      }
      return;
    }
    if (current.phase !== outcome.phase || current.result?.["text"] !== outcome.text) {
      await runtime.store.saveResult(
        job.accountId,
        job.id,
        {
          phase: outcome.phase,
          result: outcome.result,
          error: current.error,
          sendStatus: "pending",
        },
        runtime.now(),
      );
    } else {
      await runtime.store.update(
        job.accountId,
        job.id,
        { sendStatus: "pending" },
        runtime.now(),
      );
    }
    const reply: MessageReply = {
      conversationId: job.conversationId,
      text: outcome.text,
      ...(outcome.choices
        ? {
            choices: outcome.choices.map((choice, index) => ({
              label: choice.label,
              value: `msg:${job.id}:${index}`,
            })),
          }
        : {}),
    };
    await sendReply(job, { ...senderConnection, enabled: true }, reply, [job.id]);
  };

  const launchDirect = (job: MessagingJob, connection: MessagingConnection): void => {
    const key = `${job.accountId}\u0000${job.id}`;
    if (directInFlight.has(key)) return;
    const work = runtime
      .whileInFlight(() => handleDirect(job, connection))
      .catch(async (error: unknown) => {
        // Preserve the external-transfer receipt and retry the same durable phase.
        await recordJobError(job, error);
      })
      .finally(() => {
        directInFlight.delete(key);
      });
    directInFlight.set(key, work);
  };

  const pollNativeRun = async (
    job: MessagingJob,
    connection: MessagingConnection,
  ): Promise<void> => {
    if (!job.workflowRunId) return;
    const snapshot = await runtime.getWorkflowRunSnapshot(
      job.workflowRunId,
      job.accountId,
    );
    if (!snapshot) {
      const text = "原获取任务已取消或已移除";
      const result = {
        kind: "acquisition_stopped",
        workflowRunId: job.workflowRunId,
        status: "stopped",
        text,
      };
      await runtime.store.update(
        job.accountId,
        job.id,
        {
          phase: "stopped",
          result,
          error: null,
          sendStatus: "pending",
          stopRequested: true,
        },
        runtime.now(),
      );
      await sendReply(
        job,
        { ...connection, enabled: true },
        { conversationId: job.conversationId, text },
        [job.id],
      );
      return;
    }
    if (!isTerminalWorkflowStatus(snapshot.workflowRun.status)) return;

    const text = terminalText(snapshot);
    const phase: MessagingJobPhase =
      snapshot.workflowRun.status === "succeeded"
        ? "completed"
        : snapshot.workflowRun.status === "partial"
          ? "partial"
          : "failed";
    const result = {
      kind: "acquisition_result",
      workflowRunId: job.workflowRunId,
      status: snapshot.workflowRun.status,
      activity: messagingPhaseLabel(snapshot.workflowRun.status),
      text,
    };
    await runtime.store.saveResult(
      job.accountId,
      job.id,
      {
        phase,
        result,
        error:
          snapshot.workflowRun.status === "succeeded" ||
          snapshot.workflowRun.status === "partial"
            ? null
            : text,
        sendStatus: "pending",
      },
      runtime.now(),
    );
    await sendReply(
      job,
      { ...connection, enabled: true },
      { conversationId: job.conversationId, text },
      [job.id],
    );
  };

  const recoverEnqueue = async (
    job: MessagingJob,
    connection: MessagingConnection,
  ): Promise<void> => {
    const input = acquisitionEnqueueInput(job);
    if (!input) {
      await handleCommand(job, connection);
      return;
    }
    const queued = await runtime.application.enqueue(input);
    if (queued.status === "already_tracked") {
      const result = {
        kind: "already_tracked",
        text: `该作品《${input.request.title}》已在追踪，无需重复入队。`,
      };
      await runtime.store.saveResult(
        job.accountId,
        job.id,
        {
          phase: "completed",
          result,
          error: null,
          sendStatus: "pending",
        },
        runtime.now(),
      );
      await sendReply(
        job,
        { ...connection, enabled: true },
        { conversationId: job.conversationId, text: result.text },
        [job.id],
      );
      return;
    }

    const result = {
      kind: "acquisition_queued",
      workflowRunId: queued.workflowRunId,
      reused: queued.reused,
      text: `已恢复排队获取《${input.request.title}》。\n任务：${queued.workflowRunId}`,
    };
    await runtime.store.update(
      job.accountId,
      job.id,
      {
        phase: "queued",
        workflowRunId: queued.workflowRunId,
        landingStorageId: input.storageId,
        result,
        error: null,
        sendStatus: "pending",
      },
      runtime.now(),
    );
    await sendReply(
      job,
      { ...connection, enabled: true },
      { conversationId: job.conversationId, text: result.text },
      [job.id],
    );
  };

  const connectionUnavailable = async (job: MessagingJob): Promise<void> => {
    await runtime.store.update(
      job.accountId,
      job.id,
      {
        ...(job.phase === "received" || job.phase === "running"
          ? { phase: "failed" as const }
          : {}),
        error: "消息连接已解除，无法发送或处理。",
        sendStatus: "failed",
      },
      runtime.now(),
    );
  };

  const recoverJob = async (job: MessagingJob): Promise<void> => {
    const connection = currentConnection(job);
    if (!connection) {
      await connectionUnavailable(job);
      return;
    }

    const reply = storedReply(job);
    if (job.sendStatus === "pending" && reply) {
      await sendReply(job, { ...connection, enabled: true }, reply, [job.id]);
      return;
    }

    if (job.inputKind === "direct_link") {
      if (job.phase === "pending_selection") return;
      if (DIRECT_PHASES.includes(job.phase)) {
        launchDirect(job, connection);
      }
      return;
    }

    if (job.phase === "running") {
      await handleCommand(job, connection);
      return;
    }
    if (job.phase !== "queued") return;
    if (job.workflowRunId) {
      await pollNativeRun(job, connection);
      return;
    }
    await recoverEnqueue(job, connection);
  };

  const tick = async (): Promise<void> => {
    if (stopped || running || runtime.isUpdateHoldActive()) return;
    running = true;
    try {
      await runtime.whileInFlight(async () => {
        if (runtime.isUpdateHoldActive()) return;
        await refreshConnections();
        const recoverable = await runtime.listRecoverableJobIds();
        for (const ref of recoverable) {
          try {
            const job = await runtime.store.get(ref.accountId, ref.id);
            if (job) await recoverJob(job);
          } catch (error) {
            await recordJobError(ref, error);
          }
        }
        for (;;) {
          const job = await runtime.store.claimNext();
          if (!job) break;
          const connection = currentConnection(job);
          if (!connection) {
            try {
              await connectionUnavailable(job);
            } catch (error) {
              await recordJobError(job, error);
            }
            continue;
          }
          try {
            await handleCommand(job, connection);
          } catch (error) {
            await recordJobError(job, error);
          }
        }
      });
    } finally {
      running = false;
    }
  };

  return {
    tick,
    stop() {
      stopped = true;
      for (const receiver of activeReceivers.values()) receiver.controller.abort();
      activeReceivers.clear();
    },
  };
}

export async function listRecoverableMessagingJobIds(
  pool: Pick<Pool, "query">,
): Promise<RecoverableMessagingJobRef[]> {
  const result = await pool.query<{ account_id: string; id: string }>(
    `SELECT account_id, id
     FROM messaging_jobs
     WHERE phase = 'running'
        OR (phase = 'queued' AND input_kind <> 'direct_link')
        OR (input_kind = 'direct_link' AND phase IN (
          'direct_pending','queued','submitted','transferring',
          'verifying','identifying','organizing'
        ))
        OR (send_status = 'pending' AND result->>'text' IS NOT NULL)
     ORDER BY created_at ASC, id ASC`,
  );
  return result.rows.map((row) => ({ accountId: row.account_id, id: row.id }));
}

async function createDefaultRuntime(): Promise<MessagingWorkerRuntime> {
  const pool = getLibraryPool();
  const store = new PostgresMessagingStore(pool);
  await store.ensureSchema();
  const repository = getWorkflowRepository();
  const application = createMessagingApplication(store);
  return {
    store,
    commandProcessor: new MessagingCommandProcessor(store, application),
    application,
    loadConnections: async () => {
      const accounts = new Set([
        "acct_default",
        ...(await repository.listAccounts()).map((account) => account.id),
      ]);
      const connections: MessagingConnection[] = [];
      for (const accountId of accounts) {
        connections.push(...(await readMessagingConnections(accountId, repository)));
      }
      return connections;
    },
    transportFor: (connection) => {
      switch (connection.platform) {
        case "weixin":
          return createWeixinTransport();
        case "feishu":
          return createFeishuTransport();
        case "telegram":
          return createTelegramTransport();
      }
    },
    getWorkflowRunSnapshot: (workflowRunId, accountId) =>
      repository.getWorkflowRunSnapshot(workflowRunId, accountId),
    listRecoverableJobIds: () => listRecoverableMessagingJobIds(pool),
    processDirectLink: (job, connection, directStore) =>
      processLinkImport(job, connection, createLinkImportDependencies(directStore)),
    isUpdateHoldActive: () => isUpdateHoldActive(Date.now()),
    whileInFlight,
    now: () => new Date().toISOString(),
  };
}

function connectionSignature(connection: MessagingConnection): string {
  return JSON.stringify(connection);
}

function safeErrorMessage(
  error: unknown,
  connection: Pick<MessagingConnection, "credentials"> | null,
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of Object.values(connection?.credentials ?? {})) {
    if (credential) message = message.split(credential).join("[redacted]");
  }
  return message;
}

function acquisitionEnqueueInput(job: MessagingJob): MessagingEnqueueInput | null {
  if (job.result?.["kind"] !== "acquisition_request") return null;
  const request = job.result["request"];
  const storageId = job.result["storageId"];
  if (typeof request !== "object" || request === null || typeof storageId !== "string") {
    return null;
  }
  const value = request as Record<string, unknown>;
  if (
    typeof value["titleId"] !== "string" ||
    (value["mediaType"] !== "movie" && value["mediaType"] !== "tv") ||
    (value["seasonNumber"] !== null && typeof value["seasonNumber"] !== "number") ||
    typeof value["title"] !== "string"
  ) {
    return null;
  }
  return {
    accountId: job.accountId,
    messagingJobId: job.id,
    request: {
      titleId: value["titleId"],
      mediaType: value["mediaType"],
      seasonNumber: value["seasonNumber"],
      title: value["title"],
    },
    storageId,
  };
}

function isTerminalWorkflowStatus(status: WorkflowStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "partial" ||
    status === "no_coverage"
  );
}

function terminalText(snapshot: PersistedWorkflowRunSnapshot): string {
  const notification = [...snapshot.notifications]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (notification?.body.trim()) return notification.body.trim();
  const title = snapshot.title.title;
  const status = snapshot.workflowRun.status;
  if (status === "succeeded") return `《${title}》已完成获取。`;
  if (status === "partial") return `《${title}》已部分完成，请在任务中查看结果。`;
  if (status === "no_coverage") return `《${title}》暂未找到可用资源。`;
  return `《${title}》获取失败。`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
