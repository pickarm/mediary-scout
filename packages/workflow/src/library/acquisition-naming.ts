import type { MediaTitle, PackageTreeFile, TransferAttempt } from "../domain.js";
import { episodePartsFromCode } from "../domain.js";
import type { StorageExecutor } from "../ports.js";
import { initializeWorkflowPostgresSchema } from "../postgres.js";
import type { Pool } from "pg";
import { legacyMediaLibraryFolderName, mediaLibraryFolderName } from "../media-library-folder.js";
import type { AcquisitionDirectoryBindingPlan } from "./acquisition-bindings.js";
import {
  addStableCollisionSuffix,
  DEFAULT_NAMING_TEMPLATES,
  deriveSubtitlePath,
  parseNamingTemplate,
  renderParsedNamingTemplate,
  type NamingTemplateKind,
  type NamingValues,
} from "./naming.js";

export const ACQUISITION_NAMING_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_149;
const ACQUISITION_NAMING_DATABASE = Symbol.for("media-track.acquisition-naming-database");

const MAX_CONFIGURATIONS = 10_000;
const CONFIGURATION_PAGE_SIZE = 100;
const MAX_DIRECTORY_DEPTH = 8;
const MAX_DIRECTORIES_WALKED = 1_024;
const SUBTITLE_EXTENSIONS = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup", ".smi"]);
const VIDEO_EXTENSIONS = new Set([
  ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m2ts", ".mpg", ".mpeg", ".webm", ".3gp",
]);

export type AcquisitionNamingErrorCode =
  | "ACQUISITION_NAMING_TEMPLATE_CONFLICT"
  | "ACQUISITION_NAMING_TEMPLATE_INVALID"
  | "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED"
  | "ACQUISITION_NAMING_FILE_UNVERIFIED"
  | "ACQUISITION_NAMING_STORAGE_UNREADABLE"
  | "ACQUISITION_NAMING_DATABASE_UNAVAILABLE";

export class AcquisitionNamingError extends Error {
  readonly code: AcquisitionNamingErrorCode;

  constructor(code: AcquisitionNamingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcquisitionNamingError";
    this.code = code;
  }
}

export interface AcquisitionNamingScope {
  accountId: string;
  connectedStorageId: string;
}

export interface AcquisitionNamingPolicy {
  readonly targetRootId: string;
  readonly kind: "movie" | "tv";
  readonly matchedConfigIds: readonly string[];
  readonly templates: Readonly<Record<NamingTemplateKind, string>>;
}

export interface AcquisitionNamingDirectoryIdentity {
  readonly scope: AcquisitionNamingScope;
  readonly mediaType: MediaTitle["type"];
  readonly tmdbId: number;
  readonly directoryKey: string;
}

export interface AcquisitionNamingDirectoryIntent {
  readonly identity: AcquisitionNamingDirectoryIdentity;
  readonly rootDirectoryId: string;
  readonly relativePath: string;
  readonly directoryId: string | null;
  readonly status: "planned" | "verified";
  readonly updatedAt: string;
}

export interface AcquisitionNamingFileIdentity {
  readonly scope: AcquisitionNamingScope;
  readonly mediaType: MediaTitle["type"];
  readonly tmdbId: number;
  readonly workflowRunId: string;
  readonly fileId: string;
}

export interface AcquisitionNamingFileIntent {
  readonly identity: AcquisitionNamingFileIdentity;
  readonly attemptId: string;
  readonly kind: "video" | "subtitle";
  readonly originalDirectoryId: string;
  readonly originalName: string;
  readonly targetDirectoryId: string;
  readonly targetName: string;
  readonly episodeCodes: readonly string[];
  readonly status: "planned" | "verified" | "skipped" | "failed";
  readonly reason: string | null;
  readonly updatedAt: string;
}

export interface AcquisitionNamingDatabase {
  resolvePolicy(input: {
    scope: AcquisitionNamingScope;
    targetRootId: string;
    kind: "movie" | "tv";
  }): Promise<AcquisitionNamingPolicy>;
  getDirectoryIntent(identity: AcquisitionNamingDirectoryIdentity): Promise<AcquisitionNamingDirectoryIntent | null>;
  beginDirectoryIntent(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    rootDirectoryId: string;
    relativePath: string;
  }): Promise<AcquisitionNamingDirectoryIntent>;
  markDirectoryVerified(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    directoryId: string;
    relativePath?: string;
  }): Promise<void>;
  beginFileIntent(input: Omit<AcquisitionNamingFileIntent, "status" | "reason" | "updatedAt">): Promise<AcquisitionNamingFileIntent>;
  markFileVerified(identity: AcquisitionNamingFileIdentity, targetDirectoryId: string): Promise<void>;
  markFileSkipped(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void>;
  markFileFailed(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void>;
  getFileIntent(identity: AcquisitionNamingFileIdentity): Promise<AcquisitionNamingFileIntent | null>;
  listPendingFileIntents(input: {
    scope: AcquisitionNamingScope;
    mediaType: MediaTitle["type"];
    tmdbId: number;
  }): Promise<AcquisitionNamingFileIntent[]>;
}

interface NamingDatabaseAttachment {
  readonly pool: Pool;
}

const postgresDatabases = new WeakMap<Pool, PostgresAcquisitionNamingDatabase>();

export function attachAcquisitionNamingDatabase<T extends StorageExecutor>(storage: T, pool: Pool): T {
  Object.defineProperty(storage, ACQUISITION_NAMING_DATABASE, {
    value: { pool } satisfies NamingDatabaseAttachment,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return storage;
}

function acquisitionNamingPoolOf(storage: object): Pool | null {
  const attachment = (storage as StorageExecutor & {
    readonly [ACQUISITION_NAMING_DATABASE]?: NamingDatabaseAttachment;
  })[ACQUISITION_NAMING_DATABASE];
  return attachment?.pool ?? null;
}

function postgresDatabaseFor(storage: object): PostgresAcquisitionNamingDatabase | null {
  const pool = acquisitionNamingPoolOf(storage);
  if (!pool) return null;
  let database = postgresDatabases.get(pool);
  if (!database) {
    database = new PostgresAcquisitionNamingDatabase(pool);
    postgresDatabases.set(pool, database);
  }
  return database;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AcquisitionNamingError("ACQUISITION_NAMING_TEMPLATE_INVALID", `扫描配置字段 ${field} 为空`);
  }
  return value.trim();
}

function relevantTemplateKinds(kind: "movie" | "tv"): readonly NamingTemplateKind[] {
  return kind === "movie"
    ? ["movieDirectory", "movieFile"]
    : ["tvDirectory", "seasonDirectory", "episodeFile"];
}

function validateTemplateValue(templateKind: NamingTemplateKind, value: string, configId: string): void {
  const parsed = parseNamingTemplate(value);
  if (!parsed.ok) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_TEMPLATE_INVALID",
      `扫描配置 ${configId} 的 ${templateKind} 模板无效：${parsed.errors.join("；")}`,
    );
  }
  if (templateKind === "movieDirectory" || templateKind === "tvDirectory" || templateKind === "seasonDirectory") {
    if (parsed.template.segments.length > MAX_DIRECTORY_DEPTH) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_TEMPLATE_INVALID",
        `扫描配置 ${configId} 的 ${templateKind} 模板超过 ${MAX_DIRECTORY_DEPTH} 层目录，无法在获取沙箱内安全核实`,
      );
    }
    return;
  }
  const segments = parsed.template.segments;
  const lastSegment = segments.at(-1) ?? [];
  const lastToken = lastSegment.at(-1);
  if (
    segments.length !== 1
    || lastToken?.type !== "field"
    || lastToken.field !== "ext"
  ) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_TEMPLATE_INVALID",
      `扫描配置 ${configId} 的 ${templateKind} 模板必须以 {ext} 结尾，以保留实际文件扩展名`,
    );
  }
}

