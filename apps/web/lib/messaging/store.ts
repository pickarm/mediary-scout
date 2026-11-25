import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { InboundMessage, MessagingConnection } from "./types.js";

export type MessagingJobPhase =
  | "received"
  | "running"
  | "pending_selection"
  | "expired"
  | "direct_pending"
  | "queued"
  | "submitted"
  | "transferring"
  | "verifying"
  | "identifying"
  | "organizing"
  | "completed"
  | "partial"
  | "failed"
  | "stopped";

export type MessagingInputKind = "text" | "selection" | "direct_link";
export type MessagingSendStatus = "not_applicable" | "pending" | "sent" | "failed";
export type MessagingCandidateKind = "title" | "season" | "storage";

export interface MessagingCandidate {
  kind: MessagingCandidateKind;
  value: string;
  label: string;
  hint?: string;
  history?: readonly { kind: "title" | "season"; value: string }[];
}

export interface MessagingJob {
  id: string;
  connectionId: string;
  accountId: string;
  platform: MessagingConnection["platform"];
  platformMessageId: string;
  conversationId: string;
  senderId: string;
  text: string;
  callbackData: string | null;
  replyToken: string | null;
  inputKind: MessagingInputKind;
  phase: MessagingJobPhase;
  candidates: readonly MessagingCandidate[];
  selectedCandidateIndex: number | null;
  workflowRunId: string | null;
  scanTaskId: string | null;
  organizationKey: string | null;
  landingStorageId: string | null;
  landingDirectoryId: string | null;
  receipt: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  sendStatus: MessagingSendStatus;
  stopRequested: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MessagingJobPatch {
  inputKind?: MessagingInputKind;
  phase?: MessagingJobPhase;
  workflowRunId?: string | null;
  scanTaskId?: string | null;
  organizationKey?: string | null;
  landingStorageId?: string | null;
  landingDirectoryId?: string | null;
  receipt?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  sendStatus?: MessagingSendStatus;
  stopRequested?: boolean;
}

export interface MessagingResultInput {
  phase: MessagingJobPhase;
  result: Record<string, unknown>;
  error?: string | null;
  sendStatus: MessagingSendStatus;
}

export interface PostgresMessagingStoreOptions {
  now?: () => string;
  idFactory?: () => string;
}

/**
 * Durable inbox and command state. `accept` deliberately takes the trusted
 * connection object: account ownership and the self-sender filter must never be
 * inferred from untrusted chat text.
 */
export class PostgresMessagingStore {
  private schemaPromise: Promise<void> | null = null;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(
    private readonly pool: Pool,
    options: PostgresMessagingStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async ensureSchema(): Promise<void> {
    this.schemaPromise ??= this.createSchema().catch((error: unknown) => {
      this.schemaPromise = null;
      throw error;
    });
    await this.schemaPromise;
  }

  async loadCursor(connectionId: string): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ value: string }>(
      "SELECT value FROM account_settings WHERE key = $1 ORDER BY account_id LIMIT 1",
      [messagingCursorKey(connectionId)],
    );
    return result.rows[0]?.value ?? null;
  }

