#!/usr/bin/env node
// @ts-check
/**
 * 巡影 Fork F16：迁移演练、预检、指纹核验与切换/回退计划。
 *
 * 常用：
 *   MEDIA_TRACK_MIGRATION_SOURCE_URL=... MEDIA_TRACK_MIGRATION_COPY_URL=... \
 *     node scripts/fork-migration.mjs inventory --out /tmp/source-manifest.json
 *   ... node scripts/fork-migration.mjs preflight --manifest /tmp/source-manifest.json
 *   ... MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE=1 node scripts/fork-migration.mjs schema-init
 *   ... node scripts/fork-migration.mjs verify --manifest /tmp/source-manifest.json
 *   ... node scripts/fork-migration.mjs rehearsal
 *   ... node scripts/fork-migration.mjs backup-plan
 *   ... node scripts/fork-migration.mjs restore-plan
 *   ... node scripts/fork-migration.mjs switch-plan
 *   ... node scripts/fork-migration.mjs rollback-plan
 *
 * 不执行真实迁移/切换；备份、恢复与切换只输出命令计划。计划中的
 * $MEDIA_TRACK_MIGRATION_* / $MEDIA_TRACK_RESTORE_TARGET_URL 为运行时环境变量，
 * 不会展开或打印凭证。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  MigrationInputError,
  assertIsolatedTarget,
  assertWritableTempPath,
  buildBackupPlan,
  buildManifest,
  buildRestorePlan,
  buildRollbackPlan,
  buildSwitchPlan,
  compareManifest,
  describeRehearsal,
  initializeNativeSchema,
  isRecord,
  loadMigrationPolicy,
  openPgPool,
  openReadOnlyClient,
  parsePostgresIdentity,
  readManifestFile,
  resolveMigrationIdentities,
  runWriterGate,
  sameDatabaseIdentity,
  safeError,
  writeSecureFile,
} from "./fork-migration-lib.mjs";

/**
 * @typedef {{out?: string, manifest?: string, role?: string, gate?: string, execute?: boolean, writeEnv?: string}} CliOptions
 */

/**
 * @param {string[]} argv
 * @returns {{command: string, options: CliOptions, commandArgs: string[]}}
 */
function parseCli(argv) {
  const separator = argv.indexOf("--");
  const optionArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const commandArgs = separator >= 0 ? argv.slice(separator + 1) : [];
  const command = optionArgs[0] ?? "help";
  /** @type {CliOptions} */
  const options = {};
  for (let index = 1; index < optionArgs.length; index += 1) {
    const flag = optionArgs[index];
    if (flag === "--execute") {
      options.execute = true;
      continue;
    }
    const next = optionArgs[index + 1];
    if (flag === "--out" || flag === "--manifest" || flag === "--role" || flag === "--gate" || flag === "--write-env") {
      if (!next) throw new MigrationInputError(`${flag} 缺少值`, "CLI_OPTION_MISSING");
      if (flag === "--out") options.out = next;
      if (flag === "--manifest") options.manifest = next;
      if (flag === "--role") options.role = next;
      if (flag === "--gate") options.gate = next;
      if (flag === "--write-env") options.writeEnv = next;
      index += 1;
      continue;
    }
    throw new MigrationInputError(`未知参数：${flag}`, "CLI_OPTION_UNKNOWN");
  }
  return { command, options, commandArgs };
}

/**
 * @param {unknown} value
 */
function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} role
 * @param {import("./fork-migration-lib.mjs").DatabaseIdentity} identity
 * @param {import("./fork-migration-lib.mjs").MigrationManifest} manifest
 */
function manifestSummary(role, identity, manifest) {
  return {
    ok: true,
    command: "inventory",
    role,
    identity: identity.display,
    generatedAt: manifest.generatedAt,
    schemaName: manifest.schemaName,
    schemaTableCount: Object.keys(manifest.schema.tables).length,
    tables: manifest.tables,
    groups: manifest.groups,
    warnings: manifest.warnings,
  };
}

