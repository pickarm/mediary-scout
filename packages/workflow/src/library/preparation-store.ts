import type { Pool, PoolClient } from "pg";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { isQueueClaimableKind, UNSCOPED_STORAGE } from "../repository.js";
import type { MediaType, ResourceSnapshot, WorkflowKind } from "../domain.js";

export type PreparationStatus = "queued" | "running" | "ready" | "cancelled" | "stale" | "failed";
export interface PreparationDescriptor {
  accountId: string;
  connectedStorageId: string | null;
  workflowRunId: string;
  mediaType: MediaType;
  tmdbId: number;
  title: string;
  aliases: string[];
  year?: number;
  searchConfigFingerprint: string;
}
export interface PreparedJevResult {
  target: { mediaType: MediaType; tmdbId: number; title: string; aliases: string[]; year?: number };
  result: { scores: Record<string, number>; model: string; inputTokens?: number; cost?: number; failedChunks?: number; nsfw?: Record<string, number> };
}
export interface PreparationResult { snapshots: ResourceSnapshot[]; jev?: PreparedJevResult }
export interface PreparationJob extends PreparationDescriptor {
  status: PreparationStatus;
  attempts: number;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  expiresAt: string;
  result: PreparationResult | null;
}
export interface PreparationScope { accountId: string; connectedStorageId: string | null }
export interface PreparationClaimFilter { accountId?: string; connectedStorageId?: string | null; workflowRunIds?: readonly string[] }

export const LIBRARY_PREPARATION_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_146;
const DDL = `
CREATE TABLE IF NOT EXISTS library_preparation_jobs (
 account_id text NOT NULL, connected_storage_id text NOT NULL DEFAULT '__unscoped__', workflow_run_id text NOT NULL,
 media_type text NOT NULL CHECK (media_type IN ('movie','tv','anime')), tmdb_id integer NOT NULL,
 descriptor jsonb NOT NULL, search_config_fingerprint text NOT NULL,
 status text NOT NULL CHECK (status IN ('queued','running','ready','cancelled','stale','failed')),
 attempts integer NOT NULL DEFAULT 0, lease_id text, lease_expires_at timestamptz,
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 result jsonb, error_code text,
 PRIMARY KEY (account_id, connected_storage_id, workflow_run_id)
);
CREATE INDEX IF NOT EXISTS library_preparation_claim ON library_preparation_jobs(status, expires_at, created_at);
CREATE INDEX IF NOT EXISTS library_preparation_scope ON library_preparation_jobs(account_id, connected_storage_id, status);
`;
const JOB_TTL_MS = 24 * 60 * 60_000;

