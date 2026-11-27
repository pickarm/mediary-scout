// @ts-check
/**
 * 巡影 Fork 迁移演练工具的纯逻辑与 PostgreSQL 读模型。
 *
 * 安全边界：
 * - 预检/核验只连接副本，并把会话设为只读；源 URL 只用于同库比较，不打开连接。
 * - 副本目标必须是本机，或在策略文件中显式列出的隔离测试主机，同时设置
 *   MEDIA_TRACK_MIGRATION_ISOLATED_TEST_DB=1。
 * - 指纹只输出行数与哈希，不输出作品名、provider ID、token 或连接 payload。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_FORMAT = "media-track-fork-migration-manifest@1";
export const POLICY_FORMAT = "media-track-fork-migration-policy@1";
export const F16_MIGRATION_ADVISORY_LOCK_KEY = 4_011_989_150;

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LIB_DIR, "..");
const DEFAULT_POLICY_PATH = path.join(LIB_DIR, "fork-migration-policy.json");
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const READ_ONLY_APPLICATION = "fork-migration-readonly";
const CONNECTION_IDENTITY_QUERY_PARAMETERS = new Set([
  "application_name",
  "database",
  "dbname",
  "host",
  "hostaddr",
  "passfile",
  "password",
  "port",
  "service",
  "servicefile",
  "user",
]);

/**
 * @typedef {object} FingerprintTablePolicy
 * @property {string} id
 * @property {string} table
 * @property {string[]} columns
 * @property {string} group
 * @property {boolean} required
 *
 * @typedef {object} GatePolicy
 * @property {number} advisoryLockKey
 * @property {string} applicationNamePrefix
 * @property {number} maxForeignConnections
 *
 * @typedef {object} BackupPolicy
 * @property {string} dumpFormat
 * @property {string[]} dumpArgs
 * @property {string[]} restoreArgs
 *
 * @typedef {object} PlanPolicy
 * @property {string} composeFile
 * @property {string} imagePlaceholder
 * @property {string} backupPathPlaceholder
 *
 * @typedef {object} MigrationPolicy
 * @property {string} format
 * @property {string[]} localHosts
 * @property {string[]} isolatedHosts
 * @property {Record<string, string>} rehearsalEnv
 * @property {string[]} rehearsalBlockedEnv
 * @property {string[]} rehearsalAllowedEnv
 * @property {FingerprintTablePolicy[]} fingerprintTables
 * @property {GatePolicy} gate
 * @property {BackupPolicy} backup
 * @property {PlanPolicy} plan
 *
 * @typedef {object} DatabaseIdentity
 * @property {string} scheme
 * @property {string} host
 * @property {number} port
 * @property {string} database
 * @property {string} display
 *
 * @typedef {object} SchemaColumn
 * @property {string} name
 * @property {string} dataType
 * @property {string} udtName
 * @property {boolean} nullable
 * @property {number} position
 *
 * @typedef {object} SchemaTable
 * @property {SchemaColumn[]} columns
 *
 * @typedef {object} TableFingerprint
 * @property {boolean} present
 * @property {boolean} tablePresent
 * @property {number} rowCount
 * @property {string | null} fingerprint
 * @property {string} group
 * @property {boolean} required
 * @property {string} table
 *
 * @typedef {object} MigrationManifest
 * @property {string} format
 * @property {string} generatedAt
 * @property {string} role
 * @property {DatabaseIdentity} identity
 * @property {string} serverVersion
 * @property {string} schemaName
 * @property {{tables: Record<string, SchemaTable>}} schema
 * @property {Record<string, TableFingerprint>} tables
 * @property {Record<string, {views: string[], rowCount: number}>} groups
 * @property {string[]} warnings
 *
 * @typedef {object} CheckResult
 * @property {string} id
 * @property {boolean} ok
 * @property {"error" | "warning" | "info"} severity
 * @property {string} message
 *
 * @typedef {object} PlanStep
 * @property {string} id
 * @property {string} title
 * @property {string} detail
 * @property {string[]} [command]
 * @property {string[]} [env]
 * @property {boolean} [destructive]
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is string}
 */
function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationInputError(`${label} 必须是非空字符串`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string[]}
 */
function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new MigrationInputError(`${label} 必须是字符串数组`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {number}
 */
function requireNonNegativeSafeInteger(value, label) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new MigrationInputError(`${label} 必须是非负安全整数`);
  }
  return value;
}

export class MigrationInputError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = "MIGRATION_INPUT_INVALID") {
    super(message);
    this.name = "MigrationInputError";
    this.code = code;
  }
}

export class MigrationCheckError extends Error {
  /**
   * @param {string} message
   * @param {string} [code]
   */
  constructor(message, code = "MIGRATION_CHECK_FAILED") {
    super(message);
    this.name = "MigrationCheckError";
    this.code = code;
  }
}

/**
 * @param {string} [file]
 * @returns {Promise<MigrationPolicy>}
 */