function effectiveTemplates(
  rawTemplates: unknown,
  kind: "movie" | "tv",
  configId: string,
): Record<NamingTemplateKind, string> {
  const configured = isRecord(rawTemplates) ? rawTemplates : {};
  const templates = { ...DEFAULT_NAMING_TEMPLATES };
  for (const templateKind of relevantTemplateKinds(kind)) {
    const candidate = configured[templateKind];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_TEMPLATE_INVALID",
        `扫描配置 ${configId} 的 ${templateKind} 模板不是字符串`,
      );
    }
    validateTemplateValue(templateKind, candidate, configId);
    templates[templateKind] = candidate;
  }
  return templates;
}

function relevantTemplateSignature(
  templates: Readonly<Record<NamingTemplateKind, string>>,
  kind: "movie" | "tv",
): string {
  return JSON.stringify(relevantTemplateKinds(kind).map((templateKind) => [templateKind, templates[templateKind]]));
}

export function resolveAcquisitionNamingPolicyFromConfigurations(input: {
  scope: AcquisitionNamingScope;
  targetRootId: string;
  kind: "movie" | "tv";
  configurations: readonly unknown[];
}): AcquisitionNamingPolicy {
  const matching: Array<{ configId: string; templates: Record<NamingTemplateKind, string> }> = [];
  for (const candidate of input.configurations) {
    if (!isRecord(candidate)) continue;
    const configuration = isRecord(candidate.configuration) ? candidate.configuration : candidate;
    const scope = isRecord(configuration.scope) ? configuration.scope : null;
    if (
      !scope
      || scope.accountId !== input.scope.accountId
      || scope.connectedStorageId !== input.scope.connectedStorageId
    ) continue;
    const targetField = input.kind === "movie" ? "movieTargetDirectoryId" : "tvTargetDirectoryId";
    if (configuration[targetField] !== input.targetRootId) continue;
    const configId =
      typeof candidate.configId === "string"
        ? candidate.configId
        : nonEmpty(configuration.configId, "configId");
    matching.push({
      configId,
      templates: effectiveTemplates(configuration.templates, input.kind, configId),
    });
  }

  if (matching.length === 0) {
    return {
      targetRootId: input.targetRootId,
      kind: input.kind,
      matchedConfigIds: [],
      templates: { ...DEFAULT_NAMING_TEMPLATES },
    };
  }
  const signatures = new Set(
    matching.map((entry) => relevantTemplateSignature(entry.templates, input.kind)),
  );
  if (signatures.size !== 1) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_TEMPLATE_CONFLICT",
      `获取根 ${input.targetRootId} 匹配了多个模板冲突的扫描配置（${matching.map((entry) => entry.configId).join("、")}）；请先统一这些配置的命名模板`,
    );
  }
  return {
    targetRootId: input.targetRootId,
    kind: input.kind,
    matchedConfigIds: matching.map((entry) => entry.configId).sort(),
    templates: matching[0]!.templates,
  };
}

interface DirectoryRow {
  account_id: string;
  connected_storage_id: string;
  media_type: MediaTitle["type"];
  tmdb_id: number;
  directory_key: string;
  root_directory_id: string;
  relative_path: string;
  directory_id: string | null;
  status: "planned" | "verified";
  updated_at: Date;
}

interface FileRow {
  account_id: string;
  connected_storage_id: string;
  media_type: MediaTitle["type"];
  tmdb_id: number;
  workflow_run_id: string;
  file_id: string;
  attempt_id: string;
  kind: "video" | "subtitle";
  original_directory_id: string;
  original_name: string;
  target_directory_id: string;
  target_name: string;
  episode_codes: string[];
  status: "planned" | "verified" | "skipped" | "failed";
  reason: string | null;
  updated_at: Date;
}

const NAMING_SCHEMA = `
CREATE TABLE IF NOT EXISTS library_acquisition_naming_directories (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('movie','tv','anime')),
  tmdb_id integer NOT NULL,
  directory_key text NOT NULL,
  root_directory_id text NOT NULL,
  relative_path text NOT NULL,
  directory_id text,
  status text NOT NULL CHECK (status IN ('planned','verified')),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, connected_storage_id, media_type, tmdb_id, directory_key)
);
CREATE TABLE IF NOT EXISTS library_acquisition_naming_files (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  media_type text NOT NULL CHECK (media_type IN ('movie','tv','anime')),
  tmdb_id integer NOT NULL,
  workflow_run_id text NOT NULL,
  file_id text NOT NULL,
  attempt_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('video','subtitle')),
  original_directory_id text NOT NULL,
  original_name text NOT NULL,
  target_directory_id text NOT NULL,
  target_name text NOT NULL,
  episode_codes jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('planned','verified','skipped','failed')),
  reason text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, connected_storage_id, media_type, tmdb_id, workflow_run_id, file_id)
);
CREATE INDEX IF NOT EXISTS library_acquisition_naming_files_status
  ON library_acquisition_naming_files
     (account_id, connected_storage_id, media_type, tmdb_id, status, updated_at);
`;

export class PostgresAcquisitionNamingDatabase implements AcquisitionNamingDatabase {
  private schemaReady: Promise<void> | null = null;
  private scanSchemaReady: Promise<void> | null = null;

  constructor(readonly pool: Pool) {}