/**
 * @param {CliOptions} options
 */
async function commandInventory(options) {
  const policy = await loadMigrationPolicy();
  const role = options.role ?? "copy";
  if (role !== "source" && role !== "copy") {
    throw new MigrationInputError("inventory --role 只能是 source 或 copy", "CLI_OPTION_INVALID");
  }
  if (role === "source" && process.env.MEDIA_TRACK_MIGRATION_ALLOW_SOURCE_READ !== "1") {
    throw new MigrationInputError(
      "读取源库清单需要显式设置 MEDIA_TRACK_MIGRATION_ALLOW_SOURCE_READ=1；预检本身不会连接源库",
      "SOURCE_READ_NOT_ALLOWED",
    );
  }
  const env = process.env;
  const identity = role === "source"
    ? parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_SOURCE_URL, "MEDIA_TRACK_MIGRATION_SOURCE_URL")
    : parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_COPY_URL, "MEDIA_TRACK_MIGRATION_COPY_URL");
  if (role === "source" && env.MEDIA_TRACK_MIGRATION_COPY_URL) {
    const copy = parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_COPY_URL, "MEDIA_TRACK_MIGRATION_COPY_URL");
    if (sameDatabaseIdentity(copy, identity)) {
      throw new MigrationInputError("源与副本指向同一数据库", "SOURCE_COPY_SAME_DATABASE");
    }
  }
  if (role === "copy") {
    const copy = identity;
    const source = parsePostgresIdentity(env.MEDIA_TRACK_MIGRATION_SOURCE_URL, "MEDIA_TRACK_MIGRATION_SOURCE_URL");
    if (sameDatabaseIdentity(source, copy)) {
      throw new MigrationInputError("源与副本指向同一数据库", "SOURCE_COPY_SAME_DATABASE");
    }
    assertIsolatedTarget(copy, policy, env);
  }
  const connectionString = role === "source"
    ? env.MEDIA_TRACK_MIGRATION_SOURCE_URL
    : env.MEDIA_TRACK_MIGRATION_COPY_URL;
  if (!connectionString) throw new MigrationInputError("缺少数据库 URL", "DATABASE_URL_MISSING");
  const opened = await openReadOnlyClient(connectionString, `fork-migration-inventory-${role}`);
  /** @type {import("./fork-migration-lib.mjs").MigrationManifest} */
  let manifest;
  try {
    manifest = await buildManifest(opened.client, policy, role, identity);
  } finally {
    await opened.close();
  }
  if (options.out) {
    await assertWritableTempPath(options.out);
    await writeSecureFile(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
    printJson({ ...manifestSummary(role, identity, manifest), out: options.out, manifestWritten: true });
    return 0;
  }
  printJson(manifest);
  return 0;
}

/**
 * @param {"preflight" | "verify"} command
 * @param {CliOptions} options
 */
