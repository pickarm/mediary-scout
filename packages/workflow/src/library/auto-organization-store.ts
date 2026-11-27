import type { Pool, PoolClient } from "pg";
import { STORAGE_BRANDS } from "../storage-brands.js";
import { LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY, PostgresScanStore } from "./scan-store.js";
import { PostgresIdentificationStore } from "./identification-store.js";
import { PostgresLibraryStore } from "./store.js";
import { PostgresOrganizationStore } from "./organization-store.js";
import { PostgresOrganizedIndexStore } from "./organized-index-store.js";
import { computeNamingTemplatesFingerprint, type OrganizationScope } from "./organizer.js";
import type { NamingTemplateKind } from "./naming.js";
import type {
  AutoOrganizationBatch,
  AutoOrganizationCandidate,
  AutoOrganizationCheckpoint,
  AutoOrganizationStore,
  AutoOrganizationTaskStatus,
} from "./auto-organization.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_auto_organization_tasks (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  task_id text NOT NULL,
  config_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('idle','planning','requested','paused','failed','completed')),
  batch_id text,
  operation_key text,
  file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz,
  lease_id text,
  lease_expires_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(account_id, connected_storage_id, task_id)
);
CREATE INDEX IF NOT EXISTS library_auto_organization_tasks_rotation
  ON library_auto_organization_tasks(next_attempt_at, last_checked_at, account_id, connected_storage_id, task_id);
CREATE TABLE IF NOT EXISTS library_auto_organization_items (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  task_id text NOT NULL,
  file_id text NOT NULL,
  batch_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('planning','requested','completed','paused','failed','cancelled')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(account_id, connected_storage_id, task_id, file_id)
);
CREATE INDEX IF NOT EXISTS library_auto_organization_items_batch
  ON library_auto_organization_items(account_id, connected_storage_id, task_id, batch_id, status);