  async resolvePolicy(input: {
    scope: AcquisitionNamingScope;
    targetRootId: string;
    kind: "movie" | "tv";
  }): Promise<AcquisitionNamingPolicy> {
    await this.ensureSchema();
    await this.ensureScanSchema();
    const configurations: unknown[] = [];
    let afterConfigId: string | undefined;
    while (configurations.length < MAX_CONFIGURATIONS) {
      const result = await this.pool.query<{
        config_id: string;
        configuration: unknown;
      }>(
        `SELECT c.config_id,c.configuration
           FROM library_scan_configs c
           JOIN connected_storages s
             ON s.id=c.connected_storage_id AND s.account_id=c.account_id
          WHERE c.account_id=$1 AND c.connected_storage_id=$2
            AND ($3::text IS NULL OR c.config_id > $3)
          ORDER BY c.config_id
          LIMIT $4`,
        [
          input.scope.accountId,
          input.scope.connectedStorageId,
          afterConfigId ?? null,
          CONFIGURATION_PAGE_SIZE,
        ],
      );
      configurations.push(...result.rows.map((row) => row.configuration));
      if (result.rows.length < CONFIGURATION_PAGE_SIZE) break;
      afterConfigId = result.rows.at(-1)?.config_id;
      if (!afterConfigId) break;
    }
    if (configurations.length >= MAX_CONFIGURATIONS) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_TEMPLATE_INVALID",
        `扫描配置超过 ${MAX_CONFIGURATIONS} 份，无法在有界范围内确认模板一致性`,
      );
    }
    return resolveAcquisitionNamingPolicyFromConfigurations({ ...input, configurations });
  }

  async getDirectoryIntent(
    identity: AcquisitionNamingDirectoryIdentity,
  ): Promise<AcquisitionNamingDirectoryIntent | null> {
    await this.ensureSchema();
    const result = await this.pool.query<DirectoryRow>(
      `SELECT account_id,connected_storage_id,media_type,tmdb_id,directory_key,
              root_directory_id,relative_path,directory_id,status,updated_at
         FROM library_acquisition_naming_directories
        WHERE account_id=$1 AND connected_storage_id=$2 AND media_type=$3 AND tmdb_id=$4 AND directory_key=$5`,
      [
        identity.scope.accountId,
        identity.scope.connectedStorageId,
        identity.mediaType,
        identity.tmdbId,
        identity.directoryKey,
      ],
    );
    return result.rows[0] ? directoryIntentFromRow(result.rows[0]) : null;
  }

  async beginDirectoryIntent(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    rootDirectoryId: string;
    relativePath: string;
  }): Promise<AcquisitionNamingDirectoryIntent> {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.pool.query(
      `INSERT INTO library_acquisition_naming_directories
        (account_id,connected_storage_id,media_type,tmdb_id,directory_key,root_directory_id,relative_path,directory_id,status,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,NULL,'planned',$8)
       ON CONFLICT DO NOTHING`,
      [
        input.identity.scope.accountId,
        input.identity.scope.connectedStorageId,
        input.identity.mediaType,
        input.identity.tmdbId,
        input.identity.directoryKey,
        input.rootDirectoryId,
        input.relativePath,
        now,
      ],
    );
    const current = await this.getDirectoryIntent(input.identity);
    if (!current) throw new AcquisitionNamingError("ACQUISITION_NAMING_DIRECTORY_UNVERIFIED", "目录命名意图写入后无法读取");
    if (
      current.rootDirectoryId !== input.rootDirectoryId
      || (current.status === "planned" && current.relativePath !== input.relativePath)
    ) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        `作品 ${input.identity.tmdbId} 已绑定其他获取目录；已停止获取以避免重复目录`,
      );
    }
    return current;
  }

  async markDirectoryVerified(input: {
    identity: AcquisitionNamingDirectoryIdentity;
    directoryId: string;
    relativePath?: string;
  }): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE library_acquisition_naming_directories
          SET directory_id=$6,status='verified',relative_path=COALESCE($7,relative_path),updated_at=$8
        WHERE account_id=$1 AND connected_storage_id=$2 AND media_type=$3 AND tmdb_id=$4 AND directory_key=$5`,
      [
        input.identity.scope.accountId,
        input.identity.scope.connectedStorageId,
        input.identity.mediaType,
        input.identity.tmdbId,
        input.identity.directoryKey,
        input.directoryId,
        input.relativePath ?? null,
        new Date().toISOString(),
      ],
    );
    if (result.rowCount !== 1) {
      throw new AcquisitionNamingError("ACQUISITION_NAMING_DIRECTORY_UNVERIFIED", "目录 ID 回读后无法持久化");
    }
  }

  async beginFileIntent(
    input: Omit<AcquisitionNamingFileIntent, "status" | "reason" | "updatedAt">,
  ): Promise<AcquisitionNamingFileIntent> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO library_acquisition_naming_files
        (account_id,connected_storage_id,media_type,tmdb_id,workflow_run_id,file_id,attempt_id,kind,
         original_directory_id,original_name,target_directory_id,target_name,episode_codes,status,reason,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'planned',NULL,$14)
       ON CONFLICT DO NOTHING`,
      [
        input.identity.scope.accountId,
        input.identity.scope.connectedStorageId,
        input.identity.mediaType,
        input.identity.tmdbId,
        input.identity.workflowRunId,
        input.identity.fileId,
        input.attemptId,
        input.kind,
        input.originalDirectoryId,
        input.originalName,
        input.targetDirectoryId,
        input.targetName,
        JSON.stringify(input.episodeCodes),
        new Date().toISOString(),
      ],
    );
    const existing = await this.getFileIntent(input.identity);
    if (!existing) {
      throw new AcquisitionNamingError("ACQUISITION_NAMING_FILE_UNVERIFIED", "文件命名意图写入后无法读取");
    }
    if (
      existing.kind !== input.kind
      || existing.originalName !== input.originalName
      || existing.targetDirectoryId !== input.targetDirectoryId
      || existing.targetName !== input.targetName
      || JSON.stringify(existing.episodeCodes) !== JSON.stringify(input.episodeCodes)
    ) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `文件 ${input.identity.fileId} 已绑定不同的命名意图，拒绝覆盖`,
      );
    }
    return existing;
  }

  async markFileVerified(identity: AcquisitionNamingFileIdentity, targetDirectoryId: string): Promise<void> {
    await this.updateFile(identity, "verified", null, targetDirectoryId);
  }

  async markFileSkipped(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void> {
    await this.updateFile(identity, "skipped", reason);
  }

  async markFileFailed(identity: AcquisitionNamingFileIdentity, reason: string): Promise<void> {
    await this.updateFile(identity, "failed", reason);
  }

  async getFileIntent(identity: AcquisitionNamingFileIdentity): Promise<AcquisitionNamingFileIntent | null> {
    await this.ensureSchema();
    const result = await this.pool.query<FileRow>(
      `SELECT account_id,connected_storage_id,media_type,tmdb_id,workflow_run_id,file_id,attempt_id,kind,
              original_directory_id,original_name,target_directory_id,target_name,episode_codes,status,reason,updated_at
         FROM library_acquisition_naming_files
        WHERE account_id=$1 AND connected_storage_id=$2 AND media_type=$3 AND tmdb_id=$4
          AND workflow_run_id=$5 AND file_id=$6`,
      [
        identity.scope.accountId,
        identity.scope.connectedStorageId,
        identity.mediaType,
        identity.tmdbId,
        identity.workflowRunId,
        identity.fileId,
      ],
    );
    return result.rows[0] ? fileIntentFromRow(result.rows[0]) : null;
  }

  async listPendingFileIntents(input: {
    scope: AcquisitionNamingScope;
    mediaType: MediaTitle["type"];
    tmdbId: number;
  }): Promise<AcquisitionNamingFileIntent[]> {
    await this.ensureSchema();
    const result = await this.pool.query<FileRow>(
      `SELECT account_id,connected_storage_id,media_type,tmdb_id,workflow_run_id,file_id,attempt_id,kind,
              original_directory_id,original_name,target_directory_id,target_name,episode_codes,status,reason,updated_at
         FROM library_acquisition_naming_files
        WHERE account_id=$1 AND connected_storage_id=$2 AND media_type=$3 AND tmdb_id=$4
          AND status IN ('planned','failed')
        ORDER BY updated_at,workflow_run_id,file_id
        LIMIT 5001`,
      [
        input.scope.accountId,
        input.scope.connectedStorageId,
        input.mediaType,
        input.tmdbId,
      ],
    );
    if (result.rows.length > 5_000) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `作品 ${input.tmdbId} 的待核实命名文件超过 5000 个，已停止自动恢复以免重复写盘`,
      );
    }
    return result.rows.map(fileIntentFromRow);
  }

  private async updateFile(
    identity: AcquisitionNamingFileIdentity,
    status: AcquisitionNamingFileIntent["status"],
    reason: string | null,
    targetDirectoryId?: string,
  ): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `UPDATE library_acquisition_naming_files
          SET status=$7,reason=$8,target_directory_id=COALESCE($9,target_directory_id),updated_at=$10
        WHERE account_id=$1 AND connected_storage_id=$2 AND media_type=$3 AND tmdb_id=$4
          AND workflow_run_id=$5 AND file_id=$6`,
      [
        identity.scope.accountId,
        identity.scope.connectedStorageId,
        identity.mediaType,
        identity.tmdbId,
        identity.workflowRunId,
        identity.fileId,
        status,
        reason?.slice(0, 1_000) ?? null,
        targetDirectoryId ?? null,
        new Date().toISOString(),
      ],
    );
    if (result.rowCount !== 1) {
      throw new AcquisitionNamingError("ACQUISITION_NAMING_FILE_UNVERIFIED", "文件命名状态无法持久化");
    }
  }

  async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.installSchema();
    return this.schemaReady;
  }

  private async ensureScanSchema(): Promise<void> {
    this.scanSchemaReady ??= (async () => {
      const { PostgresScanStore } = await import("./scan-store.js");
      await new PostgresScanStore(this.pool).ensureSchema();
    })();
    return this.scanSchemaReady;
  }

  private async installSchema(): Promise<void> {
    await initializeWorkflowPostgresSchema(this.pool);
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1)", [ACQUISITION_NAMING_SCHEMA_ADVISORY_LOCK_KEY]);
      try {
        await client.query(NAMING_SCHEMA);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [ACQUISITION_NAMING_SCHEMA_ADVISORY_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }
}