export async function loadMigrationPolicy(file = process.env.MEDIA_TRACK_MIGRATION_POLICY || DEFAULT_POLICY_PATH) {
  if (!existsSync(file)) {
    throw new MigrationInputError(`找不到迁移策略文件：${path.basename(file)}`, "POLICY_NOT_FOUND");
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new MigrationInputError(`迁移策略文件不是合法 JSON：${safeErrorMessage(error)}`, "POLICY_INVALID");
  }
  if (!isRecord(parsed) || parsed.format !== POLICY_FORMAT) {
    throw new MigrationInputError(`迁移策略格式必须为 ${POLICY_FORMAT}`, "POLICY_INVALID");
  }
  const localHosts = requireStringArray(parsed.localHosts, "localHosts").map(normalizeHost);
  const isolatedHosts = requireStringArray(parsed.isolatedHosts, "isolatedHosts").map(normalizeHost);
  const rehearsalEnv = parsed.rehearsalEnv;
  if (!isRecord(rehearsalEnv) || Object.values(rehearsalEnv).some((value) => typeof value !== "string")) {
    throw new MigrationInputError("rehearsalEnv 必须是字符串键值对象", "POLICY_INVALID");
  }
  const fingerprintTables = parsed.fingerprintTables;
  if (!Array.isArray(fingerprintTables)) {
    throw new MigrationInputError("fingerprintTables 必须是数组", "POLICY_INVALID");
  }
  /** @type {FingerprintTablePolicy[]} */
  const tables = fingerprintTables.map((item, index) => {
    if (!isRecord(item)) throw new MigrationInputError(`fingerprintTables[${index}] 非法`, "POLICY_INVALID");
    const id = item.id;
    const table = item.table;
    const group = item.group;
    requireString(id, `fingerprintTables[${index}].id`);
    requireString(table, `fingerprintTables[${index}].table`);
    requireString(group, `fingerprintTables[${index}].group`);
    assertIdentifier(String(table), `fingerprintTables[${index}].table`);
    const columns = requireStringArray(item.columns, `fingerprintTables[${index}].columns`);
    for (const column of columns) assertIdentifier(column, `fingerprintTables[${index}].columns`);
    if (typeof item.required !== "boolean") {
      throw new MigrationInputError(`fingerprintTables[${index}].required 必须是布尔值`, "POLICY_INVALID");
    }
    return { id: String(id), table: String(table), columns, group: String(group), required: item.required };
  });
  const gate = parsed.gate;
  if (!isRecord(gate) || !Number.isSafeInteger(gate.advisoryLockKey) || typeof gate.applicationNamePrefix !== "string" || !Number.isSafeInteger(gate.maxForeignConnections)) {
    throw new MigrationInputError("gate 配置非法", "POLICY_INVALID");
  }
  if (gate.advisoryLockKey !== F16_MIGRATION_ADVISORY_LOCK_KEY) {
    throw new MigrationInputError(
      `F16 唯一 writer 门禁键必须是 ${F16_MIGRATION_ADVISORY_LOCK_KEY}`,
      "GATE_ADVISORY_KEY_INVALID",
    );
  }
  const backup = parsed.backup;
  if (!isRecord(backup) || typeof backup.dumpFormat !== "string") {
    throw new MigrationInputError("backup 配置非法", "POLICY_INVALID");
  }
  const plan = parsed.plan;
  if (!isRecord(plan)) throw new MigrationInputError("plan 配置非法", "POLICY_INVALID");
  return {
    format: POLICY_FORMAT,
    localHosts,
    isolatedHosts,
    rehearsalEnv: /** @type {Record<string, string>} */ (rehearsalEnv),
    rehearsalBlockedEnv: requireStringArray(parsed.rehearsalBlockedEnv, "rehearsalBlockedEnv"),
    rehearsalAllowedEnv: requireStringArray(parsed.rehearsalAllowedEnv, "rehearsalAllowedEnv"),
    fingerprintTables: tables,
    gate: {
      advisoryLockKey: Number(gate.advisoryLockKey),
      applicationNamePrefix: gate.applicationNamePrefix,
      maxForeignConnections: Number(gate.maxForeignConnections),
    },
    backup: {
      dumpFormat: backup.dumpFormat,
      dumpArgs: requireStringArray(backup.dumpArgs, "backup.dumpArgs"),
      restoreArgs: requireStringArray(backup.restoreArgs, "backup.restoreArgs"),
    },
    plan: {
      composeFile: requirePlanString(plan.composeFile, "plan.composeFile"),
      imagePlaceholder: requirePlanString(plan.imagePlaceholder, "plan.imagePlaceholder"),
      backupPathPlaceholder: requirePlanString(plan.backupPathPlaceholder, "plan.backupPathPlaceholder"),
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requirePlanString(value, label) {
  requireString(value, label);
  return String(value);
}

/**
 * @param {string} value
 * @param {string} label
 */
function assertIdentifier(value, label) {
  if (!IDENTIFIER.test(value)) throw new MigrationInputError(`${label} 含非法标识符：${value}`, "IDENTIFIER_INVALID");
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} host
 */
export function normalizeHost(host) {
  let lower = host.trim().toLowerCase();
  if (lower.startsWith("[") && lower.endsWith("]")) lower = lower.slice(1, -1);
  if (lower.endsWith(".")) lower = lower.slice(0, -1);
  return lower;
}

/**
 * @param {string} host
 */
function isLoopbackHost(host) {
  const normalized = normalizeHost(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) !== 4) return false;
  return normalized.split(".")[0] === "127";
}

/**
 * 解析 PostgreSQL URL，但绝不返回密码或用户名。
 *
 * @param {string | undefined} raw
 * @param {string} label
 * @returns {DatabaseIdentity}
 */
export function parsePostgresIdentity(raw, label) {
  if (!raw) throw new MigrationInputError(`缺少 ${label}`, "DATABASE_URL_MISSING");
  /** @type {URL} */
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new MigrationInputError(`${label} 不是合法 URL`, "DATABASE_URL_INVALID");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new MigrationInputError(`${label} 必须使用 postgres:// 或 postgresql://`, "DATABASE_URL_INVALID");
  }
  for (const key of url.searchParams.keys()) {
    if (CONNECTION_IDENTITY_QUERY_PARAMETERS.has(key.toLowerCase())) {
      throw new MigrationInputError(`${label} 不得通过查询参数 ${key} 覆盖连接身份`, "DATABASE_URL_INVALID");
    }
  }
  const host = normalizeHost(url.hostname);
  if (!host) throw new MigrationInputError(`${label} 必须显式包含主机`, "DATABASE_URL_INVALID");
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!database) throw new MigrationInputError(`${label} 必须包含数据库名`, "DATABASE_URL_INVALID");
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new MigrationInputError(`${label} 端口非法`, "DATABASE_URL_INVALID");
  }
  return {
    scheme: "postgresql",
    host,
    port,
    database,
    display: `postgresql://${host}:${port}/${database}`,
  };
}

/**
 * @param {DatabaseIdentity} a
 * @param {DatabaseIdentity} b
 */
export function sameDatabaseIdentity(a, b) {
  const sameHost = normalizeHost(a.host) === normalizeHost(b.host)
    || (isLoopbackHost(a.host) && isLoopbackHost(b.host));
  return sameHost && a.port === b.port && a.database === b.database;
}

/**
 * 目标只允许本机，或策略文件显式列出的隔离测试服务。
 *
 * @param {DatabaseIdentity} identity
 * @param {MigrationPolicy} policy
 * @param {NodeJS.ProcessEnv} env
 */
