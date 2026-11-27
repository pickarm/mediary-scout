import type { Pool, PoolClient } from "pg";
import { STORAGE_BRANDS } from "../storage-brands.js";
import {
  computeNamingTemplatesFingerprint,
  renderExpectedVideoTarget,
  type OrganizationIdentity,
  type OrganizationScope,
} from "./organizer.js";
import { DEFAULT_NAMING_TEMPLATES, type NamingTemplateKind } from "./naming.js";

export const LIBRARY_ORGANIZED_INDEX_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_151;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_organized_index (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  file_id text NOT NULL,
  parent_directory_id text NOT NULL,
  target_root_id text NOT NULL,
  organized_name text NOT NULL,
  organized_relative_path text NOT NULL,
  template_fingerprint text NOT NULL,
  source text NOT NULL CHECK (source IN ('acquisition','organization')),
  media_title_id text NOT NULL,
  tracked_season_id text NOT NULL,
  identity jsonb NOT NULL,
  drift_status text NOT NULL DEFAULT 'clean' CHECK (drift_status IN ('clean','drifted','ignored')),
  drift_reason text,
  observed_task_id text,
  observed_parent_directory_id text,
  observed_name text,
  observed_relative_path text,
  expected_name text,
  expected_relative_path text,
  expected_template_fingerprint text,
  ignored_name text,
  ignored_parent_directory_id text,
  ignored_template_fingerprint text,
  ignored_at timestamptz,
  organized_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, connected_storage_id, file_id)
);
CREATE INDEX IF NOT EXISTS library_organized_index_drift
  ON library_organized_index(account_id, connected_storage_id, drift_status, updated_at DESC, file_id);
CREATE INDEX IF NOT EXISTS library_organized_index_parent
  ON library_organized_index(account_id, connected_storage_id, parent_directory_id, file_id);