function directoryIntentFromRow(row: DirectoryRow): AcquisitionNamingDirectoryIntent {
  return {
    identity: {
      scope: {
        accountId: row.account_id,
        connectedStorageId: row.connected_storage_id,
      },
      mediaType: row.media_type,
      tmdbId: Number(row.tmdb_id),
      directoryKey: row.directory_key,
    },
    rootDirectoryId: row.root_directory_id,
    relativePath: row.relative_path,
    directoryId: row.directory_id,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

function fileIntentFromRow(row: FileRow): AcquisitionNamingFileIntent {
  return {
    identity: {
      scope: {
        accountId: row.account_id,
        connectedStorageId: row.connected_storage_id,
      },
      mediaType: row.media_type,
      tmdbId: Number(row.tmdb_id),
      workflowRunId: row.workflow_run_id,
      fileId: row.file_id,
    },
    attemptId: row.attempt_id,
    kind: row.kind,
    originalDirectoryId: row.original_directory_id,
    originalName: row.original_name,
    targetDirectoryId: row.target_directory_id,
    targetName: row.target_name,
    episodeCodes: row.episode_codes,
    status: row.status,
    reason: row.reason,
    updatedAt: row.updated_at.toISOString(),
  };
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

function baseNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function fileKind(name: string): "video" | "subtitle" | null {
  const extension = extensionOf(name).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (SUBTITLE_EXTENSIONS.has(extension)) return "subtitle";
  return null;
}

function isNonReconcilableWriteError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name.endsWith("AuthError") || error.name.includes("ConnectionChanged")) return true;
  return /(?:AUTH_FAILED|AUTH_REQUIRED|CONNECTION_CHANGED|SAFETY_VIOLATION|WRITE_SCOPE_VIOLATION)/iu.test(
    error.message,
  );
}

function renderRelativeDirectory(
  template: string,
  values: NamingValues,
  label: string,
): { path: string; segments: string[] } {
  const parsed = parseNamingTemplate(template);
  if (!parsed.ok) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_TEMPLATE_INVALID",
      `${label}模板无效：${parsed.errors.join("；")}`,
    );
  }
  const path = renderParsedNamingTemplate(parsed.template, values);
  const segments = path.split("/");
  if (segments.some((segment) => !segment)) {
    throw new AcquisitionNamingError("ACQUISITION_NAMING_TEMPLATE_INVALID", `${label}模板渲染出空目录`);
  }
  return { path, segments };
}

function renderFileName(template: string, values: NamingValues, label: string): string {
  const parsed = parseNamingTemplate(template);
  if (!parsed.ok) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_TEMPLATE_INVALID",
      `${label}模板无效：${parsed.errors.join("；")}`,
    );
  }
  const rendered = renderParsedNamingTemplate(parsed.template, values);
  if (rendered.includes("/")) {
    throw new AcquisitionNamingError("ACQUISITION_NAMING_TEMPLATE_INVALID", `${label}模板只能渲染单个文件名`);
  }
  return rendered;
}

function titleValues(title: MediaTitle, season?: number, originalName?: string): NamingValues {
  return {
    title: title.title,
    originalTitle: title.originalTitle ?? "",
    year: title.year ?? "",
    tmdbId: title.tmdbId,
    season,
    originalName,
  };
}

function canonicalNames(title: MediaTitle): readonly string[] {
  return [
    mediaLibraryFolderName({
      title: title.title,
      year: title.year,
      tmdbId: title.tmdbId,
    }),
    legacyMediaLibraryFolderName({ title: title.title, year: title.year }),
  ];
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

async function childrenOf(storage: Pick<StorageExecutor, "listChildDirectories">, parentId: string): Promise<
  readonly { id: string; name: string }[]
> {
  try {
    return await storage.listChildDirectories(parentId);
  } catch (error) {
    throw new AcquisitionNamingError(
      "ACQUISITION_NAMING_STORAGE_UNREADABLE",
      `无法读取目录 ${parentId}，已停止命名以避免写错位置`,
      { cause: error },
    );
  }
}

async function findDirectoryUnderRoot(input: {
  storage: Pick<StorageExecutor, "listChildDirectories">;
  rootDirectoryId: string;
  targetDirectoryId: string;
}): Promise<string | null> {
  const queue: Array<{ id: string; depth: number }> = [{ id: input.rootDirectoryId, depth: 0 }];
  const queued = new Set<string>([input.rootDirectoryId]);
  let expanded = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_DIRECTORY_DEPTH) continue;
    if (expanded >= MAX_DIRECTORIES_WALKED) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        `获取根 ${input.rootDirectoryId} 的目录树超过 ${MAX_DIRECTORIES_WALKED} 个目录，无法安全复用命名目录身份`,
      );
    }
    expanded += 1;
    const children = await childrenOf(input.storage, current.id);
    for (const child of children) {
      if (child.id === input.targetDirectoryId) return current.id;
      if (!queued.has(child.id)) {
        queued.add(child.id);
        queue.push({ id: child.id, depth: current.depth + 1 });
      }
    }
  }
  return null;
}

async function ensureDirectoryPath(input: {
  storage: Pick<StorageExecutor, "listChildDirectories" | "createDirectory">;
  rootDirectoryId: string;
  segments: readonly string[];
}): Promise<{ directoryId: string; relativePath: string }> {
  let parentId = input.rootDirectoryId;
  for (const segment of input.segments) {
    const children = await childrenOf(input.storage, parentId);
    const caseInsensitive = children.filter((child) => normalizedName(child.name) === normalizedName(segment));
    const exact = caseInsensitive.filter((child) => child.name === segment);
    if (caseInsensitive.length > exact.length) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        `目录“${segment}”与现有目录仅大小写不同，拒绝创建重复项`,
      );
    }
    if (exact.length > 1) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        `目录 ${parentId} 下存在多个“${segment}”，无法安全选择`,
      );
    }
    if (exact[0]) {
      parentId = exact[0].id;
      continue;
    }
    let writeError: unknown;
    let createdId: string | null = null;
    try {
      createdId = await input.storage.createDirectory({ name: segment, parentId });
    } catch (error) {
      writeError = error;
    }
    if (writeError !== undefined && isNonReconcilableWriteError(writeError)) throw writeError;
    const after = await childrenOf(input.storage, parentId);
    const matches = after.filter((child) => child.name === segment);
    if (matches.length !== 1) {
      const message = writeError instanceof Error
        ? `创建目录“${segment}”后回读未确认：${writeError.message}`
        : `创建目录“${segment}”后回读未发现唯一目录`;
      if (writeError !== undefined) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
          message,
          { cause: writeError },
        );
      }
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        message,
      );
    }
    if (createdId !== null && createdId !== matches[0]!.id) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
        `创建目录“${segment}”返回的 ID 与回读结果不一致`,
      );
    }
    parentId = matches[0]!.id;
  }
  return { directoryId: parentId, relativePath: input.segments.join("/") };
}

interface MaterializedFile {
  readonly fileId: string;
  readonly attemptId: string;
  readonly kind: "video" | "subtitle";
  readonly originalDirectoryId: string;
  readonly originalName: string;
  readonly sourcePath: string;
  hintName?: string;
}

export interface AcquisitionNamingDecorationInput {
  storage: StorageExecutor;
  database: AcquisitionNamingDatabase;
  scope: AcquisitionNamingScope;
  title: MediaTitle;
  kind: "movie" | "tv";
  categoryParentId: string;
  seasons: readonly number[];
  workflowRunId: string;
  policy: AcquisitionNamingPolicy;
  bindingPlan?: AcquisitionDirectoryBindingPlan | null;
}

export async function prepareAcquisitionNaming(input: {
  storage: StorageExecutor;
  scope: AcquisitionNamingScope;
  title: MediaTitle;
  categoryParentId: string;
  seasons: readonly number[];
  workflowRunId: string;
  bindingPlan?: AcquisitionDirectoryBindingPlan | null;
}): Promise<StorageExecutor> {
  const database = postgresDatabaseFor(input.storage);
  if (!database) return input.storage;
  const kind: "movie" | "tv" = input.title.type === "movie" ? "movie" : "tv";
  const policy = await database.resolvePolicy({
    scope: input.scope,
    targetRootId: input.categoryParentId,
    kind,
  });
  await recoverPendingFileNaming({
    storage: input.storage,
    database,
    scope: input.scope,
    title: input.title,
    categoryParentId: input.categoryParentId,
  });
  return withAcquisitionNaming({
    ...input,
    database,
    policy,
    kind,
  });
}