`;
const REGISTERED_STORAGE_PROVIDERS = STORAGE_BRANDS.map(({ provider }) => provider);

interface TaskRow {
  account_id: string;
  connected_storage_id: string;
  task_id: string;
  config_id: string;
  status: AutoOrganizationTaskStatus;
  batch_id: string | null;
  operation_key: string | null;
  file_ids: unknown;
  attempts: number;
  last_error: string | null;
  next_attempt_at: Date | string | null;
  lease_id: string | null;
  lease_expires_at: Date | string | null;
  last_checked_at: Date | string | null;
}

interface CandidateRow extends TaskRow {
  checkpoint_status: AutoOrganizationTaskStatus | null;
  checkpoint_batch_id: string | null;
  checkpoint_operation_key: string | null;
  checkpoint_file_ids: unknown;
  checkpoint_attempts: number | null;
  checkpoint_last_error: string | null;
  checkpoint_next_attempt_at: Date | string | null;
  checkpoint_last_checked_at: Date | string | null;
}

/** Persistence for F08f checkpoints. DDL is serialized by the existing F02 scan-schema lock. */
export class PostgresAutoOrganizationStore implements AutoOrganizationStore {
  private schema: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {}

  ensureSchema(): Promise<void> {
    if (!this.schema) this.schema = this.initialize().catch((error: unknown) => { this.schema = null; throw error; });
    return this.schema;
  }

  private async initialize(): Promise<void> {
    // F08f queries scan configurations/tasks, identification results, F02 file bindings, and F08c
    // plans. A fresh database cannot rely on another page/worker having created those tables, so
    // initialize every existing schema in dependency order before our own DDL.
    await new PostgresScanStore(this.pool).ensureSchema();
    await new PostgresLibraryStore(this.pool).ensureSchema();
    await new PostgresIdentificationStore(this.pool).ensureSchema();
    await new PostgresOrganizationStore(this.pool).ensureSchema();
    await new PostgresOrganizedIndexStore(this.pool).ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY]);
      try {
        await client.query(SCHEMA);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY]);
      }
    } finally { client.release(); }
  }

  async cancelUnrequested(now: string, limit = 50): Promise<number> {
    await this.ensureSchema();
    const page = boundedLimit(limit, 200, "unrequested cancellation page");
    return this.transaction(async (client) => {
      const stale = await client.query<{ account_id: string; connected_storage_id: string; task_id: string; batch_id: string | null }>(
        `SELECT a.account_id,a.connected_storage_id,a.task_id,a.batch_id
           FROM library_auto_organization_tasks a
          WHERE a.status='planning' AND a.operation_key IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM library_scan_tasks t
                JOIN library_scan_configs cfg ON cfg.account_id=t.account_id AND cfg.connected_storage_id=t.connected_storage_id AND cfg.config_id=t.config_id
                JOIN connected_storages s ON s.id=t.connected_storage_id AND s.account_id=t.account_id
               WHERE t.account_id=a.account_id AND t.connected_storage_id=a.connected_storage_id AND t.task_id=a.task_id
                 AND t.config_id=a.config_id AND t.status IN ('completed','partial')
                 AND s.provider=ANY($2::text[]) AND s.status='active'
                 AND cfg.configuration->>'autoOrganize'='true'
            )
          LIMIT $1 FOR UPDATE`,
        [page, REGISTERED_STORAGE_PROVIDERS],
      );
      for (const row of stale.rows) {
        await client.query(
          `UPDATE library_auto_organization_tasks
              SET status='idle',batch_id=NULL,operation_key=NULL,file_ids='[]'::jsonb,attempts=0,
                  last_error=$4,next_attempt_at=NULL,updated_at=$5
            WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
          [row.account_id, row.connected_storage_id, row.task_id, "自动整理已关闭或任务不可用，未请求批次已取消", now],
        );
        if (row.batch_id) {
          await client.query(
            `UPDATE library_auto_organization_items SET status='cancelled',updated_at=$5
              WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4 AND status='planning'`,
            [row.account_id, row.connected_storage_id, row.task_id, row.batch_id, now],
          );
        }
      }
      return stale.rows.length;
    });
  }

  async listRunnableTasks(input: { now: string; limit: number }): Promise<AutoOrganizationCandidate[]> {
    await this.ensureSchema();
    const limit = boundedLimit(input.limit, 50, "runnable task page");
    const result = await this.pool.query<CandidateRow>(
      `SELECT t.account_id,t.connected_storage_id,t.task_id,t.config_id,
              c.status AS checkpoint_status,c.batch_id AS checkpoint_batch_id,c.operation_key AS checkpoint_operation_key,
              c.file_ids AS checkpoint_file_ids,c.attempts AS checkpoint_attempts,c.last_error AS checkpoint_last_error,
              c.next_attempt_at AS checkpoint_next_attempt_at,c.last_checked_at AS checkpoint_last_checked_at
         FROM library_scan_tasks t
         JOIN library_scan_configs cfg ON cfg.account_id=t.account_id AND cfg.connected_storage_id=t.connected_storage_id AND cfg.config_id=t.config_id
         JOIN connected_storages s ON s.id=t.connected_storage_id AND s.account_id=t.account_id
         LEFT JOIN library_auto_organization_tasks c ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.task_id=t.task_id
        WHERE s.provider=ANY($3::text[]) AND s.status='active'
          AND t.status IN ('completed','partial')
          AND cfg.configuration->>'autoOrganize'='true'
          AND (c.status IS NULL OR c.status NOT IN ('paused','failed'))
          AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= $1::timestamptz)
        ORDER BY c.last_checked_at NULLS FIRST,t.account_id,t.connected_storage_id,t.task_id
        LIMIT $2`,
      [input.now, limit, REGISTERED_STORAGE_PROVIDERS],
    );
    return result.rows.map(candidateFromRow);
  }

  async listPlanningRecoveryTasks(input: { now: string; limit: number }): Promise<AutoOrganizationCandidate[]> {
    await this.ensureSchema();
    const limit = boundedLimit(input.limit, 50, "planning recovery page");
    const result = await this.pool.query<TaskRow>(
      `SELECT a.* FROM library_auto_organization_tasks a
        WHERE a.status='planning' AND a.operation_key IS NOT NULL
          AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= $1::timestamptz)
        ORDER BY a.last_checked_at NULLS FIRST,a.account_id,a.connected_storage_id,a.task_id
        LIMIT $2`,
      [input.now, limit],
    );
    return result.rows.map((row) => ({
      scope: { accountId: row.account_id, connectedStorageId: row.connected_storage_id },
      taskId: row.task_id, configId: row.config_id, checkpoint: checkpointFromRow(row),
    }));
  }

  async beginTask(input: { candidate: AutoOrganizationCandidate; leaseId: string; now: string; leaseExpiresAt: string; requireEligible: boolean }): Promise<AutoOrganizationCheckpoint | null> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const { candidate } = input;
      await client.query(
        `INSERT INTO library_auto_organization_tasks(account_id,connected_storage_id,task_id,config_id,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,'idle',$5,$5) ON CONFLICT DO NOTHING`,
        [candidate.scope.accountId, candidate.scope.connectedStorageId, candidate.taskId, candidate.configId, input.now],
      );
      const selected = await client.query<TaskRow>(
        `SELECT * FROM library_auto_organization_tasks
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE`,
        [candidate.scope.accountId, candidate.scope.connectedStorageId, candidate.taskId],
      );
      const row = selected.rows[0];
      if (!row) return null;
      const terminal = row.status === "paused" || row.status === "failed";
      const leaseBusy = row.lease_id !== null && row.lease_expires_at !== null && iso(row.lease_expires_at) > input.now && row.lease_id !== input.leaseId;
      const notDue = row.next_attempt_at !== null && iso(row.next_attempt_at) > input.now;
      if (terminal || leaseBusy || notDue || (input.requireEligible && !(await isEligible(client, candidate.scope, candidate.taskId, candidate.configId)))) {
        await client.query(
          `UPDATE library_auto_organization_tasks SET last_checked_at=$4,updated_at=$4
            WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
          [candidate.scope.accountId, candidate.scope.connectedStorageId, candidate.taskId, input.now],
        );
        return terminal ? checkpointFromRow(row) : null;
      }
      const leased = await client.query<TaskRow>(
        `UPDATE library_auto_organization_tasks
            SET lease_id=$4,lease_expires_at=$5,last_checked_at=$6,updated_at=$6,config_id=$7
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3
          RETURNING *`,
        [candidate.scope.accountId, candidate.scope.connectedStorageId, candidate.taskId, input.leaseId, input.leaseExpiresAt, input.now, candidate.configId],
      );
      return leased.rows[0] ? checkpointFromRow(leased.rows[0]) : null;
    });
  }

  async releaseTask(scope: OrganizationScope, taskId: string, leaseId: string, now: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `UPDATE library_auto_organization_tasks SET lease_id=NULL,lease_expires_at=NULL,updated_at=$5
        WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4`,
      [scope.accountId, scope.connectedStorageId, taskId, leaseId, now],
    );
  }

  async getCheckpoint(scope: OrganizationScope, taskId: string): Promise<AutoOrganizationCheckpoint | null> {
    await this.ensureSchema();
    const result = await this.pool.query<TaskRow>(
      `SELECT * FROM library_auto_organization_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
      [scope.accountId, scope.connectedStorageId, taskId],
    );
    const row = result.rows[0];
    return row ? checkpointFromRow(row) : null;
  }

  async isAuthorized(scope: OrganizationScope, taskId: string, configId: string): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try { return await isEligible(client, scope, taskId, configId); }
    finally { client.release(); }
  }

  async claimBatch(input: { scope: OrganizationScope; taskId: string; configId: string; batchId: string; now: string; limit: number; leaseId: string }): Promise<AutoOrganizationBatch | null> {
    await this.ensureSchema();
    const limit = boundedLimit(input.limit, 100, "auto organization batch");
    return this.transaction(async (client) => {
      const checkpoint = await client.query<TaskRow>(
        `SELECT * FROM library_auto_organization_tasks
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4 FOR UPDATE`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.leaseId],
      );
      const row = checkpoint.rows[0];
      if (!row || (row.status !== "idle" && row.status !== "completed")) return null;
      if (!(await isEligible(client, input.scope, input.taskId, input.configId))) return null;
      const cfgRes = await client.query<{ configuration: unknown }>(
        `SELECT configuration FROM library_scan_configs
          WHERE account_id=$1 AND connected_storage_id=$2 AND config_id=$3`,
        [input.scope.accountId, input.scope.connectedStorageId, input.configId],
      );
      const rawCfg = cfgRes.rows[0]?.configuration;
      const rawTemplates = rawCfg && typeof rawCfg === "object" && !Array.isArray(rawCfg)
        ? (rawCfg as Record<string, unknown>).templates
        : undefined;
      const templateFingerprint = computeNamingTemplatesFingerprint(
        rawTemplates && typeof rawTemplates === "object" && !Array.isArray(rawTemplates)
          ? (rawTemplates as Partial<Record<NamingTemplateKind, string>>)
          : undefined,
      );
      const files = await client.query<{ file_id: string }>(
        `SELECT f.file_id
           FROM library_scan_task_files f
           JOIN library_scan_tasks t ON t.account_id=f.account_id AND t.connected_storage_id=f.connected_storage_id AND t.task_id=f.task_id
           JOIN library_file_bindings b ON b.account_id=f.account_id AND b.connected_storage_id=f.connected_storage_id AND b.file_id=f.file_id AND b.parent_directory_id=f.parent_directory_id
           JOIN library_scan_identifications i ON i.account_id=f.account_id AND i.connected_storage_id=f.connected_storage_id
             AND i.task_id=f.task_id AND i.file_id=f.file_id AND i.status='confirmed' AND i.import_status='imported'
          WHERE f.account_id=$1 AND f.connected_storage_id=$2 AND f.task_id=$3
            AND t.status IN ('completed','partial') AND f.is_directory=false
            AND NOT EXISTS (
              SELECT 1 FROM library_auto_organization_items existing
               WHERE existing.account_id=f.account_id AND existing.connected_storage_id=f.connected_storage_id
                 AND existing.task_id=f.task_id AND existing.file_id=f.file_id AND existing.status <> 'cancelled'
            )
            AND NOT EXISTS (
              SELECT 1 FROM library_organized_index idx
               WHERE idx.account_id=f.account_id AND idx.connected_storage_id=f.connected_storage_id
                 AND idx.file_id=f.file_id
                 AND (
                   idx.drift_status IN ('drifted','ignored')
                   OR (
                     idx.drift_status='clean'
                     AND idx.parent_directory_id=f.parent_directory_id
                     AND idx.organized_name=f.name
                     AND idx.template_fingerprint=$5
                   )
                 )
            )
          ORDER BY f.file_id LIMIT $4`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, limit, templateFingerprint],
      );
      const fileIds = files.rows.map((file) => file.file_id);
      if (!fileIds.length) return null;
      await client.query(
        `INSERT INTO library_auto_organization_items(account_id,connected_storage_id,task_id,file_id,batch_id,status,updated_at)
         SELECT $1,$2,$3,file_id,$4,'planning',$5 FROM unnest($6::text[]) AS ids(file_id)
         ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE
           SET batch_id=EXCLUDED.batch_id,status='planning',updated_at=EXCLUDED.updated_at
           WHERE library_auto_organization_items.status='cancelled'`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now, fileIds],
      );
      await client.query(
        `UPDATE library_auto_organization_tasks
            SET status='planning',batch_id=$4,operation_key=NULL,file_ids=$5::jsonb,attempts=0,
                last_error=NULL,next_attempt_at=NULL,updated_at=$6
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, JSON.stringify(fileIds), input.now],
      );
      return { batchId: input.batchId, fileIds };
    });
  }

  async markPlanning(input: { scope: OrganizationScope; taskId: string; batchId: string; operationKey: string; now: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE library_auto_organization_tasks
          SET operation_key=$5,next_attempt_at=$6,updated_at=$6
        WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4
          AND lease_id=$7 AND status='planning'`,
      [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.operationKey, input.now, input.leaseId],
    );
    return result.rowCount === 1;
  }

  async markRequested(input: { scope: OrganizationScope; taskId: string; batchId: string; operationKey: string; now: string; leaseId: string; nextAttemptAt: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE library_auto_organization_tasks
            SET status='requested',operation_key=$5,next_attempt_at=$7,updated_at=$6,last_error=NULL
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4
            AND lease_id=$8 AND status IN ('planning','requested')`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.operationKey, input.now, input.nextAttemptAt, input.leaseId],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `UPDATE library_auto_organization_items SET status='requested',updated_at=$5
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4 AND status='planning'`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now],
      );
      return true;
    });
  }

  async completeBatch(input: { scope: OrganizationScope; taskId: string; batchId: string; now: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE library_auto_organization_tasks
            SET status='idle',batch_id=NULL,operation_key=NULL,file_ids='[]'::jsonb,attempts=0,
                last_error=NULL,next_attempt_at=$6,updated_at=$5
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4
            AND lease_id=$7 AND status IN ('planning','requested')`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now, input.now, input.leaseId],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `UPDATE library_auto_organization_items SET status='completed',updated_at=$5
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now],
      );
      return true;
    });
  }

  async cancelBatch(input: { scope: OrganizationScope; taskId: string; batchId: string; reason: string; now: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE library_auto_organization_tasks
            SET status='idle',batch_id=NULL,operation_key=NULL,file_ids='[]'::jsonb,attempts=0,
                last_error=$5,next_attempt_at=NULL,updated_at=$6
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3
            AND lease_id=$7 AND ($4::text IS NULL OR batch_id=$4) AND status IN ('planning','requested')`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId || null, input.reason, input.now, input.leaseId],
      );
      if (result.rowCount !== 1) return false;
      if (input.batchId) {
        await client.query(
          `UPDATE library_auto_organization_items SET status='cancelled',updated_at=$5
            WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4 AND status IN ('planning','requested')`,
          [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now],
        );
      }
      return true;
    });
  }

  async markBatchTerminal(input: { scope: OrganizationScope; taskId: string; batchId: string; status: "paused" | "failed"; error: string; now: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE library_auto_organization_tasks
            SET status=$5,last_error=$6,next_attempt_at=NULL,updated_at=$7
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4
            AND lease_id=$8 AND status IN ('planning','requested')`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.status, input.error, input.now, input.leaseId],
      );
      if (result.rowCount !== 1) return false;
      await client.query(
        `UPDATE library_auto_organization_items SET status=$5,updated_at=$6
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.status, input.now],
      );
      return true;
    });
  }

  async completeTask(input: { scope: OrganizationScope; taskId: string; now: string; nextCheckAt: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE library_auto_organization_tasks
          SET status='completed',batch_id=NULL,operation_key=NULL,file_ids='[]'::jsonb,attempts=0,
              last_error=NULL,next_attempt_at=$5,updated_at=$4
        WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3
          AND lease_id=$6 AND status IN ('idle','completed')`,
      [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.now, input.nextCheckAt, input.leaseId],
    );
    return result.rowCount === 1;
  }

  async deferTask(input: { scope: OrganizationScope; taskId: string; now: string; nextAttemptAt: string; leaseId: string }): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE library_auto_organization_tasks SET next_attempt_at=$5,updated_at=$4
        WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$6
          AND status NOT IN ('paused','failed')`,
      [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.now, input.nextAttemptAt, input.leaseId],
    );
    return result.rowCount === 1;
  }

  async recordFailure(input: { scope: OrganizationScope; taskId: string; batchId: string | null; error: string; now: string; leaseId: string; maxAttempts: number; retryDelayMs: number }): Promise<"retry" | "failed"> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const selected = await client.query<TaskRow>(
        `SELECT * FROM library_auto_organization_tasks
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4 FOR UPDATE`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.leaseId],
      );
      const row = selected.rows[0];
      if (!row) return "failed";
      const attempts = Number(row.attempts) + 1;
      const terminal = attempts >= input.maxAttempts;
      await client.query(
        `UPDATE library_auto_organization_tasks
            SET status=$4,attempts=$5,last_error=$6,next_attempt_at=$7,updated_at=$8
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
        [
          input.scope.accountId, input.scope.connectedStorageId, input.taskId,
          terminal ? "failed" : row.status, attempts, input.error.slice(0, 1000),
          terminal ? null : new Date(Date.parse(input.now) + input.retryDelayMs).toISOString(), input.now,
        ],
      );
      if (terminal && input.batchId) {
        await client.query(
          `UPDATE library_auto_organization_items SET status='failed',updated_at=$5
            WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND batch_id=$4`,
          [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.batchId, input.now],
        );
      }
      return terminal ? "failed" : "retry";
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

async function isEligible(client: PoolClient, scope: OrganizationScope, taskId: string, configId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM library_scan_tasks t
       JOIN library_scan_configs cfg ON cfg.account_id=t.account_id AND cfg.connected_storage_id=t.connected_storage_id AND cfg.config_id=t.config_id
       JOIN connected_storages s ON s.id=t.connected_storage_id AND s.account_id=t.account_id
      WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3 AND t.config_id=$4
        AND t.status IN ('completed','partial') AND s.provider=ANY($5::text[]) AND s.status='active'
        AND cfg.configuration->>'autoOrganize'='true'`,
    [scope.accountId, scope.connectedStorageId, taskId, configId, REGISTERED_STORAGE_PROVIDERS],
  );
  return result.rowCount === 1;
}