  /**
   * Persist only messages sent by the configured owner through this exact
   * connection. The cursor advances in the same transaction as the batch, which
   * lets the transport acknowledge only after both writes commit.
   */
  async accept(
    connection: MessagingConnection,
    messages: readonly InboundMessage[],
    cursor?: string,
  ): Promise<MessagingJob[]> {
    await this.ensureSchema();
    const now = this.now();
    const acceptedMessages = messages.filter((message) => messageBelongsToConnection(message, connection));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const accepted: MessagingJob[] = [];
      for (const message of acceptedMessages) {
        const inserted = await client.query<MessagingJobRow>(
          `INSERT INTO messaging_jobs (
             id, connection_id, platform_message_id, account_id, platform,
             conversation_id, sender_id, text, callback_data, reply_token, input_kind,
             phase, candidates, selected_candidate_index, workflow_run_id,
             scan_task_id, organization_key, landing_storage_id,
             landing_directory_id, receipt, result, error, send_status,
             stop_requested, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             'received','[]'::jsonb,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,
             'not_applicable',false,$12,$12
           )
           ON CONFLICT (connection_id, platform_message_id) DO NOTHING
           RETURNING *`,
          [
            this.idFactory(),
            connection.id,
            message.messageId,
            connection.accountId,
            connection.platform,
            message.conversationId,
            message.senderId,
            message.text,
            message.callbackData ?? null,
            connection.platform === "weixin" ? message.replyToken ?? null : null,
            message.callbackData === undefined ? "text" : "selection",
            now,
          ],
        );
        const row = inserted.rows[0];
        if (row) accepted.push(messagingJobFromRow(row));
      }

      if (cursor !== undefined) {
        await client.query(
          `INSERT INTO account_settings (account_id, key, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id, key) DO UPDATE SET value = EXCLUDED.value`,
          [connection.accountId, messagingCursorKey(connection.id), cursor],
        );
      }
      await client.query("COMMIT");
      return accepted;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(): Promise<MessagingJob | null> {
    await this.ensureSchema();
    const result = await this.pool.query<MessagingJobRow>(
      `WITH next_job AS (
         SELECT id
         FROM messaging_jobs
         WHERE phase = 'received'
         ORDER BY created_at ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE messaging_jobs AS job
       SET phase = 'running', updated_at = $1
       FROM next_job
       WHERE job.id = next_job.id
       RETURNING job.*`,
      [this.now()],
    );
    const row = result.rows[0];
    return row ? messagingJobFromRow(row) : null;
  }

  async get(accountId: string, id: string): Promise<MessagingJob | null> {
    await this.ensureSchema();
    const result = await this.pool.query<MessagingJobRow>(
      "SELECT * FROM messaging_jobs WHERE account_id = $1 AND id = $2",
      [accountId, id],
    );
    const row = result.rows[0];
    return row ? messagingJobFromRow(row) : null;
  }

  async listRecent(accountId: string, limit = 20): Promise<MessagingJob[]> {
    await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query<MessagingJobRow>(
      `SELECT * FROM messaging_jobs
       WHERE account_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [accountId, safeLimit],
    );
    return result.rows.map(messagingJobFromRow);
  }

  async findLatestPending(
    accountId: string,
    connectionId: string,
    conversationId: string,
  ): Promise<MessagingJob | null> {
    await this.ensureSchema();
    const result = await this.pool.query<MessagingJobRow>(
      `SELECT * FROM messaging_jobs
       WHERE account_id = $1
         AND connection_id = $2
         AND conversation_id = $3
         AND phase = 'pending_selection'
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [accountId, connectionId, conversationId],
    );
    const row = result.rows[0];
    return row ? messagingJobFromRow(row) : null;
  }

  /** Newest inbound context token in this account-owned private conversation. */
  async loadLatestReplyToken(
    accountId: string,
    connectionId: string,
    conversationId: string,
  ): Promise<string | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ reply_token: string }>(
      `SELECT reply_token
       FROM messaging_jobs
       WHERE account_id = $1
         AND connection_id = $2
         AND conversation_id = $3
         AND reply_token IS NOT NULL
       ORDER BY received_seq DESC
       LIMIT 1`,
      [accountId, connectionId, conversationId],
    );
    return result.rows[0]?.reply_token ?? null;
  }

  async expirePending(
    accountId: string,
    connectionId: string,
    conversationId: string,
    exceptJobId: string,
    now: string = this.now(),
  ): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE messaging_jobs
       SET phase = 'expired', updated_at = $5
       WHERE account_id = $1
         AND connection_id = $2
         AND conversation_id = $3
         AND id <> $4
         AND phase = 'pending_selection'`,
      [accountId, connectionId, conversationId, exceptJobId, now],
    );
    return result.rowCount ?? 0;
  }

  async replacePendingCandidates(
    accountId: string,
    id: string,
    candidates: readonly MessagingCandidate[],
    now: string = this.now(),
  ): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Pick<MessagingJobRow, "connection_id" | "conversation_id">>(
        `SELECT connection_id, conversation_id
         FROM messaging_jobs
         WHERE account_id = $1 AND id = $2
         FOR UPDATE`,
        [accountId, id],
      );
      const row = current.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE messaging_jobs
         SET phase = 'expired', updated_at = $5
         WHERE account_id = $1
           AND connection_id = $2
           AND conversation_id = $3
           AND id <> $4
           AND phase = 'pending_selection'`,
        [accountId, row.connection_id, row.conversation_id, id, now],
      );
      await client.query(
        `UPDATE messaging_jobs
         SET phase = 'pending_selection',
             candidates = $3::jsonb,
             selected_candidate_index = NULL,
             updated_at = $4
         WHERE account_id = $1 AND id = $2`,
        [accountId, id, JSON.stringify(candidates), now],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async confirmPending(
    accountId: string,
    id: string,
    index: number,
    now: string = this.now(),
  ): Promise<boolean> {
    await this.ensureSchema();
    if (!Number.isInteger(index) || index < 0) return false;
    const result = await this.pool.query(
      `UPDATE messaging_jobs
       SET phase = 'queued', selected_candidate_index = $3, updated_at = $4
       WHERE account_id = $1
         AND id = $2
         AND phase = 'pending_selection'
         AND jsonb_array_length(candidates) > $3
       RETURNING id`,
      [accountId, id, index, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async update(
    accountId: string,
    id: string,
    patch: MessagingJobPatch,
    now: string = this.now(),
  ): Promise<boolean> {
    await this.ensureSchema();
    const assignments: string[] = [];
    const values: unknown[] = [accountId, id];
    const append = (column: string, value: unknown, cast = ""): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}${cast}`);
    };

    if (patch.inputKind !== undefined) append("input_kind", patch.inputKind);
    if (patch.phase !== undefined) append("phase", patch.phase);
    if (patch.workflowRunId !== undefined) append("workflow_run_id", patch.workflowRunId);
    if (patch.scanTaskId !== undefined) append("scan_task_id", patch.scanTaskId);
    if (patch.organizationKey !== undefined) append("organization_key", patch.organizationKey);
    if (patch.landingStorageId !== undefined) append("landing_storage_id", patch.landingStorageId);
    if (patch.landingDirectoryId !== undefined) append("landing_directory_id", patch.landingDirectoryId);
    if (patch.receipt !== undefined) append("receipt", patch.receipt === null ? null : JSON.stringify(patch.receipt), "::jsonb");
    if (patch.result !== undefined) append("result", patch.result === null ? null : JSON.stringify(patch.result), "::jsonb");
    if (patch.error !== undefined) append("error", patch.error);
    if (patch.sendStatus !== undefined) append("send_status", patch.sendStatus);
    if (patch.stopRequested !== undefined) append("stop_requested", patch.stopRequested);
    if (assignments.length === 0) {
      const found = await this.pool.query("SELECT 1 FROM messaging_jobs WHERE account_id = $1 AND id = $2", [
        accountId,
        id,
      ]);
      return (found.rowCount ?? 0) === 1;
    }
    values.push(now);
    assignments.push(`updated_at = $${values.length}`);
    const result = await this.pool.query(
      `UPDATE messaging_jobs
       SET ${assignments.join(", ")}
       WHERE account_id = $1 AND id = $2
       RETURNING id`,
      values,
    );
    return (result.rowCount ?? 0) === 1;
  }

  async saveResult(
    accountId: string,
    id: string,
    input: MessagingResultInput,
    now: string = this.now(),
  ): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE messaging_jobs
       SET phase = $3,
           result = $4::jsonb,
           error = $5,
           send_status = $6,
           updated_at = $7
       WHERE account_id = $1 AND id = $2
       RETURNING id`,
      [accountId, id, input.phase, JSON.stringify(input.result), input.error ?? null, input.sendStatus, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async requestStop(accountId: string, id: string, now: string = this.now()): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE messaging_jobs
       SET stop_requested = true, updated_at = $3
       WHERE account_id = $1 AND id = $2
       RETURNING id`,
      [accountId, id, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS messaging_jobs (
        id text PRIMARY KEY,
        connection_id text NOT NULL,
        platform_message_id text NOT NULL,
        account_id text NOT NULL,
        platform text NOT NULL,
        conversation_id text NOT NULL,
        sender_id text NOT NULL,
        text text NOT NULL,
        callback_data text,
        reply_token text,
        input_kind text NOT NULL,
        phase text NOT NULL,
        candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
        selected_candidate_index integer,
        workflow_run_id text,
        scan_task_id text,
        organization_key text,
        landing_storage_id text,
        landing_directory_id text,
        receipt jsonb,
        result jsonb,
        error text,
        send_status text NOT NULL,
        stop_requested boolean NOT NULL DEFAULT false,
        received_seq bigint GENERATED ALWAYS AS IDENTITY,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        UNIQUE(connection_id, platform_message_id)
      );
      CREATE INDEX IF NOT EXISTS messaging_jobs_claim_idx
        ON messaging_jobs(phase, created_at, id);
      CREATE INDEX IF NOT EXISTS messaging_jobs_account_recent_idx
        ON messaging_jobs(account_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS messaging_jobs_pending_chat_idx
        ON messaging_jobs(account_id, connection_id, conversation_id, phase, created_at DESC);
    `);
  }
}

export function messagingCursorKey(connectionId: string): string {
  return `messaging.cursor:${connectionId}`;
}

interface MessagingJobRow {
  id: string;
  connection_id: string;
  platform_message_id: string;
  account_id: string;
  platform: MessagingConnection["platform"];
  conversation_id: string;
  sender_id: string;
  text: string;
  callback_data: string | null;
  reply_token: string | null;
  input_kind: MessagingInputKind;
  phase: MessagingJobPhase;
  candidates: unknown;
  selected_candidate_index: number | null;
  workflow_run_id: string | null;
  scan_task_id: string | null;
  organization_key: string | null;
  landing_storage_id: string | null;
  landing_directory_id: string | null;
  receipt: unknown;
  result: unknown;
  error: string | null;
  send_status: MessagingSendStatus;
  stop_requested: boolean;
  created_at: string;
  updated_at: string;
}

function messageBelongsToConnection(
  message: InboundMessage,
  connection: MessagingConnection,
): boolean {
  return (
    message.connectionId === connection.id &&
    message.platform === connection.platform &&
    message.botId === connection.botId &&
    message.senderId === connection.senderId
  );
}

function messagingJobFromRow(row: MessagingJobRow): MessagingJob {
  return {
    id: row.id,
    connectionId: row.connection_id,
    accountId: row.account_id,
    platform: row.platform,
    platformMessageId: row.platform_message_id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    text: row.text,
    callbackData: row.callback_data,
    replyToken: row.reply_token,
    inputKind: row.input_kind,
    phase: row.phase,
    candidates: candidatesFromJson(row.candidates),
    selectedCandidateIndex: row.selected_candidate_index,
    workflowRunId: row.workflow_run_id,
    scanTaskId: row.scan_task_id,
    organizationKey: row.organization_key,
    landingStorageId: row.landing_storage_id,
    landingDirectoryId: row.landing_directory_id,
    receipt: objectFromJson(row.receipt),
    result: objectFromJson(row.result),
    error: row.error,
    sendStatus: row.send_status,
    stopRequested: row.stop_requested,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function objectFromJson(value: unknown): Record<string, unknown> | null {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

function candidatesFromJson(value: unknown): MessagingCandidate[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): MessagingCandidate[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const candidate = entry as Record<string, unknown>;
    if (
      (candidate.kind !== "title" && candidate.kind !== "season" && candidate.kind !== "storage") ||
      typeof candidate.value !== "string" ||
      typeof candidate.label !== "string"
    ) {
      return [];
    }
    const history = Array.isArray(candidate.history)
      ? candidate.history.flatMap((item): { kind: "title" | "season"; value: string }[] => {
          if (typeof item !== "object" || item === null) return [];
          const selection = item as Record<string, unknown>;
          if (
            (selection.kind !== "title" && selection.kind !== "season") ||
            typeof selection.value !== "string"
          ) {
            return [];
          }
          return [{ kind: selection.kind, value: selection.value }];
        })
      : undefined;
    return [
      {
        kind: candidate.kind,
        value: candidate.value,
        label: candidate.label,
        ...(typeof candidate.hint === "string" ? { hint: candidate.hint } : {}),
        ...(history === undefined ? {} : { history }),
      },
    ];
  });
}