export function assertIsolatedTarget(identity, policy, env) {
  const host = normalizeHost(identity.host);
  if (policy.localHosts.includes(host)) return;
  const marked = env.MEDIA_TRACK_MIGRATION_ISOLATED_TEST_DB === "1";
  if (marked && policy.isolatedHosts.includes(host)) return;
  throw new MigrationInputError(
    `副本目标 ${identity.display} 不是本机，也未在策略中显式标记为隔离测试服务`,
    "ISOLATED_TARGET_REQUIRED",
  );
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {MigrationPolicy} policy
 * @returns {{source: DatabaseIdentity, copy: DatabaseIdentity}}
 */
export function resolveMigrationIdentities(env, policy) {
  const source = parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_SOURCE_URL, "MEDIA_TRACK_MIGRATION_SOURCE_URL");
  const copy = parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_COPY_URL, "MEDIA_TRACK_MIGRATION_COPY_URL");
  if (sameDatabaseIdentity(source, copy)) {
    throw new MigrationInputError("源与副本指向同一数据库（主机、端口、库名相同）", "SOURCE_COPY_SAME_DATABASE");
  }
  assertIsolatedTarget(copy, policy, env);
  return { source, copy };
}

/**
 * @param {string} connectionString
 * @param {string} applicationName
 */
export async function openPgPool(connectionString, applicationName) {
  const { default: pg } = await import("pg");
  return new pg.Pool({
    connectionString,
    application_name: applicationName,
    max: 2,
    statement_timeout: 120_000,
    query_timeout: 120_000,
    idleTimeoutMillis: 5_000,
  });
}

/**
 * 只读连接：即使实现误写，也会被 PostgreSQL 拒绝。
 *
 * @param {string} connectionString
 * @param {string} [applicationName]
 */
export async function openReadOnlyClient(connectionString, applicationName = READ_ONLY_APPLICATION) {
  const pool = await openPgPool(connectionString, applicationName);
  const client = await pool.connect();
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
  return {
    client,
    async close() {
      client.release();
      await pool.end();
    },
  };
}

/**
 * @param {import("pg").PoolClient} client
 */
async function currentSchemaName(client) {
  const result = await client.query("SELECT current_schema() AS schema");
  const row = result.rows[0];
  const schema = row && typeof row.schema === "string" ? row.schema : "public";
  assertIdentifier(schema, "current_schema");
  return schema;
}

/**
 * @param {import("pg").PoolClient} client
 * @param {string} schema
 */
export async function introspectSchema(client, schema) {
  const tablesResult = await client.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [schema],
  );
  const columnsResult = await client.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, ordinal_position
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );
  /** @type {Record<string, SchemaTable>} */
  const tables = {};
  for (const row of tablesResult.rows) {
    if (typeof row.table_name === "string") tables[row.table_name] = { columns: [] };
  }
  for (const row of columnsResult.rows) {
    if (typeof row.table_name !== "string" || typeof row.column_name !== "string") continue;
    const table = tables[row.table_name];
    if (!table) continue;
    table.columns.push({
      name: row.column_name,
      dataType: typeof row.data_type === "string" ? row.data_type : "",
      udtName: typeof row.udt_name === "string" ? row.udt_name : "",
      nullable: row.is_nullable === "YES",
      position: typeof row.ordinal_position === "number" ? row.ordinal_position : 0,
    });
  }
  return tables;
}

/**
 * @param {import("pg").PoolClient} client
 * @param {string} schema
 * @param {Record<string, SchemaTable>} schemaTables
 * @param {FingerprintTablePolicy} tablePolicy
 * @returns {Promise<TableFingerprint>}
 */
async function fingerprintOneTable(client, schema, schemaTables, tablePolicy) {
  const table = schemaTables[tablePolicy.table];
  if (!table) {
    return {
      present: false,
      tablePresent: false,
      rowCount: 0,
      fingerprint: null,
      group: tablePolicy.group,
      required: tablePolicy.required,
      table: tablePolicy.table,
    };
  }
  const available = new Set(table.columns.map((column) => column.name));
  if (tablePolicy.columns.some((column) => !available.has(column))) {
    const count = await client.query(`SELECT count(*)::int AS n FROM "${schema}"."${tablePolicy.table}"`);
    return {
      present: false,
      tablePresent: true,
      rowCount: typeof count.rows[0]?.n === "number" ? count.rows[0].n : Number(count.rows[0]?.n ?? 0),
      fingerprint: null,
      group: tablePolicy.group,
      required: tablePolicy.required,
      table: tablePolicy.table,
    };
  }
  for (const column of tablePolicy.columns) assertIdentifier(column, `${tablePolicy.table}.columns`);
  const rowJson = `jsonb_build_array(${tablePolicy.columns.map((column) => `"${column}"`).join(", ")})::text`;
  const sql = `
    SELECT count(*)::int AS row_count,
           COALESCE(md5(string_agg(md5(row_json), '' ORDER BY row_json COLLATE "C")), md5('')) AS fingerprint
      FROM (
        SELECT ${rowJson} AS row_json
          FROM "${schema}"."${tablePolicy.table}"
      ) AS rows
  `;
  const result = await client.query(sql);
  const row = result.rows[0];
  return {
    present: true,
    tablePresent: true,
    rowCount: typeof row?.row_count === "number" ? row.row_count : Number(row?.row_count ?? 0),
    fingerprint: typeof row?.fingerprint === "string" ? row.fingerprint : null,
    group: tablePolicy.group,
    required: tablePolicy.required,
    table: tablePolicy.table,
  };
}

/**
 * @param {import("pg").PoolClient} client
 * @param {MigrationPolicy} policy
 * @param {string} schemaName
 * @param {Record<string, SchemaTable>} schemaTables
 */
export async function collectFingerprints(client, policy, schemaName, schemaTables) {
  /** @type {Record<string, TableFingerprint>} */
  const tables = {};
  for (const tablePolicy of policy.fingerprintTables) {
    tables[tablePolicy.id] = await fingerprintOneTable(client, schemaName, schemaTables, tablePolicy);
  }
  return tables;
}

/**
 * @param {Record<string, TableFingerprint>} tables
 * @param {MigrationPolicy} policy
 */
