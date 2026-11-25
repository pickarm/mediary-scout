import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresWorkflowRepository, initializeWorkflowPostgresSchema } from "../src/postgres.js";
import { workflowPersistenceFixture } from "./workflow-fixtures.js";
import { PostgresMessagingStore } from "../../../apps/web/lib/messaging/store.js";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);
const scriptPath = fileURLToPath(new URL("../../../scripts/fork-migration.mjs", import.meta.url));
const policyPath = fileURLToPath(new URL("../../../scripts/fork-migration-policy.json", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown>;
}

interface ManifestTable {
  present: boolean;
  rowCount: number;
  fingerprint: string | null;
}

interface ManifestJson {
  format: string;
  identity: { host: string; port: number; database: string; display: string };
  tables: Record<string, ManifestTable>;
  groups: Record<string, { rowCount: number }>;
  schema: { tables: Record<string, { columns: Array<{ name: string }> }> };
}

interface PlanStepJson {
  id: string;
  title: string;
  detail: string;
  command?: string[];
  destructive?: boolean;
}

interface PlanJson {
  ok: boolean;
  executes: boolean;
  steps: PlanStepJson[];
  ready?: boolean;
  blockedReasons?: string[];
  uniqueWriterGate?: { advisoryLockKey: number; queries: string[] };
}

interface PreflightJson {
  ok: boolean;
  sourceConnectionOpened: boolean;
  copyConnectionOpened: boolean;
  nativeSchemaReady: boolean;
  checks: Array<{ id: string; ok: boolean; severity: string; message: string }>;
  tables: Record<string, ManifestTable>;
}

const SOURCE_SECRET = "SOURCE_SECRET_F16";
const PROVIDER_SECRET = "SECRET_PROVIDER_TOKEN_F16";
const SETTING_SECRET = "SECRET_SETTING_VALUE_F16";
const ACCOUNT_SETTING_SECRET = "SECRET_ACCOUNT_SETTING_F16";
const COOKIE_SECRET = "SECRET_COOKIE_F16";
const AGENT_SECRET = "SECRET_AGENT_KEY_F16";
const WORKER_SECRET = "SECRET_WORKER_F16";

let tempDir = "";
let adminPool: pg.Pool | null = null;
let pool: pg.Pool | null = null;
let databaseName = "";
let copyUrl = "";
let manifestPath = "";
const sourceUrl = `postgresql://source_user:${SOURCE_SECRET}@127.0.0.1:1/source_f16`;

function cliEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MEDIA_TRACK_MIGRATION_")) delete env[key];
  }
  return { ...env, ...extra };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("not an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error(`CLI 未输出合法 JSON：${text.slice(0, 500)}`);
  }
}

function runCli(args: string[], extraEnv: NodeJS.ProcessEnv = {}): CliResult {
  const effectiveCopyUrl = copyUrl || "postgresql://user:PLAN_ONLY_PASSWORD@127.0.0.1:5432/f16_plan_copy";
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: cliEnv({
      MEDIA_TRACK_MIGRATION_SOURCE_URL: sourceUrl,
      MEDIA_TRACK_MIGRATION_COPY_URL: effectiveCopyUrl,
      ...extraEnv,
    }),
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
  const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
  return {
    status: result.status,
    stdout,
    stderr,
    json: stdout.trim() ? parseJson(stdout) : {},
  };
}

function expectNoSecrets(text: string): void {
  for (const secret of [SOURCE_SECRET, PROVIDER_SECRET, SETTING_SECRET, ACCOUNT_SETTING_SECRET, COOKIE_SECRET, AGENT_SECRET, WORKER_SECRET]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toContain("codex-isolated-test");
  expect(text).not.toContain("source_user:");
}

function findStep(plan: PlanJson, id: string): PlanStepJson {
  const step = plan.steps.find((candidate) => candidate.id === id);
  if (!step) throw new Error(`missing plan step ${id}`);
  return step;
}

function asManifest(value: unknown): ManifestJson {
  return value as ManifestJson;
}

beforeAll(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "fork-migration-test-"));
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