async function commandPreflight(command, options) {
  if (!options.manifest) throw new MigrationInputError(`${command} 需要 --manifest <离线清单>`, "MANIFEST_REQUIRED");
  const policy = await loadMigrationPolicy();
  const identities = resolveMigrationIdentities(process.env, policy);
  const manifest = await readManifestFile(options.manifest);
  const copyUrl = process.env.MEDIA_TRACK_MIGRATION_COPY_URL;
  if (!copyUrl) throw new MigrationInputError("缺少副本 URL", "DATABASE_URL_MISSING");
  const opened = await openReadOnlyClient(copyUrl, `fork-migration-${command}`);
  /** @type {import("./fork-migration-lib.mjs").MigrationManifest} */
  let actual;
  /** @type {Awaited<ReturnType<typeof compareManifest>>} */
  let comparison;
  try {
    actual = await buildManifest(opened.client, policy, "copy", identities.copy);
    comparison = await compareManifest(manifest, actual, policy, opened.client, {
      requireNative: command === "verify",
    });
  } finally {
    await opened.close();
  }
  const sameDatabase = sameDatabaseIdentity(manifest.identity, actual.identity);
  const checks = [
    {
      id: "identity.sourceCopyDistinct",
      ok: !sameDatabaseIdentity(identities.source, identities.copy),
      severity: "error",
      message: "源与副本不是同一数据库",
    },
    {
      id: "identity.isolatedCopy",
      ok: true,
      severity: "info",
      message: `副本目标 ${identities.copy.display} 已通过本机/隔离测试服务校验`,
    },
    {
      id: "identity.sourceNotConnected",
      ok: true,
      severity: "info",
      message: "预检只打开副本连接，未连接源库；源 URL 仅用于同库比较与备份计划占位",
    },
    ...(sameDatabase
      ? [{
        id: "manifest.origin",
        ok: false,
        severity: "warning",
        message: "离线清单来源与副本相同；该清单可用于重复运行检查，但不能证明源库克隆的一致性",
      }]
      : [{
        id: "manifest.origin",
        ok: true,
        severity: "info",
        message: "离线清单来源与副本不同",
      }]),
    ...comparison.checks,
  ];
  const ok = checks.every((check) => check.ok || check.severity === "warning");
  printJson({
    ok,
    command,
    source: identities.source.display,
    copy: identities.copy.display,
    sourceConnectionOpened: false,
    copyConnectionOpened: true,
    manifestGeneratedAt: manifest.generatedAt,
    manifestOrigin: manifest.identity.display,
    manifestOriginMatchesCopy: sameDatabase,
    rehearsalEnv: policy.rehearsalEnv,
    nativeSchemaReady: !comparison.checks.some((check) => check.id === "native.schema" && !check.ok),
    checks,
    tables: actual.tables,
    groups: actual.groups,
  });
  return ok ? 0 : 1;
}

/**
 * @param {CliOptions} options
 */
async function commandSchemaInit(options) {
  const policy = await loadMigrationPolicy();
  if (process.env.MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE !== "1") {
    throw new MigrationInputError(
      "schema-init 会修改副本数据库；请显式设置 MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE=1",
      "SCHEMA_WRITE_NOT_ALLOWED",
    );
  }
  const copy = parsePostgresIdentity(process.env.MEDIA_TRACK_MIGRATION_COPY_URL, "MEDIA_TRACK_MIGRATION_COPY_URL");
  assertIsolatedTarget(copy, policy, process.env);
  const source = parsePostgresIdentity(process.env.MEDIA_TRACK_MIGRATION_SOURCE_URL, "MEDIA_TRACK_MIGRATION_SOURCE_URL");
  if (sameDatabaseIdentity(source, copy)) {
    throw new MigrationInputError("源与副本指向同一数据库", "SOURCE_COPY_SAME_DATABASE");
  }
  const manifest = options.manifest ? await readManifestFile(options.manifest) : null;
  const connectionString = process.env.MEDIA_TRACK_MIGRATION_COPY_URL;
  if (!connectionString) throw new MigrationInputError("缺少副本 URL", "DATABASE_URL_MISSING");
  const beforePool = await openPgPool(connectionString, "fork-migration-schema-before");
  /** @type {import("./fork-migration-lib.mjs").MigrationManifest} */
  let before;
  const beforeClient = await beforePool.connect();
  try {
    before = await buildManifest(beforeClient, policy, "copy", copy);
  } finally {
    beforeClient.release();
    await beforePool.end();
  }
  await initializeNativeSchema(connectionString);
  const afterPool = await openPgPool(connectionString, "fork-migration-schema-after");
  /** @type {import("./fork-migration-lib.mjs").MigrationManifest} */
  let after;
  /** @type {Awaited<ReturnType<typeof compareManifest>>} */
  let comparison;
  const afterClient = await afterPool.connect();
  try {
    after = await buildManifest(afterClient, policy, "copy", copy);
    comparison = await compareManifest(before, after, policy, afterClient, { requireNative: true });
    if (manifest) {
      const manifestComparison = await compareManifest(manifest, after, policy, afterClient, { requireNative: true });
      comparison = {
        ...comparison,
        ok: comparison.ok && manifestComparison.ok,
        checks: [...comparison.checks, ...manifestComparison.checks.map((check) => ({ ...check, id: `manifest.${check.id}` }))],
        schemaDiff: comparison.schemaDiff,
        tableMismatches: comparison.tableMismatches,
      };
    }
  } finally {
    afterClient.release();
    await afterPool.end();
  }
  printJson({
    ok: comparison.ok,
    command: "schema-init",
    copy: copy.display,
    sourceConnectionOpened: false,
    copyConnectionOpened: true,
    nativeSchemaApplied: true,
    dataUnchanged: comparison.checks
      .filter((check) => check.id.startsWith("data.") || check.id.startsWith("schema.") || check.id.startsWith("native."))
      .every((check) => check.ok || check.severity === "warning"),
    checks: comparison.checks,
    before: before.tables,
    after: after.tables,
    groups: after.groups,
  });
  return comparison.ok ? 0 : 1;
}