function summarizeGroups(tables, policy) {
  /** @type {Record<string, {views: string[], rowCount: number}>} */
  const groups = {};
  for (const tablePolicy of policy.fingerprintTables) {
    const bucket = groups[tablePolicy.group] ?? { views: [], rowCount: 0 };
    bucket.views.push(tablePolicy.id);
    bucket.rowCount += tables[tablePolicy.id]?.rowCount ?? 0;
    groups[tablePolicy.group] = bucket;
  }
  return groups;
}

/**
 * @param {import("pg").PoolClient} client
 * @param {MigrationPolicy} policy
 * @param {"source" | "copy"} role
 * @param {DatabaseIdentity} identity
 * @returns {Promise<MigrationManifest>}
 */
export async function buildManifest(client, policy, role, identity) {
  const versionResult = await client.query("SELECT version() AS version");
  const schemaName = await currentSchemaName(client);
  const schema = await introspectSchema(client, schemaName);
  const tables = await collectFingerprints(client, policy, schemaName, schema);
  const warnings = [];
  for (const tablePolicy of policy.fingerprintTables) {
    if (tablePolicy.required && !tables[tablePolicy.id]?.present) {
      warnings.push(`缺少必需表 ${tablePolicy.table}`);
    }
    const table = schema[tablePolicy.table];
    if (table) {
      const available = new Set(table.columns.map((column) => column.name));
      const missing = tablePolicy.columns.filter((column) => !available.has(column));
      if (missing.length > 0) warnings.push(`${tablePolicy.table} 缺少策略列：${missing.join(", ")}`);
    }
  }
  return {
    format: MANIFEST_FORMAT,
    generatedAt: new Date().toISOString(),
    role,
    identity,
    serverVersion: typeof versionResult.rows[0]?.version === "string" ? versionResult.rows[0].version : "unknown",
    schemaName,
    schema: { tables: schema },
    tables,
    groups: summarizeGroups(tables, policy),
    warnings,
  };
}

/**
 * @param {unknown} value
 * @returns {MigrationManifest}
 */
export function parseManifest(value) {
  if (!isRecord(value) || value.format !== MANIFEST_FORMAT) {
    throw new MigrationInputError(`离线清单格式必须为 ${MANIFEST_FORMAT}`, "MANIFEST_INVALID");
  }
  requireString(value.generatedAt, "离线清单 generatedAt");
  if (value.role !== "source" && value.role !== "copy") {
    throw new MigrationInputError("离线清单 role 必须是 source 或 copy", "MANIFEST_INVALID");
  }
  requireString(value.serverVersion, "离线清单 serverVersion");
  requireString(value.schemaName, "离线清单 schemaName");
  assertIdentifier(String(value.schemaName), "离线清单 schemaName");
  if (!isRecord(value.identity)
    || typeof value.identity.host !== "string"
    || typeof value.identity.port !== "number"
    || !Number.isSafeInteger(value.identity.port)
    || value.identity.port < 1
    || value.identity.port > 65535
    || typeof value.identity.database !== "string"
    || typeof value.identity.display !== "string") {
    throw new MigrationInputError("离线清单缺少库身份", "MANIFEST_INVALID");
  }
  const identityHost = normalizeHost(value.identity.host);
  if (identityHost.length === 0 || value.identity.database.length === 0) {
    throw new MigrationInputError("离线清单库身份为空", "MANIFEST_INVALID");
  }
  const safeIdentityDisplay = `postgresql://${identityHost}:${value.identity.port}/${value.identity.database}`;
  if (value.identity.display !== safeIdentityDisplay) {
    throw new MigrationInputError("离线清单库身份 display 必须是无凭证的规范化值", "MANIFEST_INVALID");
  }
  if (!isRecord(value.schema) || !isRecord(value.schema.tables)) {
    throw new MigrationInputError("离线清单缺少 schema", "MANIFEST_INVALID");
  }
  for (const [tableName, tableValue] of Object.entries(value.schema.tables)) {
    assertIdentifier(tableName, "离线清单 schema 表名");
    if (!isRecord(tableValue) || !Array.isArray(tableValue.columns)) {
      throw new MigrationInputError(`离线清单 ${tableName} schema 非法`, "MANIFEST_INVALID");
    }
    for (const columnValue of tableValue.columns) {
      if (!isRecord(columnValue)
        || typeof columnValue.name !== "string"
        || typeof columnValue.dataType !== "string"
        || typeof columnValue.udtName !== "string"
        || typeof columnValue.nullable !== "boolean"
        || typeof columnValue.position !== "number"
        || !Number.isSafeInteger(columnValue.position)) {
        throw new MigrationInputError(`离线清单 ${tableName} 列 schema 非法`, "MANIFEST_INVALID");
      }
      assertIdentifier(columnValue.name, `${tableName} 列名`);
    }
  }
  if (!isRecord(value.tables)) {
    throw new MigrationInputError("离线清单缺少数据指纹", "MANIFEST_INVALID");
  }
  for (const [id, tableValue] of Object.entries(value.tables)) {
    assertIdentifier(id, "离线清单数据项 ID");
    if (!isRecord(tableValue)
      || typeof tableValue.present !== "boolean"
      || typeof tableValue.tablePresent !== "boolean"
      || typeof tableValue.fingerprint !== "string" && tableValue.fingerprint !== null
      || typeof tableValue.group !== "string"
      || typeof tableValue.required !== "boolean"
      || typeof tableValue.table !== "string") {
      throw new MigrationInputError(`离线清单数据项 ${id} 非法`, "MANIFEST_INVALID");
    }
    requireNonNegativeSafeInteger(tableValue.rowCount, `离线清单 ${id}.rowCount`);
    assertIdentifier(tableValue.table, `离线清单 ${id}.table`);
    if (tableValue.fingerprint !== null && !/^[a-f0-9]{32}$/.test(tableValue.fingerprint)) {
      throw new MigrationInputError(`离线清单 ${id}.fingerprint 非法`, "MANIFEST_INVALID");
    }
  }
  if (!Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string")) {
    throw new MigrationInputError("离线清单 warnings 必须是字符串数组", "MANIFEST_INVALID");
  }
  return /** @type {MigrationManifest} */ (value);
}