async function recoverPendingFileNaming(input: {
  storage: StorageExecutor;
  database: AcquisitionNamingDatabase;
  scope: AcquisitionNamingScope;
  title: MediaTitle;
  categoryParentId: string;
}): Promise<void> {
  const pending = await input.database.listPendingFileIntents({
    scope: input.scope,
    mediaType: input.title.type,
    tmdbId: input.title.tmdbId,
  });
  for (const intent of pending) {
    const identity = intent.identity;
    const parent = await findDirectoryUnderRoot({
      storage: input.storage,
      rootDirectoryId: input.categoryParentId,
      targetDirectoryId: intent.targetDirectoryId,
    });
    if (parent === null) {
      await input.database.markFileFailed(
        identity,
        `恢复时目标目录 ${intent.targetDirectoryId} 已不在当前获取根 ${input.categoryParentId} 下`,
      );
      continue;
    }
    let tree: PackageTreeFile[];
    try {
      tree = await input.storage.listTree({ directoryId: intent.targetDirectoryId });
    } catch (error) {
      await input.database.markFileFailed(identity, "恢复时无法回读目标目录");
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_STORAGE_UNREADABLE",
        `恢复文件 ${identity.fileId} 时无法回读目标目录 ${intent.targetDirectoryId}`,
        { cause: error },
      );
    }
    const current = tree.find((file) => file.providerFileId === identity.fileId);
    if (!current) {
      await input.database.markFileFailed(identity, "恢复时物理文件已不在持久化目标目录；未继续写盘");
      continue;
    }
    if (extensionOf(current.path).toLowerCase() !== extensionOf(intent.targetName).toLowerCase()) {
      await input.database.markFileFailed(identity, "恢复时实际扩展名与持久化意图不一致；未改名");
      continue;
    }
    const currentName = current.path.slice(current.path.lastIndexOf("/") + 1);
    if (currentName === intent.targetName) {
      await input.database.markFileVerified(identity, intent.targetDirectoryId);
      continue;
    }
    if (
      tree.some((file) =>
        file.providerFileId !== identity.fileId
        && file.path === intent.targetName
      )
    ) {
      await input.database.markFileFailed(identity, `恢复目标名 ${intent.targetName} 已被其他物理文件占用`);
      continue;
    }
    let writeError: unknown;
    try {
      await input.storage.renameFile({
        directoryId: intent.targetDirectoryId,
        fileId: identity.fileId,
        newName: intent.targetName,
      });
    } catch (error) {
      writeError = error;
    }
    if (writeError !== undefined && isNonReconcilableWriteError(writeError)) throw writeError;
    let after: PackageTreeFile[];
    try {
      after = await input.storage.listTree({ directoryId: intent.targetDirectoryId });
    } catch (error) {
      await input.database.markFileFailed(identity, "恢复改名结果未知且回读失败");
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `恢复文件 ${identity.fileId} 时改名结果无法回读；已停止且不会盲重试`,
        { cause: error },
      );
    }
    const verified = after.find((file) => file.providerFileId === identity.fileId);
    const verifiedName = verified?.path.slice(verified.path.lastIndexOf("/") + 1);
    if (verifiedName !== intent.targetName) {
      await input.database.markFileFailed(
        identity,
        writeError instanceof Error ? writeError.message : "恢复改名后回读名称不一致",
      );
      if (writeError !== undefined) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_FILE_UNVERIFIED",
          `恢复文件 ${identity.fileId} 失败且回读未证实目标名称`,
          { cause: writeError },
        );
      }
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `恢复文件 ${identity.fileId} 后回读未出现目标名称，已停止且不会盲重试`,
      );
    }
    await input.database.markFileVerified(identity, intent.targetDirectoryId);
  }
}