async function commandGate() {
  const policy = await loadMigrationPolicy();
  const copy = parsePostgresIdentity(process.env.MEDIA_TRACK_MIGRATION_COPY_URL, "MEDIA_TRACK_MIGRATION_COPY_URL");
  assertIsolatedTarget(copy, policy, process.env);
  const copyUrl = process.env.MEDIA_TRACK_MIGRATION_COPY_URL;
  if (!copyUrl) throw new MigrationInputError("缺少副本 URL", "DATABASE_URL_MISSING");
  const opened = await openReadOnlyClient(copyUrl, "fork-migration-gate");
  let result;
  try {
    result = await runWriterGate(opened.client, policy);
  } finally {
    await opened.close();
  }
  printJson({
    ...result,
    command: "gate",
    copy: copy.display,
    note: "该门禁验证旧应用连接已断开且迁移门禁锁可获得；应用进程本身未集成该锁，切换步骤仍需保证唯一 writer。",
  });
  return result.ok ? 0 : 1;
}

/**
 * @param {Record<string, string>} env
 */
function envFileContent(env) {
  return Object.entries(env)
    .filter(([, value]) => !value.includes("\n") && !value.includes("\r"))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n") + "\n";
}

/**
 * @param {CliOptions} options
 * @param {string[]} commandArgs
 */
async function commandRehearsal(options, commandArgs) {
  const policy = await loadMigrationPolicy();
  const description = describeRehearsal(policy, process.env);
  const env = description.childEnv;
  if (options.writeEnv) {
    await assertWritableTempPath(options.writeEnv);
    await writeSecureFile(options.writeEnv, envFileContent(env));
  }
  if (options.execute) {
    if (commandArgs.length === 0) {
      throw new MigrationInputError("rehearsal --execute 需要在 -- 之后提供命令", "REHEARSAL_COMMAND_MISSING");
    }
    const executable = commandArgs[0];
    if (!executable) throw new MigrationInputError("rehearsal 命令为空", "REHEARSAL_COMMAND_MISSING");
    const child = spawnSync(executable, commandArgs.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: "inherit",
    });
    if (child.error) throw child.error;
    printJson({
      ok: child.status === 0,
      command: "rehearsal",
      executes: true,
      exitCode: child.status,
      copy: description.copy,
      forcedEnv: description.forcedEnv,
      blockedEnv: description.blockedEnv,
      envFile: options.writeEnv ?? null,
    });
    return child.status === 0 ? 0 : 1;
  }
  printJson({
    ok: true,
    command: "rehearsal",
    executes: false,
    copy: description.copy,
    forcedEnv: description.forcedEnv,
    blockedEnv: description.blockedEnv,
    envFile: options.writeEnv ?? null,
    envFileWritten: Boolean(options.writeEnv),
    dockerRun: {
      image: description.image,
      command: [
        "docker",
        "run",
        "--rm",
        "--name",
        "media-track-rehearsal",
        "-p",
        "127.0.0.1:13000:3000",
        "--env-file",
        options.writeEnv ?? "<TEMP_ENV_FILE>",
        description.image,
      ],
    },
    compose: {
      file: description.composeFile,
      command: ["docker", "compose", "-f", description.composeFile, "--project-name", "media-track-rehearsal", "up", "-d", "web"],
      warning: "compose 的 env_file .env 可能含生产凭证；演练应使用独立项目目录或上面的 docker run 临时 env-file。",
    },
    warnings: description.warnings,
  });
  return 0;
}