/**
 * @param {Record<string, SchemaTable>} sourceSchema
 * @param {Record<string, SchemaTable>} copySchema
 */
function compareSchemas(sourceSchema, copySchema) {
  const missingTables = [];
  const missingColumns = [];
  const incompatibleTypes = [];
  const tightenedNulls = [];
  for (const [tableName, sourceTable] of Object.entries(sourceSchema)) {
    const copyTable = copySchema[tableName];
    if (!copyTable) {
      missingTables.push(tableName);
      continue;
    }
    /** @type {Map<string, SchemaColumn>} */
    const copyColumns = new Map(copyTable.columns.map((column) => [column.name, column]));
    for (const sourceColumn of sourceTable.columns) {
      const copyColumn = copyColumns.get(sourceColumn.name);
      if (!copyColumn) {
        missingColumns.push(`${tableName}.${sourceColumn.name}`);
        continue;
      }
      if (!isCompatibleType(sourceColumn.udtName, copyColumn.udtName)) {
        incompatibleTypes.push(`${tableName}.${sourceColumn.name}: ${sourceColumn.udtName} -> ${copyColumn.udtName}`);
      }
      if (sourceColumn.nullable && !copyColumn.nullable) {
        tightenedNulls.push(`${tableName}.${sourceColumn.name}`);
      }
    }
  }
  return { missingTables, missingColumns, incompatibleTypes, tightenedNulls };
}

/**
 * 兼容目标库的放宽类型；收窄或语义变化明确拒绝。
 *
 * @param {string} source
 * @param {string} target
 */
function isCompatibleType(source, target) {
  if (source === target) return true;
  const textTypes = new Set(["text", "varchar", "bpchar"]);
  if (textTypes.has(source) && textTypes.has(target)) return true;
  const integerTypes = ["int2", "int4", "int8"];
  const sourceIndex = integerTypes.indexOf(source);
  const targetIndex = integerTypes.indexOf(target);
  if (sourceIndex >= 0 && targetIndex >= sourceIndex) return true;
  const numericTypes = new Set(["numeric", "float4", "float8"]);
  if (numericTypes.has(source) && numericTypes.has(target)) return true;
  return false;
}

/**
 * @param {import("pg").PoolClient} client
 * @param {string} schema
 * @param {string} table
 * @param {string} column
 */
async function countNulls(client, schema, table, column) {
  assertIdentifier(table, "table");
  assertIdentifier(column, "column");
  const result = await client.query(`SELECT count(*)::int AS n FROM "${schema}"."${table}" WHERE "${column}" IS NULL`);
  return typeof result.rows[0]?.n === "number" ? result.rows[0].n : Number(result.rows[0]?.n ?? 0);
}

/**
 * @param {MigrationManifest} manifest
 * @param {MigrationManifest} actual
 * @param {MigrationPolicy} policy
 * @param {import("pg").PoolClient | null} client
 * @param {{requireNative: boolean}} options
 */
export async function compareManifest(manifest, actual, policy, client, options) {
  /** @type {CheckResult[]} */
  const checks = [];
  const schemaDiff = compareSchemas(manifest.schema.tables, actual.schema.tables);
  checks.push({
    id: "schema.tables",
    ok: schemaDiff.missingTables.length === 0,
    severity: "error",
    message: schemaDiff.missingTables.length === 0
      ? "源 schema 的表在副本中均存在"
      : `副本缺少表：${schemaDiff.missingTables.join(", ")}`,
  });
  checks.push({
    id: "schema.columns",
    ok: schemaDiff.missingColumns.length === 0,
    severity: "error",
    message: schemaDiff.missingColumns.length === 0
      ? "源 schema 的列在副本中均存在"
      : `副本缺少列：${schemaDiff.missingColumns.join(", ")}`,
  });
  checks.push({
    id: "schema.types",
    ok: schemaDiff.incompatibleTypes.length === 0,
    severity: "error",
    message: schemaDiff.incompatibleTypes.length === 0
      ? "源列类型与副本兼容"
      : `不兼容类型：${schemaDiff.incompatibleTypes.join(", ")}`,
  });

  /** @type {string[]} */
  const nullViolations = [];
  if (client && schemaDiff.tightenedNulls.length > 0) {
    for (const qualified of schemaDiff.tightenedNulls) {
      const [table, column] = qualified.split(".");
      if (!table || !column) continue;
      const nulls = await countNulls(client, actual.schemaName, table, column);
      if (nulls > 0) nullViolations.push(`${qualified} (${nulls} 行 NULL)`);
    }
  }
  checks.push({
    id: "schema.nulls",
    ok: nullViolations.length === 0,
    severity: "error",
    message: nullViolations.length === 0
      ? "新增 NOT NULL 约束没有现存 NULL"
      : `副本列被收紧为 NOT NULL 但仍有 NULL：${nullViolations.join(", ")}`,
  });

  /** @type {string[]} */
  const rowMismatches = [];
  /** @type {string[]} */
  const fingerprintMismatches = [];
  /** @type {string[]} */
  const unexpectedRows = [];
  for (const tablePolicy of policy.fingerprintTables) {
    const expected = manifest.tables[tablePolicy.id];
    const seen = actual.tables[tablePolicy.id];
    if (!expected) {
      if (tablePolicy.required) {
        rowMismatches.push(`${tablePolicy.id}（清单缺少必需项）`);
      }
      continue;
    }
    if (tablePolicy.required && !expected.present) {
      rowMismatches.push(`${tablePolicy.id}（源清单标记为缺失）`);
    }
    if (expected.present) {
      if (!seen?.present) {
        rowMismatches.push(`${tablePolicy.id}（副本表缺失）`);
        continue;
      }
      if (expected.rowCount !== seen.rowCount) {
        rowMismatches.push(`${tablePolicy.id}（${expected.rowCount} -> ${seen.rowCount}）`);
      }
      if (expected.fingerprint !== seen.fingerprint) {
        fingerprintMismatches.push(tablePolicy.id);
      }
    } else if (seen?.present && seen.rowCount > 0) {
      if (expected.tablePresent) {
        if (expected.rowCount !== seen.rowCount) {
          rowMismatches.push(`${tablePolicy.id}（${expected.rowCount} -> ${seen.rowCount}）`);
        }
      } else {
        unexpectedRows.push(`${tablePolicy.id}（${seen.rowCount} 行）`);
      }
    } else if (expected.tablePresent && !seen?.present) {
      rowMismatches.push(`${tablePolicy.id}（副本表缺失）`);
    }
  }
  checks.push({
    id: "data.rowCounts",
    ok: rowMismatches.length === 0,
    severity: "error",
    message: rowMismatches.length === 0 ? "作品/任务/设置/追更等行数与清单一致" : `行数不一致：${rowMismatches.join(", ")}`,
  });
  checks.push({
    id: "data.fingerprints",
    ok: fingerprintMismatches.length === 0,
    severity: "error",
    message: fingerprintMismatches.length === 0 ? "数据指纹与清单一致" : `数据指纹不一致：${fingerprintMismatches.join(", ")}`,
  });
  checks.push({
    id: "data.unexpectedRows",
    ok: unexpectedRows.length === 0,
    severity: "error",
    message: unexpectedRows.length === 0 ? "没有清单外的新表数据" : `清单外出现数据：${unexpectedRows.join(", ")}`,
  });

  const nativeMissing = policy.fingerprintTables
    .filter((tablePolicy) => !actual.schema.tables[tablePolicy.table])
    .map((tablePolicy) => tablePolicy.table);
  const nativeMissingColumns = policy.fingerprintTables.flatMap((tablePolicy) => {
    const table = actual.schema.tables[tablePolicy.table];
    if (!table) return [];
    const available = new Set(table.columns.map((column) => column.name));
    return tablePolicy.columns
      .filter((column) => !available.has(column))
      .map((column) => `${tablePolicy.table}.${column}`);
  });
  checks.push({
    id: "native.schema",
    ok: nativeMissing.length === 0 && nativeMissingColumns.length === 0,
    severity: options.requireNative ? "error" : "warning",
    message: nativeMissing.length === 0 && nativeMissingColumns.length === 0
      ? "原生增量 schema 已就绪"
      : `尚未执行原生增量 schema，缺少表：${nativeMissing.join(", ") || "无"}；缺少列：${nativeMissingColumns.join(", ") || "无"}`,
  });

  return {
    ok: checks.every((check) => check.ok || check.severity === "warning"),
    checks,
    schemaDiff,
    tableMismatches: { rowMismatches, fingerprintMismatches, unexpectedRows },
  };
}

