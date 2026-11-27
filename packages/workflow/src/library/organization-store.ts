import type { Pool, PoolClient } from "pg";
import { STORAGE_BRANDS } from "../storage-brands.js";
import { DEFAULT_NAMING_TEMPLATES, deriveSubtitlePath, type NamingTemplateKind } from "./naming.js";
import { DEFAULT_ORGANIZE_CONCURRENCY, MAX_ORGANIZE_CONCURRENCY, MIN_ORGANIZE_CONCURRENCY } from "./scanner.js";
import type { OrganizationGraph, OrganizationIdentity, OrganizationOperation, OrganizationPlan, OrganizationPlanInput, OrganizationScope, OrganizationTaskStatus } from "./organizer.js";

export const LIBRARY_ORGANIZATION_SCHEMA_ADVISORY_LOCK_KEY = 4_011_989_144;
const REGISTERED_STORAGE_PROVIDERS = STORAGE_BRANDS.map(({ provider }) => provider);

export type OrganizationHistoryStatusFilter = "all" | "active" | "planned" | "running" | "verified" | "failed";

export interface OrganizationHistoryItem {
  taskId: string;
  operationKey: string;
  operationId: string;
  fileId: string;
  originalParentId: string;
  originalName: string;
  targetRootId: string;
  targetRelativePath: string;
  targetParentId: string | null;
  targetName: string;
  identity: OrganizationIdentity | null;
  pairedFileId: string;
  pairedVideoTargetPath: string;
  status: OrganizationOperation["status"];
  error: string | null;
  updatedAt: string;
}