/**
 * @param {"backup" | "restore" | "switch" | "rollback"} kind
 * @param {CliOptions} options
 */
async function commandPlan(kind, options) {
  const policy = await loadMigrationPolicy();
  let identities = null;
  if (process.env.MEDIA_TRACK_MIGRATION_SOURCE_URL || process.env.MEDIA_TRACK_MIGRATION_COPY_URL) {
    identities = resolveMigrationIdentities(process.env, policy);
  }
  if (kind === "backup") {
    if (!identities) throw new MigrationInputError("backup-plan 需要源与副本 URL 以校验同库和隔离目标", "DATABASE_URL_MISSING");
    printJson({
      ok: true,
      command: "backup-plan",
      executes: false,
      source: identities.source.display,
      copy: identities.copy.display,
      steps: buildBackupPlan(policy),
      notice: "本命令只打印计划，不执行 pg_dump；凭证通过环境变量传入，不得写入 shell 历史或 Git。",
    });
    return 0;
  }
  if (kind === "restore") {
    printJson({
      ok: true,
      command: "restore-plan",
      executes: false,
      steps: buildRestorePlan(policy),
      notice: "pg_restore 具有破坏性；本命令不执行恢复。恢复前必须停止新实例全部 worker。",
    });
    return 0;
  }
  if (kind === "switch") {
    const plan = buildSwitchPlan(policy, process.env);
    let ready = plan.ready;
    const blockedReasons = [...plan.blockedReasons];
    if (options.gate) {
      /** @type {unknown} */
      let gate;
      try {
        gate = JSON.parse(readFileSync(options.gate, "utf8"));
      } catch (error) {
        throw new MigrationInputError(`无法读取 gate 结果：${safeError(error, process.env).message}`, "GATE_RESULT_UNREADABLE");
      }
      if (!isRecord(gate) || typeof gate.ok !== "boolean") {
        throw new MigrationInputError("gate 结果缺少 ok", "GATE_RESULT_INVALID");
      }
      if (gate.advisoryLockKey !== policy.gate.advisoryLockKey) {
        ready = false;
        blockedReasons.push("gate 结果的 advisoryLockKey 与 F16 专用门禁键不一致");
      }
      if (gate.ok !== true) {
        ready = false;
        blockedReasons.push("gate 结果未通过");
      }
      if (gate.advisoryLockAvailable !== true) {
        ready = false;
        blockedReasons.push("gate 结果未证明专用 advisory lock 可获得");
      }
      if (gate.maxForeignConnections !== policy.gate.maxForeignConnections
        || typeof gate.foreignConnections !== "number"
        || !Number.isSafeInteger(gate.foreignConnections)
        || gate.foreignConnections > policy.gate.maxForeignConnections) {
        ready = false;
        blockedReasons.push("gate 结果的旧应用连接计数无效或超过策略上限");
      }
      if (identities && gate.copy !== identities.copy.display) {
        ready = false;
        blockedReasons.push("gate 结果不是针对当前副本数据库");
      }
      const withGate = {
        ...plan,
        ready,
        blockedReasons,
        uniqueWriterGate: { ...plan.uniqueWriterGate, result: gate },
      };
      printJson({
        ok: true,
        command: "switch-plan",
        executes: false,
        source: identities?.source.display ?? null,
        copy: identities?.copy.display ?? null,
        ...withGate,
        notice: "本命令不执行切换。旧实例全部 worker/定时器/updater 停写且唯一 writer 门禁通过后，才允许启动新实例。",
      });
      return 0;
    }
    printJson({
      ok: true,
      command: "switch-plan",
      executes: false,
      source: identities?.source.display ?? null,
      copy: identities?.copy.display ?? null,
      ...plan,
      ready,
      blockedReasons,
      notice: "本命令不执行切换。旧实例全部 worker/定时器/updater 停写且唯一 writer 门禁通过后，才允许启动新实例。",
    });
    return 0;
  }
  const plan = buildRollbackPlan(policy, process.env);
  printJson({
    ok: true,
    command: "rollback-plan",
    executes: false,
    ...plan,
    notice: "回退前先停止新实例全部 worker；本命令不执行恢复。",
  });
  return 0;
}