/**
 * 使用原生公开 schema 初始化入口。禁止在脚本里复制/伪造 DDL。
 *
 * @param {string} connectionString
 */
export async function initializeNativeSchema(connectionString) {
  const { default: pg } = await import("pg");
  let base;
  let library;
  try {
    base = await import("@media-track/workflow");
    library = await import("@media-track/workflow/library");
  } catch (error) {
    throw new MigrationInputError(
      `无法加载原生 workflow 构建产物，请先执行 npm run build:workflow（${safeErrorMessage(error)}）`,
      "WORKFLOW_BUILD_MISSING",
    );
  }
  const pool = new pg.Pool({
    connectionString,
    application_name: "fork-migration-schema",
    max: 4,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  });
  try {
    await base.initializeWorkflowPostgresSchema(pool);
    await new library.PostgresLibraryStore(pool).ensureSchema();
    await new library.PostgresScanStore(pool).ensureSchema();
    await new library.PostgresIdentificationStore(pool).ensureSchema();
    await new library.PostgresOrganizationStore(pool).ensureSchema();
    await new library.PostgresPreparationStore(pool).ensureSchema();
    await new library.PostgresAutoOrganizationStore(pool).ensureSchema();
    await new library.PostgresAcquisitionNamingDatabase(pool).ensureSchema();
    await new library.PostgresOrganizedIndexStore(pool).ensureSchema();
  } finally {
    await pool.end();
  }
}

/**
 * @param {import("pg").PoolClient} client
 * @param {MigrationPolicy} policy
 */
export async function runWriterGate(client, policy) {
  const lockResult = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [policy.gate.advisoryLockKey]);
  const locked = lockResult.rows[0]?.locked === true;
  const connectionResult = await client.query(
    `SELECT count(*)::int AS n
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND application_name NOT LIKE $1`,
    [`${policy.gate.applicationNamePrefix}%`],
  );
  const foreignConnections = typeof connectionResult.rows[0]?.n === "number"
    ? connectionResult.rows[0].n
    : Number(connectionResult.rows[0]?.n ?? 0);
  const runningResult = await client.query(
    `SELECT count(*)::int AS n
       FROM workflow_runs
      WHERE payload->>'status' = 'running'`,
  ).catch(() => ({ rows: [{ n: null }] }));
  const activeRunningRuns = typeof runningResult.rows[0]?.n === "number"
    ? runningResult.rows[0].n
    : Number(runningResult.rows[0]?.n ?? 0);
  if (locked) {
    await client.query("SELECT pg_advisory_unlock($1)", [policy.gate.advisoryLockKey]);
  }
  return {
    ok: locked && foreignConnections <= policy.gate.maxForeignConnections,
    advisoryLockKey: policy.gate.advisoryLockKey,
    advisoryLockAvailable: locked,
    foreignConnections,
    maxForeignConnections: policy.gate.maxForeignConnections,
    activeRunningRuns,
    observedAt: new Date().toISOString(),
  };
}

/**
 * @param {MigrationPolicy} policy
 * @param {NodeJS.ProcessEnv} parentEnv
 */
export function buildRehearsalEnv(policy, parentEnv) {
  resolveMigrationIdentities(parentEnv, policy);
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of policy.rehearsalAllowedEnv) {
    const value = parentEnv[key];
    if (typeof value === "string") env[key] = value;
  }
  for (const [key, value] of Object.entries(policy.rehearsalEnv)) env[key] = value;
  const copyUrl = parentEnv.MEDIA_TRACK_MIGRATION_COPY_URL;
  if (!copyUrl) throw new MigrationInputError("缺少 MEDIA_TRACK_MIGRATION_COPY_URL", "DATABASE_URL_MISSING");
  for (const key of policy.rehearsalBlockedEnv) delete env[key];
  env.MEDIA_TRACK_POSTGRES_URL = copyUrl;
  env.MEDIA_TRACK_MIGRATION_COPY_URL = copyUrl;
  return env;
}