export interface OrganizationHistoryPage {
  items: OrganizationHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  counts: {
    all: number;
    running: number;
    planned: number;
    verified: number;
    failed: number;
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS library_organization_plans (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  task_id text NOT NULL,
  operation_key text NOT NULL,
  source_root_ids jsonb NOT NULL,
  target_root_ids jsonb NOT NULL,
  target_roots_by_media_type jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('planned','running','paused','completed','failed')),
  skipped_files jsonb NOT NULL DEFAULT '[]'::jsonb,
  lease_id text,
  lease_expires_at timestamptz,
  execute_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(account_id, connected_storage_id, task_id, operation_key)
);
CREATE TABLE IF NOT EXISTS library_organization_operations (
  account_id text NOT NULL,
  connected_storage_id text NOT NULL,
  task_id text NOT NULL,
  operation_key text NOT NULL,
  operation_id text NOT NULL,
  file_id text NOT NULL,
  original_parent_id text NOT NULL,
  original_name text NOT NULL,
  target_root_id text NOT NULL,
  target_relative_path text NOT NULL,
  target_parent_id text,
  target_name text NOT NULL,
  identity jsonb,
  paired_file_id text,
  paired_video_target_path text,
  status text NOT NULL CHECK (status IN ('planned','running','verified','failed')),
  error text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(account_id, connected_storage_id, task_id, operation_key, operation_id),
  FOREIGN KEY(account_id, connected_storage_id, task_id, operation_key)
    REFERENCES library_organization_plans(account_id, connected_storage_id, task_id, operation_key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS library_organization_operations_status
  ON library_organization_operations(account_id, connected_storage_id, task_id, operation_key, status, operation_id);
CREATE INDEX IF NOT EXISTS library_organization_operations_history
  ON library_organization_operations(account_id, connected_storage_id, updated_at DESC, operation_id DESC);
`;
const SCHEMA_COMPAT = `
  ALTER TABLE library_organization_plans ADD COLUMN IF NOT EXISTS skipped_files jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE library_organization_plans ADD COLUMN IF NOT EXISTS execute_requested boolean NOT NULL DEFAULT false;
  ALTER TABLE library_organization_plans ADD COLUMN IF NOT EXISTS target_roots_by_media_type jsonb NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE library_organization_operations ADD COLUMN IF NOT EXISTS identity jsonb;
  ALTER TABLE library_organization_operations ADD COLUMN IF NOT EXISTS paired_file_id text;
  ALTER TABLE library_organization_operations ADD COLUMN IF NOT EXISTS paired_video_target_path text;
  CREATE INDEX IF NOT EXISTS library_organization_operations_history ON library_organization_operations(account_id, connected_storage_id, updated_at DESC, operation_id DESC);
`;

export interface OrganizationPlanCreate {
  plan: OrganizationPlan;
  operationKey: string;
}

/** F08f passes this only for automatic dispatch. Manual API calls keep the old four-argument behavior. */
export interface OrganizationExecutionRequestOptions {
  autoOrganization?: { batchId: string; leaseId: string };
}

export interface OrganizationStore {
  ensureSchema(): Promise<void>;
  /** Replace caller-supplied authorization facts with verified task/config/import facts. */
  authorizePlan(input: OrganizationPlanInput): Promise<OrganizationPlanInput>;
  /** Recheck the persisted task/config/import bindings before every execution or resume. */
  authorizeExecution(plan: OrganizationPlan): Promise<void>;
  createOrGet(input: OrganizationPlanCreate): Promise<OrganizationPlan>;
  get(scope: OrganizationScope, taskId: string, operationKey: string): Promise<OrganizationPlan | null>;
  claim(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, now: string, expiresAt: string): Promise<boolean>;
  renew(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, now: string, expiresAt: string): Promise<boolean>;
  updateOperation(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, operation: OrganizationOperation, now: string): Promise<boolean>;
  finish(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, status: OrganizationTaskStatus, now: string): Promise<boolean>;
  requestExecution(scope: OrganizationScope, taskId: string, operationKey: string, now: string, options?: OrganizationExecutionRequestOptions): Promise<boolean>;
  pause(scope: OrganizationScope, taskId: string, operationKey: string, now: string): Promise<boolean>;
  listRequested(scope: OrganizationScope, limit: number): Promise<Array<{ taskId: string; operationKey: string }>>;
  listPlans(scope: OrganizationScope, taskId: string, input: { limit: number; afterOperationKey?: string }): Promise<Array<{ operationKey: string; status: OrganizationTaskStatus; executeRequested: boolean; createdAt: string; updatedAt: string; skippedFiles: Array<{fileId:string;reason:string}>; operationCount: number }>>;
  getPlanSummary(scope: OrganizationScope, taskId: string, operationKey: string): Promise<{ operationKey: string; status: OrganizationTaskStatus; executeRequested: boolean; createdAt: string; updatedAt: string; skippedFiles: Array<{fileId:string;reason:string}>; operationCount: number } | null>;
  listVerifiedLocationsToSync(scope: OrganizationScope, taskId: string, operationKey: string, limit: number): Promise<Array<{ fileId:string; parentId:string; name:string; targetRootId:string; relativePath:string }>>;
  listVerifiedLocationPlanKeys(scope: OrganizationScope, limit: number): Promise<Array<{taskId:string;operationKey:string}>>;
  listOperations(scope: OrganizationScope, taskId: string, operationKey: string, input: { limit: number; afterOperationId?: string }): Promise<OrganizationOperation[]>;
  derivePlanInput(scope: OrganizationScope, taskId: string, input: { fileIds?: readonly string[]; afterFileId?: string; limit: number; operationKey: string }): Promise<OrganizationPlanInput>;
}

interface PlanRow { account_id: string; connected_storage_id: string; task_id: string; operation_key: string; source_root_ids: string[]; target_root_ids: string[]; target_roots_by_media_type: Partial<Record<OrganizationIdentity["mediaType"],string>>; skipped_files: Array<{fileId:string;reason:string}>; status: OrganizationTaskStatus; execute_requested: boolean; created_at: Date; updated_at: Date; }
interface OperationRow { operation_id: string; file_id: string; original_parent_id: string; original_name: string; target_root_id: string; target_relative_path: string; target_parent_id: string | null; target_name: string; identity: unknown; paired_file_id: string; paired_video_target_path: string; status: OrganizationOperation["status"]; error: string | null; }
interface ScanConfigRow { status: string; configuration: unknown; }
interface ScanDirectoryAuthRow { directory_id: string; parent_directory_id: string | null; path: string; }
interface ScanFileAuthRow { file_id: string; parent_directory_id: string; name: string; is_directory: boolean; }
interface FileIdentityRow { file_id: string; parent_directory_id: string; media_title_id: string; tracked_season_id: string; media_type: string; tmdb_id: number; episode_codes: unknown; quality: string | null; title_payload: unknown; season_payload: unknown; }
interface TrustedScanContext { configuration: Record<string,unknown>; sourceRootIds: string[]; graph: OrganizationGraph; directoryParents: Map<string,string|null>; files: Map<string,{fileId:string;parentDirectoryId:string;name:string;isDirectory:boolean}>; }

export class PostgresOrganizationStore implements OrganizationStore {
  private schema: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {}

  ensureSchema(): Promise<void> {
    if (!this.schema) this.schema = this.initialize().catch((error: unknown) => { this.schema = null; throw error; });
    return this.schema;
  }

  async authorizePlan(input: OrganizationPlanInput): Promise<OrganizationPlanInput> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client,input.scope);
      const context = await loadScanAuthorization(client,input.scope,input.taskId,[...input.confirmedFiles.map(({fileId})=>fileId),...(input.preSkippedFiles ?? []).map(({fileId})=>fileId)]);
      if (!sameSet(input.sourceRoots,context.sourceRootIds)) throw new Error("整理来源根与该扫描任务持久化配置不一致");
      const suppliedById = new Map(input.confirmedFiles.map((file) => [file.fileId,file]));
      if (suppliedById.size !== input.confirmedFiles.length || (suppliedById.size === 0 && !(input.preSkippedFiles?.length))) throw new Error("整理计划必须包含已确认媒体文件或明确的安全跳过项");
      const identities = await loadBoundIdentities(client,input.scope,input.confirmedFiles.map(({fileId}) => fileId));
      const authorizedFiles = input.confirmedFiles.map((file) => {
        const scanFact = context.files.get(file.fileId);
        if (!scanFact || scanFact.isDirectory || scanFact.parentDirectoryId !== file.parentDirectoryId || scanFact.name !== file.name) throw new Error(`文件 ${file.fileId} 与持久化扫描事实不一致`);
        if (!isWithinRoots(file.parentDirectoryId,context.sourceRootIds,context.directoryParents)) throw new Error(`文件 ${file.fileId} 不属于该扫描任务的已授权来源根`);
        const binding = identities.get(file.fileId);
        if (!binding || binding.parent_directory_id !== file.parentDirectoryId || !identityMatchesBinding(file.identity,binding)) throw new Error(`文件 ${file.fileId} 的整理身份/目录与F02导入绑定不一致`);
        return { ...file,confirmed:true as const,identity:identityFromBinding(file.identity,binding) };
      });
      const targetRootByMediaType: Partial<Record<OrganizationPlanInput["confirmedFiles"][number]["identity"]["mediaType"],string>> = {};
      for (const file of authorizedFiles) {
        const configured = configuredTarget(context.configuration,file.identity.mediaType);
        const supplied = input.targetRootByMediaType?.[file.identity.mediaType] ?? (input.targetRoots.length === 1 ? input.targetRoots[0] : undefined);
        if (!configured || supplied !== configured) throw new Error(`媒体类型 ${file.identity.mediaType} 的目标根与持久化扫描配置不一致`);
        targetRootByMediaType[file.identity.mediaType] = configured;
      }
      const targetRootIds = [...new Set(Object.values(targetRootByMediaType).filter((value): value is string => typeof value === "string"))];
      if (!sameSet(input.targetRoots,targetRootIds)) throw new Error("整理目标根与该扫描任务持久化配置不一致");
      const configuredTemplates = asRecord(context.configuration.templates);
      const templates = {} as Record<NamingTemplateKind,string>;
      const templateKinds = Object.keys(DEFAULT_NAMING_TEMPLATES) as NamingTemplateKind[];
      for (const kind of templateKinds) {
        const saved = configuredTemplates[kind];
        if (saved !== undefined && (typeof saved !== "string" || !saved.trim())) throw new Error(`持久化模板 ${kind} 无效`);
        const value = typeof saved === "string" ? saved : DEFAULT_NAMING_TEMPLATES[kind];
        const supplied = input.templates?.[kind];
        if (supplied !== undefined && supplied !== value) throw new Error(`模板 ${kind} 与持久化扫描配置不一致`);
        templates[kind] = value;
      }
      if (Object.keys(input.templates ?? {}).some((key) => !templateKinds.includes(key as NamingTemplateKind))) throw new Error("整理请求包含未知模板类型");
      return { ...input,sourceRoots:context.sourceRootIds,targetRoots:targetRootIds,targetRootByMediaType,templates,graph:context.graph,confirmedFiles:authorizedFiles };
    } finally { client.release(); }
  }

  /** Constructs planner facts exclusively from the persisted scan and F02 rows. */
  async derivePlanInput(scope: OrganizationScope, taskId: string, selection: { fileIds?: readonly string[]; afterFileId?: string; limit: number; operationKey: string }): Promise<OrganizationPlanInput> {
    if (!Number.isSafeInteger(selection.limit) || selection.limit < 1 || selection.limit > 100) throw new RangeError("organization preview batch must be 1..100");
    if (!selection.operationKey.trim()) throw new Error("整理清单幂等键不能为空");
    if (selection.fileIds && (selection.fileIds.length < 1 || selection.fileIds.length > 100 || new Set(selection.fileIds).size !== selection.fileIds.length || selection.fileIds.some((id) => !id.trim()))) throw new Error("整理文件选择必须包含1至100个唯一文件ID");
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client,scope);
      let requested: string[];
      if (selection.fileIds) requested = [...selection.fileIds];
      else {
        const ids = await client.query<{file_id:string}>(
          `SELECT f.file_id FROM library_scan_task_files f JOIN library_file_bindings b
             ON b.account_id=f.account_id AND b.connected_storage_id=f.connected_storage_id AND b.file_id=f.file_id
            WHERE f.account_id=$1 AND f.connected_storage_id=$2 AND f.task_id=$3 AND NOT f.is_directory
              AND ($4::text IS NULL OR f.file_id>$4) ORDER BY f.file_id LIMIT $5`,
          [scope.accountId,scope.connectedStorageId,taskId,selection.afterFileId ?? null,selection.limit],
        );
        requested = ids.rows.map(({file_id}) => file_id);
      }
      if (requested.length === 0) throw new Error("没有可整理的已导入文件");
      const context = await loadScanAuthorization(client,scope,taskId,requested);
      const identities = await loadBoundIdentities(client,scope,requested);
      const confirmedFiles: OrganizationPlanInput["confirmedFiles"][number][] = [];
      const preSkippedFiles: Array<{fileId:string;reason:string}> = [];
      for (const fileId of requested) {
        const fact = context.files.get(fileId);
        const binding = identities.get(fileId);
        if (!fact || fact.isDirectory || !binding || fact.parentDirectoryId !== binding.parent_directory_id) throw new Error(`文件 ${fileId} 不存在于该任务的持久扫描及已导入绑定中`);
        const codes = Array.isArray(binding.episode_codes) ? binding.episode_codes.filter((value): value is string => typeof value === "string") : [];
        if (binding.media_type !== "movie" && codes.length !== 1) {
          preSkippedFiles.push({fileId,reason:`该provider文件绑定了${codes.length}集，当前命名模板不能安全表达完整多集身份，已保留原位`});
          continue;
        }
        const title = asRecord(binding.title_payload);
        const season = asRecord(binding.season_payload);
        const episodeCode = codes[0];
        const episodeMatch = episodeCode ? /^S\d{2}E(\d+)$/u.exec(episodeCode) : null;
        confirmedFiles.push({fileId,parentDirectoryId:fact.parentDirectoryId,name:fact.name,isDirectory:false,confirmed:true,identity:{
          mediaTitleId:binding.media_title_id,trackedSeasonId:binding.tracked_season_id,mediaType:binding.media_type as OrganizationIdentity["mediaType"],
          title:String(title.title ?? ""),originalTitle:String(title.originalTitle ?? ""),year:Number(title.year),tmdbId:Number(binding.tmdb_id),
          season:Number(season.seasonNumber ?? 1),...(episodeCode ? {episodeCode} : {}),...(episodeMatch ? {episode:Number(episodeMatch[1])} : {}),
          ...(binding.quality ? {resolution:binding.quality} : {}),
        }});
      }
      if (!confirmedFiles.length && !preSkippedFiles.length) throw new Error("所选范围内没有可整理的已导入文件");
      const targetRootByMediaType: Partial<Record<OrganizationIdentity["mediaType"],string>> = {};
      for (const file of confirmedFiles) {
        const configured = configuredTarget(context.configuration,file.identity.mediaType);
        if (!configured) throw new Error(`媒体类型 ${file.identity.mediaType} 尚未配置整理目标目录`);
        targetRootByMediaType[file.identity.mediaType] = configured;
      }
      const targetRoots = [...new Set(Object.values(targetRootByMediaType).filter((value): value is string => typeof value === "string"))];
      return {scope,taskId,operationKey:selection.operationKey,sourceRoots:context.sourceRootIds,targetRoots,targetRootByMediaType,graph:context.graph,confirmedFiles,preSkippedFiles};
    } finally { client.release(); }
  }

  async authorizeExecution(plan: OrganizationPlan): Promise<void> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client,plan.scope);
      const context = await loadScanAuthorization(client,plan.scope,plan.taskId,[...plan.operations.map(({fileId})=>fileId),...plan.operations.map(({pairedFileId})=>pairedFileId)]);
      if (!sameSet(plan.sourceRootIds,context.sourceRootIds)) throw new Error("整理清单来源根已不再匹配持久化扫描配置");
      const pairedIds = [...new Set(plan.operations.map(({pairedFileId}) => pairedFileId))];
      const identities = await loadBoundIdentities(client,plan.scope,pairedIds);
      const anchorTargets = new Map(plan.operations.filter((operation) => operation.fileId === operation.pairedFileId && operation.status === "verified" && operation.targetParentId !== null).map((operation) => [operation.fileId,operation.targetParentId!]));
      for (const operation of plan.operations) {
        if (!operation.targetRelativePath || operation.targetRelativePath.split("/").at(-1) !== operation.targetName) throw new Error(`整理操作 ${operation.operationId} 的目标相对路径无效`);
        const file = context.files.get(operation.fileId);
        if (!file || file.isDirectory || file.parentDirectoryId !== operation.originalParentId || file.name !== operation.originalName) throw new Error(`整理操作 ${operation.operationId} 的来源事实不匹配扫描记录`);
        if (!isWithinRoots(file.parentDirectoryId,context.sourceRootIds,context.directoryParents)) throw new Error(`整理操作 ${operation.operationId} 的来源不在扫描授权根下`);
        const anchor = context.files.get(operation.pairedFileId);
        if (!anchor || anchor.isDirectory || anchor.parentDirectoryId !== operation.originalParentId) throw new Error(`整理操作 ${operation.operationId} 缺少同目录的已扫描视频身份锚点`);
        if (operation.fileId === operation.pairedFileId) {
          if (!isVideoName(anchor.name) || operation.pairedVideoTargetPath !== operation.targetRelativePath) throw new Error(`整理操作 ${operation.operationId} 不是有效的视频目标`);
        } else {
          const pairedSubtitle = deriveSubtitlePath(anchor.name,file.name,operation.pairedVideoTargetPath);
          if (!isVideoName(anchor.name) || !isSubtitleName(file.name) || pairedSubtitle !== operation.targetRelativePath) throw new Error(`整理操作 ${operation.operationId} 的字幕与视频basename配对不成立`);
        }
        const identityBinding = identities.get(operation.pairedFileId);
        const allowedParents = [anchor.parentDirectoryId,anchorTargets.get(operation.pairedFileId)].filter((parent): parent is string => parent !== undefined);
        if (!identityBinding || !allowedParents.includes(identityBinding.parent_directory_id) || !identityMatchesBinding(operation.identity,identityBinding)) throw new Error(`整理操作 ${operation.operationId} 的身份/目录与F02导入绑定不一致`);
        if (configuredTarget(context.configuration,operation.identity.mediaType) !== operation.targetRootId) throw new Error(`整理操作 ${operation.operationId} 的目标根不属于持久化配置`);
      }
      const configuredTargets = [...new Set(plan.operations.map(({targetRootId}) => targetRootId))];
      const authorizedTargets = [...new Set(Object.entries(plan.targetRootByMediaType).map(([mediaType,target]) => {
        if ((mediaType !== "movie" && mediaType !== "tv" && mediaType !== "anime") || typeof target !== "string" || configuredTarget(context.configuration,mediaType) !== target) throw new Error("整理清单目标映射与持久化配置不匹配");
        return target;
      }))];
      if (!sameSet(plan.targetRootIds,authorizedTargets) || configuredTargets.some((target) => !authorizedTargets.includes(target))) throw new Error("整理清单目标根列表与授权映射/操作不匹配");
    } finally { client.release(); }
  }

  private async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [LIBRARY_ORGANIZATION_SCHEMA_ADVISORY_LOCK_KEY]);
      await client.query(SCHEMA);
      await client.query(SCHEMA_COMPAT);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async createOrGet(input: OrganizationPlanCreate): Promise<OrganizationPlan> {
    await this.ensureSchema();
    validatePlan(input.plan, input.operationKey);
    return this.transaction(async (client) => {
      await this.assertStorage(client, input.plan.scope);
      await client.query(
        `INSERT INTO library_organization_plans(account_id,connected_storage_id,task_id,operation_key,source_root_ids,target_root_ids,target_roots_by_media_type,skipped_files,status,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,'planned',$9,$9) ON CONFLICT DO NOTHING`,
        [input.plan.scope.accountId,input.plan.scope.connectedStorageId,input.plan.taskId,input.operationKey,JSON.stringify(input.plan.sourceRootIds),JSON.stringify(input.plan.targetRootIds),JSON.stringify(input.plan.targetRootByMediaType),JSON.stringify(input.plan.skippedFiles),input.plan.createdAt],
      );
      const existing = await client.query<PlanRow>(`SELECT * FROM library_organization_plans WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 FOR UPDATE`, [input.plan.scope.accountId,input.plan.scope.connectedStorageId,input.plan.taskId,input.operationKey]);
      if (!existing.rows[0]) throw new Error("整理清单写入后无法读取");
      const row = existing.rows[0];
      if (!sameStringArray(row.source_root_ids, input.plan.sourceRootIds) || !sameStringArray(row.target_root_ids, input.plan.targetRootIds) || stableJson(row.target_roots_by_media_type) !== stableJson(input.plan.targetRootByMediaType) || JSON.stringify(row.skipped_files) !== JSON.stringify(input.plan.skippedFiles)) throw new Error("相同任务幂等键已绑定不同授权根或跳过项");
      const incomingIds = input.plan.operations.map((operation) => operation.operationId);
      const stored = await client.query<OperationRow>(`SELECT * FROM library_organization_operations WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4`, [row.account_id,row.connected_storage_id,row.task_id,input.operationKey]);
      if (stored.rows.length === 0) {
        for (const operation of input.plan.operations) await insertOperation(client, input.plan.scope, input.plan.taskId, input.operationKey, operation, input.plan.createdAt);
      } else if (stored.rows.length !== incomingIds.length || stored.rows.some((operation) => {
        const incoming = input.plan.operations.find(({operationId}) => operationId === operation.operation_id);
        return !incoming || incoming.fileId !== operation.file_id || incoming.originalParentId !== operation.original_parent_id || incoming.originalName !== operation.original_name || incoming.targetRootId !== operation.target_root_id || incoming.targetRelativePath !== operation.target_relative_path || incoming.targetName !== operation.target_name || incoming.pairedFileId !== operation.paired_file_id || incoming.pairedVideoTargetPath !== operation.paired_video_target_path || stableJson(incoming.identity) !== stableJson(operation.identity);
      })) {
        throw new Error("相同任务幂等键已绑定另一份整理清单");
      }
      const result = await readPlan(client, input.plan.scope, input.plan.taskId, input.operationKey);
      if (!result) throw new Error("整理清单不存在");
      return result;
    });
  }

  async get(scope: OrganizationScope, taskId: string, operationKey: string): Promise<OrganizationPlan | null> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try { await this.assertStorage(client, scope); return await readPlan(client, scope, taskId, operationKey); }
    finally { client.release(); }
  }

  async claim(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, now: string, expiresAt: string): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client, scope);
      const result = await client.query(`UPDATE library_organization_plans SET status='running',lease_id=$5,lease_expires_at=$7,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND status IN ('planned','paused','running','failed') AND (lease_id IS NULL OR lease_expires_at <= $6 OR lease_id=$5)`, [scope.accountId,scope.connectedStorageId,taskId,operationKey,leaseId,now,expiresAt]);
      return result.rowCount === 1;
    } finally { client.release(); }
  }

  async renew(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, now: string, expiresAt: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_organization_plans SET lease_expires_at=$7,updated_at=$6 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND lease_id=$5 AND status='running' AND lease_expires_at > $6`, [scope.accountId,scope.connectedStorageId,taskId,operationKey,leaseId,now,expiresAt]);
    return result.rowCount === 1;
  }