function candidateFromRow(row: CandidateRow): AutoOrganizationCandidate {
  const checkpoint = row.checkpoint_status
    ? checkpointFromRow({
      account_id: row.account_id, connected_storage_id: row.connected_storage_id, task_id: row.task_id, config_id: row.config_id,
      status: row.checkpoint_status, batch_id: row.checkpoint_batch_id, operation_key: row.checkpoint_operation_key,
      file_ids: row.checkpoint_file_ids, attempts: row.checkpoint_attempts ?? 0, last_error: row.checkpoint_last_error,
      next_attempt_at: row.checkpoint_next_attempt_at, last_checked_at: row.checkpoint_last_checked_at,
      lease_id: null, lease_expires_at: null,
    })
    : null;
  return {
    scope: { accountId: row.account_id, connectedStorageId: row.connected_storage_id },
    taskId: row.task_id, configId: row.config_id, checkpoint,
  };
}

function checkpointFromRow(row: TaskRow): AutoOrganizationCheckpoint {
  return {
    scope: { accountId: row.account_id, connectedStorageId: row.connected_storage_id },
    taskId: row.task_id, configId: row.config_id, status: row.status,
    batchId: row.batch_id, operationKey: row.operation_key, fileIds: stringArray(row.file_ids),
    attempts: Number(row.attempts), lastError: row.last_error,
    nextAttemptAt: nullableIso(row.next_attempt_at), lastCheckedAt: nullableIso(row.last_checked_at),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function nullableIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return iso(value);
}
function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
function boundedLimit(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${label} must be between 1 and ${max}`);
  return value;
}