function printHelp() {
  process.stdout.write(`巡影 Fork F16 迁移演练工具（只读预检 + 可审查计划）

环境变量：
  MEDIA_TRACK_MIGRATION_SOURCE_URL   源库 URL（预检只用于同库比较，不连接）
  MEDIA_TRACK_MIGRATION_COPY_URL     副本 URL（预检/核验唯一打开的库）
  MEDIA_TRACK_MIGRATION_POLICY       可选策略文件路径
  MEDIA_TRACK_MIGRATION_ISOLATED_TEST_DB=1  非本机副本必须配合策略 isolatedHosts
  MEDIA_TRACK_MIGRATION_ALLOW_SOURCE_READ=1 仅 inventory --role source 读取源清单
  MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE=1 schema-init 修改副本所需

命令：
  inventory [--role source|copy] [--out <file>]  生成离线 schema/数据指纹清单
  preflight --manifest <file>                     只读对比副本与清单，不连接源
  verify --manifest <file>                        同 preflight，并要求原生增量 schema 已就绪
  schema-init [--manifest <file>]                 用原生公开初始化入口升级副本
  gate                                            检查副本库外连接与唯一 writer 门禁
  rehearsal [--write-env <file>] [--execute -- cmd...]
                                                  输出/执行强制 fake + worker 关闭的演练环境
  backup-plan                                     输出 pg_dump 计划，不执行
  restore-plan                                    输出 pg_restore 计划，不执行
  switch-plan [--gate <file>]                     输出切换步骤与唯一 writer 条件
  rollback-plan                                   输出回退步骤，先停新 worker

安全：不打印 URL 凭证；输出/临时 env 不允许写入 Git 工作区；演练副本仍含真实
provider 文件 ID，禁止真实网盘写入。
`);
}

async function main() {
  const { command, options, commandArgs } = parseCli(process.argv.slice(2));
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "inventory":
    case "fingerprint":
      return commandInventory(options);
    case "preflight":
      return commandPreflight("preflight", options);
    case "verify":
      return commandPreflight("verify", options);
    case "schema-init":
      return commandSchemaInit(options);
    case "gate":
      return commandGate();
    case "rehearsal":
      return commandRehearsal(options, commandArgs);
    case "backup-plan":
      return commandPlan("backup", options);
    case "restore-plan":
      return commandPlan("restore", options);
    case "switch-plan":
      return commandPlan("switch", options);
    case "rollback-plan":
      return commandPlan("rollback", options);
    default:
      throw new MigrationInputError(`未知命令：${command}`, "CLI_COMMAND_UNKNOWN");
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    const safe = safeError(error, process.env);
    printJson({ ok: false, error: safe });
    process.exitCode = error instanceof MigrationInputError ? 2 : 1;
  });
