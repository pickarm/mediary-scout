import type { Pool, PoolClient } from "pg";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import type {
  ScanConfiguration,
  ScanDirectoryCheckpoint,
  ScanDirectoryStatus,
  ScanFileFact,
  ScanScope,
  ScanStore,
  ScanTask,
  ScanTaskStatus,
} from "./scanner.js";

export const LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_143;

const SCAN_SCHEMA = `
  CREATE TABLE IF NOT EXISTS library_scan_configs (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    config_id text NOT NULL,
    configuration jsonb NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, config_id)
  );
  CREATE TABLE IF NOT EXISTS library_scan_tasks (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    config_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued','running','paused','cancelling','cancelled','completed','partial','failed')),
    lease_id text,
    lease_expires_at text,
    directories_done integer NOT NULL DEFAULT 0,
    files_discovered integer NOT NULL DEFAULT 0,
    directories_discovered integer NOT NULL DEFAULT 0,
    created_at text NOT NULL,
    updated_at text NOT NULL,
    PRIMARY KEY (account_id, connected_storage_id, task_id),
    FOREIGN KEY (account_id, connected_storage_id, config_id)
      REFERENCES library_scan_configs (account_id, connected_storage_id, config_id)
  );
  CREATE INDEX IF NOT EXISTS library_scan_tasks_status
    ON library_scan_tasks (account_id, connected_storage_id, status, updated_at);
  CREATE TABLE IF NOT EXISTS library_scan_directories (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    directory_id text NOT NULL,
    parent_directory_id text,
    path text NOT NULL,
    next_page integer NOT NULL DEFAULT 0,
    status text NOT NULL CHECK (status IN ('pending','running','done','failed')),
    PRIMARY KEY (account_id, connected_storage_id, task_id, directory_id),
    FOREIGN KEY (account_id, connected_storage_id, task_id)
      REFERENCES library_scan_tasks (account_id, connected_storage_id, task_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_scan_directories_pending
    ON library_scan_directories (account_id, connected_storage_id, task_id, status, path);
  CREATE TABLE IF NOT EXISTS library_scan_files (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    file_id text NOT NULL,
    parent_directory_id text NOT NULL,
    name text NOT NULL,
    is_directory boolean NOT NULL,
    size_bytes bigint,
    path text NOT NULL,
    modified_at text,
    PRIMARY KEY (account_id, connected_storage_id, file_id)
  );
  CREATE INDEX IF NOT EXISTS library_scan_files_parent
    ON library_scan_files (account_id, connected_storage_id, parent_directory_id, file_id);
  CREATE TABLE IF NOT EXISTS library_scan_task_files (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    file_id text NOT NULL,
    parent_directory_id text NOT NULL,
    name text NOT NULL,
    is_directory boolean NOT NULL,
    size_bytes bigint,
    path text NOT NULL,
    modified_at text,
    PRIMARY KEY (account_id, connected_storage_id, task_id, file_id),
    FOREIGN KEY (account_id, connected_storage_id, task_id)
      REFERENCES library_scan_tasks (account_id, connected_storage_id, task_id) ON DELETE CASCADE,
    FOREIGN KEY (account_id, connected_storage_id, file_id)
      REFERENCES library_scan_files (account_id, connected_storage_id, file_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS library_scan_task_files_parent
    ON library_scan_task_files (account_id, connected_storage_id, task_id, parent_directory_id, file_id);
  CREATE TABLE IF NOT EXISTS library_scan_failures (
    account_id text NOT NULL,
    connected_storage_id text NOT NULL,
    task_id text NOT NULL,
    sequence bigserial NOT NULL,
    directory_id text NOT NULL,
    page integer NOT NULL,
    message text NOT NULL,
    created_at text NOT NULL,
    resolved_at text,
    PRIMARY KEY (account_id, connected_storage_id, task_id, sequence),
    FOREIGN KEY (account_id, connected_storage_id, task_id)
      REFERENCES library_scan_tasks (account_id, connected_storage_id, task_id) ON DELETE CASCADE
  );
`;
const SCAN_SCHEMA_COMPAT = `
  ALTER TABLE library_scan_tasks ADD COLUMN IF NOT EXISTS lease_id text;
  ALTER TABLE library_scan_tasks ADD COLUMN IF NOT EXISTS lease_expires_at text;
  ALTER TABLE library_scan_failures ADD COLUMN IF NOT EXISTS resolved_at text;
`;