/**
 * @param {MigrationPolicy} policy
 * @param {NodeJS.ProcessEnv} parentEnv
 */
export function describeRehearsal(policy, parentEnv) {
  const env = buildRehearsalEnv(policy, parentEnv);
  const { copy } = resolveMigrationIdentities(parentEnv, policy);
  /** @type {Record<string, string>} */
  const forcedEnv = {};
  for (const [key, value] of Object.entries(policy.rehearsalEnv)) forcedEnv[key] = value;
  forcedEnv.MEDIA_TRACK_POSTGRES_URL = `<copy:${copy.display}>`;
  forcedEnv.MEDIA_TRACK_MIGRATION_COPY_URL = `<copy:${copy.display}>`;
  return {
    copy: copy.display,
    forcedEnv,
    blockedEnv: [...policy.rehearsalBlockedEnv],
    childEnv: env,
    image: policy.plan.imagePlaceholder,
    composeFile: policy.plan.composeFile,
    warnings: [
      "副本仍含真实 provider 文件 ID；必须保持 fake storage/agent/workflow，禁止真实网盘写入。",
      "演练使用独立项目目录或 docker run 临时 env，不得复用含生产地址/令牌的 .env。",
    ],
  };
}

/**
 * @param {string} file
 * @returns {Promise<void>}
 */
export async function assertWritableTempPath(file) {
  const resolved = path.resolve(file);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new MigrationInputError("输出/临时 env 文件不得写入 Git 工作区", "OUTPUT_INSIDE_REPO");
  }
}

/**
 * @param {string} file
 * @param {string} content
 */
export async function writeSecureFile(file, content) {
  await assertWritableTempPath(file);
  await writeFile(file, content, { encoding: "utf8", mode: 0o600 });
}

/**
 * @param {string} file
 */
export async function readManifestFile(file) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new MigrationInputError(`无法读取离线清单 ${path.basename(file)}：${safeErrorMessage(error)}`, "MANIFEST_UNREADABLE");
  }
  return parseManifest(parsed);
}

/**
 * @param {MigrationPolicy} policy
 * @returns {PlanStep[]}
 */
export function buildBackupPlan(policy) {
  const dump = policy.plan.backupPathPlaceholder;
  return [
    {
      id: "quiesce-source-writers",
      title: "停止旧实例写入",
      detail: "先停止旧实例全部 worker、定时任务与 updater，并完成唯一 writer 检查；在备份完成前不要让旧实例继续领取任务。",
      env: ["MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED=1"],
    },
    {
      id: "dump-source",
      title: "备份源数据库",
      detail: "使用自定义格式导出，保留 owner/acl 以外的结构与数据；路径放在 Git 工作区之外的受控目录。",
      command: ["pg_dump", "--dbname=$MEDIA_TRACK_MIGRATION_SOURCE_URL", ...policy.backup.dumpArgs, `--file=${dump}`],
    },
    {
      id: "dump-copy",
      title: "备份演练副本",
      detail: "单独保存副本备份，便于演练失败后恢复；该转储同样不得提交到 Git。",
      command: ["pg_dump", "--dbname=$MEDIA_TRACK_MIGRATION_COPY_URL", ...policy.backup.dumpArgs, `--file=${dump}.copy`],
    },
    {
      id: "checksum",
      title: "记录转储校验和",
      detail: "为两个转储计算 SHA-256，并记录到受控运维记录。",
      command: ["sha256sum", dump, `${dump}.copy`],
    },
    {
      id: "verify-dump",
      title: "验证转储可读",
      detail: "只读列出转储内容，确认 pg_restore 能识别且包含预期表。",
      command: ["pg_restore", "--list", dump],
    },
  ];
}

/**
 * @param {MigrationPolicy} policy
 * @returns {PlanStep[]}
 */
export function buildRestorePlan(policy) {
  return [
    {
      id: "stop-new-workers",
      title: "先停止全部新实例 worker",
      detail: "回退数据库前必须停止新实例的 worker、定时器与 updater；否则恢复期间仍可能写旧/新表。",
      env: ["MEDIA_TRACK_MIGRATION_NEW_WRITERS_STOPPED=1"],
    },
    {
      id: "verify-backup",
      title: "核对备份校验和",
      detail: "确认转储 SHA-256 与备份记录一致，并用 pg_restore --list 检查内容。",
      command: ["pg_restore", "--list", policy.plan.backupPathPlaceholder],
    },
    {
      id: "restore",
      title: "恢复数据库",
      detail: "只恢复到显式指定的恢复目标；--clean --if-exists 会删除目标库对象，必须人工确认目标不是正在运行的新实例。",
      destructive: true,
      command: [
        "pg_restore",
        "--dbname=$MEDIA_TRACK_RESTORE_TARGET_URL",
        ...policy.backup.restoreArgs,
        policy.plan.backupPathPlaceholder,
      ],
    },
    {
      id: "verify-restored",
      title: "恢复后核验",
      detail: "把恢复目标指向隔离副本，重新执行 inventory/preflight 对比离线清单，确认作品、任务、设置与追更指纹。",
      command: ["node", "scripts/fork-migration.mjs", "preflight", "--manifest", "<MANIFEST_PATH>"],
    },
  ];
}

/**
 * @param {MigrationPolicy} policy
 * @param {NodeJS.ProcessEnv} env
 */