`;

const REGISTERED_STORAGE_PROVIDERS = STORAGE_BRANDS.map(({ provider }) => provider);
const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".avi", ".mov", ".wmv", ".m4v", ".ts", ".m2ts", ".webm"]);

export type OrganizedIndexSource = "acquisition" | "organization";
export type OrganizedIndexDriftStatus = "clean" | "drifted" | "ignored";

export interface OrganizedIndexEntry {
  accountId: string;
  connectedStorageId: string;
  fileId: string;
  parentDirectoryId: string;
  targetRootId: string;
  organizedName: string;
  organizedRelativePath: string;
  templateFingerprint: string;
  source: OrganizedIndexSource;
  mediaTitleId: string;
  trackedSeasonId: string;
  identity: OrganizationIdentity;
  driftStatus: OrganizedIndexDriftStatus;
  driftReason: string | null;
  observedTaskId: string | null;
  observedParentDirectoryId: string | null;
  observedName: string | null;
  observedRelativePath: string | null;
  expectedName: string | null;
  expectedRelativePath: string | null;
  expectedTemplateFingerprint: string | null;
  ignoredName: string | null;
  ignoredParentDirectoryId: string | null;
  ignoredTemplateFingerprint: string | null;
  ignoredAt: string | null;
  organizedAt: string;
  lastSeenAt: string;
  updatedAt: string;
}

export interface UpsertOrganizedIndexInput {
  scope: OrganizationScope;
  fileId: string;
  parentDirectoryId: string;
  targetRootId: string;
  organizedName: string;
  organizedRelativePath: string;
  templateFingerprint: string;
  source: OrganizedIndexSource;
  identity: OrganizationIdentity;
  now?: string;
}

export interface OrganizedIndexReconcileSummary {
  cleanSkipped: number;
  drifted: number;
  ignored: number;
  removed: number;
  indexedTotal: number;
}

export interface OrganizedDriftListPage {
  items: OrganizedIndexEntry[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: {
    totalIndexed: number;
    drifted: number;
    ignored: number;
  };
}

interface IndexRow {
  account_id: string;
  connected_storage_id: string;
  file_id: string;
  parent_directory_id: string;
  target_root_id: string;
  organized_name: string;
  organized_relative_path: string;
  template_fingerprint: string;
  source: OrganizedIndexSource;
  media_title_id: string;
  tracked_season_id: string;
  identity: unknown;
  drift_status: OrganizedIndexDriftStatus;
  drift_reason: string | null;
  observed_task_id: string | null;
  observed_parent_directory_id: string | null;
  observed_name: string | null;
  observed_relative_path: string | null;
  expected_name: string | null;
  expected_relative_path: string | null;
  expected_template_fingerprint: string | null;
  ignored_name: string | null;
  ignored_parent_directory_id: string | null;
  ignored_template_fingerprint: string | null;
  ignored_at: Date | null;
  organized_at: Date;
  last_seen_at: Date;
  updated_at: Date;
}

export class PostgresOrganizedIndexStore {
  private schema: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  ensureSchema(): Promise<void> {
    if (!this.schema) {
      this.schema = this.initialize().catch((error: unknown) => {
        this.schema = null;
        throw error;
      });
    }
    return this.schema;
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LIBRARY_ORGANIZED_INDEX_SCHEMA_ADVISORY_LOCK_KEY]);
      await client.query(SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertOrganized(input: UpsertOrganizedIndexInput): Promise<void> {
    await this.ensureSchema();
    const now = input.now ?? new Date().toISOString();
    await this.pool.query(
      `INSERT INTO library_organized_index (
         account_id, connected_storage_id, file_id, parent_directory_id, target_root_id,
         organized_name, organized_relative_path, template_fingerprint, source,
         media_title_id, tracked_season_id, identity,
         drift_status, drift_reason,
         observed_parent_directory_id, observed_name, observed_relative_path,
         expected_name, expected_relative_path, expected_template_fingerprint,
         ignored_name, ignored_parent_directory_id, ignored_template_fingerprint, ignored_at,
         organized_at, last_seen_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12::jsonb,
         'clean', NULL,
         $4, $6, $7,
         $6, $7, $8,
         NULL, NULL, NULL, NULL,
         $13, $13, $13
       )
       ON CONFLICT (account_id, connected_storage_id, file_id) DO UPDATE SET
         parent_directory_id=EXCLUDED.parent_directory_id,
         target_root_id=EXCLUDED.target_root_id,
         organized_name=EXCLUDED.organized_name,
         organized_relative_path=EXCLUDED.organized_relative_path,
         template_fingerprint=EXCLUDED.template_fingerprint,
         source=EXCLUDED.source,
         media_title_id=EXCLUDED.media_title_id,
         tracked_season_id=EXCLUDED.tracked_season_id,
         identity=EXCLUDED.identity,
         drift_status='clean',
         drift_reason=NULL,
         observed_parent_directory_id=EXCLUDED.observed_parent_directory_id,
         observed_name=EXCLUDED.observed_name,
         observed_relative_path=EXCLUDED.observed_relative_path,
         expected_name=EXCLUDED.expected_name,
         expected_relative_path=EXCLUDED.expected_relative_path,
         expected_template_fingerprint=EXCLUDED.expected_template_fingerprint,
         ignored_name=NULL,
         ignored_parent_directory_id=NULL,
         ignored_template_fingerprint=NULL,
         ignored_at=NULL,
         organized_at=EXCLUDED.organized_at,
         last_seen_at=EXCLUDED.last_seen_at,
         updated_at=EXCLUDED.updated_at`,
      [
        input.scope.accountId,
        input.scope.connectedStorageId,
        input.fileId,
        input.parentDirectoryId,
        input.targetRootId,
        input.organizedName,
        input.organizedRelativePath,
        input.templateFingerprint,
        input.source,
        input.identity.mediaTitleId,
        input.identity.trackedSeasonId,
        JSON.stringify(input.identity),
        now,
      ],
    );
  }

  async reconcileScanTask(input: {
    scope: OrganizationScope;
    taskId: string;
    now?: string;
  }): Promise<OrganizedIndexReconcileSummary> {
    await this.ensureSchema();
    const now = input.now ?? new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertStorage(client, input.scope);

      const taskResult = await client.query<{ status: string; configuration: unknown }>(
        `SELECT t.status, c.configuration
           FROM library_scan_tasks t
           JOIN library_scan_configs c
             ON c.account_id=t.account_id
            AND c.connected_storage_id=t.connected_storage_id
            AND c.config_id=t.config_id
          WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow || (taskRow.status !== "completed" && taskRow.status !== "partial")) {
        await client.query("COMMIT");
        return { cleanSkipped: 0, drifted: 0, ignored: 0, removed: 0, indexedTotal: 0 };
      }

      const config = asRecord(taskRow.configuration);
      const templates = normalizeTemplates(config.templates);
      const currentFingerprint = computeNamingTemplatesFingerprint(templates);
      const movieTargetRoot = asOptionalString(config.movieTargetDirectoryId);
      const tvTargetRoot = asOptionalString(config.tvTargetDirectoryId);

      // 冷启动兼容：把此前历史整理成功但尚未建档的文件先纳入基线索引
      await this.backfillVerifiedOperations(client, input.scope, currentFingerprint, now);

      const dirRows = await client.query<{
        directory_id: string;
        parent_directory_id: string | null;
        path: string;
        status: string;
      }>(
        `SELECT directory_id, parent_directory_id, path, status
           FROM library_scan_directories
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId],
      );
      const dirParents = new Map<string, { parentDirectoryId: string | null; name: string }>();
      const doneDirectories = new Set<string>();
      for (const row of dirRows.rows) {
        dirParents.set(row.directory_id, {
          parentDirectoryId: row.parent_directory_id,
          name: pathLeaf(row.path),
        });
        if (row.status === "done") doneDirectories.add(row.directory_id);
      }

      const scanFiles = await client.query<{
        file_id: string;
        parent_directory_id: string;
        name: string;
        is_directory: boolean;
        path: string;
      }>(
        `SELECT file_id, parent_directory_id, name, is_directory, path
           FROM library_scan_task_files
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
        [input.scope.accountId, input.scope.connectedStorageId, input.taskId],
      );
      const seenAllIds = new Set<string>();
      const scannedVideos: Array<{ fileId: string; parentDirectoryId: string; name: string; path: string }> = [];
      for (const row of scanFiles.rows) {
        seenAllIds.add(row.file_id);
        if (!row.is_directory && isVideoName(row.name)) {
          scannedVideos.push({
            fileId: row.file_id,
            parentDirectoryId: row.parent_directory_id,
            name: row.name,
            path: row.path,
          });
        }
      }

      // 将本任务扫描到但尚未建索引、且已有绑定并完全合规的视频也补入索引
      await this.backfillCompliantBindings(client, {
        scope: input.scope,
        scannedVideos,
        dirParents,
        movieTargetRoot,
        tvTargetRoot,
        templates,
        fingerprint: currentFingerprint,
        now,
      });

      const indexRows = await client.query<IndexRow>(
        `SELECT *
           FROM library_organized_index
          WHERE account_id=$1 AND connected_storage_id=$2
          FOR UPDATE`,
        [input.scope.accountId, input.scope.connectedStorageId],
      );
      const indexByFileId = new Map(indexRows.rows.map((row) => [row.file_id, row]));

      let cleanSkipped = 0;
      let drifted = 0;
      let ignored = 0;
      const skipIdentificationRows: Array<{
        fileId: string;
        reason: string;
        identity: OrganizationIdentity;
      }> = [];

      for (const file of scannedVideos) {
        const entry = indexByFileId.get(file.fileId);
        if (!entry) continue;

        const identity = parseIdentity(entry.identity);
        if (!identity) continue;
        const configuredTargetRoot = identity.mediaType === "movie"
          ? (movieTargetRoot ?? entry.target_root_id)
          : (tvTargetRoot ?? entry.target_root_id);
        const targetRootId = configuredTargetRoot || entry.target_root_id;

        const relDir = relativeDirectoryFromRoot(file.parentDirectoryId, targetRootId, dirParents);
        const observedRelativePath = relDir !== null
          ? (relDir ? `${relDir}/${file.name}` : file.name)
          : file.path;

        let expectedName = entry.organized_name;
        let expectedRelativePath = entry.organized_relative_path;
        if (currentFingerprint !== entry.template_fingerprint || targetRootId !== entry.target_root_id) {
          try {
            const rendered = renderExpectedVideoTarget(identity, file.name, templates, entry.organized_name);
            expectedName = rendered.fileName;
            expectedRelativePath = rendered.relativePath;
          } catch {
            expectedName = entry.organized_name;
            expectedRelativePath = entry.organized_relative_path;
          }
        }

        const isCompliant = relDir !== null
          ? (observedRelativePath === expectedRelativePath && file.name === expectedName)
          : (file.parentDirectoryId === entry.parent_directory_id && file.name === expectedName);

        if (isCompliant) {
          cleanSkipped += 1;
          await client.query(
            `UPDATE library_organized_index
                SET parent_directory_id=$4,
                    target_root_id=$5,
                    organized_name=$6,
                    organized_relative_path=$7,
                    template_fingerprint=$8,
                    drift_status='clean',
                    drift_reason=NULL,
                    observed_task_id=$9,
                    observed_parent_directory_id=$4,
                    observed_name=$10,
                    observed_relative_path=$11,
                    expected_name=$6,
                    expected_relative_path=$7,
                    expected_template_fingerprint=$8,
                    ignored_name=NULL,
                    ignored_parent_directory_id=NULL,
                    ignored_template_fingerprint=NULL,
                    ignored_at=NULL,
                    last_seen_at=$12,
                    updated_at=$12
              WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3`,
            [
              input.scope.accountId,
              input.scope.connectedStorageId,
              file.fileId,
              file.parentDirectoryId,
              targetRootId,
              expectedName,
              expectedRelativePath,
              currentFingerprint,
              input.taskId,
              file.name,
              observedRelativePath,
              now,
            ],
          );
          skipIdentificationRows.push({
            fileId: file.fileId,
            reason: "命中整理索引，文件未变动自动跳过",
            identity,
          });
          continue;
        }

        const matchesIgnoredSnapshot =
          entry.ignored_name === file.name
          && entry.ignored_parent_directory_id === file.parentDirectoryId
          && entry.ignored_template_fingerprint === currentFingerprint;

        const driftReason = currentFingerprint !== entry.template_fingerprint
          ? "命名模板已更新"
          : file.name !== entry.organized_name
            ? "文件名已被修改"
            : "文件所在目录已变更";

        if (matchesIgnoredSnapshot) {
          ignored += 1;
          await client.query(
            `UPDATE library_organized_index
                SET drift_status='ignored',
                    drift_reason=$4,
                    observed_task_id=$5,
                    observed_parent_directory_id=$6,
                    observed_name=$7,
                    observed_relative_path=$8,
                    expected_name=$9,
                    expected_relative_path=$10,
                    expected_template_fingerprint=$11,
                    last_seen_at=$12,
                    updated_at=$12
              WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3`,
            [
              input.scope.accountId,
              input.scope.connectedStorageId,
              file.fileId,
              driftReason,
              input.taskId,
              file.parentDirectoryId,
              file.name,
              observedRelativePath,
              expectedName,
              expectedRelativePath,
              currentFingerprint,
              now,
            ],
          );
          skipIdentificationRows.push({
            fileId: file.fileId,
            reason: "已忽略当前文件名改动，跳过重复识别",
            identity,
          });
          continue;
        }

        drifted += 1;
        await client.query(
          `UPDATE library_organized_index
              SET drift_status='drifted',
                  drift_reason=$4,
                  observed_task_id=$5,
                  observed_parent_directory_id=$6,
                  observed_name=$7,
                  observed_relative_path=$8,
                  expected_name=$9,
                  expected_relative_path=$10,
                  expected_template_fingerprint=$11,
                  last_seen_at=$12,
                  updated_at=$12
            WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3`,
          [
            input.scope.accountId,
            input.scope.connectedStorageId,
            file.fileId,
            driftReason,
            input.taskId,
            file.parentDirectoryId,
            file.name,
            observedRelativePath,
            expectedName,
            expectedRelativePath,
            currentFingerprint,
            now,
          ],
        );
        skipIdentificationRows.push({
          fileId: file.fileId,
          reason: `检测到文件变动（${driftReason}），等待手动确认整理或忽略`,
          identity,
        });
      }

      if (skipIdentificationRows.length > 0) {
        await this.markIdentificationsSkippedInTx(client, input.scope, input.taskId, skipIdentificationRows, now);
      }

      let removed = 0;
      if (taskRow.status === "completed") {
        const deletedIds: string[] = [];
        for (const row of indexRows.rows) {
          if (seenAllIds.has(row.file_id)) continue;
          const lastParent = row.observed_parent_directory_id ?? row.parent_directory_id;
          if (doneDirectories.has(lastParent) || doneDirectories.has(row.parent_directory_id)) {
            deletedIds.push(row.file_id);
          }
        }
        if (deletedIds.length > 0) {
          const del = await client.query(
            `DELETE FROM library_organized_index
              WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=ANY($3::text[])`,
            [input.scope.accountId, input.scope.connectedStorageId, deletedIds],
          );
          removed = del.rowCount ?? 0;
        }
      }

      const totalCountResult = await client.query<{ total_count: string }>(
        `SELECT COUNT(*)::text AS total_count
           FROM library_organized_index
          WHERE account_id=$1 AND connected_storage_id=$2`,
        [input.scope.accountId, input.scope.connectedStorageId],
      );
      await client.query("COMMIT");
      return {
        cleanSkipped,
        drifted,
        ignored,
        removed,
        indexedTotal: Number(totalCountResult.rows[0]?.total_count ?? 0),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async listDrifts(
    scope: OrganizationScope,
    input: { status: "drifted" | "ignored"; page: number; pageSize: number },
  ): Promise<OrganizedDriftListPage> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 10_000) {
      throw new RangeError("page must be 1..10000");
    }
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) {
      throw new RangeError("pageSize must be 1..100");
    }
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client, scope);
      const countRes = await client.query<{ total_indexed: string; drifted_count: string; ignored_count: string }>(
        `SELECT COUNT(*)::text AS total_indexed,
                COUNT(*) FILTER (WHERE drift_status='drifted')::text AS drifted_count,
                COUNT(*) FILTER (WHERE drift_status='ignored')::text AS ignored_count
           FROM library_organized_index
          WHERE account_id=$1 AND connected_storage_id=$2`,
        [scope.accountId, scope.connectedStorageId],
      );
      const c = countRes.rows[0];
      const counts = {
        totalIndexed: Number(c?.total_indexed ?? 0),
        drifted: Number(c?.drifted_count ?? 0),
        ignored: Number(c?.ignored_count ?? 0),
      };
      const total = input.status === "drifted" ? counts.drifted : counts.ignored;
      const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
      const offset = (input.page - 1) * input.pageSize;
      const rows = await client.query<IndexRow>(
        `SELECT *
           FROM library_organized_index
          WHERE account_id=$1 AND connected_storage_id=$2 AND drift_status=$3
          ORDER BY updated_at DESC, file_id DESC
          LIMIT $4 OFFSET $5`,
        [scope.accountId, scope.connectedStorageId, input.status, input.pageSize, offset],
      );
      return {
        items: rows.rows.map(entryFromRow),
        page: input.page,
        pageSize: input.pageSize,
        total,
        totalPages,
        counts,
      };
    } finally {
      client.release();
    }
  }

  async ignoreDrifts(scope: OrganizationScope, fileIds: readonly string[], now = new Date().toISOString()): Promise<number> {
    await this.ensureSchema();
    const ids = cleanIds(fileIds);
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE library_organized_index
          SET drift_status='ignored',
              ignored_name=COALESCE(observed_name, organized_name),
              ignored_parent_directory_id=COALESCE(observed_parent_directory_id, parent_directory_id),
              ignored_template_fingerprint=COALESCE(expected_template_fingerprint, template_fingerprint),
              ignored_at=$4,
              updated_at=$4
        WHERE account_id=$1
          AND connected_storage_id=$2
          AND file_id=ANY($3::text[])
          AND drift_status='drifted'`,
      [scope.accountId, scope.connectedStorageId, ids, now],
    );
    return result.rowCount ?? 0;
  }

  async unignoreDrifts(scope: OrganizationScope, fileIds: readonly string[], now = new Date().toISOString()): Promise<number> {
    await this.ensureSchema();
    const ids = cleanIds(fileIds);
    if (ids.length === 0) return 0;
    const result = await this.pool.query(
      `UPDATE library_organized_index
          SET drift_status='drifted',
              ignored_name=NULL,
              ignored_parent_directory_id=NULL,
              ignored_template_fingerprint=NULL,
              ignored_at=NULL,
              updated_at=$4
        WHERE account_id=$1
          AND connected_storage_id=$2
          AND file_id=ANY($3::text[])
          AND drift_status='ignored'`,
      [scope.accountId, scope.connectedStorageId, ids, now],
    );
    return result.rowCount ?? 0;
  }

  async listByFileIds(scope: OrganizationScope, fileIds: readonly string[]): Promise<OrganizedIndexEntry[]> {
    await this.ensureSchema();
    const ids = cleanIds(fileIds);
    if (ids.length === 0) return [];
    const result = await this.pool.query<IndexRow>(
      `SELECT *
         FROM library_organized_index
        WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=ANY($3::text[])`,
      [scope.accountId, scope.connectedStorageId, ids],
    );
    return result.rows.map(entryFromRow);
  }

  async listAllDriftedFileIds(scope: OrganizationScope, limit = 50): Promise<string[]> {
    await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query<{ file_id: string }>(
      `SELECT file_id
         FROM library_organized_index
        WHERE account_id=$1 AND connected_storage_id=$2 AND drift_status='drifted'
        ORDER BY updated_at DESC, file_id DESC
        LIMIT $3`,
      [scope.accountId, scope.connectedStorageId, safeLimit],
    );
    return result.rows.map((row) => row.file_id);
  }

  /** 若扫描发现已索引文件被手工移动到同配置来源根下的新目录，同步绑定目录以便后续按新位置重新整理。 */
  async syncScannedParentBindings(scope: OrganizationScope, taskId: string, fileIds: readonly string[], now = new Date().toISOString()): Promise<void> {
    await this.ensureSchema();
    const ids = cleanIds(fileIds);
    if (ids.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.assertStorage(client, scope);
      const taskRes = await client.query<{ configuration: unknown }>(
        `SELECT c.configuration
           FROM library_scan_tasks t
           JOIN library_scan_configs c
             ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.config_id=t.config_id
          WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3
            AND t.status IN ('completed','partial')`,
        [scope.accountId, scope.connectedStorageId, taskId],
      );
      const rawRoots = asRecord(taskRes.rows[0]?.configuration).sourceRoots;
      const rootIds = Array.isArray(rawRoots)
        ? rawRoots.map((entry) => asOptionalString(asRecord(entry).directoryId)).filter((id): id is string => Boolean(id))
        : [];
      if (rootIds.length === 0) {
        await client.query("COMMIT");
        return;
      }

      const dirRows = await client.query<{ directory_id: string; parent_directory_id: string | null; path: string }>(
        `SELECT directory_id, parent_directory_id, path
           FROM library_scan_directories
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3`,
        [scope.accountId, scope.connectedStorageId, taskId],
      );
      const dirMap = new Map(dirRows.rows.map((row) => [row.directory_id, { parentDirectoryId: row.parent_directory_id, name: pathLeaf(row.path) }]));

      const candidates = await client.query<{
        file_id: string;
        scan_parent_id: string;
        bound_parent_id: string;
        media_title_id: string;
        tracked_season_id: string;
        media_type: string;
        tmdb_id: number;
        season_number: unknown;
      }>(
        `SELECT f.file_id, f.parent_directory_id AS scan_parent_id, b.parent_directory_id AS bound_parent_id,
                b.media_title_id, b.tracked_season_id, b.media_type, b.tmdb_id, ts.payload->>'seasonNumber' AS season_number
           FROM library_scan_task_files f
           JOIN library_file_bindings b
             ON b.account_id=f.account_id AND b.connected_storage_id=f.connected_storage_id AND b.file_id=f.file_id
           JOIN tracked_seasons ts
             ON ts.id=b.tracked_season_id AND ts.account_id=b.account_id AND ts.connected_storage_id=b.connected_storage_id
          WHERE f.account_id=$1
            AND f.connected_storage_id=$2
            AND f.task_id=$3
            AND f.file_id=ANY($4::text[])
            AND NOT f.is_directory
            AND f.parent_directory_id <> b.parent_directory_id`,
        [scope.accountId, scope.connectedStorageId, taskId, ids],
      );

      for (const row of candidates.rows) {
        if (!isDirectoryUnderAnyRoot(row.scan_parent_id, rootIds, dirMap)) continue;
        const dirInfo = dirMap.get(row.scan_parent_id);
        const seasonNum = Number(row.season_number ?? 1);
        await client.query(
          `INSERT INTO library_directory_bindings (
             account_id, connected_storage_id, directory_id, parent_directory_id,
             media_title_id, tracked_season_id, media_type, tmdb_id, season_number, exclusive, bound_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false,$10)
           ON CONFLICT DO NOTHING`,
          [
            scope.accountId,
            scope.connectedStorageId,
            row.scan_parent_id,
            dirInfo?.parentDirectoryId ?? null,
            row.media_title_id,
            row.tracked_season_id,
            row.media_type,
            row.tmdb_id,
            Number.isFinite(seasonNum) ? seasonNum : 1,
            now,
          ],
        );
        await client.query(
          `UPDATE library_file_bindings
              SET parent_directory_id=$4, bound_at=$5
            WHERE account_id=$1 AND connected_storage_id=$2 AND file_id=$3`,
          [scope.accountId, scope.connectedStorageId, row.file_id, row.scan_parent_id, now],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async backfillVerifiedOperations(
    client: PoolClient,
    scope: OrganizationScope,
    fallbackFingerprint: string,
    now: string,
  ): Promise<void> {
    const existsRes = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('library_organization_operations')::text AS exists",
    );
    if (!existsRes.rows[0]?.exists) return;

    await client.query(
      `INSERT INTO library_organized_index (
         account_id, connected_storage_id, file_id, parent_directory_id, target_root_id,
         organized_name, organized_relative_path, template_fingerprint, source,
         media_title_id, tracked_season_id, identity,
         drift_status, drift_reason,
         observed_parent_directory_id, observed_name, observed_relative_path,
         expected_name, expected_relative_path, expected_template_fingerprint,
         organized_at, last_seen_at, updated_at
       )
       SELECT DISTINCT ON (o.file_id)
         o.account_id,
         o.connected_storage_id,
         o.file_id,
         o.target_parent_id,
         o.target_root_id,
         o.target_name,
         o.target_relative_path,
         $3,
         'organization',
         o.identity->>'mediaTitleId',
         o.identity->>'trackedSeasonId',
         o.identity,
         'clean',
         NULL,
         o.target_parent_id,
         o.target_name,
         o.target_relative_path,
         o.target_name,
         o.target_relative_path,
         $3,
         o.updated_at,
         $4,
         $4
       FROM library_organization_operations o
       WHERE o.account_id=$1
         AND o.connected_storage_id=$2
         AND o.status='verified'
         AND o.file_id=o.paired_file_id
         AND o.target_parent_id IS NOT NULL
         AND o.identity IS NOT NULL
         AND COALESCE(o.identity->>'mediaTitleId','') <> ''
         AND COALESCE(o.identity->>'trackedSeasonId','') <> ''
       ORDER BY o.file_id, o.updated_at DESC
       ON CONFLICT (account_id, connected_storage_id, file_id) DO NOTHING`,
      [scope.accountId, scope.connectedStorageId, fallbackFingerprint, now],
    );
  }

  private async backfillCompliantBindings(
    client: PoolClient,
    input: {
      scope: OrganizationScope;
      scannedVideos: ReadonlyArray<{ fileId: string; parentDirectoryId: string; name: string; path: string }>;
      dirParents: Map<string, { parentDirectoryId: string | null; name: string }>;
      movieTargetRoot: string | null;
      tvTargetRoot: string | null;
      templates: Readonly<Record<NamingTemplateKind, string>>;
      fingerprint: string;
      now: string;
    },
  ): Promise<void> {
    if (input.scannedVideos.length === 0) return;
    const existsRes = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('library_file_bindings')::text AS exists",
    );
    if (!existsRes.rows[0]?.exists) return;

    const candidateIds = input.scannedVideos.map((file) => file.fileId);
    const scanById = new Map(input.scannedVideos.map((file) => [file.fileId, file]));
    const rows = await client.query<{
      file_id: string;
      parent_directory_id: string;
      media_title_id: string;
      tracked_season_id: string;
      media_type: string;
      tmdb_id: number;
      episode_codes: unknown;
      quality: string | null;
      title_payload: unknown;
      season_payload: unknown;
    }>(
      `SELECT b.file_id, b.parent_directory_id, b.media_title_id, b.tracked_season_id, b.media_type, b.tmdb_id,
              b.episode_codes, b.quality, mt.payload AS title_payload, ts.payload AS season_payload
         FROM library_file_bindings b
         JOIN tracked_seasons ts ON ts.id=b.tracked_season_id AND ts.account_id=b.account_id AND ts.connected_storage_id=b.connected_storage_id
         JOIN media_titles mt ON mt.id=b.media_title_id
        WHERE b.account_id=$1
          AND b.connected_storage_id=$2
          AND b.file_id=ANY($3::text[])
          AND NOT EXISTS (
            SELECT 1 FROM library_organized_index idx
             WHERE idx.account_id=b.account_id
               AND idx.connected_storage_id=b.connected_storage_id
               AND idx.file_id=b.file_id
          )`,
      [input.scope.accountId, input.scope.connectedStorageId, candidateIds],
    );

    for (const row of rows.rows) {
      const scanned = scanById.get(row.file_id);
      if (!scanned || scanned.parentDirectoryId !== row.parent_directory_id) continue;
      const codes = Array.isArray(row.episode_codes)
        ? row.episode_codes.filter((value): value is string => typeof value === "string")
        : [];
      if (row.media_type !== "movie" && codes.length !== 1) continue;
      const targetRootId = row.media_type === "movie" ? input.movieTargetRoot : input.tvTargetRoot;
      if (!targetRootId) continue;

      const title = asRecord(row.title_payload);
      const season = asRecord(row.season_payload);
      const episodeCode = codes[0];
      const epMatch = episodeCode ? /^S\d{2}E(\d+)$/u.exec(episodeCode) : null;
      const identity: OrganizationIdentity = {
        mediaTitleId: row.media_title_id,
        trackedSeasonId: row.tracked_season_id,
        mediaType: row.media_type as OrganizationIdentity["mediaType"],
        title: String(title.title ?? ""),
        originalTitle: String(title.originalTitle ?? ""),
        year: Number(title.year),
        tmdbId: Number(row.tmdb_id),
        season: Number(season.seasonNumber ?? 1),
        ...(episodeCode ? { episodeCode } : {}),
        ...(epMatch ? { episode: Number(epMatch[1]) } : {}),
        ...(row.quality ? { resolution: row.quality } : {}),
      };
      if (!identity.title.trim() || !Number.isSafeInteger(identity.tmdbId) || identity.tmdbId < 1) continue;
      let expected: { relativeDirectory: string; fileName: string; relativePath: string };
      try {
        expected = renderExpectedVideoTarget(identity, scanned.name, input.templates);
      } catch {
        continue;
      }
      const relDir = relativeDirectoryFromRoot(scanned.parentDirectoryId, targetRootId, input.dirParents);
      if (relDir === null) continue;
      const observedRelative = relDir ? `${relDir}/${scanned.name}` : scanned.name;
      if (observedRelative !== expected.relativePath || scanned.name !== expected.fileName) continue;

      await client.query(
        `INSERT INTO library_organized_index (
           account_id, connected_storage_id, file_id, parent_directory_id, target_root_id,
           organized_name, organized_relative_path, template_fingerprint, source,
           media_title_id, tracked_season_id, identity,
           drift_status, drift_reason,
           observed_parent_directory_id, observed_name, observed_relative_path,
           expected_name, expected_relative_path, expected_template_fingerprint,
           organized_at, last_seen_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, 'organization',
           $9, $10, $11::jsonb,
           'clean', NULL,
           $4, $6, $7,
           $6, $7, $8,
           $12, $12, $12
         ) ON CONFLICT DO NOTHING`,
        [
          input.scope.accountId,
          input.scope.connectedStorageId,
          scanned.fileId,
          scanned.parentDirectoryId,
          targetRootId,
          expected.fileName,
          expected.relativePath,
          input.fingerprint,
          identity.mediaTitleId,
          identity.trackedSeasonId,
          JSON.stringify(identity),
          input.now,
        ],
      );
    }
  }

  private async markIdentificationsSkippedInTx(
    client: PoolClient,
    scope: OrganizationScope,
    taskId: string,
    rows: ReadonlyArray<{ fileId: string; reason: string; identity: OrganizationIdentity }>,
    now: string,
  ): Promise<void> {
    const existsRes = await client.query<{ exists: string | null }>(
      "SELECT to_regclass('library_scan_identifications')::text AS exists",
    );
    if (!existsRes.rows[0]?.exists) return;

    const fileIds: string[] = [];
    const reasons: string[] = [];
    const evidences: string[] = [];
    const mediaTypes: string[] = [];
    const tmdbIds: number[] = [];
    const seasons: Array<number | null> = [];
    const episodeCodes: string[] = [];
    for (const item of rows) {
      fileIds.push(item.fileId);
      reasons.push(item.reason);
      evidences.push(JSON.stringify([{
        kind: "library_organized_index",
        value: `${item.identity.mediaType}:${item.identity.tmdbId}`,
        source: "metadata",
      }]));
      mediaTypes.push(item.identity.mediaType);
      tmdbIds.push(item.identity.tmdbId);
      seasons.push(item.identity.season ?? null);
      episodeCodes.push(JSON.stringify(item.identity.episodeCode ? [item.identity.episodeCode] : []));
    }

    await client.query(
      `INSERT INTO library_scan_identifications (
         account_id, connected_storage_id, task_id, file_id, status, reason,
         evidence, candidates, media_type, tmdb_id, season_number, episode_codes,
         import_status, manual, updated_at
       )
       SELECT $1, $2, $3, v.file_id, 'confirmed', v.reason,
              v.evidence::jsonb, '[]'::jsonb, v.media_type, v.tmdb_id, v.season_number, v.episode_codes::jsonb,
              'imported', false, $4
         FROM unnest($5::text[], $6::text[], $7::text[], $8::text[], $9::int[], $10::int[], $11::text[])
              AS v(file_id, reason, evidence, media_type, tmdb_id, season_number, episode_codes)
       ON CONFLICT (account_id, connected_storage_id, task_id, file_id) DO NOTHING`,
      [
        scope.accountId,
        scope.connectedStorageId,
        taskId,
        now,
        fileIds,
        reasons,
        evidences,
        mediaTypes,
        tmdbIds,
        seasons,
        episodeCodes,
      ],
    );
  }

  private async assertStorage(client: PoolClient, scope: OrganizationScope): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM connected_storages WHERE id=$1 AND account_id=$2 AND provider=ANY($3::text[])",
      [scope.connectedStorageId, scope.accountId, REGISTERED_STORAGE_PROVIDERS],
    );
    if (!result.rowCount) {
      throw new Error("整理索引网盘不存在或不属于指定账号");
    }
  }
}

function entryFromRow(row: IndexRow): OrganizedIndexEntry {
  return {
    accountId: row.account_id,
    connectedStorageId: row.connected_storage_id,
    fileId: row.file_id,
    parentDirectoryId: row.parent_directory_id,
    targetRootId: row.target_root_id,
    organizedName: row.organized_name,
    organizedRelativePath: row.organized_relative_path,
    templateFingerprint: row.template_fingerprint,
    source: row.source,
    mediaTitleId: row.media_title_id,
    trackedSeasonId: row.tracked_season_id,
    identity: parseIdentity(row.identity) ?? {
      mediaTitleId: row.media_title_id,
      trackedSeasonId: row.tracked_season_id,
      mediaType: "movie",
      title: row.organized_name,
      originalTitle: row.organized_name,
      year: 0,
      tmdbId: 0,
    },
    driftStatus: row.drift_status,
    driftReason: row.drift_reason,
    observedTaskId: row.observed_task_id,
    observedParentDirectoryId: row.observed_parent_directory_id,
    observedName: row.observed_name,
    observedRelativePath: row.observed_relative_path,
    expectedName: row.expected_name,
    expectedRelativePath: row.expected_relative_path,
    expectedTemplateFingerprint: row.expected_template_fingerprint,
    ignoredName: row.ignored_name,
    ignoredParentDirectoryId: row.ignored_parent_directory_id,
    ignoredTemplateFingerprint: row.ignored_template_fingerprint,
    ignoredAt: row.ignored_at ? row.ignored_at.toISOString() : null,
    organizedAt: row.organized_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function isDirectoryUnderAnyRoot(
  directoryId: string,
  roots: readonly string[],
  directories: Map<string, { parentDirectoryId: string | null; name: string }>,
): boolean {
  const seen = new Set<string>();
  let current: string | null = directoryId;
  while (current !== null) {
    if (roots.includes(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = directories.get(current)?.parentDirectoryId ?? null;
  }
  return false;
}

function relativeDirectoryFromRoot(
  directoryId: string,
  targetRootId: string,
  directories: Map<string, { parentDirectoryId: string | null; name: string }>,
): string | null {
  const segments: string[] = [];
  const seen = new Set<string>();
  let current: string | null = directoryId;
  while (current !== null && current !== targetRootId) {
    if (seen.has(current)) return null;
    seen.add(current);
    const dir = directories.get(current);
    if (!dir || dir.parentDirectoryId === null) return null;
    segments.unshift(dir.name);
    current = dir.parentDirectoryId;
  }
  return current === targetRootId ? segments.join("/") : null;
}

function normalizeTemplates(raw: unknown): Record<NamingTemplateKind, string> {
  const rec = asRecord(raw);
  const result = {} as Record<NamingTemplateKind, string>;
  for (const key of Object.keys(DEFAULT_NAMING_TEMPLATES) as NamingTemplateKind[]) {
    const val = rec[key];
    result[key] = typeof val === "string" && val.trim() ? val : DEFAULT_NAMING_TEMPLATES[key];
  }
  return result;
}

function parseIdentity(value: unknown): OrganizationIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.mediaTitleId !== "string" || typeof raw.trackedSeasonId !== "string") return null;
  return raw as unknown as OrganizationIdentity;
}

function cleanIds(fileIds: readonly string[]): string[] {
  return [...new Set(fileIds.map((id) => id.trim()).filter(Boolean))];
}

function isVideoName(name: string): boolean {
  const index = name.lastIndexOf(".");
  if (index <= 0) return false;
  return VIDEO_EXTENSIONS.has(name.slice(index).toLowerCase());
}

function pathLeaf(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