/** Durable PG queue; acquisition workflow rows remain owned and claimed by the native worker. */
export class PostgresPreparationStore {
  private schemaReady: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.initializeSchema();
    try { await this.schemaReady; } catch (error) { this.schemaReady = null; throw error; }
  }

  private async initializeSchema(): Promise<void> {
    await initializeWorkflowPostgresSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LIBRARY_PREPARATION_SCHEMA_ADVISORY_LOCK_KEY]);
      await client.query(DDL);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async register(descriptor: PreparationDescriptor, now = new Date()): Promise<boolean> {
    validateDescriptor(descriptor);
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await readValidRun(client, descriptor);
      if (!run) { await client.query("ROLLBACK"); return false; }
      const scopeStorage = descriptor.connectedStorageId ?? UNSCOPED_STORAGE;
      const created = now.toISOString();
      await client.query(
        `INSERT INTO library_preparation_jobs(account_id,connected_storage_id,workflow_run_id,media_type,tmdb_id,descriptor,search_config_fingerprint,status,created_at,updated_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'queued',$8,$8,$9)
         ON CONFLICT(account_id,connected_storage_id,workflow_run_id) DO UPDATE SET
          descriptor=EXCLUDED.descriptor, media_type=EXCLUDED.media_type, tmdb_id=EXCLUDED.tmdb_id,
          search_config_fingerprint=EXCLUDED.search_config_fingerprint,status='queued',attempts=0,
          lease_id=NULL,lease_expires_at=NULL,result=NULL,error_code=NULL,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at
         WHERE library_preparation_jobs.status <> 'cancelled' AND (library_preparation_jobs.search_config_fingerprint IS DISTINCT FROM EXCLUDED.search_config_fingerprint OR library_preparation_jobs.descriptor IS DISTINCT FROM EXCLUDED.descriptor)`,
        [descriptor.accountId, scopeStorage, descriptor.workflowRunId, descriptor.mediaType, descriptor.tmdbId, JSON.stringify(toStoredDescriptor(descriptor)), descriptor.searchConfigFingerprint, created, new Date(now.getTime() + JOB_TTL_MS).toISOString()],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  /** Explicit user/operator retry. A repeated register call never revives a cancelled job. */
  async retry(descriptor: PreparationDescriptor, now = new Date()): Promise<boolean> {
    validateDescriptor(descriptor);
    await this.ensureSchema();
    return withTransaction(this.pool, async (client) => {
      if (!(await readValidRun(client, descriptor))) return false;
      const changed = await client.query(`UPDATE library_preparation_jobs SET descriptor=$5::jsonb,search_config_fingerprint=$4,status='queued',attempts=0,
        lease_id=NULL,lease_expires_at=NULL,result=NULL,error_code=NULL,created_at=$6,updated_at=$6,expires_at=$7
        WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3
          AND status IN ('cancelled','failed','stale')`, [descriptor.accountId,descriptor.connectedStorageId ?? UNSCOPED_STORAGE,descriptor.workflowRunId,descriptor.searchConfigFingerprint,JSON.stringify(toStoredDescriptor(descriptor)),now.toISOString(),new Date(now.getTime()+JOB_TTL_MS).toISOString()]);
      return changed.rowCount === 1;
    });
  }

  async claim(now = new Date(), leaseMs = 30_000, filter?: PreparationClaimFilter): Promise<PreparationJob | null> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE library_preparation_jobs SET status=CASE WHEN expires_at<=$1 THEN 'stale' ELSE 'failed' END,
        result=NULL,lease_id=NULL,lease_expires_at=NULL,error_code=CASE WHEN expires_at<=$1 THEN 'preparation_expired' ELSE 'retry_limit' END,updated_at=$1
        WHERE (expires_at<=$1 AND status IN ('queued','running')) OR (attempts>=4 AND status='running' AND lease_expires_at<=$1)`, [now.toISOString()]);
      const filters: string[] = [];
      const values: unknown[] = [now.toISOString()];
      if (filter?.accountId !== undefined) { values.push(filter.accountId); filters.push(`account_id=$${values.length}`); }
      if (filter && "connectedStorageId" in filter) { values.push(filter.connectedStorageId ?? UNSCOPED_STORAGE); filters.push(`connected_storage_id=$${values.length}`); }
      if (filter?.workflowRunIds) { values.push(filter.workflowRunIds); filters.push(`workflow_run_id=ANY($${values.length}::text[])`); }
      const selected = await client.query<{ account_id: string; connected_storage_id: string; workflow_run_id: string; descriptor: PreparationDescriptor; attempts: number; created_at: Date; expires_at: Date }>(
        `SELECT account_id,connected_storage_id,workflow_run_id,descriptor,attempts,created_at,expires_at FROM library_preparation_jobs
         WHERE expires_at>$1 AND attempts<4 AND (status='queued' OR (status='running' AND lease_expires_at<=$1)) ${filters.map((part) => `AND ${part}`).join(" ")}
         ORDER BY created_at,workflow_run_id LIMIT 1 FOR UPDATE SKIP LOCKED`, values,
      );
      const row = selected.rows[0];
      if (!row) { await client.query("COMMIT"); return null; }
      if (!(await readValidRun(client, row.descriptor))) {
        await client.query("UPDATE library_preparation_jobs SET status='stale',lease_id=NULL,lease_expires_at=NULL,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3", [row.account_id,row.connected_storage_id,row.workflow_run_id,now.toISOString()]);
        await client.query("COMMIT"); return null;
      }
      const leaseId = globalThis.crypto.randomUUID();
      const expiry = new Date(now.getTime() + leaseMs).toISOString();
      await client.query("UPDATE library_preparation_jobs SET status='running',attempts=attempts+1,lease_id=$4,lease_expires_at=$5,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3", [row.account_id,row.connected_storage_id,row.workflow_run_id,leaseId,expiry,now.toISOString()]);
      await client.query("COMMIT");
      return { ...row.descriptor, status: "running", attempts: row.attempts + 1, leaseId, leaseExpiresAt: expiry, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), result: null };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async heartbeat(job: PreparationJob, now = new Date(), leaseMs = 30_000): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_preparation_jobs SET lease_expires_at=$5,updated_at=$6
      WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status='running' AND lease_id=$4 AND expires_at>$6 AND lease_expires_at>$6`,
      [job.accountId, job.connectedStorageId ?? UNSCOPED_STORAGE, job.workflowRunId, job.leaseId, new Date(now.getTime() + leaseMs).toISOString(), now.toISOString()]);
    return result.rowCount === 1;
  }

  async isLive(job: PreparationJob): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      const lease = await client.query("SELECT 1 FROM library_preparation_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status='running' AND lease_id=$4 AND expires_at>now() AND lease_expires_at>now()", [job.accountId,job.connectedStorageId ?? UNSCOPED_STORAGE,job.workflowRunId,job.leaseId]);
      return lease.rowCount === 1 && await readValidRun(client, job);
    } finally { client.release(); }
  }

  async commit(job: PreparationJob, result: PreparationResult, now = new Date()): Promise<boolean> {
    validateResult(result);
    await this.ensureSchema();
    return withTransaction(this.pool, async (client) => {
      if (!(await readValidRun(client, job))) {
        await client.query("UPDATE library_preparation_jobs SET status='stale',lease_id=NULL,lease_expires_at=NULL,result=NULL,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND lease_id=$5 AND lease_expires_at>$4", [job.accountId,job.connectedStorageId ?? UNSCOPED_STORAGE,job.workflowRunId,now.toISOString(),job.leaseId]);
        return false;
      }
      const saved = await client.query(`UPDATE library_preparation_jobs SET status='ready',result=$6::jsonb,lease_id=NULL,lease_expires_at=NULL,updated_at=$7
        WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status='running' AND lease_id=$4 AND search_config_fingerprint=$5 AND expires_at>$7 AND lease_expires_at>$7`,
        [job.accountId,job.connectedStorageId ?? UNSCOPED_STORAGE,job.workflowRunId,job.leaseId,job.searchConfigFingerprint,JSON.stringify(result),now.toISOString()]);
      return saved.rowCount === 1;
    });
  }

  async fail(job: PreparationJob, retryable: boolean, now = new Date()): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_preparation_jobs SET status=CASE WHEN $5 AND attempts<4 AND expires_at>$6 THEN 'queued' ELSE 'failed' END,
      lease_id=NULL,lease_expires_at=NULL,error_code='preparation_failed',updated_at=$6
      WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status='running' AND lease_id=$4 AND lease_expires_at>$6 AND expires_at>$6`,
      [job.accountId,job.connectedStorageId ?? UNSCOPED_STORAGE,job.workflowRunId,job.leaseId,retryable,now.toISOString()]);
    return result.rowCount === 1;
  }

  async stale(job: PreparationJob, now = new Date()): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_preparation_jobs SET status='stale',lease_id=NULL,lease_expires_at=NULL,result=NULL,updated_at=$5
      WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status='running' AND lease_id=$4 AND lease_expires_at>$5`, [job.accountId,job.connectedStorageId ?? UNSCOPED_STORAGE,job.workflowRunId,job.leaseId,now.toISOString()]);
    return result.rowCount === 1;
  }

  async cancel(scope: PreparationScope, workflowRunId: string, now = new Date()): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_preparation_jobs SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,result=NULL,updated_at=$4
      WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND status IN ('queued','running','ready')`, [scope.accountId,scope.connectedStorageId ?? UNSCOPED_STORAGE,workflowRunId,now.toISOString()]);
    return result.rowCount === 1;
  }

  async get(scope: PreparationScope, workflowRunId: string): Promise<PreparationJob | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ descriptor: PreparationDescriptor; status: PreparationStatus; attempts: number; lease_id: string | null; lease_expires_at: Date | null; created_at: Date; expires_at: Date; result: PreparationResult | null }>(
      "SELECT descriptor,status,attempts,lease_id,lease_expires_at,created_at,expires_at,result FROM library_preparation_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3", [scope.accountId,scope.connectedStorageId ?? UNSCOPED_STORAGE,workflowRunId]);
    const row = result.rows[0];
    return row ? { ...row.descriptor, status: row.status, attempts: row.attempts, leaseId: row.lease_id, leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), result: row.result } : null;
  }

  /** Consumer-safe accessor; raw results are visible only while their exact run/config/target remains eligible. */
  async getReadyResult(descriptor: PreparationDescriptor, now = new Date()): Promise<PreparationResult | null> {
    validateDescriptor(descriptor);
    await this.ensureSchema();
    return withTransaction(this.pool, async (client) => {
      if (!(await readValidRun(client, descriptor))) return null;
      const result = await client.query<{ result: PreparationResult | null }>(`SELECT result FROM library_preparation_jobs
        WHERE account_id=$1 AND connected_storage_id=$2 AND workflow_run_id=$3 AND media_type=$4 AND tmdb_id=$5
          AND search_config_fingerprint=$6 AND descriptor=$7::jsonb AND status='ready' AND expires_at>$8`,
        [descriptor.accountId,descriptor.connectedStorageId ?? UNSCOPED_STORAGE,descriptor.workflowRunId,descriptor.mediaType,descriptor.tmdbId,descriptor.searchConfigFingerprint,JSON.stringify(toStoredDescriptor(descriptor)),now.toISOString()]);
      return result.rows[0]?.result ?? null;
    });
  }
}

async function readValidRun(client: PoolClient, descriptor: PreparationDescriptor): Promise<boolean> {
  const result = await client.query<{ status: string; kind: WorkflowKind; run_account: string; run_storage: string | null; season_account: string; season_storage: string | null; media_title_id: string; title_payload: { tmdbId?: number; type?: MediaType } }>(
    `SELECT wr.payload->>'status' AS status, wr.payload->>'kind' AS kind, wr.account_id AS run_account,wr.connected_storage_id AS run_storage,
      ts.account_id AS season_account,ts.connected_storage_id AS season_storage,ts.media_title_id,mt.payload AS title_payload
     FROM workflow_runs wr JOIN tracked_seasons ts ON ts.id=wr.tracked_season_id AND ts.account_id=wr.account_id AND ts.connected_storage_id IS NOT DISTINCT FROM wr.connected_storage_id
     JOIN media_titles mt ON mt.id=ts.media_title_id
     LEFT JOIN connected_storages cs ON cs.id=wr.connected_storage_id AND cs.account_id=wr.account_id
     WHERE wr.id=$1 AND wr.account_id=$2 AND wr.connected_storage_id=$3 AND ($4::text IS NULL OR (cs.provider='guangya' AND cs.status='active')) FOR SHARE OF wr,ts,mt`,
    [descriptor.workflowRunId, descriptor.accountId, descriptor.connectedStorageId ?? UNSCOPED_STORAGE, descriptor.connectedStorageId]);
  const row = result.rows[0];
  return Boolean(row && (row.status === "queued" || row.status === "running") && isQueueClaimableKind(row.kind as WorkflowKind)
    && row.run_account === descriptor.accountId && row.season_account === descriptor.accountId
    && row.run_storage === (descriptor.connectedStorageId ?? UNSCOPED_STORAGE) && row.season_storage === (descriptor.connectedStorageId ?? UNSCOPED_STORAGE)
    && row.title_payload.type === descriptor.mediaType && row.title_payload.tmdbId === descriptor.tmdbId);
}

function validateDescriptor(value: PreparationDescriptor): void {
  if (!value.accountId.trim() || !value.workflowRunId.trim() || (value.connectedStorageId !== null && !value.connectedStorageId.trim())) throw new Error("PREPARATION_SCOPE_REQUIRED");
  if (!Number.isSafeInteger(value.tmdbId) || value.tmdbId < 1 || !["movie","tv","anime"].includes(value.mediaType)) throw new Error("PREPARATION_IDENTITY_INVALID");
  if (!value.title.trim() || value.title.length > 300 || value.aliases.length > 20 || value.aliases.some((alias) => typeof alias !== "string" || alias.length > 300) || value.searchConfigFingerprint.length < 8 || value.searchConfigFingerprint.length > 256) throw new Error("PREPARATION_DESCRIPTOR_INVALID");
  if (value.year !== undefined && (!Number.isInteger(value.year) || value.year < 1800 || value.year > 2200)) throw new Error("PREPARATION_YEAR_INVALID");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 8192) throw new Error("PREPARATION_DESCRIPTOR_TOO_LARGE");
}
export { validateDescriptor as validatePreparationDescriptor };
function toStoredDescriptor(value: PreparationDescriptor): PreparationDescriptor {
  return {
    accountId: value.accountId,
    connectedStorageId: value.connectedStorageId,
    workflowRunId: value.workflowRunId,
    mediaType: value.mediaType,
    tmdbId: value.tmdbId,
    title: value.title,
    aliases: [...value.aliases],
    ...(value.year === undefined ? {} : { year: value.year }),
    searchConfigFingerprint: value.searchConfigFingerprint,
  };
}
function validateResult(value: PreparationResult): void {
  if (!Array.isArray(value.snapshots) || value.snapshots.length > 8) throw new Error("PREPARATION_RESULT_INVALID");
  const candidateCount = value.snapshots.reduce((sum, snapshot) => sum + snapshot.candidates.length, 0);
  if (candidateCount > 800 || Buffer.byteLength(JSON.stringify(value), "utf8") > 2_000_000) throw new Error("PREPARATION_RESULT_TOO_LARGE");
}
async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const value = await fn(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