export function withAcquisitionNaming(input: AcquisitionNamingDecorationInput): StorageExecutor {
  const {
    storage: base,
    database,
    scope,
    title,
    kind,
    categoryParentId,
    workflowRunId,
    policy,
    bindingPlan,
  } = input;
  const directoryIdentities = {
    title: {
      scope,
      mediaType: title.type,
      tmdbId: title.tmdbId,
      directoryKey: "title",
    } satisfies AcquisitionNamingDirectoryIdentity,
    season: (season: number): AcquisitionNamingDirectoryIdentity => ({
      scope,
      mediaType: title.type,
      tmdbId: title.tmdbId,
      directoryKey: `season:${season}`,
    }),
  };
  const expectedTitleNames = new Set(canonicalNames(title));
  const materialized = new Map<string, MaterializedFile>();
  const videoTargetsByEpisode = new Map<
    string,
    Array<{ readonly sourcePath: string; readonly targetName: string }>
  >();
  const knownTargetDirectoryIds = new Set<string>();
  for (const directoryId of Object.values(bindingPlan?.seasonDirectoryIds ?? {})) {
    knownTargetDirectoryIds.add(directoryId);
  }
  if (bindingPlan?.kind === "movie" && bindingPlan.movieDirectoryId) {
    knownTargetDirectoryIds.add(bindingPlan.movieDirectoryId);
  }
  let showDirectoryId =
    bindingPlan?.kind === "tv"
      ? bindingPlan.showDirectoryId
      : null;
  let titleDirectoryIntent: AcquisitionNamingDirectoryIntent | null | undefined;

  const titleIntent = async (): Promise<AcquisitionNamingDirectoryIntent | null> => {
    if (titleDirectoryIntent === undefined) {
      titleDirectoryIntent = await database.getDirectoryIntent(directoryIdentities.title);
    }
    return titleDirectoryIntent;
  };

  const isExpectedTitleCreate = (request: { name: string; parentId: string }): boolean =>
    request.parentId === categoryParentId && expectedTitleNames.has(request.name.trim());

  const seasonNumberForCreate = (request: { name: string; parentId: string }): number | null => {
    if (!showDirectoryId || request.parentId !== showDirectoryId) return null;
    const match = /^Season\s+(\d{1,4})$/iu.exec(request.name.trim());
    if (!match?.[1]) return null;
    const season = Number(match[1]);
    return Number.isSafeInteger(season) && season >= 0 ? season : null;
  };

  const ensureTitleDirectory = async (): Promise<string> => {
    if (bindingPlan?.kind === "movie" && bindingPlan.movieDirectoryId) {
      knownTargetDirectoryIds.add(bindingPlan.movieDirectoryId);
      return bindingPlan.movieDirectoryId;
    }
    if (bindingPlan?.kind === "tv" && bindingPlan.showDirectoryId) {
      return bindingPlan.showDirectoryId;
    }
    const existing = await titleIntent();
    if (existing?.status === "verified" && existing.directoryId) {
      const parent = await findDirectoryUnderRoot({
        storage: base,
        rootDirectoryId: categoryParentId,
        targetDirectoryId: existing.directoryId,
      });
      if (parent === null) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
          `作品 ${title.id} 的已绑定目录 ${existing.directoryId} 不在当前获取根 ${categoryParentId} 下；请先恢复目录或调整获取根`,
        );
      }
      if (kind === "movie") knownTargetDirectoryIds.add(existing.directoryId);
      return existing.directoryId;
    }
    const rendered = renderRelativeDirectory(
      kind === "movie" ? policy.templates.movieDirectory : policy.templates.tvDirectory,
      titleValues(title),
      kind === "movie" ? "电影目录" : "剧集目录",
    );
    const intent = await database.beginDirectoryIntent({
      identity: directoryIdentities.title,
      rootDirectoryId: categoryParentId,
      relativePath: existing?.relativePath ?? rendered.path,
    });
    titleDirectoryIntent = intent;
    const intendedSegments = intent.relativePath.split("/");
    const ensured = await ensureDirectoryPath({
      storage: base,
      rootDirectoryId: categoryParentId,
      segments: intendedSegments,
    });
    await database.markDirectoryVerified({
      identity: directoryIdentities.title,
      directoryId: ensured.directoryId,
      relativePath: ensured.relativePath,
    });
    titleDirectoryIntent = {
      ...intent,
      directoryId: ensured.directoryId,
      relativePath: ensured.relativePath,
      status: "verified",
      updatedAt: new Date().toISOString(),
    };
    if (kind === "movie") knownTargetDirectoryIds.add(ensured.directoryId);
    return ensured.directoryId;
  };

  const ensureSeasonDirectory = async (season: number): Promise<string> => {
    const bound = bindingPlan?.seasonDirectoryIds[season];
    if (bound) {
      knownTargetDirectoryIds.add(bound);
      return bound;
    }
    if (!showDirectoryId) {
      showDirectoryId = await ensureTitleDirectory();
    }
    const identity = directoryIdentities.season(season);
    const existing = await database.getDirectoryIntent(identity);
    if (existing?.status === "verified" && existing.directoryId) {
      const parent = await findDirectoryUnderRoot({
        storage: base,
        rootDirectoryId: showDirectoryId,
        targetDirectoryId: existing.directoryId,
      });
      if (parent === null) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
          `第 ${season} 季的已绑定目录 ${existing.directoryId} 不在作品目录 ${showDirectoryId} 下；请先恢复目录`,
        );
      }
      knownTargetDirectoryIds.add(existing.directoryId);
      return existing.directoryId;
    }
    const rendered = renderRelativeDirectory(
      policy.templates.seasonDirectory,
      titleValues(title, season),
      "季目录",
    );
    const intent = await database.beginDirectoryIntent({
      identity,
      rootDirectoryId: showDirectoryId,
      relativePath: existing?.relativePath ?? rendered.path,
    });
    const ensured = await ensureDirectoryPath({
      storage: base,
      rootDirectoryId: showDirectoryId,
      segments: intent.relativePath.split("/"),
    });
    await database.markDirectoryVerified({
      identity,
      directoryId: ensured.directoryId,
      relativePath: ensured.relativePath,
    });
    knownTargetDirectoryIds.add(ensured.directoryId);
    return ensured.directoryId;
  };

  const recordMaterialized = async (
    attempt: TransferAttempt,
    directoryId: string,
    requestedNames: readonly string[] = [],
  ): Promise<void> => {
    if (attempt.status !== "succeeded" || attempt.materializedFileIds.length === 0) return;
    let tree: PackageTreeFile[];
    try {
      tree = await base.listTree({ directoryId });
    } catch (error) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_STORAGE_UNREADABLE",
        `转存返回了物理文件 ID，但无法回读目录 ${directoryId} 以确认实际文件名`,
        { cause: error },
      );
    }
    const byId = new Map(tree.map((file) => [file.providerFileId, file]));
    for (const [index, fileId] of attempt.materializedFileIds.entries()) {
      const file = byId.get(fileId);
      if (!file) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_FILE_UNVERIFIED",
          `转存返回的文件 ${fileId} 未在目录 ${directoryId} 中回读出现`,
        );
      }
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      const type = fileKind(name);
      if (!type) continue;
      materialized.set(fileId, {
        fileId,
        attemptId: attempt.id,
        kind: type,
        originalDirectoryId: directoryId,
        originalName: name,
        sourcePath: file.path,
        ...(requestedNames[index] === undefined || !requestedNames[index]
          ? {}
          : { hintName: requestedNames[index] }),
      });
    }
  };

  const reliableEpisodeCodes = (name: string): string[] => {
    const codePattern = /[Ss](\d{1,2})[Ee](\d{1,4})/gu;
    const direct = [...name.matchAll(codePattern)].map((match) =>
      `S${match[1]!.padStart(2, "0")}E${match[2]!.padStart(2, "0")}`,
    );
    if (direct.length === 0) return [];
    if (direct.length > 1) return [...new Set(direct)];
    const first = direct[0]!;
    const parts = episodePartsFromCode(first);
    const endpointCode = (episode: number): string =>
      `S${String(parts.seasonNumber).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    const expandedRange = (last: number): string[] => {
      if (last === parts.episodeNumber) return [first];
      if (last < parts.episodeNumber || last - parts.episodeNumber > 999) {
        return [first, endpointCode(last)];
      }
      return Array.from(
        { length: last - parts.episodeNumber + 1 },
        (_, index) => endpointCode(parts.episodeNumber + index),
      );
    };
    const compact = new RegExp(
      `[Ss]${String(parts.seasonNumber).padStart(2, "0")}[Ee]${String(parts.episodeNumber).padStart(2, "0")}[Ee](\\d{1,4})`,
      "u",
    ).exec(name);
    if (compact?.[1]) {
      return expandedRange(Number(compact[1]));
    }
    const range = new RegExp(
      `[Ss]${String(parts.seasonNumber).padStart(2, "0")}[Ee]${String(parts.episodeNumber).padStart(2, "0")}\\s*[-–]\\s*(?:(?:[Ss]\\d{1,2})?[Ee])?(\\d{1,4})`,
      "u",
    ).exec(name);
    if (range?.[1]) {
      return expandedRange(Number(range[1]));
    }
    return [first];
  };

  const targetNameForVideo = (
    sourceName: string,
    codes: readonly string[],
    resolution?: string,
  ): string => {
    const extension = extensionOf(sourceName);
    if (kind === "movie") {
      return renderFileName(
        policy.templates.movieFile,
        {
          ...titleValues(title, 1, sourceName),
          episode: 1,
          episodeCode: "MOVIE",
          ext: extension,
        },
        "电影文件",
      );
    }
    const code = codes[0]!;
    const parts = episodePartsFromCode(code);
    return renderFileName(
      policy.templates.episodeFile,
      {
        ...titleValues(title, parts.seasonNumber, sourceName),
        episode: parts.episodeNumber,
        episodeCode: code,
        resolution,
        ext: extension,
      },
      "剧集文件",
    );
  };

  const assertSameExtension = (sourceName: string, targetName: string, label: string): void => {
    if (extensionOf(sourceName).toLowerCase() !== extensionOf(targetName).toLowerCase()) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_TEMPLATE_INVALID",
        `${label}模板没有保留实际扩展名 ${extensionOf(sourceName) || "（无扩展名）"}`,
      );
    }
  };

  const fileIdentityFor = (fileId: string): AcquisitionNamingFileIdentity => ({
    scope,
    mediaType: title.type,
    tmdbId: title.tmdbId,
    workflowRunId,
    fileId,
  });

  const recordSkip = async (inputSkip: {
    identity: AcquisitionNamingFileIdentity;
    entry: MaterializedFile;
    directoryId: string;
    currentName: string;
    episodeCodes: readonly string[];
    reason: string;
  }): Promise<void> => {
    const existing = await database.getFileIntent(inputSkip.identity);
    if (!existing) {
      await database.beginFileIntent({
        identity: inputSkip.identity,
        attemptId: inputSkip.entry.attemptId,
        kind: inputSkip.entry.kind,
        originalDirectoryId: inputSkip.entry.originalDirectoryId,
        originalName: inputSkip.entry.originalName,
        targetDirectoryId: inputSkip.directoryId,
        targetName: inputSkip.currentName,
        episodeCodes: inputSkip.episodeCodes,
      });
    }
    await database.markFileSkipped(inputSkip.identity, inputSkip.reason);
  };

  const rememberVideoTarget = (
    code: string,
    sourcePath: string,
    targetName: string,
  ): void => {
    const targets = videoTargetsByEpisode.get(code) ?? [];
    const next = targets.filter((target) =>
      target.sourcePath !== sourcePath || target.targetName !== targetName
    );
    next.push({ sourcePath, targetName });
    videoTargetsByEpisode.set(code, next);
  };

  const subtitleTargetName = (
    entry: MaterializedFile,
    tree: readonly PackageTreeFile[],
    currentPath: PackageTreeFile,
    episodeCode: string,
  ): string | null => {
    const hint = entry.hintName;
    const sourceSubtitlePath = hint
      ? `${currentPath.path.slice(0, currentPath.path.lastIndexOf("/") + 1)}${hint}`
      : currentPath.path;
    const newVideoTargets = videoTargetsByEpisode.get(episodeCode) ?? [];
    const paired = newVideoTargets.flatMap((video) => {
      const derived = deriveSubtitlePath(video.sourcePath, sourceSubtitlePath, video.targetName);
      return derived ? [derived] : [];
    });
    if (paired.length === 1) return paired[0]!.slice(paired[0]!.lastIndexOf("/") + 1);
    if (paired.length > 1) return null;

    const existingVideos = tree.flatMap((file) => {
      if (file.providerFileId === entry.fileId || !VIDEO_EXTENSIONS.has(extensionOf(file.path).toLowerCase())) {
        return [];
      }
      const codes = reliableEpisodeCodes(file.path.slice(file.path.lastIndexOf("/") + 1));
      if (codes.length !== 1 || codes[0] !== episodeCode) return [];
      const derived = deriveSubtitlePath(file.path, sourceSubtitlePath, file.path);
      return derived ? [derived] : [];
    });
    if (existingVideos.length !== 1) return null;
    return existingVideos[0]!.slice(existingVideos[0]!.lastIndexOf("/") + 1);
  };

  const uniqueTargetName = (
    tree: readonly PackageTreeFile[],
    directoryId: string,
    fileId: string,
    desiredName: string,
    persistedName?: string,
  ): string => {
    const name = persistedName ?? desiredName;
    const collision = tree.some((file) =>
      file.providerFileId !== fileId
      && baseNameOf(file.path) === name,
    );
    if (!collision) return name;
    if (persistedName !== undefined) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `目录 ${directoryId} 中目标文件名“${name}”已被其他文件占用，已停止覆盖`,
      );
    }
    return addStableCollisionSuffix(name, fileId);
  };

  const applyOneFile = async (
    directoryId: string,
    entry: MaterializedFile,
    tree: readonly PackageTreeFile[],
  ): Promise<void> => {
    const identity = fileIdentityFor(entry.fileId);
    const currentPath = tree.find((file) => file.providerFileId === entry.fileId);
    if (!currentPath) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `本次新获取文件 ${entry.fileId} 未在目标目录 ${directoryId} 回读出现`,
      );
    }
    const currentName = currentPath.path.slice(currentPath.path.lastIndexOf("/") + 1);
    const codes = kind === "movie"
      ? ["MOVIE"]
      : reliableEpisodeCodes(entry.hintName ?? currentName ?? entry.originalName);
    if (codes.length !== 1) {
      await recordSkip({
        identity,
        entry,
        directoryId,
        currentName,
        episodeCodes: codes,
        reason: codes.length > 1
          ? `文件 ${entry.fileId} 含 ${codes.join("、")} 多集身份；当前获取链路无法安全表达完整多集映射，已保留原名`
          : `文件 ${entry.fileId} 无可信季集映射，已保留原名并记录审计`,
      });
      return;
    }
    const desiredName = entry.kind === "video"
      ? targetNameForVideo(
          currentName,
          codes,
          /\b(?:2160p|4k|1080p|720p)\b/iu.exec(currentName)?.[0],
        )
      : SUBTITLE_EXTENSIONS.has(extensionOf(currentName).toLowerCase())
        ? subtitleTargetName(entry, tree, currentPath, codes[0]!)
        : null;
    if (!desiredName) {
      await recordSkip({
        identity,
        entry,
        directoryId,
        currentName,
        episodeCodes: codes,
        reason: `文件 ${entry.fileId} 无法与唯一视频配对并保留语言/forced 后缀，已保留原名`,
      });
      return;
    }
    assertSameExtension(currentName, desiredName, entry.kind === "video" ? "视频文件" : "字幕");
    const existingIntent = await database.getFileIntent(identity);
    if (existingIntent?.status === "skipped") return;
    const targetName = uniqueTargetName(
      tree,
      directoryId,
      entry.fileId,
      desiredName,
      existingIntent?.targetName,
    );
    const proposed = await database.beginFileIntent({
      identity,
      attemptId: entry.attemptId,
      kind: entry.kind,
      originalDirectoryId: entry.originalDirectoryId,
      originalName: entry.originalName,
      targetDirectoryId: directoryId,
      targetName,
      episodeCodes: codes,
    });
    const persistedTargetName = proposed.targetName;
    if (currentName === persistedTargetName) {
      if (entry.kind === "video") rememberVideoTarget(codes[0]!, currentPath.path, persistedTargetName);
      await database.markFileVerified(identity, directoryId);
      return;
    }
    let writeError: unknown;
    try {
      await base.renameFile({ directoryId, fileId: entry.fileId, newName: persistedTargetName });
    } catch (error) {
      writeError = error;
    }
    if (writeError !== undefined && isNonReconcilableWriteError(writeError)) throw writeError;
    let after: PackageTreeFile[];
    try {
      after = await base.listTree({ directoryId });
    } catch (error) {
      await database.markFileFailed(identity, "写请求结果未知且回读失败");
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `文件 ${entry.fileId} 的改名结果无法回读，已停止本次获取；下一轮将按持久化意图恢复`,
        { cause: error },
      );
    }
    const verified = after.find((file) => file.providerFileId === entry.fileId);
    const verifiedName = verified?.path.slice(verified.path.lastIndexOf("/") + 1);
    if (verifiedName !== persistedTargetName) {
      await database.markFileFailed(
        identity,
        writeError instanceof Error ? writeError.message : "改名后回读名称不一致",
      );
      if (writeError !== undefined) {
        throw new AcquisitionNamingError(
          "ACQUISITION_NAMING_FILE_UNVERIFIED",
          `文件 ${entry.fileId} 的改名未通过回读核实；为防重复写已停止，下一轮按持久化意图恢复`,
          { cause: writeError },
        );
      }
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `文件 ${entry.fileId} 的改名未通过回读核实；为防重复写已停止，下一轮按持久化意图恢复`,
      );
    }
    await database.markFileVerified(identity, directoryId);
    if (entry.kind === "video") rememberVideoTarget(codes[0]!, currentPath.path, persistedTargetName);
  };

  const applyMaterializedFiles = async (
    directoryId: string,
    fileIds: readonly string[],
  ): Promise<void> => {
    const entries = fileIds.flatMap((fileId) => {
      const entry = materialized.get(fileId);
      return entry ? [entry] : [];
    });
    if (entries.length === 0) return;
    let tree = await base.listTree({ directoryId });
    const presentIds = new Set(tree.map((file) => file.providerFileId));
    const missing = entries.filter((entry) => !presentIds.has(entry.fileId));
    if (missing.length > 0) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_FILE_UNVERIFIED",
        `本次新获取文件未在目标目录 ${directoryId} 回读出现：${missing.map((entry) => entry.fileId).join("、")}`,
      );
    }
    const ordered = [...entries].sort((left, right) =>
      left.kind === right.kind ? 0 : left.kind === "video" ? -1 : 1,
    );
    for (const entry of ordered) {
      tree = await base.listTree({ directoryId });
      await applyOneFile(directoryId, entry, tree);
    }
  };

  const moveAndVerify = async (inputMove: {
    fileIds: string[];
    targetDirectoryId: string;
  }): Promise<{ moved: string[] }> => {
    let result: { moved: string[] } | null = null;
    let moveError: unknown;
    try {
      result = await base.moveFiles(inputMove);
    } catch (error) {
      moveError = error;
    }
    if (moveError !== undefined && isNonReconcilableWriteError(moveError)) throw moveError;
    let tree: PackageTreeFile[];
    try {
      tree = await base.listTree({ directoryId: inputMove.targetDirectoryId });
    } catch (error) {
      throw new AcquisitionNamingError(
        "ACQUISITION_NAMING_STORAGE_UNREADABLE",
        `文件移动结果未知且无法回读目标目录 ${inputMove.targetDirectoryId}`,
        { cause: error },
      );
    }
    const present = new Set(tree.map((file) => file.providerFileId));
    const absent = inputMove.fileIds.filter((fileId) => !present.has(fileId));
    if (absent.length > 0) {
      throw moveError instanceof Error
        ? moveError
        : new AcquisitionNamingError(
            "ACQUISITION_NAMING_FILE_UNVERIFIED",
            `文件移动返回成功但目标目录未回读到：${absent.join("、")}`,
          );
    }
    await applyMaterializedFiles(inputMove.targetDirectoryId, inputMove.fileIds);
    return result ?? { moved: inputMove.fileIds };
  };

  const applyIfTargetDirectory = async (
    directoryId: string,
    fileIds: readonly string[],
  ): Promise<void> => {
    if (!knownTargetDirectoryIds.has(directoryId) || fileIds.length === 0) return;
    await applyMaterializedFiles(directoryId, fileIds);
  };

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "createDirectory") {
        return async (create: { name: string; parentId: string }): Promise<string> => {
          if (isExpectedTitleCreate(create)) {
            const directoryId = await ensureTitleDirectory();
            showDirectoryId = directoryId;
            return directoryId;
          }
          if (kind === "tv") {
            const season = seasonNumberForCreate(create);
            if (season !== null) return ensureSeasonDirectory(season);
          }
          const directoryId = await target.createDirectory(create);
          if (create.name.startsWith("staging-") && create.parentId === showDirectoryId) {
            showDirectoryId = create.parentId;
          }
          return directoryId;
        };
      }
      if (property === "listChildDirectories") {
        return async (directoryId: string): Promise<Array<{ id: string; name: string }>> => {
          const children = await target.listChildDirectories(directoryId);
          if (directoryId !== categoryParentId) return children;
          const intent = await titleIntent();
          if (!intent?.directoryId) {
            const legacyTitleChildren = children.filter((child) => expectedTitleNames.has(child.name));
            if (legacyTitleChildren.length === 1) {
              if (kind === "tv") showDirectoryId = legacyTitleChildren[0]!.id;
              else knownTargetDirectoryIds.add(legacyTitleChildren[0]!.id);
            }
            return children;
          }
          const parent = await findDirectoryUnderRoot({
            storage: target,
            rootDirectoryId: categoryParentId,
            targetDirectoryId: intent.directoryId,
          });
          if (parent === null) {
            throw new AcquisitionNamingError(
              "ACQUISITION_NAMING_DIRECTORY_UNVERIFIED",
              `作品 ${title.id} 的命名目录已不在获取根 ${categoryParentId} 下`,
            );
          }
          showDirectoryId = intent.directoryId;
          const hiddenNames = expectedTitleNames;
          return [
            ...children.filter((child) => child.id !== intent.directoryId && !hiddenNames.has(child.name)),
            { id: intent.directoryId, name: canonicalNames(title)[0]! },
          ];
        };
      }
      if (property === "transfer") {
        return async (request: Parameters<StorageExecutor["transfer"]>[0]): Promise<TransferAttempt> => {
          const attempt = await target.transfer(request);
          await recordMaterialized(attempt, request.directoryId);
          await applyIfTargetDirectory(request.directoryId, attempt.materializedFileIds);
          return attempt;
        };
      }
      if (property === "transferSubtitleUrl") {
        const method = target.transferSubtitleUrl;
        if (!method) return undefined;
        return async (request: Parameters<NonNullable<StorageExecutor["transferSubtitleUrl"]>>[0]): Promise<TransferAttempt> => {
          const attempt = await method.call(target, request);
          await recordMaterialized(attempt, request.directoryId, [request.filename]);
          await applyIfTargetDirectory(request.directoryId, attempt.materializedFileIds);
          return attempt;
        };
      }
      if (property === "transferSubtitleUrls") {
        const method = target.transferSubtitleUrls;
        if (!method) return undefined;
        return async (request: Parameters<NonNullable<StorageExecutor["transferSubtitleUrls"]>>[0]): Promise<TransferAttempt[]> => {
          const attempts = await method.call(target, request);
          for (const [index, attempt] of attempts.entries()) {
            await recordMaterialized(
              attempt,
              request.directoryId,
              attempt.materializedNames?.length === attempt.materializedFileIds.length
                ? attempt.materializedNames
                : [request.files[index]?.filename ?? ""],
            );
          }
          await applyIfTargetDirectory(
            request.directoryId,
            attempts.flatMap((attempt) => attempt.materializedFileIds),
          );
          return attempts;
        };
      }
      if (property === "moveFiles") {
        return moveAndVerify;
      }
      if (property === "flattenDirectory") {
        return async (directoryId: string): Promise<{ moved: string[]; removed: string[] }> => {
          let result: { moved: string[]; removed: string[] } | null = null;
          let writeError: unknown;
          try {
            result = await target.flattenDirectory(directoryId);
          } catch (error) {
            writeError = error;
          }
          if (writeError !== undefined && isNonReconcilableWriteError(writeError)) throw writeError;
          let tree: PackageTreeFile[];
          try {
            tree = await target.listTree({ directoryId });
          } catch (error) {
            throw new AcquisitionNamingError(
              "ACQUISITION_NAMING_STORAGE_UNREADABLE",
              `电影整理结果未知且无法回读目录 ${directoryId}`,
              { cause: error },
            );
          }
          const present = new Set(tree.map((file) => file.providerFileId));
          const tracked = [...materialized.values()]
            .filter((entry) => entry.kind === "video" || entry.kind === "subtitle")
            .map((entry) => entry.fileId);
          const expected = tracked.filter((fileId) => present.has(fileId));
          if (writeError) {
            const allTrackedVisibleAndFlat = tracked.length > 0
              && tracked.every((fileId) => present.has(fileId))
              && tree.every((file) =>
                !tracked.includes(file.providerFileId) || !file.path.includes("/")
              );
            if (!allTrackedVisibleAndFlat) throw writeError;
          }
          await applyMaterializedFiles(directoryId, expected);
          return result ?? { moved: expected, removed: [] };
        };
      }
      if (property === "renameFile") {
        return async (request: Parameters<StorageExecutor["renameFile"]>[0]): Promise<void> => {
          const entry = materialized.get(request.fileId);
          if (!entry) {
            await target.renameFile(request);
            return;
          }
          if (!knownTargetDirectoryIds.has(request.directoryId)) {
            let writeError: unknown;
            try {
              await target.renameFile(request);
            } catch (error) {
              writeError = error;
            }
            if (writeError !== undefined && isNonReconcilableWriteError(writeError)) throw writeError;
            let tree: PackageTreeFile[];
            try {
              tree = await target.listTree({ directoryId: request.directoryId });
            } catch (error) {
              throw new AcquisitionNamingError(
                "ACQUISITION_NAMING_FILE_UNVERIFIED",
                `字幕文件 ${request.fileId} 的暂存区改名结果无法回读，已停止且不会盲重试`,
                { cause: error },
              );
            }
            const current = tree.find((file) => file.providerFileId === request.fileId);
            if (current && baseNameOf(current.path) === request.newName) {
              entry.hintName = request.newName;
              return;
            }
            if (writeError instanceof Error) throw writeError;
            if (writeError !== undefined) {
              throw new AcquisitionNamingError(
                "ACQUISITION_NAMING_FILE_UNVERIFIED",
                `字幕文件 ${request.fileId} 的暂存区改名未通过回读核实，已停止且不会盲重试`,
                { cause: writeError },
              );
            }
            throw new AcquisitionNamingError(
              "ACQUISITION_NAMING_FILE_UNVERIFIED",
              `字幕文件 ${request.fileId} 的暂存区改名未通过回读核实，已停止且不会盲重试`,
            );
          }
          entry.hintName = request.newName;
          await applyMaterializedFiles(request.directoryId, [request.fileId]);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