export function buildSwitchPlan(policy, env) {
  const gateOk = env.MEDIA_TRACK_MIGRATION_GATE_OK === "1";
  const oldStopped = env.MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED === "1";
  const backupOk = env.MEDIA_TRACK_MIGRATION_BACKUP_OK === "1";
  const blockedReasons = [];
  if (!oldStopped) blockedReasons.push("未确认旧实例 worker/定时器/updater 已停写（MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED=1）");
  if (!gateOk) blockedReasons.push("未确认唯一 writer 门禁通过（MEDIA_TRACK_MIGRATION_GATE_OK=1）");
  if (!backupOk) blockedReasons.push("未确认备份已完成（MEDIA_TRACK_MIGRATION_BACKUP_OK=1）");
  return {
    ready: blockedReasons.length === 0,
    blockedReasons,
    uniqueWriterGate: {
      advisoryLockKey: policy.gate.advisoryLockKey,
      queries: [
        "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND application_name NOT LIKE 'fork-migration%';",
        "SELECT pg_try_advisory_lock(" + policy.gate.advisoryLockKey + ");",
        "SELECT count(*) FROM workflow_runs WHERE payload->>'status'='running';",
      ],
    },
    steps: [
      {
        id: "stop-old-writers",
        title: "停止旧实例全部写者",
        detail: "停止旧实例的 worker、扫描/整理/准备定时器与 updater，等待在途写请求结束；确认旧容器不再连接数据库或网盘。",
        command: ["docker", "compose", "-f", "<OLD_COMPOSE_FILE>", "stop", "web"],
        env: ["MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED=1"],
      },
      {
        id: "verify-unique-writer",
        title: "执行唯一 writer 门禁",
        detail: "使用 gate 命令或上面的只读 SQL，确认同一库没有旧应用连接且迁移门禁锁可获得；通过后才允许启动新实例。",
        command: ["node", "scripts/fork-migration.mjs", "gate"],
      },
      {
        id: "start-new-with-workers-disabled",
        title: "先以 worker 关闭启动新实例",
        detail: "新实例先只读/无 worker 启动，确认健康检查和登录，再开放 worker；启动期间强制 fake 适配器与 MEDIA_TRACK_INPROCESS_WORKER=0。",
        command: [
          "docker",
          "compose",
          "-f",
          policy.plan.composeFile,
          "--project-name",
          "media-track-new",
          "up",
          "-d",
          "web",
        ],
        env: ["MEDIA_TRACK_INPROCESS_WORKER=0", "MEDIA_TRACK_STORAGE_ADAPTER=fake", "MEDIA_TRACK_AGENT_ADAPTER=fake", "MEDIA_TRACK_WORKFLOW_ADAPTER=fake"],
      },
      {
        id: "health-check",
        title: "检查新实例健康",
        detail: "访问 /api/health，用只读查询核对作品/任务/设置/追更指纹；检查完成前不要开启 worker。",
        command: ["curl", "-fsS", "http://127.0.0.1:3000/api/health"],
      },
      {
        id: "enable-new-workers",
        title: "最后开启新实例 worker",
        detail: "仅在新实例健康、旧实例确认停写、唯一 writer 门禁通过后，设置真实适配器并开启 MEDIA_TRACK_INPROCESS_WORKER=1。",
        env: ["MEDIA_TRACK_INPROCESS_WORKER=1"],
      },
    ],
  };
}

/**
 * @param {MigrationPolicy} policy
 * @param {NodeJS.ProcessEnv} env
 */
export function buildRollbackPlan(policy, env) {
  const newStopped = env.MEDIA_TRACK_MIGRATION_NEW_WRITERS_STOPPED === "1";
  return {
    ready: newStopped,
    blockedReasons: newStopped ? [] : ["未确认新实例 worker/定时器已停止（MEDIA_TRACK_MIGRATION_NEW_WRITERS_STOPPED=1）"],
    steps: [
      {
        id: "stop-new-workers",
        title: "回退前先停止新实例 worker",
        detail: "停止新实例全部 worker、定时器与 updater，确认没有新写入后再恢复旧数据库；绝不能与新实例同时写。",
        command: ["docker", "compose", "-f", policy.plan.composeFile, "--project-name", "media-track-new", "stop", "web"],
        env: ["MEDIA_TRACK_MIGRATION_NEW_WRITERS_STOPPED=1"],
      },
      {
        id: "verify-unique-writer",
        title: "确认唯一 writer",
        detail: "重新运行 gate 或只读 SQL，确认新实例已断开、没有其他写者。",
        command: ["node", "scripts/fork-migration.mjs", "gate"],
      },
      {
        id: "restore-old-database",
        title: "恢复旧数据库备份",
        detail: "只恢复到已确认停写且不是当前新实例的数据库；恢复操作具有破坏性，必须先核对目标 URL 与转储校验和。",
        destructive: true,
        command: [
          "pg_restore",
          "--dbname=$MEDIA_TRACK_RESTORE_TARGET_URL",
          ...policy.backup.restoreArgs,
          policy.plan.backupPathPlaceholder,
        ],
      },
      {
        id: "start-old-instance",
        title: "启动旧实例",
        detail: "旧实例先以 worker 关闭启动并检查健康，确认数据后按原运维步骤恢复 worker。",
        command: ["docker", "compose", "-f", "<OLD_COMPOSE_FILE>", "up", "-d", "web"],
      },
    ],
  };
}

/**
 * @param {string} text
 */
export function redactText(text) {
  return text.replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, "<redacted-postgres-url>");
}

/**
 * @param {unknown} error
 */
export function safeErrorMessage(error) {
  if (error instanceof Error) return redactText(error.message);
  return redactText(String(error));
}

/**
 * @param {unknown} error
 * @param {NodeJS.ProcessEnv} env
 */
export function safeError(error, env) {
  let message = safeErrorMessage(error);
  for (const key of ["MEDIA_TRACK_MIGRATION_SOURCE_URL", "MEDIA_TRACK_MIGRATION_COPY_URL"]) {
    const value = env[key];
    if (value) {
      message = message.split(value).join("<redacted-postgres-url>");
      try {
        const url = new URL(value);
        const credentials = [url.username, url.password]
          .filter((part) => part.length > 0)
          .flatMap((part) => {
            const encoded = [part];
            try {
              encoded.push(decodeURIComponent(part));
            } catch {
              // URL 解析已成功；非法百分号仍只按原始值脱敏。
            }
            return encoded;
          });
        for (const credential of credentials.sort((left, right) => right.length - left.length)) {
          message = message.split(credential).join("***");
        }
      } catch {
        // 非 URL 输入由调用方报告。
      }
    }
  }
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  return {
    name: error instanceof Error ? error.name : "Error",
    ...(code ? { code } : {}),
    message,
  };
}

/**
 * @param {string} file
 */
export async function fileSha256(file) {
  const content = await readFile(file);
  return createHash("sha256").update(content).digest("hex");
}