  async updateOperation(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, operation: OrganizationOperation, now: string): Promise<boolean> {
    await this.ensureSchema();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const lease = await client.query(`SELECT 1 FROM library_organization_plans WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND lease_id=$5 AND status='running' AND lease_expires_at > $6 FOR UPDATE`, [scope.accountId,scope.connectedStorageId,taskId,operationKey,leaseId,now]);
      if (!lease.rowCount) { await client.query("ROLLBACK"); return false; }
      const result = await client.query(`UPDATE library_organization_operations SET target_parent_id=$7,status=$8,error=$9,updated_at=$10 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND operation_id=$5 AND file_id=$6`, [scope.accountId,scope.connectedStorageId,taskId,operationKey,operation.operationId,operation.fileId,operation.targetParentId,operation.status,operation.error,now]);
      await client.query("COMMIT"); return result.rowCount === 1;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async finish(scope: OrganizationScope, taskId: string, operationKey: string, leaseId: string, status: OrganizationTaskStatus, now: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_organization_plans SET status=$6,execute_requested=CASE WHEN $6 IN ('completed','failed') THEN false ELSE execute_requested END,lease_id=NULL,lease_expires_at=NULL,updated_at=$7 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND lease_id=$5`, [scope.accountId,scope.connectedStorageId,taskId,operationKey,leaseId,status,now]);
    return result.rowCount === 1;
  }

  async requestExecution(scope: OrganizationScope, taskId: string, operationKey: string, now: string, options: OrganizationExecutionRequestOptions = {}): Promise<boolean> {
    await this.ensureSchema();
    return this.transaction(async (client) => {
      const plan = await client.query<{ status: OrganizationTaskStatus; execute_requested: boolean }>(
        `SELECT status,execute_requested FROM library_organization_plans
          WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 FOR UPDATE`,
        [scope.accountId, scope.connectedStorageId, taskId, operationKey],
      );
      const current = plan.rows[0];
      if (!current) return false;
      if (options.autoOrganization) {
        // Automatic dispatch may only request a plan that is still waiting for its first execution
        // intent. Manual requests retain their existing paused/failed resume semantics.
        if (current.status !== "planned" || current.execute_requested) return false;
        const checkpoint = await client.query<{ batch_id: string | null; operation_key: string | null; lease_id: string | null; status: string; lease_active: boolean }>(
          `SELECT batch_id,operation_key,lease_id,status,
                  (lease_expires_at IS NOT NULL AND lease_expires_at > $4::timestamptz) AS lease_active
             FROM library_auto_organization_tasks
            WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 FOR UPDATE`,
          [scope.accountId, scope.connectedStorageId, taskId, now],
        );
        const auto = checkpoint.rows[0];
        if (!auto || auto.status !== "planning" || auto.batch_id !== options.autoOrganization.batchId ||
            auto.operation_key !== operationKey || auto.lease_id !== options.autoOrganization.leaseId || !auto.lease_active) return false;
        const eligibility = await client.query(
          `SELECT 1 FROM library_scan_tasks t
             JOIN library_scan_configs c ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.config_id=t.config_id
             JOIN connected_storages s ON s.id=t.connected_storage_id AND s.account_id=t.account_id
            WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3 AND t.status IN ('completed','partial')
              AND s.provider=ANY($4::text[]) AND s.status='active' AND c.configuration->>'autoOrganize'='true'
            FOR UPDATE OF t,c,s`,
          [scope.accountId, scope.connectedStorageId, taskId, REGISTERED_STORAGE_PROVIDERS],
        );
        if (eligibility.rowCount !== 1) return false;
      }
      const result = await client.query(`UPDATE library_organization_plans SET execute_requested=true,status=CASE WHEN status IN ('completed','running') THEN status ELSE 'planned' END,updated_at=$5 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND status <> 'completed'`,[scope.accountId,scope.connectedStorageId,taskId,operationKey,now]);
      return result.rowCount === 1;
    });
  }

  async pause(scope: OrganizationScope, taskId: string, operationKey: string, now: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(`UPDATE library_organization_plans SET execute_requested=false,status=CASE WHEN status IN ('planned','running') THEN 'paused' ELSE status END,lease_id=NULL,lease_expires_at=NULL,updated_at=$5 WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 AND status <> 'completed'`,[scope.accountId,scope.connectedStorageId,taskId,operationKey,now]);
    return result.rowCount === 1;
  }

  async listRequested(scope: OrganizationScope, limit: number): Promise<Array<{ taskId: string; operationKey: string }>> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError("requested organization page must be 1..20");
    const result = await this.pool.query<{ task_id:string; operation_key:string }>(`SELECT task_id,operation_key FROM library_organization_plans WHERE account_id=$1 AND connected_storage_id=$2 AND execute_requested=true AND status IN ('planned','paused','failed','running') AND (lease_id IS NULL OR lease_expires_at <= now()) ORDER BY updated_at,task_id,operation_key LIMIT $3`,[scope.accountId,scope.connectedStorageId,limit]);
    return result.rows.map((row) => ({ taskId:row.task_id,operationKey:row.operation_key }));
  }

  async listPlans(scope: OrganizationScope, taskId: string, input: { limit: number; afterOperationKey?: string }): Promise<Array<{ operationKey: string; status: OrganizationTaskStatus; executeRequested: boolean; createdAt: string; updatedAt: string; skippedFiles: Array<{fileId:string;reason:string}>; operationCount: number }>> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 201) throw new RangeError("organization plan page must be 1..201");
    const result = await this.pool.query<PlanRow & { operation_count:string }>(`SELECT p.*,COUNT(o.operation_id)::text AS operation_count FROM library_organization_plans p LEFT JOIN library_organization_operations o USING(account_id,connected_storage_id,task_id,operation_key) WHERE p.account_id=$1 AND p.connected_storage_id=$2 AND p.task_id=$3 AND ($4::text IS NULL OR p.operation_key > $4) GROUP BY p.account_id,p.connected_storage_id,p.task_id,p.operation_key ORDER BY p.operation_key LIMIT $5`,[scope.accountId,scope.connectedStorageId,taskId,input.afterOperationKey ?? null,input.limit]);
    return result.rows.map((row) => ({operationKey:row.operation_key,status:row.status,executeRequested:row.execute_requested,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),skippedFiles:row.skipped_files ?? [],operationCount:Number(row.operation_count)}));
  }

  async getPlanSummary(scope: OrganizationScope, taskId: string, operationKey: string): Promise<{ operationKey: string; status: OrganizationTaskStatus; executeRequested: boolean; createdAt: string; updatedAt: string; skippedFiles: Array<{fileId:string;reason:string}>; operationCount: number } | null> {
    await this.ensureSchema();
    const result = await this.pool.query<PlanRow & { operation_count:string }>(`SELECT p.*,COUNT(o.operation_id)::text AS operation_count FROM library_organization_plans p LEFT JOIN library_organization_operations o USING(account_id,connected_storage_id,task_id,operation_key) WHERE p.account_id=$1 AND p.connected_storage_id=$2 AND p.task_id=$3 AND p.operation_key=$4 GROUP BY p.account_id,p.connected_storage_id,p.task_id,p.operation_key`,[scope.accountId,scope.connectedStorageId,taskId,operationKey]);
    const row=result.rows[0];
    return row?{operationKey:row.operation_key,status:row.status,executeRequested:row.execute_requested,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),skippedFiles:row.skipped_files??[],operationCount:Number(row.operation_count)}:null;
  }

  async listVerifiedLocationsToSync(scope: OrganizationScope, taskId: string, operationKey: string, limit: number): Promise<Array<{ fileId:string; parentId:string; name:string; targetRootId:string; relativePath:string }>> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new RangeError("verified location sync page must be 1..200");
    const result=await this.pool.query<{file_id:string;target_parent_id:string;target_name:string;target_root_id:string;target_relative_path:string}>(
      `SELECT o.file_id,o.target_parent_id,o.target_name,o.target_root_id,o.target_relative_path FROM library_organization_operations o
        JOIN library_file_bindings b ON b.account_id=o.account_id AND b.connected_storage_id=o.connected_storage_id AND b.file_id=o.file_id
       WHERE o.account_id=$1 AND o.connected_storage_id=$2 AND o.task_id=$3 AND o.operation_key=$4
         AND o.status='verified' AND o.target_parent_id IS NOT NULL AND b.parent_directory_id<>o.target_parent_id
       ORDER BY o.operation_id LIMIT $5`,
      [scope.accountId,scope.connectedStorageId,taskId,operationKey,limit],
    );
    return result.rows.map((row)=>({fileId:row.file_id,parentId:row.target_parent_id,name:row.target_name,targetRootId:row.target_root_id,relativePath:row.target_relative_path}));
  }

  async listVerifiedLocationPlanKeys(scope: OrganizationScope, limit: number): Promise<Array<{taskId:string;operationKey:string}>> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RangeError("verified location recovery page must be 1..20");
    const result=await this.pool.query<{task_id:string;operation_key:string}>(
      `SELECT DISTINCT o.task_id,o.operation_key FROM library_organization_operations o
        JOIN library_file_bindings b ON b.account_id=o.account_id AND b.connected_storage_id=o.connected_storage_id AND b.file_id=o.file_id
       WHERE o.account_id=$1 AND o.connected_storage_id=$2 AND o.status='verified' AND o.target_parent_id IS NOT NULL
         AND b.parent_directory_id<>o.target_parent_id ORDER BY o.task_id,o.operation_key LIMIT $3`,
      [scope.accountId,scope.connectedStorageId,limit],
    );
    return result.rows.map((row)=>({taskId:row.task_id,operationKey:row.operation_key}));
  }

  async listOperations(scope: OrganizationScope, taskId: string, operationKey: string, input: { limit: number; afterOperationId?: string }): Promise<OrganizationOperation[]> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 201) throw new RangeError("organization operation page must be 1..201");
    const result = await this.pool.query<OperationRow>(`SELECT o.* FROM library_organization_operations o WHERE o.account_id=$1 AND o.connected_storage_id=$2 AND o.task_id=$3 AND o.operation_key=$4 AND ($5::text IS NULL OR o.operation_id > $5) ORDER BY o.operation_id LIMIT $6`,[scope.accountId,scope.connectedStorageId,taskId,operationKey,input.afterOperationId ?? null,input.limit]);
    return result.rows.map((row) => ({operationId:row.operation_id,fileId:row.file_id,originalParentId:row.original_parent_id,originalName:row.original_name,targetRootId:row.target_root_id,targetRelativePath:row.target_relative_path,targetParentId:row.target_parent_id,targetName:row.target_name,identity:asIdentity(row.identity),pairedFileId:row.paired_file_id,pairedVideoTargetPath:row.paired_video_target_path,status:row.status,error:row.error}));
  }

  async listOperationHistory(
    scope: OrganizationScope,
    input: { page: number; pageSize: number; status?: OrganizationHistoryStatusFilter },
  ): Promise<OrganizationHistoryPage> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 10_000) throw new RangeError("page must be 1..10000");
    if (!Number.isSafeInteger(input.pageSize) || input.pageSize < 1 || input.pageSize > 100) throw new RangeError("pageSize must be 1..100");
    const status = input.status ?? "all";
    const statusClause = status === "all"
      ? ""
      : status === "active"
        ? " AND o.status IN ('planned','running')"
        : " AND o.status = $3";
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client, scope);
      const countsResult = await client.query<{
        all_count: string;
        running_count: string;
        planned_count: string;
        verified_count: string;
        failed_count: string;
      }>(
        `SELECT COUNT(*)::text AS all_count,
                COUNT(*) FILTER (WHERE status='running')::text AS running_count,
                COUNT(*) FILTER (WHERE status='planned')::text AS planned_count,
                COUNT(*) FILTER (WHERE status='verified')::text AS verified_count,
                COUNT(*) FILTER (WHERE status='failed')::text AS failed_count
           FROM library_organization_operations
          WHERE account_id=$1 AND connected_storage_id=$2`,
        [scope.accountId, scope.connectedStorageId],
      );
      const countRow = countsResult.rows[0];
      const counts = {
        all: Number(countRow?.all_count ?? 0),
        running: Number(countRow?.running_count ?? 0),
        planned: Number(countRow?.planned_count ?? 0),
        verified: Number(countRow?.verified_count ?? 0),
        failed: Number(countRow?.failed_count ?? 0),
      };
      const total = status === "all"
        ? counts.all
        : status === "active"
          ? counts.running + counts.planned
          : counts[status];
      const totalPages = Math.max(1, Math.ceil(total / input.pageSize));
      const offset = (input.page - 1) * input.pageSize;
      const queryParams: unknown[] = status === "all" || status === "active"
        ? [scope.accountId, scope.connectedStorageId, input.pageSize, offset]
        : [scope.accountId, scope.connectedStorageId, status, input.pageSize, offset];
      const limitPlaceholder = status === "all" || status === "active" ? "$3" : "$4";
      const offsetPlaceholder = status === "all" || status === "active" ? "$4" : "$5";
      const rows = await client.query<OperationRow & { task_id: string; operation_key: string; updated_at: Date }>(
        `SELECT o.task_id,o.operation_key,o.operation_id,o.file_id,o.original_parent_id,o.original_name,
                o.target_root_id,o.target_relative_path,o.target_parent_id,o.target_name,o.identity,
                o.paired_file_id,o.paired_video_target_path,o.status,o.error,o.updated_at
           FROM library_organization_operations o
          WHERE o.account_id=$1 AND o.connected_storage_id=$2${statusClause}
          ORDER BY o.updated_at DESC, o.operation_id DESC
          LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}`,
        queryParams,
      );
      return {
        items: rows.rows.map((row) => ({
          taskId: row.task_id,
          operationKey: row.operation_key,
          operationId: row.operation_id,
          fileId: row.file_id,
          originalParentId: row.original_parent_id,
          originalName: row.original_name,
          targetRootId: row.target_root_id,
          targetRelativePath: row.target_relative_path,
          targetParentId: row.target_parent_id,
          targetName: row.target_name,
          identity: safeIdentityOrNull(row.identity),
          pairedFileId: row.paired_file_id,
          pairedVideoTargetPath: row.paired_video_target_path,
          status: row.status,
          error: row.error,
          updatedAt: row.updated_at.toISOString(),
        })),
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

  async getTaskOrganizeConcurrency(scope: OrganizationScope, taskId: string): Promise<number> {
    await this.ensureSchema();
    const result = await this.pool.query<{ concurrency: string | null }>(
      `SELECT c.configuration->>'organizeConcurrency' AS concurrency
         FROM library_scan_tasks t
         JOIN library_scan_configs c
           ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.config_id=t.config_id
        WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3`,
      [scope.accountId, scope.connectedStorageId, taskId],
    );
    const parsed = Number(result.rows[0]?.concurrency);
    return Number.isSafeInteger(parsed) && parsed >= MIN_ORGANIZE_CONCURRENCY && parsed <= MAX_ORGANIZE_CONCURRENCY
      ? parsed
      : DEFAULT_ORGANIZE_CONCURRENCY;
  }

  async listOperationSourceAncestors(
    scope: OrganizationScope,
    taskId: string,
    directoryIds: readonly string[],
  ): Promise<string[][]> {
    await this.ensureSchema();
    const targets = [...new Set(directoryIds.map((id) => id.trim()).filter(Boolean))];
    if (targets.length === 0) return [];
    const client = await this.pool.connect();
    try {
      await this.assertStorage(client, scope);
      const taskResult = await client.query<{ configuration: unknown }>(
        `SELECT c.configuration
           FROM library_scan_tasks t
           JOIN library_scan_configs c
             ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.config_id=t.config_id
          WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3`,
        [scope.accountId, scope.connectedStorageId, taskId],
      );
      const configuration = asRecord(taskResult.rows[0]?.configuration);
      const rawRoots = Array.isArray(configuration.sourceRoots) ? configuration.sourceRoots.map(asRecord) : [];
      const rootIds = new Set(
        rawRoots.map((root) => asNonEmptyString(root.directoryId)).filter(Boolean),
      );
      if (rootIds.size === 0) return [];

      const ancestorsResult = await client.query<{ directory_id: string; parent_directory_id: string | null }>(
        `WITH RECURSIVE seed(directory_id) AS (SELECT unnest($4::text[])),
          relevant(directory_id,parent_directory_id,depth) AS (
            SELECT d.directory_id,d.parent_directory_id,0
              FROM library_scan_directories d
              JOIN seed s USING(directory_id)
             WHERE d.account_id=$1 AND d.connected_storage_id=$2 AND d.task_id=$3
            UNION ALL
            SELECT p.directory_id,p.parent_directory_id,r.depth+1
              FROM relevant r
              JOIN library_scan_directories p
                ON p.account_id=$1 AND p.connected_storage_id=$2 AND p.task_id=$3 AND p.directory_id=r.parent_directory_id
             WHERE r.depth<128
          )
          SELECT DISTINCT ON(directory_id) directory_id,parent_directory_id
            FROM relevant
           ORDER BY directory_id,depth`,
        [scope.accountId, scope.connectedStorageId, taskId, targets],
      );
      const parentById = new Map(ancestorsResult.rows.map((row) => [row.directory_id, row.parent_directory_id]));
      const chains: string[][] = [];
      for (const targetId of targets) {
        if (rootIds.has(targetId)) continue;
        const reverseChain: string[] = [];
        const seen = new Set<string>([targetId]);
        let current = parentById.get(targetId) ?? null;
        let reachedRoot = false;
        while (current !== null) {
          if (seen.has(current)) break;
          seen.add(current);
          reverseChain.push(current);
          if (rootIds.has(current)) {
            reachedRoot = true;
            break;
          }
          current = parentById.get(current) ?? null;
        }
        if (reachedRoot && reverseChain.length > 0) {
          chains.push(reverseChain.reverse());
        }
      }
      return chains;
    } finally {
      client.release();
    }
  }

  async listFailedPlans(scope: OrganizationScope, limit = 20): Promise<Array<{ taskId: string; operationKey: string }>> {
    await this.ensureSchema();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("failed organization page must be 1..100");
    }
    const result = await this.pool.query<{ task_id: string; operation_key: string }>(
      `SELECT task_id,operation_key
         FROM library_organization_plans
        WHERE account_id=$1 AND connected_storage_id=$2 AND status='failed'
        ORDER BY updated_at DESC, task_id DESC, operation_key DESC
        LIMIT $3`,
      [scope.accountId, scope.connectedStorageId, limit],
    );
    return result.rows.map((row) => ({ taskId: row.task_id, operationKey: row.operation_key }));
  }

  private async assertStorage(client: PoolClient, scope: OrganizationScope): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM connected_storages WHERE id=$1 AND account_id=$2 AND provider=ANY($3::text[])",
      [scope.connectedStorageId,scope.accountId,REGISTERED_STORAGE_PROVIDERS],
    );
    if (!result.rowCount) throw new Error("整理网盘不存在或不属于指定账号");
  }
  private async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

async function insertOperation(client: PoolClient, scope: OrganizationScope, taskId: string, key: string, operation: OrganizationOperation, now: string): Promise<void> {
  await client.query(`INSERT INTO library_organization_operations(account_id,connected_storage_id,task_id,operation_key,operation_id,file_id,original_parent_id,original_name,target_root_id,target_relative_path,target_parent_id,target_name,identity,paired_file_id,paired_video_target_path,status,error,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18)`, [scope.accountId,scope.connectedStorageId,taskId,key,operation.operationId,operation.fileId,operation.originalParentId,operation.originalName,operation.targetRootId,operation.targetRelativePath,operation.targetParentId,operation.targetName,JSON.stringify(operation.identity),operation.pairedFileId,operation.pairedVideoTargetPath,operation.status,operation.error,now]);
}

async function readPlan(client: PoolClient, scope: OrganizationScope, taskId: string, key: string): Promise<OrganizationPlan | null> {
  const plan = await client.query<PlanRow>(`SELECT * FROM library_organization_plans WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4`, [scope.accountId,scope.connectedStorageId,taskId,key]);
  const row = plan.rows[0]; if (!row) return null;
  const operations = await client.query<OperationRow>(`SELECT * FROM library_organization_operations WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND operation_key=$4 ORDER BY operation_id`, [scope.accountId,scope.connectedStorageId,taskId,key]);
  return { scope, taskId, operationKey:key, sourceRootIds:row.source_root_ids, targetRootIds:row.target_root_ids,targetRootByMediaType:row.target_roots_by_media_type ?? {},skippedFiles:row.skipped_files ?? [], status:row.status, createdAt:row.created_at.toISOString(), updatedAt:row.updated_at.toISOString(), executeRequested:row.execute_requested, operations:operations.rows.map((operation) => ({ operationId:operation.operation_id,fileId:operation.file_id,originalParentId:operation.original_parent_id,originalName:operation.original_name,targetRootId:operation.target_root_id,targetRelativePath:operation.target_relative_path,targetParentId:operation.target_parent_id,targetName:operation.target_name,identity:asIdentity(operation.identity),pairedFileId:operation.paired_file_id,pairedVideoTargetPath:operation.paired_video_target_path,status:operation.status,error:operation.error })) };
}

async function loadScanAuthorization(client: PoolClient, scope: OrganizationScope, taskId: string, referencedFileIds: readonly string[]): Promise<TrustedScanContext> {
  if (referencedFileIds.length > 400) throw new Error("整理授权检查超过安全文件上限");
  const taskResult = await client.query<ScanConfigRow>(
    `SELECT t.status,c.configuration FROM library_scan_tasks t JOIN library_scan_configs c
       ON c.account_id=t.account_id AND c.connected_storage_id=t.connected_storage_id AND c.config_id=t.config_id
     WHERE t.account_id=$1 AND t.connected_storage_id=$2 AND t.task_id=$3`,
    [scope.accountId,scope.connectedStorageId,taskId],
  );
  const task = taskResult.rows[0];
  if (!task || (task.status !== "completed" && task.status !== "partial")) throw new Error("整理必须引用该账号和网盘下已完成或部分完成的扫描任务");
  const configuration = asRecord(task.configuration);
  const rootEntries = Array.isArray(configuration.sourceRoots) ? configuration.sourceRoots.map(asRecord) : [];
  const roots = rootEntries.map((root) => ({ directoryId:asNonEmptyString(root.directoryId),name:asNonEmptyString(root.name) }));
  if (!roots.length || roots.some((root) => !root.directoryId || !root.name) || new Set(roots.map(({directoryId}) => directoryId)).size !== roots.length) throw new Error("持久化扫描配置中的来源根无效");
  const requestedFiles = referencedFileIds.length ? await client.query<ScanFileAuthRow>(
    `SELECT file_id,parent_directory_id,name,is_directory FROM library_scan_task_files
      WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND file_id=ANY($4::text[])`,
    [scope.accountId,scope.connectedStorageId,taskId,[...referencedFileIds]],
  ) : { rows:[] as ScanFileAuthRow[] };
  const targetIds=configuredTargetIds(configuration);
  const seedIds=[...new Set([...roots.map(({directoryId})=>directoryId),...targetIds,...requestedFiles.rows.map(({parent_directory_id})=>parent_directory_id)])];
  const directoryResult = await client.query<ScanDirectoryAuthRow>(
    `WITH RECURSIVE seed(directory_id) AS (SELECT unnest($4::text[])),
      relevant(directory_id,parent_directory_id,path,depth) AS (
        SELECT d.directory_id,d.parent_directory_id,d.path,0 FROM library_scan_directories d JOIN seed s USING(directory_id)
         WHERE d.account_id=$1 AND d.connected_storage_id=$2 AND d.task_id=$3
        UNION ALL
        SELECT p.directory_id,p.parent_directory_id,p.path,r.depth+1 FROM relevant r
          JOIN library_scan_directories p ON p.account_id=$1 AND p.connected_storage_id=$2 AND p.task_id=$3 AND p.directory_id=r.parent_directory_id
         WHERE r.depth<128
      )
      SELECT DISTINCT ON(directory_id) directory_id,parent_directory_id,path FROM relevant ORDER BY directory_id,depth`,
    [scope.accountId,scope.connectedStorageId,taskId,seedIds],
  );
  const directoryParents = new Map(directoryResult.rows.map((row) => [row.directory_id,row.parent_directory_id]));
  const rootNames = new Map(roots.map(({directoryId,name}) => [directoryId,name]));
  const directories = directoryResult.rows.map((row) => ({
    directoryId:row.directory_id,
    parentDirectoryId:row.parent_directory_id,
    name:rootNames.get(row.directory_id) ?? pathLeaf(row.path),
  }));
  if (roots.some(({directoryId}) => !directoryParents.has(directoryId))) throw new Error("扫描任务未保存配置中的全部来源根目录事实");
  const parentIds=[...new Set(requestedFiles.rows.filter(({is_directory})=>!is_directory).map(({parent_directory_id})=>parent_directory_id))];
  const fileResult = parentIds.length ? await client.query<ScanFileAuthRow>(
    `SELECT file_id,parent_directory_id,name,is_directory FROM library_scan_task_files
      WHERE account_id=$1 AND connected_storage_id=$2 AND task_id=$3 AND parent_directory_id=ANY($4::text[])
      ORDER BY parent_directory_id,file_id LIMIT 1001`,
    [scope.accountId,scope.connectedStorageId,taskId,parentIds],
  ) : { rows:[] as ScanFileAuthRow[] };
  if (fileResult.rows.length > 1000) throw new Error("所选来源目录同级文件超过1000项，无法在安全上限内准确配对字幕，请缩小整理范围");
  const files = new Map(fileResult.rows.map((row) => [row.file_id,{fileId:row.file_id,parentDirectoryId:row.parent_directory_id,name:row.name,isDirectory:row.is_directory}]));
  if (files.size !== fileResult.rows.length || directories.length !== directoryParents.size) throw new Error("扫描任务授权图包含重复provider ID");
  if (fileResult.rows.some((row) => !directoryParents.has(row.parent_directory_id))) throw new Error("扫描任务文件指向未记录的父目录");
  return {
    configuration,
    sourceRootIds:roots.map(({directoryId}) => directoryId),
    graph:{directories,files:fileResult.rows.filter((row) => !row.is_directory).map((row) => ({fileId:row.file_id,parentDirectoryId:row.parent_directory_id,name:row.name,isDirectory:false})),authorizedTargetRootIds:configuredTargetIds(configuration)},
    directoryParents,
    files,
  };
}

async function loadBoundIdentities(client: PoolClient, scope: OrganizationScope, fileIds: readonly string[]): Promise<Map<string,FileIdentityRow>> {
  if (fileIds.length === 0) return new Map();
  const result = await client.query<FileIdentityRow>(
    `SELECT b.file_id,b.parent_directory_id,b.media_title_id,b.tracked_season_id,b.media_type,b.tmdb_id,b.episode_codes,b.quality,t.payload AS title_payload,s.payload AS season_payload
       FROM library_file_bindings b
       JOIN media_titles t ON t.id=b.media_title_id
       JOIN tracked_seasons s ON s.id=b.tracked_season_id AND s.media_title_id=b.media_title_id
      WHERE b.account_id=$1 AND b.connected_storage_id=$2 AND b.file_id=ANY($3::text[])`,
    [scope.accountId,scope.connectedStorageId,[...fileIds]],
  );
  return new Map(result.rows.map((row) => [row.file_id,row]));
}

function identityMatchesBinding(identity: OrganizationIdentity, binding: FileIdentityRow | undefined): boolean {
  if (!binding || binding.media_title_id !== identity.mediaTitleId || binding.tracked_season_id !== identity.trackedSeasonId || binding.media_type !== identity.mediaType || Number(binding.tmdb_id) !== identity.tmdbId) return false;
  const title = asRecord(binding.title_payload);
  const season = asRecord(binding.season_payload);
  if (title.id !== identity.mediaTitleId || title.type !== identity.mediaType || Number(title.tmdbId) !== identity.tmdbId || title.title !== identity.title || title.originalTitle !== identity.originalTitle || Number(title.year) !== identity.year) return false;
  if (season.id !== identity.trackedSeasonId || season.mediaTitleId !== identity.mediaTitleId || Number(season.seasonNumber) !== Number(identity.season ?? 1)) return false;
  if (identity.mediaType !== "movie") {
    const codes = Array.isArray(binding.episode_codes) ? binding.episode_codes.filter((value): value is string => typeof value === "string") : [];
    if (!identity.episodeCode || !codes.includes(identity.episodeCode)) return false;
  }
  return true;
}

function identityFromBinding(identity: OrganizationIdentity, binding: FileIdentityRow): OrganizationIdentity {
  const title = asRecord(binding.title_payload);
  const season = asRecord(binding.season_payload);
  return { ...identity,title:String(title.title),originalTitle:String(title.originalTitle),year:Number(title.year),season:Number(season.seasonNumber),tmdbId:Number(binding.tmdb_id),mediaType:binding.media_type as OrganizationIdentity["mediaType"] };
}

function configuredTarget(configuration: Record<string,unknown>, mediaType: OrganizationIdentity["mediaType"]): string | null {
  const value = mediaType === "movie" ? configuration.movieTargetDirectoryId : configuration.tvTargetDirectoryId;
  return typeof value === "string" && value.trim() ? value : null;
}
function configuredTargetIds(configuration: Record<string,unknown>): string[] {
  return [...new Set([configuration.movieTargetDirectoryId,configuration.tvTargetDirectoryId].filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}
function isWithinRoots(directoryId: string, roots: readonly string[], parents: Map<string,string|null>): boolean {
  let current: string | null = directoryId;
  const seen = new Set<string>();
  while (current !== null) {
    if (roots.includes(current)) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = parents.get(current) ?? null;
  }
  return false;
}
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && new Set(left).size === left.length && left.every((value) => right.includes(value)); }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) return `{${Object.entries(value).sort(([left],[right]) => left.localeCompare(right)).map(([key,item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function asRecord(value: unknown): Record<string,unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string,unknown> : {}; }
function asIdentity(value: unknown): OrganizationIdentity {
  const record = asRecord(value);
  if (typeof record.mediaTitleId !== "string" || typeof record.trackedSeasonId !== "string" || (record.mediaType !== "movie" && record.mediaType !== "tv" && record.mediaType !== "anime") || typeof record.title !== "string" || typeof record.tmdbId !== "number") throw new Error("整理操作缺少持久化身份字段");
  if (typeof record.originalTitle !== "string" || typeof record.year !== "number" || typeof record.tmdbId !== "number") throw new Error("整理操作缺少完整作品身份字段");
  return record as unknown as OrganizationIdentity;
}
function safeIdentityOrNull(value: unknown): OrganizationIdentity | null {
  try { return asIdentity(value); } catch { return null; }
}
function asNonEmptyString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function pathLeaf(value: string): string { return value.replace(/\\/g,"/").split("/").filter(Boolean).at(-1) ?? ""; }
function extension(name: string): string { const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot).toLocaleLowerCase("en-US") : ""; }
function isVideoName(name: string): boolean { return new Set([".mkv",".mp4",".avi",".mov",".wmv",".m4v",".ts",".m2ts",".webm",".flv",".mpg",".mpeg",".3gp"]).has(extension(name)); }
function isSubtitleName(name: string): boolean { return new Set([".srt",".ass",".ssa",".vtt",".sup",".sub",".idx"]).has(extension(name)); }

function validatePlan(plan: OrganizationPlan, key: string): void {
  if (!key.trim() || !plan.scope.accountId.trim() || !plan.scope.connectedStorageId.trim() || !plan.taskId.trim()) throw new Error("整理清单作用域和幂等键不能为空");
  if (plan.operations.length > 200) throw new Error("整理清单最多允许200个持久化操作");
  const mappedTargets = [...new Set(Object.values(plan.targetRootByMediaType).filter((value): value is string => typeof value === "string"))];
  if (!sameSet(plan.targetRootIds,mappedTargets) || !Array.isArray(plan.skippedFiles)) throw new Error("整理清单目标映射或跳过项无效");
  const ids = new Set<string>();
  for (const operation of plan.operations) { if (!operation.operationId || ids.has(operation.operationId) || !operation.pairedFileId || !operation.identity?.mediaTitleId || !operation.identity.trackedSeasonId || plan.targetRootByMediaType[operation.identity.mediaType] !== operation.targetRootId) throw new Error("整理操作ID重复、目标根或身份锚点无效"); ids.add(operation.operationId); }
}
function sameStringArray(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value,index) => value === right[index]); }
