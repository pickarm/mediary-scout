import type { Pool, PoolClient } from "pg";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import { PostgresScanStore } from "./scan-store.js";
import type { ScanScope, ScanTaskStatus } from "./scanner.js";

export const LIBRARY_IDENTIFICATION_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_145;
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS library_identification_jobs (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('waiting','pending','running','completed','cancelled','failed')),
    lease_id text,
    lease_expires_at text,
    after_file_id text,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, task_id),
    FOREIGN KEY (account_id, connected_storage_id, task_id)
      REFERENCES library_scan_tasks (account_id, connected_storage_id, task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_identification_jobs_drain
    ON library_identification_jobs (status, updated_at, account_id, connected_storage_id, task_id);
  CREATE TABLE IF NOT EXISTS library_scan_identifications (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    file_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('confirmed','pending','ignored','failed')),
    reason text NOT NULL,
    evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
    candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    media_type text,
    tmdb_id integer,
    season_number integer,
    episode_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
    import_status text NOT NULL CHECK (import_status IN ('not_applicable','pending','imported')),
    manual boolean NOT NULL DEFAULT false,
    updated_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, task_id, file_id),
    FOREIGN KEY (account_id, connected_storage_id, task_id)
      REFERENCES library_scan_tasks (account_id, connected_storage_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, connected_storage_id, task_id, file_id)
      REFERENCES library_scan_task_files (account_id, connected_storage_id, task_id, file_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_scan_identifications_status
    ON library_scan_identifications (account_id, connected_storage_id, task_id, status, file_id);
`;

export type IdentificationJobStatus = "waiting" | "pending" | "running" | "completed" | "cancelled" | "failed";
export type StoredIdentificationStatus = "confirmed" | "pending" | "ignored" | "failed";
export type IdentificationImportStatus = "not_applicable" | "pending" | "imported";

export interface IdentificationJob {
  scope: ScanScope;
  taskId: string;
  status: IdentificationJobStatus;
  afterFileId: string | null;
  attempts: number;
  lastError: string | null;
  scanStatus: ScanTaskStatus;
}

export interface StoredIdentification {
  fileId: string;
  status: StoredIdentificationStatus;
  reason: string;
  evidence: unknown[];
  candidates: unknown[];
  mediaType: string | null;
  tmdbId: number | null;
  seasonNumber: number | null;
  episodeCodes: string[];
  importStatus: IdentificationImportStatus;
  manual: boolean;
  updatedAt: string;
}

export interface SaveIdentificationInput extends Omit<StoredIdentification, "updatedAt"> {
  scope: ScanScope;
  taskId: string;
  leaseId: string;
  now: string;
}
export interface IdentificationScanFact {
  fileId: string; parentDirectoryId: string; name: string; isDirectory: boolean;
  sizeBytes: number | null; path: string; modifiedAt: string | null;
}
export interface IdentificationTrackingFact {
  fileId: string;
  trackedSeasonId: string;
  autoAcquire: boolean | null;
}
export interface IdentificationDirectoryFact { directoryId: string; parentDirectoryId: string | null; name: string; path: string }

export class IdentificationStoreScopeError extends Error {
  constructor(message: string) { super(message); this.name = "IdentificationStoreScopeError"; }
}
export class IdentificationStoreInputError extends Error {
  constructor(message: string) { super(message); this.name = "IdentificationStoreInputError"; }
}

/** Durable job/checkpoint and compact per-file results. The scan facts remain authoritative. */
export class PostgresIdentificationStore {
  private schemaReady: Promise<void> | null = null;
  private readonly scans: PostgresScanStore;

  constructor(private readonly pool: Pool) { this.scans = new PostgresScanStore(pool); }

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.initializeSchema();
    try { await this.schemaReady; } catch (error) { this.schemaReady = null; throw error; }
  }

  private async initializeSchema(): Promise<void> {
    await initializeWorkflowPostgresSchema(this.pool);
    await this.scans.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [LIBRARY_IDENTIFICATION_SCHEMA_ADVISORY_LOCK_KEY]);
      try { await client.query(SCHEMA); }
      finally { await client.query("SELECT pg_advisory_unlock($1)", [LIBRARY_IDENTIFICATION_SCHEMA_ADVISORY_LOCK_KEY]); }
    } finally { client.release(); }
  }

  async enqueueForScan(scope: ScanScope, taskId: string, now = new Date().toISOString()): Promise<IdentificationJob> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      const task = await this.selectTask(client, scope, taskId);
      if (!task) throw new IdentificationStoreScopeError("扫描任务不存在或不属于当前账号与网盘");
      await client.query(
        "INSERT INTO library_identification_jobs (account_id,connected_storage_id,task_id,status,created_at,updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (account_id,connected_storage_id,task_id) DO UPDATE SET " +
        "status=CASE WHEN library_identification_jobs.status IN ('completed','cancelled') THEN library_identification_jobs.status " +
        "WHEN library_identification_jobs.status='running' AND library_identification_jobs.lease_expires_at > EXCLUDED.updated_at THEN 'running' " +
        "WHEN EXCLUDED.status='waiting' THEN 'waiting' ELSE 'pending' END,updated_at=EXCLUDED.updated_at",
        [scope.accountId, scope.connectedStorageId, taskId, task.status === "completed" || task.status === "partial" ? "pending" : task.status === "cancelled" ? "cancelled" : "waiting", now],
      );
      return (await this.selectJob(client, scope, taskId))!;
    });
  }

  async getJob(scope: ScanScope, taskId: string): Promise<IdentificationJob | null> {
    await this.ensureSchema();
    return this.withTransaction((client) => this.selectJob(client, scope, taskId));
  }

  async ownsJobLease(scope: ScanScope, taskId: string, leaseId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      "SELECT 1 FROM library_identification_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 " +
      "AND status='running' AND lease_id=$4 AND lease_expires_at > $5",
      [scope.accountId, scope.connectedStorageId, taskId, leaseId, new Date().toISOString()],
    );
    return result.rowCount === 1;
  }

  async drainPending(scope: ScanScope, limit = 10): Promise<Array<{ scope: ScanScope; taskId: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new IdentificationStoreInputError("识别作业领取数量无效");
    await this.ensureSchema();
    const result = await this.pool.query<{ account_id: string; connected_storage_id: string; task_id: string }>(
      "SELECT j.account_id,j.connected_storage_id,j.task_id FROM library_identification_jobs j " +
      "JOIN library_scan_tasks t USING (account_id,connected_storage_id,task_id) " +
      "WHERE j.account_id=$1 AND j.connected_storage_id=$2 AND (j.status='pending' " +
      "OR (j.status='waiting' AND t.status IN ('completed','partial','failed','cancelled')) " +
      "OR (j.status='running' AND (j.lease_id IS NULL OR j.lease_expires_at IS NULL OR j.lease_expires_at <= $3))) " +
      "ORDER BY j.updated_at,j.task_id LIMIT $4", [scope.accountId, scope.connectedStorageId, new Date().toISOString(), limit],
    );
    return result.rows.map((row) => ({ scope: { accountId: row.account_id, connectedStorageId: row.connected_storage_id }, taskId: row.task_id }));
  }

  async claimJob(scope: ScanScope, taskId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      const task = await this.selectTask(client, scope, taskId);
      if (!task) return false;
      if (task.status === "cancelled") {
        await client.query("UPDATE library_identification_jobs SET status='cancelled',lease_id=NULL,lease_expires_at=NULL,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status <> 'completed'", [scope.accountId, scope.connectedStorageId, taskId, now]);
        return false;
      }
      if (task.status === "queued" || task.status === "running" || task.status === "paused" || task.status === "cancelling") {
        await client.query("UPDATE library_identification_jobs SET status='waiting',lease_id=NULL,lease_expires_at=NULL,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status <> 'completed'", [scope.accountId, scope.connectedStorageId, taskId, now]);
        return false;
      }
      const result = await client.query(
        "UPDATE library_identification_jobs SET status='running',lease_id=$4,lease_expires_at=$5,attempts=attempts+1,updated_at=$6,last_error=NULL " +
        "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status IN ('pending','waiting','failed','running') " +
        "AND (lease_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $6)",
        [scope.accountId, scope.connectedStorageId, taskId, leaseId, leaseExpiresAt, now],
      );
      return result.rowCount === 1;
    });
  }

  async listResultFileIds(scope: ScanScope, taskId: string, afterFileId: string | null, limit: number): Promise<string[]> {
    this.checkPage(limit);
    await this.ensureSchema();
    const result = await this.pool.query<{ file_id: string }>(
      "SELECT f.file_id FROM library_scan_task_files f LEFT JOIN library_scan_identifications i " +
      "ON i.account_id=f.account_id AND i.connected_storage_id=f.connected_storage_id AND i.task_id=f.task_id AND i.file_id=f.file_id " +
      "WHERE f.account_id=$1 AND f.connected_storage_id=$2 AND f.task_id=$3 AND ($4::text IS NULL OR f.file_id>$4) " +
      "AND i.file_id IS NULL ORDER BY f.file_id LIMIT $5", [scope.accountId, scope.connectedStorageId, taskId, afterFileId, limit],
    );
    return result.rows.map((row) => row.file_id);
  }

  async listUnidentifiedFiles(scope: ScanScope, taskId: string, fileIds: readonly string[]): Promise<IdentificationScanFact[]> {
    if (fileIds.length > 500) throw new IdentificationStoreInputError("单批识别文件不能超过 500 个");
    if (fileIds.length === 0) return [];
    await this.ensureSchema();
    const result = await this.pool.query<{ file_id: string; parent_directory_id: string; name: string; is_directory: boolean; size_bytes: string | number | null; path: string; modified_at: string | null }>(
      "SELECT file_id,parent_directory_id,name,is_directory,size_bytes,path,modified_at FROM library_scan_task_files " +
      "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=ANY($4::text[]) ORDER BY file_id",
      [scope.accountId, scope.connectedStorageId, taskId, [...fileIds]],
    );
    return result.rows.map((row) => ({ fileId: row.file_id, parentDirectoryId: row.parent_directory_id, name: row.name, isDirectory: row.is_directory, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), path: row.path, modifiedAt: row.modified_at }));
  }

  /** Reads current F02 tracking state for one bounded result page in a single query. */
  async listTrackingForFiles(scope: ScanScope, fileIds: readonly string[]): Promise<IdentificationTrackingFact[]> {
    if (fileIds.length > 201) throw new IdentificationStoreInputError("单批追更状态查询不能超过 201 个文件");
    if (fileIds.length === 0) return [];
    await this.ensureSchema();
    const result = await this.pool.query<{ file_id: string; tracked_season_id: string; auto_acquire: unknown }>(
      "SELECT b.file_id,b.tracked_season_id,s.payload->'autoAcquire' AS auto_acquire " +
      "FROM library_file_bindings b JOIN tracked_seasons s " +
      "ON s.id=b.tracked_season_id AND s.account_id=b.account_id AND s.connected_storage_id=b.connected_storage_id " +
      "WHERE b.account_id=$1 AND b.connected_storage_id=$2 AND b.file_id=ANY($3::text[]) ORDER BY b.file_id",
      [scope.accountId, scope.connectedStorageId, [...fileIds]],
    );
    return result.rows.map((row) => ({ fileId: row.file_id, trackedSeasonId: row.tracked_season_id, autoAcquire: typeof row.auto_acquire === "boolean" ? row.auto_acquire : null }));
  }

  async listNextUnidentifiedFiles(scope: ScanScope, taskId: string, afterFileId: string | null, limit: number): Promise<IdentificationScanFact[]> {
    this.checkPage(limit);
    await this.ensureSchema();
    const result = await this.pool.query<{ file_id: string; parent_directory_id: string; name: string; is_directory: boolean; size_bytes: string | number | null; path: string; modified_at: string | null }>(
      "SELECT f.file_id,f.parent_directory_id,f.name,f.is_directory,f.size_bytes,f.path,f.modified_at FROM library_scan_task_files f " +
      "LEFT JOIN library_scan_identifications i ON i.account_id=f.account_id AND i.connected_storage_id=f.connected_storage_id AND i.task_id=f.task_id AND i.file_id=f.file_id " +
      "WHERE f.account_id=$1 AND f.connected_storage_id=$2 AND f.task_id=$3 AND f.is_directory=false AND ($4::text IS NULL OR f.file_id>$4) AND i.file_id IS NULL " +
      "ORDER BY f.file_id LIMIT $5", [scope.accountId, scope.connectedStorageId, taskId, afterFileId, limit],
    );
    return result.rows.map((row) => ({ fileId: row.file_id, parentDirectoryId: row.parent_directory_id, name: row.name, isDirectory: row.is_directory, sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), path: row.path, modifiedAt: row.modified_at }));
  }

  async listAncestors(scope: ScanScope, taskId: string, directoryId: string, maxDepth = 64): Promise<IdentificationDirectoryFact[]> {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 128) throw new IdentificationStoreInputError("目录祖先深度无效");
    await this.ensureSchema();
    const result = await this.pool.query<{ directory_id: string; parent_directory_id: string | null; name: string; path: string }>(
      "WITH RECURSIVE ancestors AS (" +
      "SELECT f.file_id AS directory_id,f.parent_directory_id,f.name,f.path,0 AS depth FROM library_scan_task_files f " +
      "WHERE f.account_id=$1 AND f.connected_storage_id=$2 AND f.task_id=$3 AND f.file_id=$4 AND f.is_directory " +
      "UNION ALL SELECT p.file_id,p.parent_directory_id,p.name,p.path,a.depth+1 FROM ancestors a " +
      "JOIN library_scan_task_files p ON p.account_id=$1 AND p.connected_storage_id=$2 AND p.task_id=$3 AND p.file_id=a.parent_directory_id AND p.is_directory " +
      "WHERE a.depth < $5) SELECT directory_id,parent_directory_id,name,path FROM ancestors ORDER BY depth",
      [scope.accountId, scope.connectedStorageId, taskId, directoryId, maxDepth],
    );
    return result.rows.map((row) => ({ directoryId: row.directory_id, parentDirectoryId: row.parent_directory_id, name: row.name, path: row.path }));
  }

  async retryFailed(scope: ScanScope, taskId: string, now = new Date().toISOString()): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      const job = await client.query<{ status: IdentificationJobStatus }>("SELECT status FROM library_identification_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [scope.accountId, scope.connectedStorageId, taskId]);
      const row = job.rows[0];
      if (!row) return false;
      const failed = await client.query("SELECT 1 FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status='failed' LIMIT 1", [scope.accountId, scope.connectedStorageId, taskId]);
      if (row.status !== "failed" && !failed.rowCount) return false;
      if (failed.rowCount) {
        await client.query("DELETE FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status='failed'", [scope.accountId, scope.connectedStorageId, taskId]);
      }
      const result = await client.query("UPDATE library_identification_jobs SET status='pending',lease_id=NULL,lease_expires_at=NULL,last_error=NULL,after_file_id=CASE WHEN $5 THEN NULL ELSE after_file_id END,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status IN ('failed','completed')", [scope.accountId, scope.connectedStorageId, taskId, now, Boolean(failed.rowCount)]);
      return result.rowCount === 1;
    });
  }

  async saveResult(input: SaveIdentificationInput): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      const job = await client.query<{ status: IdentificationJobStatus; lease_id: string | null; lease_expires_at: string | null }>("SELECT status,lease_id,lease_expires_at FROM library_identification_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId]);
      const current = job.rows[0];
      const ownsActiveLease = current?.status === "running" && current.lease_id === input.leaseId && current.lease_expires_at !== null && current.lease_expires_at > input.now;
      const isCommittedImportAfterCancel = current?.status === "cancelled" && input.status === "confirmed" && input.importStatus === "imported";
      if (!ownsActiveLease && !isCommittedImportAfterCancel) return false;
      await client.query(
        "INSERT INTO library_scan_identifications (account_id,connected_storage_id,task_id,file_id,status,reason,evidence,candidates,media_type,tmdb_id,season_number,episode_codes,import_status,manual,updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,$15) " +
        "ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,candidates=EXCLUDED.candidates,media_type=EXCLUDED.media_type,tmdb_id=EXCLUDED.tmdb_id,season_number=EXCLUDED.season_number,episode_codes=EXCLUDED.episode_codes,import_status=EXCLUDED.import_status,manual=EXCLUDED.manual,updated_at=EXCLUDED.updated_at " +
        "WHERE NOT library_scan_identifications.manual OR EXCLUDED.manual",
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.fileId, input.status, input.reason, JSON.stringify(input.evidence.slice(0, 40)), JSON.stringify(input.candidates.slice(0, 20)), input.mediaType, input.tmdbId, input.seasonNumber, JSON.stringify(input.episodeCodes.slice(0, 50)), input.importStatus, input.manual, input.now],
      );
      return true;
    });
  }

  async saveManualResult(scope: ScanScope, taskId: string, result: StoredIdentification): Promise<void> {
    await this.ensureSchema();
    await this.withTransaction(async (client) => {
      const fact = await client.query("SELECT 1 FROM library_scan_task_files WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 AND is_directory=false", [scope.accountId, scope.connectedStorageId, taskId, result.fileId]);
      if (!fact.rowCount) throw new IdentificationStoreScopeError("扫描文件不存在或不属于当前任务");
      await client.query(
        "INSERT INTO library_scan_identifications (account_id,connected_storage_id,task_id,file_id,status,reason,evidence,candidates,media_type,tmdb_id,season_number,episode_codes,import_status,manual,updated_at) " +
        "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,true,$14) " +
        "ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,candidates=EXCLUDED.candidates,media_type=EXCLUDED.media_type,tmdb_id=EXCLUDED.tmdb_id,season_number=EXCLUDED.season_number,episode_codes=EXCLUDED.episode_codes,import_status=EXCLUDED.import_status,manual=true,updated_at=EXCLUDED.updated_at",
        [scope.accountId, scope.connectedStorageId, taskId, result.fileId, result.status, result.reason, JSON.stringify(result.evidence), JSON.stringify(result.candidates), result.mediaType, result.tmdbId, result.seasonNumber, JSON.stringify(result.episodeCodes), result.importStatus, result.updatedAt],
      );
    });
  }

  async saveManualResultInTransaction(client: PoolClient, scope: ScanScope, taskId: string, result: StoredIdentification): Promise<void> {
    const fact = await client.query("SELECT 1 FROM library_scan_task_files WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 AND is_directory=false", [scope.accountId, scope.connectedStorageId, taskId, result.fileId]);
    if (!fact.rowCount) throw new IdentificationStoreScopeError("扫描文件不存在或不属于当前任务");
    const prior = await client.query<{ status: string; manual: boolean; media_type: string | null; tmdb_id: number | null; episode_codes: unknown }>("SELECT status,manual,media_type,tmdb_id,episode_codes FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 FOR UPDATE", [scope.accountId, scope.connectedStorageId, taskId, result.fileId]);
    const existing = prior.rows[0];
    if (existing?.status === "confirmed" && (existing.media_type !== result.mediaType || existing.tmdb_id !== result.tmdbId || JSON.stringify(jsonStringArray(existing.episode_codes).sort()) !== JSON.stringify([...result.episodeCodes].sort()))) {
      throw new IdentificationStoreScopeError("该文件已有不同身份或集号绑定，请先核对已有结果");
    }
    await client.query(
      "INSERT INTO library_scan_identifications (account_id,connected_storage_id,task_id,file_id,status,reason,evidence,candidates,media_type,tmdb_id,season_number,episode_codes,import_status,manual,updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,true,$14) " +
      "ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,candidates=EXCLUDED.candidates,media_type=EXCLUDED.media_type,tmdb_id=EXCLUDED.tmdb_id,season_number=EXCLUDED.season_number,episode_codes=EXCLUDED.episode_codes,import_status=EXCLUDED.import_status,manual=true,updated_at=EXCLUDED.updated_at",
      [scope.accountId, scope.connectedStorageId, taskId, result.fileId, result.status, result.reason, JSON.stringify(result.evidence), JSON.stringify(result.candidates), result.mediaType, result.tmdbId, result.seasonNumber, JSON.stringify(result.episodeCodes), result.importStatus, result.updatedAt],
    );
  }

  async commitAutomaticResultInTransaction(client: PoolClient, input: SaveIdentificationInput): Promise<boolean> {
    const job = await client.query<{ status: IdentificationJobStatus; lease_id: string | null; lease_expires_at: string | null }>("SELECT status,lease_id,lease_expires_at FROM library_identification_jobs WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId]);
    const current = job.rows[0];
    if (current?.status !== "running" || current.lease_id !== input.leaseId || !current.lease_expires_at || current.lease_expires_at <= input.now) return false;
    const task = await client.query<{ status: ScanTaskStatus }>("SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId]);
    if (task.rows[0]?.status !== "completed" && task.rows[0]?.status !== "partial") return false;
    const prior = await client.query<{ status: string; manual: boolean; media_type: string | null; tmdb_id: number | null; episode_codes: unknown }>("SELECT status,manual,media_type,tmdb_id,episode_codes FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 FOR UPDATE", [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.fileId]);
    const existing = prior.rows[0];
    if (existing?.manual) return false;
    if (existing?.status === "confirmed" && (existing.media_type !== input.mediaType || existing.tmdb_id !== input.tmdbId || JSON.stringify(jsonStringArray(existing.episode_codes).sort()) !== JSON.stringify([...input.episodeCodes].sort()))) {
      throw new IdentificationStoreScopeError("该文件已绑定其他作品或集号");
    }
    await client.query(
      "INSERT INTO library_scan_identifications (account_id,connected_storage_id,task_id,file_id,status,reason,evidence,candidates,media_type,tmdb_id,season_number,episode_codes,import_status,manual,updated_at) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,false,$14) ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE SET status=EXCLUDED.status,reason=EXCLUDED.reason,evidence=EXCLUDED.evidence,candidates=EXCLUDED.candidates,media_type=EXCLUDED.media_type,tmdb_id=EXCLUDED.tmdb_id,season_number=EXCLUDED.season_number,episode_codes=EXCLUDED.episode_codes,import_status=EXCLUDED.import_status,updated_at=EXCLUDED.updated_at WHERE NOT library_scan_identifications.manual",
      [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.fileId, input.status, input.reason, JSON.stringify(input.evidence), JSON.stringify(input.candidates), input.mediaType, input.tmdbId, input.seasonNumber, JSON.stringify(input.episodeCodes), input.importStatus, input.now],
    );
    await client.query("UPDATE library_identification_jobs SET after_file_id=$5,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status='running' AND lease_id=$4", [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.leaseId, input.fileId, input.now]);
    return true;
  }

  async advanceJob(scope: ScanScope, taskId: string, leaseId: string, afterFileId: string, now: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query("UPDATE library_identification_jobs SET after_file_id=$5,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status='running' AND lease_id=$4 AND lease_expires_at > $6", [scope.accountId, scope.connectedStorageId, taskId, leaseId, afterFileId, now]);
    return result.rowCount === 1;
  }

  async finishJob(scope: ScanScope, taskId: string, leaseId: string, status: "pending" | "completed" | "waiting" | "failed" | "cancelled", now: string, error?: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query("UPDATE library_identification_jobs SET status=$5,lease_id=NULL,lease_expires_at=NULL,last_error=$6,updated_at=$7 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4 AND lease_expires_at > $7", [scope.accountId, scope.connectedStorageId, taskId, leaseId, status, error?.slice(0, 500) ?? null, now]);
    return result.rowCount === 1;
  }

  async markImported(scope: ScanScope, taskId: string, fileId: string, now: string): Promise<void> {
    await this.ensureSchema();
    await this.pool.query("UPDATE library_scan_identifications SET import_status='imported',updated_at=$5 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=$4 AND status='confirmed'", [scope.accountId, scope.connectedStorageId, taskId, fileId, now]);
  }

  async listResults(scope: ScanScope, taskId: string, input: { limit: number; afterFileId?: string; status?: StoredIdentificationStatus }): Promise<StoredIdentification[]> {
    this.checkPage(input.limit);
    await this.ensureSchema();
    const result = await this.pool.query<{ file_id: string; status: StoredIdentificationStatus; reason: string; evidence: unknown; candidates: unknown; media_type: string | null; tmdb_id: number | null; season_number: number | null; episode_codes: unknown; import_status: IdentificationImportStatus; manual: boolean; updated_at: string }>(
      "SELECT file_id,status,reason,evidence,candidates,media_type,tmdb_id,season_number,episode_codes,import_status,manual,updated_at FROM library_scan_identifications " +
      "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND ($4::text IS NULL OR file_id>$4) AND ($5::text IS NULL OR status=$5) ORDER BY file_id LIMIT $6",
      [scope.accountId, scope.connectedStorageId, taskId, input.afterFileId ?? null, input.status ?? null, input.limit],
    );
    return result.rows.map((row) => ({ fileId: row.file_id, status: row.status, reason: row.reason, evidence: jsonArray(row.evidence), candidates: jsonArray(row.candidates), mediaType: row.media_type, tmdbId: row.tmdb_id, seasonNumber: row.season_number, episodeCodes: jsonStringArray(row.episode_codes), importStatus: row.import_status, manual: row.manual, updatedAt: row.updated_at }));
  }

  async getSummary(scope: ScanScope, taskId: string): Promise<{ job: IdentificationJob | null; total: number; confirmed: number; pending: number; ignored: number; failed: number; imported: number }> {
    await this.ensureSchema();
    const job = await this.withTransaction((client) => this.selectJob(client, scope, taskId));
    const counts = await this.pool.query<{ status: string; import_status: string; count: string }>("SELECT status,import_status,count(*)::text AS count FROM library_scan_identifications WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 GROUP BY status,import_status", [scope.accountId, scope.connectedStorageId, taskId]);
    const summary = { total: 0, confirmed: 0, pending: 0, ignored: 0, failed: 0, imported: 0 };
    for (const row of counts.rows) {
      const count = Number(row.count); summary.total += count;
      if (row.status in summary && row.status !== "total" && row.status !== "imported") summary[row.status as "confirmed" | "pending" | "ignored" | "failed"] += count;
      if (row.import_status === "imported") summary.imported += count;
    }
    return { job, ...summary };
  }

  async getTaskStatus(scope: ScanScope, taskId: string): Promise<ScanTaskStatus | null> {
    await this.ensureSchema();
    const result = await this.pool.query<{ status: ScanTaskStatus }>("SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3", [scope.accountId, scope.connectedStorageId, taskId]);
    return result.rows[0]?.status ?? null;
  }

  private checkPage(limit: number): void { if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new IdentificationStoreInputError("识别结果分页大小必须介于 1 到 500"); }
  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { try { await client.query("ROLLBACK"); } catch { /* retain original error */ } throw error; }
    finally { client.release(); }
  }
  private async selectTask(client: PoolClient, scope: ScanScope, taskId: string): Promise<{ status: ScanTaskStatus } | null> {
    const result = await client.query<{ status: ScanTaskStatus }>("SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3", [scope.accountId, scope.connectedStorageId, taskId]);
    return result.rows[0] ?? null;
  }
  private async selectJob(client: PoolClient, scope: ScanScope, taskId: string): Promise<IdentificationJob | null> {
    const result = await client.query<{ status: IdentificationJobStatus; after_file_id: string | null; attempts: number; last_error: string | null; scan_status: ScanTaskStatus }>(
      "SELECT j.status,j.after_file_id,j.attempts,j.last_error,t.status AS scan_status FROM library_identification_jobs j " +
      "JOIN library_scan_tasks t USING (account_id,connected_storage_id,task_id) WHERE j.account_id=$1 AND j.connected_storage_id=$2 AND j.task_id=$3",
      [scope.accountId, scope.connectedStorageId, taskId],
    );
    const row = result.rows[0];
    return row ? { scope, taskId, status: row.status, afterFileId: row.after_file_id, attempts: row.attempts, lastError: row.last_error, scanStatus: row.scan_status } : null;
  }
}

function jsonArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function jsonStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