integration("F16 migration rehearsal and switch tooling", () => {
  const accountId = "acct_f16_migration";
  const storageId = "storage_f16_guangya";

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `fork_migration_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    const copy = new URL(adminConnectionString);
    copy.pathname = `/${databaseName}`;
    copyUrl = copy.toString();
    pool = new pg.Pool({ connectionString: copyUrl, application_name: "fork-migration-fixture" });
    await initializeWorkflowPostgresSchema(pool);
    await new PostgresMessagingStore(pool).ensureSchema();
    await seedFixture(pool, accountId, storageId);
    manifestPath = path.join(tempDir, "source-manifest.json");
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool && databaseName) {
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await adminPool.end();
    }
  }, 30_000);

  it("generates an offline schema/data manifest without leaking provider IDs, secrets or row values", async () => {
    const result = runCli(["inventory", "--out", manifestPath]);
    expect(result.status).toBe(0);
    expectNoSecrets(result.stdout);
    const manifest = asManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    expect(manifest.format).toBe("media-track-fork-migration-manifest@1");
    expect(manifest.tables.media_titles?.rowCount).toBe(1);
    expect(manifest.tables.tracked_seasons?.rowCount).toBe(1);
    expect(manifest.tables.episode_states?.rowCount).toBe(2);
    expect(manifest.tables.episode_copies?.rowCount).toBe(1);
    expect(manifest.tables.workflow_runs?.rowCount).toBe(1);
    expect(manifest.groups.works?.rowCount).toBe(1);
    expect(manifest.groups.tracking?.rowCount).toBe(4);
    expect(manifest.groups.settings?.rowCount).toBe(2);
    expect(manifest.groups.connections?.rowCount).toBe(3);
    expect(manifest.schema.tables.library_scan_tasks).toBeUndefined();
    const serialized = JSON.stringify(manifest);
    expectNoSecrets(serialized);
    expect(serialized).not.toContain("gy_uid_f16");
    expect(serialized).not.toContain("gy_file_f16");
    expect(serialized).not.toContain("TAMPERED");
  });

  it("refuses to write an inventory or temporary env file inside the Git worktree", async () => {
    const forbiddenOutput = path.join(repoRoot, `.f16-manifest-${randomUUID()}.json`);
    const forbiddenEnv = path.join(repoRoot, `.f16-rehearsal-${randomUUID()}.env`);
    try {
      const result = runCli(["inventory", "--out", forbiddenOutput]);
      expect(result.status).toBe(2);
      expect(JSON.stringify(result.json)).toContain("OUTPUT_INSIDE_REPO");
      await expect(readFile(forbiddenOutput, "utf8")).rejects.toThrow();

      const rehearsal = runCli(["rehearsal", "--write-env", forbiddenEnv]);
      expect(rehearsal.status).toBe(2);
      expect(JSON.stringify(rehearsal.json)).toContain("OUTPUT_INSIDE_REPO");
      await expect(readFile(forbiddenEnv, "utf8")).rejects.toThrow();
    } finally {
      await rm(forbiddenOutput, { force: true });
      await rm(forbiddenEnv, { force: true });
    }
  });

  it("preflights only the copy, reports an uninitialized native schema, and is repeatable", async () => {
    const first = runCli(["preflight", "--manifest", manifestPath]);
    expect(first.status).toBe(0);
    expectNoSecrets(first.stdout);
    const firstJson = first.json as unknown as PreflightJson;
    expect(firstJson.ok).toBe(true);
    expect(firstJson.sourceConnectionOpened).toBe(false);
    expect(firstJson.copyConnectionOpened).toBe(true);
    expect(firstJson.nativeSchemaReady).toBe(false);
    expect(firstJson.checks.find((check) => check.id === "data.fingerprints")?.ok).toBe(true);
    expect(firstJson.checks.find((check) => check.id === "identity.sourceNotConnected")?.ok).toBe(true);

    const second = runCli(["preflight", "--manifest", manifestPath]);
    expect(second.status).toBe(0);
    expect((second.json as unknown as PreflightJson).tables).toEqual(firstJson.tables);

    const verify = runCli(["verify", "--manifest", manifestPath]);
    expect(verify.status).toBe(1);
    expect((verify.json as unknown as PreflightJson).checks.find((check) => check.id === "native.schema")?.ok).toBe(false);
  });

  it("fails preflight on changed work payload or added rows instead of accepting a partial rehearsal", async () => {
    if (!pool) throw new Error("pool missing");
    const original = await pool.query<{ payload: unknown }>("SELECT payload FROM media_titles WHERE id = 'title_1'");
    await pool.query("UPDATE media_titles SET payload = payload || '{\"title\":\"TAMPERED\"}'::jsonb WHERE id = 'title_1'");
    const tampered = runCli(["preflight", "--manifest", manifestPath]);
    expect(tampered.status).toBe(1);
    expect((tampered.json as unknown as PreflightJson).checks.find((check) => check.id === "data.fingerprints")?.ok).toBe(false);
    await pool.query("UPDATE media_titles SET payload = $1::jsonb WHERE id = 'title_1'", [JSON.stringify(original.rows[0]?.payload)]);

    await pool.query(
      `INSERT INTO media_titles (id, payload)
       VALUES ('title_extra', '{"id":"title_extra","tmdbId":999,"type":"tv","title":"extra","originalTitle":"extra","year":2026,"aliases":[]}'::jsonb)`,
    );
    const extra = runCli(["preflight", "--manifest", manifestPath]);
    expect(extra.status).toBe(1);
    expect((extra.json as unknown as PreflightJson).checks.find((check) => check.id === "data.rowCounts")?.ok).toBe(false);
    await pool.query("DELETE FROM media_titles WHERE id = 'title_extra'");
  });

  it("applies the native incremental schema to the copy idempotently without changing data", async () => {
    const first = runCli(["schema-init", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE: "1",
    });
    expect(first.status).toBe(0);
    expect(first.json.ok).toBe(true);
    expect(first.json.nativeSchemaApplied).toBe(true);
    expect(first.json.dataUnchanged).toBe(true);
    expectNoSecrets(first.stdout);

    const second = runCli(["schema-init", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE: "1",
    });
    expect(second.status).toBe(0);
    expect(second.json.dataUnchanged).toBe(true);

    const verify = runCli(["verify", "--manifest", manifestPath]);
    expect(verify.status).toBe(0);
    expect((verify.json as unknown as PreflightJson).nativeSchemaReady).toBe(true);

    if (!pool) throw new Error("pool missing");
    const table = await pool.query("SELECT to_regclass('public.library_scan_tasks') IS NOT NULL AS present");
    expect(table.rows[0]?.present).toBe(true);
  });

  it("keeps every policy column aligned with the real native schema", async () => {
    if (!pool) throw new Error("pool missing");
    const raw: unknown = JSON.parse(readFileSync(policyPath, "utf8"));
    if (typeof raw !== "object" || raw === null || !("fingerprintTables" in raw)) throw new Error("policy missing fingerprintTables");
    const entries = (raw as { fingerprintTables: unknown }).fingerprintTables;
    if (!Array.isArray(entries)) throw new Error("fingerprintTables must be an array");
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'",
    );
    const actual = new Map<string, Set<string>>();
    for (const row of columns.rows) {
      const set = actual.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      actual.set(row.table_name, set);
    }
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) throw new Error("policy table entry invalid");
      const table = "table" in entry && typeof entry.table === "string" ? entry.table : "";
      const tableColumns = "columns" in entry && Array.isArray(entry.columns) ? entry.columns : [];
      expect(actual.has(table)).toBe(true);
      for (const column of tableColumns) {
        if (typeof column === "string") expect(actual.get(table)?.has(column)).toBe(true);
      }
    }
  });

  it("rejects a foreign writer connection in the unique-writer gate", async () => {
    const blocked = runCli(["gate"]);
    expect(blocked.status).toBe(0);
    expect(blocked.json.ok).toBe(true);
    expect(blocked.json.foreignConnections).toBe(0);
    expect(blocked.json.advisoryLockKey).toBe(4011989150);

    const oldWriter = new pg.Client({ connectionString: copyUrl, application_name: "old-scanner" });
    await oldWriter.connect();
    try {
      const result = runCli(["gate"]);
      expect(result.status).toBe(1);
      expect(result.json.ok).toBe(false);
      expect(Number(result.json.foreignConnections)).toBeGreaterThanOrEqual(1);
    } finally {
      await oldWriter.end();
    }
    const released = runCli(["gate"]);
    expect(released.status).toBe(0);
  });

  it("rejects same-database and non-isolated targets before opening a connection", async () => {
    const sameUrl = new URL(copyUrl);
    sameUrl.password = "different-password";
    const same = runCli(["preflight", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_SOURCE_URL: sameUrl.toString(),
    });
    expect(same.status).toBe(2);
    expect(JSON.stringify(same.json)).toContain("SOURCE_COPY_SAME_DATABASE");
    expectNoSecrets(same.stdout);

    const loopbackAlias = new URL(copyUrl);
    loopbackAlias.hostname = "localhost";
    const aliasSame = runCli(["preflight", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_SOURCE_URL: loopbackAlias.toString(),
    });
    expect(aliasSame.status).toBe(2);
    expect(JSON.stringify(aliasSame.json)).toContain("SOURCE_COPY_SAME_DATABASE");

    const aliasInventory = runCli(["inventory"], {
      MEDIA_TRACK_MIGRATION_SOURCE_URL: loopbackAlias.toString(),
    });
    expect(aliasInventory.status).toBe(2);
    expect(JSON.stringify(aliasInventory.json)).toContain("SOURCE_COPY_SAME_DATABASE");

    const aliasSchemaInit = runCli(["schema-init"], {
      MEDIA_TRACK_MIGRATION_SOURCE_URL: loopbackAlias.toString(),
      MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE: "1",
    });
    expect(aliasSchemaInit.status).toBe(2);
    expect(JSON.stringify(aliasSchemaInit.json)).toContain("SOURCE_COPY_SAME_DATABASE");

    const queryOverride = runCli(["preflight", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_COPY_URL: "postgresql://user:REMOTE_PASSWORD@127.0.0.1:5432/media?host=db.example.com",
    });
    expect(queryOverride.status).toBe(2);
    expect(JSON.stringify(queryOverride.json)).toContain("DATABASE_URL_INVALID");
    expect(queryOverride.stdout).not.toContain("REMOTE_PASSWORD");

    const rehearsalSame = runCli(["rehearsal"], {
      MEDIA_TRACK_MIGRATION_SOURCE_URL: loopbackAlias.toString(),
    });
    expect(rehearsalSame.status).toBe(2);
    expect(JSON.stringify(rehearsalSame.json)).toContain("SOURCE_COPY_SAME_DATABASE");

    const remote = runCli(["preflight", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_COPY_URL: "postgresql://user:REMOTE_PASSWORD@db.example.com:5432/media",
    });
    expect(remote.status).toBe(2);
    expect(JSON.stringify(remote.json)).toContain("ISOLATED_TARGET_REQUIRED");
    expect(remote.stdout).not.toContain("REMOTE_PASSWORD");

    const markedButNotAllowlisted = runCli(["preflight", "--manifest", manifestPath], {
      MEDIA_TRACK_MIGRATION_COPY_URL: "postgresql://user:REMOTE_PASSWORD@db.example.com:5432/media",
      MEDIA_TRACK_MIGRATION_ISOLATED_TEST_DB: "1",
    });
    expect(markedButNotAllowlisted.status).toBe(2);
    expect(JSON.stringify(markedButNotAllowlisted.json)).toContain("ISOLATED_TARGET_REQUIRED");
  });
});

describe("F16 migration plans and rehearsal guards", () => {
  it("prints backup and restore plans without executing them or exposing credentials", () => {
    const backup = runCli(["backup-plan"]);
    expect(backup.status).toBe(0);
    expect(backup.json.executes).toBe(false);
    expectNoSecrets(backup.stdout);
    const backupPlan = backup.json as unknown as PlanJson;
    expect(findStep(backupPlan, "dump-source").command?.[0]).toBe("pg_dump");
    expect(backupPlan.steps.some((step) => step.command?.some((arg) => arg.includes("$MEDIA_TRACK_MIGRATION_SOURCE_URL")))).toBe(true);

    const restore = runCli(["restore-plan"]);
    expect(restore.status).toBe(0);
    expect(restore.json.executes).toBe(false);
    expectNoSecrets(restore.stdout);
    const restorePlan = restore.json as unknown as PlanJson;
    expect(restorePlan.steps[0]?.id).toBe("stop-new-workers");
    const restoreStep = findStep(restorePlan, "restore");
    expect(restoreStep.destructive).toBe(true);
    expect(restoreStep.command?.[0]).toBe("pg_restore");
  });

  it("gates switch planning on old writers stopped, a passing writer gate and a verified backup", () => {
    const blocked = runCli(["switch-plan"]);
    expect(blocked.status).toBe(0);
    const blockedPlan = blocked.json as unknown as PlanJson;
    expect(blockedPlan.executes).toBe(false);
    expect(blockedPlan.ready).toBe(false);
    expect(blockedPlan.blockedReasons?.length).toBe(3);
    expect(findStep(blockedPlan, "stop-old-writers").detail).toContain("worker");
    expect(findStep(blockedPlan, "stop-old-writers").detail).toContain("updater");
    expect(findStep(blockedPlan, "verify-unique-writer").title).toContain("唯一 writer");
    expect(blockedPlan.uniqueWriterGate?.queries.join(" ")).toContain("pg_stat_activity");
    expect(blockedPlan.uniqueWriterGate?.queries.join(" ")).toContain("pg_try_advisory_lock(4011989150)");

    const ready = runCli(["switch-plan"], {
      MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED: "1",
      MEDIA_TRACK_MIGRATION_GATE_OK: "1",
      MEDIA_TRACK_MIGRATION_BACKUP_OK: "1",
    });
    expect(ready.status).toBe(0);
    expect((ready.json as unknown as PlanJson).ready).toBe(true);
  });

  it("refuses switch readiness when the supplied gate result failed or used another lock", async () => {
    const failedGate = path.join(tempDir, "gate-failed.json");
    await writeFile(failedGate, JSON.stringify({ ok: false, advisoryLockKey: 4011989150, foreignConnections: 1 }));
    const failed = runCli(["switch-plan", "--gate", failedGate], {
      MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED: "1",
      MEDIA_TRACK_MIGRATION_GATE_OK: "1",
      MEDIA_TRACK_MIGRATION_BACKUP_OK: "1",
    });
    expect(failed.status).toBe(0);
    const failedPlan = failed.json as unknown as PlanJson;
    expect(failedPlan.ready).toBe(false);
    expect(failedPlan.blockedReasons?.some((reason) => reason.includes("未通过"))).toBe(true);

    const wrongKeyGate = path.join(tempDir, "gate-wrong-key.json");
    await writeFile(wrongKeyGate, JSON.stringify({ ok: true, advisoryLockKey: 4011989147, foreignConnections: 0 }));
    const wrongKey = runCli(["switch-plan", "--gate", wrongKeyGate], {
      MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED: "1",
      MEDIA_TRACK_MIGRATION_GATE_OK: "1",
      MEDIA_TRACK_MIGRATION_BACKUP_OK: "1",
    });
    const wrongKeyPlan = wrongKey.json as unknown as PlanJson;
    expect(wrongKeyPlan.ready).toBe(false);
    expect(wrongKeyPlan.blockedReasons?.some((reason) => reason.includes("advisoryLockKey"))).toBe(true);

    const passingGate = path.join(tempDir, "gate-passing.json");
    const effectiveCopyUrl = copyUrl || "postgresql://user:PLAN_ONLY_PASSWORD@127.0.0.1:5432/f16_plan_copy";
    const copyIdentity = new URL(effectiveCopyUrl);
    const copyDisplay = `postgresql://${copyIdentity.hostname}:${copyIdentity.port || "5432"}/${decodeURIComponent(copyIdentity.pathname.replace(/^\/+/, ""))}`;
    await writeFile(passingGate, JSON.stringify({
      ok: true,
      advisoryLockKey: 4011989150,
      advisoryLockAvailable: true,
      foreignConnections: 0,
      maxForeignConnections: 0,
      copy: copyDisplay,
    }));
    const passing = runCli(["switch-plan", "--gate", passingGate], {
      MEDIA_TRACK_MIGRATION_OLD_WRITERS_STOPPED: "1",
      MEDIA_TRACK_MIGRATION_GATE_OK: "1",
      MEDIA_TRACK_MIGRATION_BACKUP_OK: "1",
    });
    expect(passing.status).toBe(0);
    expect((passing.json as unknown as PlanJson).ready).toBe(true);
  });

  it("rejects invalid inventory roles and a policy that changes the dedicated gate key", async () => {
    const invalidRole = runCli(["inventory", "--role", "production"]);
    expect(invalidRole.status).toBe(2);
    expect(JSON.stringify(invalidRole.json)).toContain("CLI_OPTION_INVALID");

    const rawPolicy: unknown = JSON.parse(await readFile(policyPath, "utf8"));
    if (typeof rawPolicy !== "object" || rawPolicy === null) throw new Error("policy must be an object");
    const policyRecord = rawPolicy as Record<string, unknown>;
    const rawGate = policyRecord.gate;
    if (typeof rawGate !== "object" || rawGate === null) throw new Error("policy gate must be an object");
    const gateRecord = rawGate as Record<string, unknown>;
    gateRecord.advisoryLockKey = 4011989147;
    const conflictingPolicy = path.join(tempDir, "conflicting-policy.json");
    await writeFile(conflictingPolicy, JSON.stringify(policyRecord));

    const rejected = runCli(["switch-plan"], {
      MEDIA_TRACK_MIGRATION_POLICY: conflictingPolicy,
    });
    expect(rejected.status).toBe(2);
    expect(JSON.stringify(rejected.json)).toContain("GATE_ADVISORY_KEY_INVALID");
  });

  it("requires stopping new workers before rollback", () => {
    const blocked = runCli(["rollback-plan"]);
    expect(blocked.status).toBe(0);
    const plan = blocked.json as unknown as PlanJson;
    expect(plan.executes).toBe(false);
    expect(plan.ready).toBe(false);
    expect(plan.steps[0]?.id).toBe("stop-new-workers");
    expect(plan.steps[0]?.detail).toContain("worker");

    const ready = runCli(["rollback-plan"], { MEDIA_TRACK_MIGRATION_NEW_WRITERS_STOPPED: "1" });
    expect((ready.json as unknown as PlanJson).ready).toBe(true);
  });

  it("forces fake adapters, disabled workers and no netdisk credentials for rehearsal", async () => {
    const rehearsalEnv = {
      PAN115_COOKIE: COOKIE_SECRET,
      AGENT_MODEL_API_KEY: AGENT_SECRET,
      MEDIA_TRACK_WORKER_SECRET: WORKER_SECRET,
      MEDIA_TRACK_STORAGE_ADAPTER: "115",
      MEDIA_TRACK_AGENT_ADAPTER: "vercel-ai",
      MEDIA_TRACK_WORKFLOW_ADAPTER: "pansou",
    };
    const plan = runCli(["rehearsal"], rehearsalEnv);
    expect(plan.status).toBe(0);
    const forced = plan.json.forcedEnv as Record<string, string>;
    expect(forced.MEDIA_TRACK_REHEARSAL).toBe("1");
    expect(forced.MEDIA_TRACK_INPROCESS_WORKER).toBe("0");
    expect(forced.MEDIA_TRACK_STORAGE_ADAPTER).toBe("fake");
    expect(forced.MEDIA_TRACK_AGENT_ADAPTER).toBe("fake");
    expect(forced.MEDIA_TRACK_WORKFLOW_ADAPTER).toBe("fake");
    expect(forced.MEDIA_TRACK_DISTRIBUTION).toBe("fork-image");
    expect(forced.MEDIA_TRACK_POSTGRES_URL).toContain("<copy:");
    expect((plan.json.blockedEnv as string[]).includes("PAN115_COOKIE")).toBe(true);
    expectNoSecrets(plan.stdout);

    const envFile = path.join(tempDir, "rehearsal.env");
    const written = runCli(["rehearsal", "--write-env", envFile], rehearsalEnv);
    expect(written.status).toBe(0);
    const content = await readFile(envFile, "utf8");
    expect(content).toContain("MEDIA_TRACK_REHEARSAL=1");
    expect(content).toContain("MEDIA_TRACK_INPROCESS_WORKER=0");
    expect(content).toContain("MEDIA_TRACK_STORAGE_ADAPTER=fake");
    expect(content).not.toContain(COOKIE_SECRET);
    expect(content).not.toContain(AGENT_SECRET);
    expect(content).not.toContain(WORKER_SECRET);

    const childOut = path.join(tempDir, "child-env.json");
    const executed = runCli(
      [
        "rehearsal",
        "--execute",
        "--",
        "node",
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({rehearsal:process.env.MEDIA_TRACK_REHEARSAL,worker:process.env.MEDIA_TRACK_INPROCESS_WORKER,storage:process.env.MEDIA_TRACK_STORAGE_ADAPTER,agent:process.env.MEDIA_TRACK_AGENT_ADAPTER,workflow:process.env.MEDIA_TRACK_WORKFLOW_ADAPTER,cookie:process.env.PAN115_COOKIE??null}))",
        childOut,
      ],
      rehearsalEnv,
    );
    expect(executed.status).toBe(0);
    const childEnv = JSON.parse(await readFile(childOut, "utf8")) as Record<string, unknown>;
    expect(childEnv.rehearsal).toBe("1");
    expect(childEnv.worker).toBe("0");
    expect(childEnv.storage).toBe("fake");
    expect(childEnv.agent).toBe("fake");
    expect(childEnv.workflow).toBe("fake");
    expect(childEnv.cookie).toBeNull();
  });
});