interface TaskRow {
  task_id: string;
  account_id: string;
  connected_storage_id: string;
  config_id: string;
  status: ScanTaskStatus;
  directories_done: number;
  files_discovered: number;
  directories_discovered: number;
  created_at: string;
  updated_at: string;
}
interface DirectoryRow {
  directory_id: string;
  parent_directory_id: string | null;
  path: string;
  next_page: number;
  status: ScanDirectoryStatus;
}
interface FileRow {
  file_id: string;
  parent_directory_id: string;
  name: string;
  is_directory: boolean;
  size_bytes: string | number | null;
  path: string;
  modified_at: string | null;
}
interface FailureRow { directory_id: string; page: number; message: string }

export class ScanStorageScopeError extends Error {
  constructor(message: string) { super(message); this.name = "ScanStorageScopeError"; }
}
export class ScanStoreInputError extends Error {
  constructor(message: string) { super(message); this.name = "ScanStoreInputError"; }
}

/** PostgreSQL checkpoint store. Each page and all facts/children in it commit atomically. */
export class PostgresScanStore implements ScanStore {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;

  constructor(pool: Pool) { this.pool = pool; }

  async ensureSchema(): Promise<void> {
    if (!this.schemaReady) this.schemaReady = this.initializeSchema();
    try { await this.schemaReady; } catch (error) { this.schemaReady = null; throw error; }
  }