async function seedFixture(database: pg.Pool, accountId: string, storageId: string): Promise<void> {
  await database.query(
    "INSERT INTO accounts (id, username, password_hash, is_owner, created_at) VALUES ($1, $2, $3, false, now()::text)",
    [accountId, `user_${randomUUID()}`, "password_hash_f16"],
  );
  await database.query(
    `INSERT INTO connected_storages
       (id, account_id, provider, provider_uid, label, payload, root_cid, created_at)
     VALUES ($1, $2, 'guangya', $3, 'F16 光鸭', $4::jsonb, 'gy_root_f16', now()::text)`,
    [storageId, accountId, "gy_uid_f16", JSON.stringify({ accessToken: PROVIDER_SECRET, did: "gy_did_f16" })],
  );
  await database.query("INSERT INTO app_settings (key, value) VALUES ('f16_fixture', $1)", [SETTING_SECRET]);
  await database.query(
    "INSERT INTO account_settings (account_id, key, value) VALUES ($1, 'f16_fixture', $2)",
    [accountId, ACCOUNT_SETTING_SECRET],
  );

  const base = workflowPersistenceFixture();
  const repository = new PostgresWorkflowRepository(database);
  await repository.saveWorkflowRunSnapshot({
    ...base,
    accountId,
    connectedStorageId: storageId,
  });
  await database.query(
    `INSERT INTO episode_copies
       (tracked_season_id, episode_code, storage_id, file_ids, size_bytes, quality, run_id, recorded_at)
     VALUES ($1, 'S01E01', $2, $3::jsonb, 123456, '4K', $4, now()::text)`,
    [base.season.id, storageId, JSON.stringify(["gy_file_f16"]), base.workflowRun.id],
  );
}