  private async initializeSchema(): Promise<void> {
    // Scan ownership checks rely on connected_storages; initialize the base schema first
    // so a fresh isolated database is usable without the caller reproducing app boot order.
    await initializeWorkflowPostgresSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY]);
      try {
        await client.query(SCAN_SCHEMA);
        await client.query(SCAN_SCHEMA_COMPAT);
      }
      finally { await client.query("SELECT pg_advisory_unlock($1)", [LIBRARY_SCAN_SCHEMA_ADVISORY_LOCK_KEY]); }
    } finally { client.release(); }
  }

  async saveConfiguration(configuration: ScanConfiguration): Promise<void> {
    validateConfiguration(configuration);
    await this.ensureSchema();
    await this.withTransaction(async (client) => {
      await this.assertOwnership(client, configuration.scope);
      const existing = await client.query<{ configuration: unknown; same: boolean }>(
        "SELECT configuration,configuration=$4::jsonb AS same FROM library_scan_configs " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND config_id=$3 FOR UPDATE",
        [configuration.scope.accountId, configuration.scope.connectedStorageId, configuration.configId, JSON.stringify(configuration)],
      );
      if (existing.rows[0]?.same === false) {
        const activeTask = await client.query(
          "SELECT 1 FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND config_id=$3 " +
            "AND status IN ('queued','running','paused') LIMIT 1",
          [configuration.scope.accountId, configuration.scope.connectedStorageId, configuration.configId],
        );
        if (activeTask.rowCount) throw new ScanStoreInputError("存在排队、运行或暂停中的扫描任务，暂不能修改配置");
      }
      await client.query(
        "INSERT INTO library_scan_configs (account_id, connected_storage_id, config_id, configuration, updated_at) " +
          "VALUES ($1,$2,$3,$4::jsonb,$5) ON CONFLICT (account_id,connected_storage_id,config_id) DO UPDATE SET configuration=EXCLUDED.configuration,updated_at=EXCLUDED.updated_at",
        [configuration.scope.accountId, configuration.scope.connectedStorageId, configuration.configId, JSON.stringify(configuration), new Date().toISOString()],
      );
    });
  }

  async getConfiguration(scope: ScanScope, configId: string): Promise<ScanConfiguration | null> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client, scope);
      const result = await client.query<{ configuration: unknown }>(
        "SELECT configuration FROM library_scan_configs WHERE account_id=$1 AND connected_storage_id=$2 AND config_id=$3",
        [scope.accountId, scope.connectedStorageId, configId],
      );
      const raw = result.rows[0]?.configuration;
      if (!raw || typeof raw !== "object") return null;
      const config = raw as ScanConfiguration;
      if (config.scope?.accountId !== scope.accountId || config.scope.connectedStorageId !== scope.connectedStorageId || config.configId !== configId) return null;
      validateConfiguration(config);
      return config;
    });
  }

  async createTask(input: { taskId: string; scope: ScanScope; configuration: ScanConfiguration; roots: readonly { directoryId: string; name: string }[]; now: string }): Promise<ScanTask> {
    if (!input.taskId.trim() || input.roots.length === 0) throw new ScanStoreInputError("task id and at least one root are required");
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client, input.scope);
      const config = await client.query<{ configuration: ScanConfiguration; matches: boolean }>(
        "SELECT configuration,configuration=$4::jsonb AS matches FROM library_scan_configs WHERE account_id=$1 AND connected_storage_id=$2 AND config_id=$3 FOR KEY SHARE",
        [input.scope.accountId, input.scope.connectedStorageId, input.configuration.configId, JSON.stringify(input.configuration)],
      );
      const saved = config.rows[0]?.configuration;
      if (!saved || config.rows[0]?.matches !== true || !sameRoots(saved.sourceRoots, input.roots)) throw new ScanStorageScopeError("扫描根与已保存授权配置不匹配");
      await client.query(
        "INSERT INTO library_scan_tasks (account_id,connected_storage_id,task_id,config_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,'queued',$5,$5)",
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.configuration.configId, input.now],
      );
      for (const root of input.roots) {
        await client.query(
          "INSERT INTO library_scan_directories (account_id,connected_storage_id,task_id,directory_id,parent_directory_id,path,next_page,status) VALUES ($1,$2,$3,$4,NULL,$5,0,'pending') ON CONFLICT DO NOTHING",
          [input.scope.accountId, input.scope.connectedStorageId, input.taskId, root.directoryId, root.name],
        );
      }
      await client.query("UPDATE library_scan_tasks SET directories_discovered=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.roots.length]);
      return (await this.selectTask(client, input.scope, input.taskId))!;
    });
  }

  async getTask(scope: ScanScope, taskId: string): Promise<ScanTask | null> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client, scope);
      return this.selectTask(client, scope, taskId);
    });
  }

  async claimTask(scope: ScanScope, taskId: string, leaseId: string, now: string, leaseExpiresAt: string): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client, scope);
      const result = await client.query(
        "UPDATE library_scan_tasks SET status='running',lease_id=$4,lease_expires_at=$5,updated_at=$6 " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND " +
          "(status IN ('queued','paused') OR (status='running' AND (lease_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= $6)))",
        [scope.accountId,scope.connectedStorageId,taskId,leaseId,leaseExpiresAt,now],
      );
      return result.rowCount === 1;
    });
  }

  async renewTaskLease(scope: ScanScope, taskId: string, leaseId: string, leaseExpiresAt: string, now: string): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client, scope);
      const result = await client.query(
        "UPDATE library_scan_tasks SET lease_expires_at=$5,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4 AND status='running'",
        [scope.accountId,scope.connectedStorageId,taskId,leaseId,leaseExpiresAt,now],
      );
      return result.rowCount === 1;
    });
  }

  async listDirectories(scope: ScanScope, taskId: string, statuses: readonly ScanDirectoryStatus[]): Promise<ScanDirectoryCheckpoint[]> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertTaskScope(client, scope, taskId);
      if (statuses.length === 0) return [];
      const result = await client.query<DirectoryRow>(
        "SELECT directory_id,parent_directory_id,path,next_page,status FROM library_scan_directories " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status=ANY($4::text[]) ORDER BY path,directory_id LIMIT 1",
        [scope.accountId, scope.connectedStorageId, taskId, statuses],
      );
      return result.rows.map(directoryFromRow);
    });
  }

  async commitPage(input: { scope: ScanScope; taskId: string; leaseId: string; directory: ScanDirectoryCheckpoint; facts: readonly ScanFileFact[]; childDirectories: readonly ScanDirectoryCheckpoint[]; nextPage: number | null; now: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      if (!(await this.lockTaskLease(client, input.scope, input.taskId, input.leaseId))) return false;
      const current = await client.query<DirectoryRow>(
        "SELECT directory_id,parent_directory_id,path,next_page,status FROM library_scan_directories WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id=$4 FOR UPDATE",
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId, input.directory.directoryId],
      );
      const row = current.rows[0];
      if (!row || Number(row.next_page) !== input.directory.nextPage || (row.status !== "pending" && row.status !== "running")) return false;
      for (const fact of input.facts) {
        await client.query(
          "INSERT INTO library_scan_files (account_id,connected_storage_id,file_id,parent_directory_id,name,is_directory,size_bytes,path,modified_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) " +
            "ON CONFLICT (account_id,connected_storage_id,file_id) DO UPDATE SET parent_directory_id=EXCLUDED.parent_directory_id,name=EXCLUDED.name,is_directory=EXCLUDED.is_directory,size_bytes=EXCLUDED.size_bytes,path=EXCLUDED.path,modified_at=EXCLUDED.modified_at",
          [input.scope.accountId,input.scope.connectedStorageId,fact.fileId,fact.parentDirectoryId,fact.name,fact.isDirectory,fact.sizeBytes,fact.path,fact.modifiedAt],
        );
        await client.query(
          "INSERT INTO library_scan_task_files (account_id,connected_storage_id,task_id,file_id,parent_directory_id,name,is_directory,size_bytes,path,modified_at) " +
            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) " +
            "ON CONFLICT (account_id,connected_storage_id,task_id,file_id) DO UPDATE SET parent_directory_id=EXCLUDED.parent_directory_id,name=EXCLUDED.name,is_directory=EXCLUDED.is_directory,size_bytes=EXCLUDED.size_bytes,path=EXCLUDED.path,modified_at=EXCLUDED.modified_at",
          [input.scope.accountId,input.scope.connectedStorageId,input.taskId,fact.fileId,fact.parentDirectoryId,fact.name,fact.isDirectory,fact.sizeBytes,fact.path,fact.modifiedAt],
        );
      }
      for (const child of input.childDirectories) {
        await client.query(
          "INSERT INTO library_scan_directories (account_id,connected_storage_id,task_id,directory_id,parent_directory_id,path,next_page,status) VALUES ($1,$2,$3,$4,$5,$6,0,'pending') ON CONFLICT (account_id,connected_storage_id,task_id,directory_id) DO NOTHING",
          [input.scope.accountId,input.scope.connectedStorageId,input.taskId,child.directoryId,child.parentDirectoryId,child.path],
        );
      }
      const complete = input.nextPage === null;
      await client.query(
        "UPDATE library_scan_directories SET next_page=COALESCE($5,next_page),status=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id=$4",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.directory.directoryId,input.nextPage,complete ? "done" : "pending"],
      );
      await client.query(
        "UPDATE library_scan_failures SET resolved_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id=$4 AND page=$5 AND resolved_at IS NULL",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.directory.directoryId,input.directory.nextPage,input.now],
      );
      const stats = await client.query<{ files: string; directories: string }>(
        "SELECT count(*) FILTER (WHERE NOT is_directory)::text AS files,count(*) FILTER (WHERE is_directory)::text AS directories FROM library_scan_task_files WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId],
      );
      const counts = await client.query<{ done: string; discovered: string }>(
        "SELECT count(*) FILTER (WHERE status='done')::text AS done,count(*)::text AS discovered FROM library_scan_directories WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId],
      );
      await client.query(
        "UPDATE library_scan_tasks SET files_discovered=$4,directories_discovered=$5,directories_done=$6,updated_at=$7 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,Number(stats.rows[0]?.files ?? 0),Number(counts.rows[0]?.discovered ?? 0),Number(counts.rows[0]?.done ?? 0),input.now],
      );
      return true;
    });
  }

  async failPage(input: { scope: ScanScope; taskId: string; leaseId: string; directoryId: string; page: number; message: string; now: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      if (!(await this.lockTaskLease(client, input.scope, input.taskId, input.leaseId))) return false;
      const current = await client.query<DirectoryRow>(
        "SELECT directory_id,parent_directory_id,path,next_page,status FROM library_scan_directories " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id=$4 FOR UPDATE",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.directoryId],
      );
      const row = current.rows[0];
      if (!row || Number(row.next_page) !== input.page || (row.status !== "pending" && row.status !== "running")) return false;
      await client.query(
        "INSERT INTO library_scan_failures (account_id,connected_storage_id,task_id,directory_id,page,message,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.directoryId,input.page,input.message.slice(0,1000),input.now],
      );
      await client.query(
        "UPDATE library_scan_directories SET status='failed' WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id=$4 AND next_page=$5",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.directoryId,input.page],
      );
      return true;
    });
  }

  async finishTask(input: { scope: ScanScope; taskId: string; leaseId: string; status: "completed" | "partial" | "failed"; message?: string; now: string }): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      if (!(await this.lockTaskLease(client,input.scope,input.taskId,input.leaseId))) return false;
      if (input.message) {
        await client.query(
          "INSERT INTO library_scan_failures (account_id,connected_storage_id,task_id,directory_id,page,message,created_at) VALUES ($1,$2,$3,'',0,$4,$5)",
          [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.message.slice(0,1000),input.now],
        );
      }
      const result = await client.query(
        "UPDATE library_scan_tasks SET status=$5,lease_id=NULL,lease_expires_at=NULL,updated_at=$6 " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND lease_id=$4 AND status='running'",
        [input.scope.accountId,input.scope.connectedStorageId,input.taskId,input.leaseId,input.status,input.now],
      );
      return result.rowCount === 1;
    });
  }

  async transitionTaskStatus(scope: ScanScope, taskId: string, expected: ScanTaskStatus, status: "paused" | "cancelled", now: string): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertTaskScope(client,scope,taskId);
      const result = await client.query(
        "UPDATE library_scan_tasks SET status=$5,lease_id=NULL,lease_expires_at=NULL,updated_at=$6 " +
          "WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status=$4",
        [scope.accountId,scope.connectedStorageId,taskId,expected,status,now],
      );
      return result.rowCount === 1;
    });
  }

  async resetFailedDirectories(scope: ScanScope, taskId: string, now: string): Promise<boolean> {
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertOwnership(client,scope);
      const task = await client.query<{ status: ScanTaskStatus }>(
        "SELECT status FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE",
        [scope.accountId,scope.connectedStorageId,taskId],
      );
      if (task.rows[0]?.status !== "partial" && task.rows[0]?.status !== "failed") return false;
      const wasFailed = task.rows[0].status === "failed";
      const reset = await client.query<{ directory_id: string }>(
        "UPDATE library_scan_directories SET status='pending' WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 " +
          (wasFailed ? "AND status IN ('failed','pending','running')" : "AND status='failed'") + " RETURNING directory_id",
        [scope.accountId,scope.connectedStorageId,taskId],
      );
      const taskFailure = wasFailed
        ? await client.query(
          "SELECT 1 FROM library_scan_failures WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id='' AND resolved_at IS NULL LIMIT 1",
          [scope.accountId,scope.connectedStorageId,taskId],
        )
        : { rowCount: 0 };
      if (reset.rowCount === 0 && !taskFailure.rowCount) return false;
      if (wasFailed && taskFailure.rowCount) {
        await client.query(
          "UPDATE library_scan_failures SET resolved_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND directory_id='' AND resolved_at IS NULL",
          [scope.accountId,scope.connectedStorageId,taskId,now],
        );
      }
      await client.query(
        "UPDATE library_scan_tasks SET status='queued',lease_id=NULL,lease_expires_at=NULL,updated_at=$4 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
        [scope.accountId,scope.connectedStorageId,taskId,now],
      );
      return true;
    });
  }

  async listTaskFiles(scope: ScanScope, taskId: string, input: { limit?: number; afterFileId?: string } = {}): Promise<ScanFileFact[]> {
    const limit = input.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ScanStoreInputError("scan file page size must be between 1 and 500");
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertTaskScope(client,scope,taskId);
      const params: Array<string | number> = [scope.accountId,scope.connectedStorageId,taskId];
      let cursor = "";
      if (input.afterFileId !== undefined) { params.push(input.afterFileId); cursor = ` AND file_id > $${params.length}`; }
      params.push(limit);
      const result = await client.query<FileRow>(
        "SELECT file_id,parent_directory_id,name,is_directory,size_bytes,path,modified_at FROM library_scan_task_files " +
          `WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3${cursor} ORDER BY file_id LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(fileFromRow);
    });
  }

  async listTaskDirectories(scope: ScanScope, taskId: string, input: { limit?: number; afterDirectoryId?: string } = {}): Promise<ScanDirectoryCheckpoint[]> {
    const limit = input.limit ?? 200;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ScanStoreInputError("scan directory page size must be between 1 and 500");
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertTaskScope(client,scope,taskId);
      const params: Array<string | number> = [scope.accountId,scope.connectedStorageId,taskId];
      let cursor = "";
      if (input.afterDirectoryId !== undefined) { params.push(input.afterDirectoryId); cursor = ` AND directory_id > $${params.length}`; }
      params.push(limit);
      const result = await client.query<DirectoryRow>(
        "SELECT directory_id,parent_directory_id,path,next_page,status FROM library_scan_directories " +
          `WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3${cursor} ORDER BY directory_id LIMIT $${params.length}`,
        params,
      );
      return result.rows.map(directoryFromRow);
    });
  }

  async listTaskFailures(scope: ScanScope, taskId: string, limit = 100): Promise<Array<{ directoryId: string; page: number; message: string }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new ScanStoreInputError("failure page size must be between 1 and 500");
    await this.ensureSchema();
    return this.withTransaction(async (client) => {
      await this.assertTaskScope(client,scope,taskId);
      const result = await client.query<FailureRow>(
        "SELECT directory_id,page,message FROM library_scan_failures WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND resolved_at IS NULL ORDER BY sequence DESC LIMIT $4",
        [scope.accountId,scope.connectedStorageId,taskId,limit],
      );
      return result.rows.map((row) => ({ directoryId: row.directory_id,page: row.page,message: row.message }));
    });
  }

  private async selectTask(client: PoolClient, scope: ScanScope, taskId: string): Promise<ScanTask | null> {
    const result = await client.query<TaskRow>(
      "SELECT task_id,account_id,connected_storage_id,config_id,status,directories_done,files_discovered,directories_discovered,created_at,updated_at " +
        "FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3",
      [scope.accountId,scope.connectedStorageId,taskId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const failures = await client.query<FailureRow>(
      "SELECT directory_id,page,message FROM library_scan_failures WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND resolved_at IS NULL ORDER BY sequence DESC LIMIT 100",
      [scope.accountId,scope.connectedStorageId,taskId],
    );
    return {
      taskId: row.task_id,
      scope: { accountId: row.account_id, connectedStorageId: row.connected_storage_id },
      configId: row.config_id,
      status: row.status,
      directoriesDone: Number(row.directories_done),
      filesDiscovered: Number(row.files_discovered),
      directoriesDiscovered: Number(row.directories_discovered),
      failures: failures.rows.map((failure) => ({ directoryId: failure.directory_id,page: failure.page,message: failure.message })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async assertOwnership(client: PoolClient, scope: ScanScope): Promise<void> {
    const result = await client.query("SELECT 1 FROM connected_storages WHERE id=$1 AND account_id=$2 AND provider='guangyapan'", [scope.connectedStorageId,scope.accountId]);
    if (!result.rowCount) throw new ScanStorageScopeError("网盘不存在或不属于指定账号");
  }
  private async assertTaskScope(client: PoolClient, scope: ScanScope, taskId: string): Promise<void> {
    await this.assertOwnership(client,scope);
    const result = await client.query("SELECT 1 FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3", [scope.accountId,scope.connectedStorageId,taskId]);
    if (!result.rowCount) throw new ScanStorageScopeError("扫描任务不存在或超出账号/网盘作用域");
  }
  private async lockTaskLease(client: PoolClient, scope: ScanScope, taskId: string, leaseId: string): Promise<boolean> {
    await this.assertOwnership(client,scope);
    const result = await client.query(
      "SELECT 1 FROM library_scan_tasks WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND status='running' AND lease_id=$4 FOR UPDATE",
      [scope.accountId,scope.connectedStorageId,taskId,leaseId],
    );
    return result.rowCount === 1;
  }
  private async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

function validateConfiguration(config: ScanConfiguration): void {
  if (!config.configId.trim() || !config.scope.accountId.trim() || !config.scope.connectedStorageId.trim()) throw new ScanStoreInputError("config id and storage scope are required");
  if (!Array.isArray(config.sourceRoots) || config.sourceRoots.length < 1 || config.sourceRoots.length > 100) throw new ScanStoreInputError("sourceRoots must contain 1 to 100 directories");
  if (config.mediaKind !== "movie" && config.mediaKind !== "tv" && config.mediaKind !== "mixed") throw new ScanStoreInputError("invalid mediaKind");
  if (config.dailyScheduleEnabled && (!config.dailyScheduleTime || !/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dailyScheduleTime))) throw new ScanStoreInputError("dailyScheduleTime must be HH:mm (Asia/Shanghai)");
  if (config.dailyScheduleTimezone !== "Asia/Shanghai") throw new ScanStoreInputError("dailyScheduleTimezone must be Asia/Shanghai");
  if (config.autoAcquire !== false) throw new ScanStoreInputError("autoAcquire must remain disabled by default");
  const ids = new Set<string>();
  for (const root of config.sourceRoots) {
    if (!root.directoryId.trim() || !root.name.trim() || ids.has(root.directoryId)) throw new ScanStoreInputError("source roots must have unique directory ids and names");
    ids.add(root.directoryId);
  }
}
function sameRoots(left: readonly { directoryId: string; name: string }[], right: readonly { directoryId: string; name: string }[]): boolean {
  return left.length === right.length && left.every((root, i) => root.directoryId === right[i]?.directoryId && root.name === right[i]?.name);
}
function directoryFromRow(row: DirectoryRow): ScanDirectoryCheckpoint {
  return { directoryId: row.directory_id,parentDirectoryId: row.parent_directory_id,path: row.path,nextPage: Number(row.next_page),status: row.status };
}
function fileFromRow(row: FileRow): ScanFileFact {
  return { fileId: row.file_id,parentDirectoryId: row.parent_directory_id,name: row.name,isDirectory: row.is_directory,sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),path: row.path,modifiedAt: row.modified_at };
}
