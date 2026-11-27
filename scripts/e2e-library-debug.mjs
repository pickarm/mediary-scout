import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { chromium } from "playwright";
import { hashPassword } from "../packages/workflow/dist/auth/password.js";
import { getStorageBrand } from "../packages/workflow/dist/storage-brands.js";
import { initializeWorkflowPostgresSchema } from "../packages/workflow/dist/postgres.js";
import { createFileBackedFakeStorageExecutor } from "../packages/workflow/dist/fakes.js";
import {
  buildOrganizationPlan,
  computeNamingTemplatesFingerprint,
  createStorageOrganizationStorage,
  DEFAULT_NAMING_TEMPLATES,
  LibraryOrganizer,
  LibraryScanner,
  PostgresAutoOrganizationStore,
  PostgresIdentificationStore,
  PostgresLibraryStore,
  PostgresOrganizationStore,
  PostgresOrganizedIndexStore,
  PostgresScanStore,
  createStorageDirectoryReader,
} from "../packages/workflow/dist/library/index.js";

const execFileAsync = promisify(execFile);
const PG_CONTAINER = "mediary_e2e_pg";
const PG_PORT = 55439;
const WEB_PORT = 3911;
const BASE_URL = `http://127.0.0.1:${WEB_PORT}`;
const ACCOUNT_ID = "acct_default";
const STORAGE_ID = "cs_e2e_quark";
const USERNAME = "e2e_admin";
const PASSWORD = "E2eTestPass2026!";

function assert(condition, message) {
  if (!condition) throw new Error(`端到端断言失败: ${message}`);
}

async function waitFor(fn, { timeoutMs = 45_000, intervalMs = 500, label = "条件" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）${lastError instanceof Error ? `: ${lastError.message}` : ""}`);
}

function readFakeState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeFakeState(statePath, state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function killProcessTree(pid) {
  if (!pid) return Promise.resolve();
  if (process.platform === "win32") {
    return execFileAsync("taskkill", ["/pid", String(pid), "/t", "/f"]).catch(() => undefined);
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 忽略已退出进程
    }
  }
  return Promise.resolve();
}

async function runCmd(cmd, args) {
  return execFileAsync(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
}

async function main() {
  const workDir = mkdtempSync(path.join(tmpdir(), "mediary-e2e-"));
  const statePath = path.join(workDir, "fake-drive.json");
  const dbName = `mediary_e2e_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const adminUrl = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
  const appDbUrl = `postgres://postgres:postgres@127.0.0.1:${PG_PORT}/${dbName}`;

  let adminPool = null;
  let pool = null;
  let webProcess = null;
  let browser = null;

  try {
    console.log("[E2E] 1/6 启动本机 WSL PostgreSQL 18.6 临时容器...");
    await runCmd("wsl", [
      "-e",
      "bash",
      "-lc",
      `docker rm -f ${PG_CONTAINER} 2>/dev/null || true; docker run -d --rm --name ${PG_CONTAINER} -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres -p ${PG_PORT}:5432 postgres:18.6-alpine`,
    ]);

    adminPool = new pg.Pool({ connectionString: adminUrl });
    adminPool.on("error", () => {});
    await waitFor(
      async () => {
        await adminPool.query("SELECT 1");
        return true;
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "PostgreSQL 18.6 容器就绪" },
    );

    await adminPool.query(`CREATE DATABASE ${dbName}`);
    pool = new pg.Pool({ connectionString: appDbUrl });
    pool.on("error", () => {});

    console.log("[E2E] 2/6 初始化数据库架构与演练测试盘夹具...");
    await initializeWorkflowPostgresSchema(pool);
    const scanStore = new PostgresScanStore(pool);
    const libraryStore = new PostgresLibraryStore(pool);
    const idStore = new PostgresIdentificationStore(pool);
    const orgStore = new PostgresOrganizationStore(pool);
    const indexStore = new PostgresOrganizedIndexStore(pool);
    const autoStore = new PostgresAutoOrganizationStore(pool);
    await Promise.all([
      scanStore.ensureSchema(),
      libraryStore.ensureSchema(),
      idStore.ensureSchema(),
      orgStore.ensureSchema(),
      indexStore.ensureSchema(),
      autoStore.ensureSchema(),
    ]);

    const nowIso = new Date().toISOString();
    const passwordHash = await hashPassword(PASSWORD);
    await pool.query(
      `INSERT INTO accounts (id, username, password_hash, is_owner, created_at)
       VALUES ($1, $2, $3, true, $4)
       ON CONFLICT (id) DO UPDATE SET username=EXCLUDED.username, password_hash=EXCLUDED.password_hash, is_owner=true`,
      [ACCOUNT_ID, USERNAME, passwordHash, nowIso],
    );

    const provider = getStorageBrand("quark").provider;
    await pool.query(
      `INSERT INTO connected_storages (id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, status, created_at)
       VALUES ($1, $2, $3, 'e2e-uid', '演练测试盘', '{}'::jsonb, 'dir-root', 'dir-movies', 'dir-tv', 'active', $4)`,
      [STORAGE_ID, ACCOUNT_ID, provider, nowIso],
    );

    const initialItems = [
      { fileId: "dir-movies", parentId: "dir-root", name: "电影", isDirectory: true, sizeBytes: null },
      { fileId: "dir-tv", parentId: "dir-root", name: "剧集", isDirectory: true, sizeBytes: null },
      { fileId: "dir-dune", parentId: "dir-movies", name: "沙丘 (2021) [tmdbid=438631]", isDirectory: true, sizeBytes: null },
      { fileId: "file-dune", parentId: "dir-dune", name: "沙丘 (2021) - 2160p.DV.mkv", isDirectory: false, sizeBytes: 4096 },
      { fileId: "dir-batch", parentId: "dir-movies", name: "待整理批次", isDirectory: true, sizeBytes: null },
    ];
    for (let i = 1; i <= 6; i += 1) {
      initialItems.push({
        fileId: `file-batch-${i}`,
        parentId: "dir-batch",
        name: `BatchFilm${i}.mkv`,
        isDirectory: false,
        sizeBytes: 2048,
      });
    }
    writeFakeState(statePath, { items: initialItems });

    const scope = { accountId: ACCOUNT_ID, connectedStorageId: STORAGE_ID };
    const duneIdentity = {
      mediaTitleId: "tmdb_movie_438631",
      trackedSeasonId: "tmdb_movie_438631_movie",
      mediaType: "movie",
      title: "沙丘",
      originalTitle: "Dune",
      year: 2021,
      tmdbId: 438631,
      season: 1,
      edition: "4K",
    };
    await libraryStore.importExistingMedia({
      accountId: ACCOUNT_ID,
      connectedStorageId: STORAGE_ID,
      title: {
        id: duneIdentity.mediaTitleId,
        tmdbId: duneIdentity.tmdbId,
        type: "movie",
        title: duneIdentity.title,
        originalTitle: duneIdentity.originalTitle,
        year: duneIdentity.year,
        aliases: [],
      },
      season: {
        id: duneIdentity.trackedSeasonId,
        mediaTitleId: duneIdentity.mediaTitleId,
        seasonNumber: 1,
        status: "active",
        qualityPreference: "",
        storageDirectoryId: "dir-dune",
        totalEpisodes: 1,
        latestAiredEpisode: 1,
        latestAiredSource: "unknown",
      },
      episodes: [],
      files: [{ fileId: "file-dune", parentDirectoryId: "dir-dune", episodeCode: "S01E01" }],
      directories: [
        { directoryId: "dir-movies", parentDirectoryId: null },
        { directoryId: "dir-dune", parentDirectoryId: "dir-movies" },
      ],
      now: nowIso,
    });
    const templateFingerprint = computeNamingTemplatesFingerprint(DEFAULT_NAMING_TEMPLATES);
    await indexStore.upsertOrganized({
      scope,
      fileId: "file-dune",
      parentDirectoryId: "dir-dune",
      targetRootId: "dir-movies",
      organizedName: "沙丘 (2021) - 2160p.DV.mkv",
      organizedRelativePath: "沙丘 (2021) [tmdbid=438631]/沙丘 (2021) - 2160p.DV.mkv",
      templateFingerprint,
      source: "organization",
      identity: duneIdentity,
      now: nowIso,
    });

    console.log("[E2E] 3/6 启动本地真实 Next.js 生产服务 (http://127.0.0.1:3911)...");
    const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    webProcess = spawn(process.execPath, [nextCli, "start", "apps/web", "-H", "127.0.0.1", "-p", String(WEB_PORT)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        MEDIA_TRACK_POSTGRES_URL: appDbUrl,
        MEDIA_TRACK_STORAGE_ADAPTER: "fake",
        MEDIA_TRACK_FAKE_STORAGE_STATE_PATH: statePath,
        MEDIA_TRACK_INPROCESS_WORKER: "1",
        MEDIA_TRACK_MULTI_USER: "1",
        MEDIA_TRACK_SESSION_SECRET: "e2e-local-debug-secret-key-2026",
        MEDIA_TRACK_LIBRARY_ORGANIZATION_WORKER_POLL_MS: "800",
        MEDIA_TRACK_LIBRARY_SCAN_WORKER_POLL_MS: "2000",
        MEDIA_TRACK_LIBRARY_AUTO_ORG_WORKER_POLL_MS: "2000",
        REDIS_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const serverLogs = [];
    webProcess.stdout?.on("data", (chunk) => serverLogs.push(String(chunk)));
    webProcess.stderr?.on("data", (chunk) => serverLogs.push(String(chunk)));

    await waitFor(
      async () => {
        const res = await fetch(`${BASE_URL}/api/health`);
        return res.ok;
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "Next.js Web 服务健康探针" },
    );

    console.log("[E2E] 4/6 启动 Playwright 无头浏览器执行全按钮交互测试...");
    browser = await chromium.launch({
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);

    const consoleErrors = [];
    const pageErrors = [];
    const serverErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("response", (res) => {
      if (res.status() >= 400) serverErrors.push(`${res.status()} ${res.url()}`);
    });

    // 场景 1：真实登录并进入 /library/manage
    await page.goto(`${BASE_URL}/library/manage`);
    await page.waitForURL(/\/login/u);
    await page.fill("#auth-username", USERNAME);
    await page.fill("#auth-password", PASSWORD);
    await page.click("button[type='submit'].auth-submit");
    await page.waitForURL(/\/library\/manage/u);
    await page.waitForSelector(`[data-testid="storage-pill-${STORAGE_ID}"]`);
    await waitFor(
      async () => !(await page.textContent("body"))?.includes("正在读取网盘设置"),
      { label: "首屏网盘配置读取完成" },
    );

    // 场景 2：开启每日定时扫描 + 设置时间与并发 + 切换预设模板并保存，刷新核验持久化
    await page.click('[data-testid="toggle-daily-schedule"]');
    await page.fill('[data-testid="input-daily-schedule-time"]', "04:30");
    await page.selectOption('[data-testid="select-organize-concurrency"]', "5");
    await page.selectOption('[data-testid="select-template-preset"]', "emby-compact");
    await page.selectOption('[data-testid="select-template-preset"]', "perfect");
    await page.click('[data-testid="btn-save-settings"]');
    await waitFor(
      async () => (await page.textContent("body"))?.includes("设置已保存，新片入库与后续整理将立即采用当前规则与并发数"),
      { label: "保存设置成功提示" },
    );
    await page.reload();
    await page.waitForSelector('[data-testid="toggle-daily-schedule"]');
    await waitFor(
      async () => await page.isChecked('[data-testid="toggle-daily-schedule"]'),
      { label: "刷新后每日定时扫描开关恢复勾选" },
    );
    assert((await page.inputValue('[data-testid="input-daily-schedule-time"]')) === "04:30", "刷新后扫描时间应为 04:30");
    assert((await page.inputValue('[data-testid="select-organize-concurrency"]')) === "5", "刷新后并发数应为 5");

    const cfgRows = await scanStore.listConfigurations(scope, 5);
    const activeConfig = cfgRows[0];
    assert(Boolean(activeConfig), "数据库应已持久化扫描配置");
    assert(activeConfig.dailyScheduleEnabled === true && activeConfig.dailyScheduleTime === "04:30", "数据库应保存每日定时扫描配置");

    // 场景 3：验证「停止整理」按钮
    await scanStore.createTask({
      taskId: "scan-stop-test",
      scope,
      configuration: activeConfig,
      roots: activeConfig.sourceRoots,
      now: new Date().toISOString(),
    });
    await page.click('[data-testid="btn-refresh-history"]');
    await page.waitForSelector('[data-testid="btn-stop-organize-top"]');
    await page.waitForSelector('[data-testid="btn-stop-organize-history"]');
    await page.click('[data-testid="btn-stop-organize-history"]');
    await waitFor(
      async () => (await page.textContent("body"))?.includes("已停止当前网盘的扫描与整理任务"),
      { label: "停止整理提示文案" },
    );
    const stoppedTask = await scanStore.getTask(scope, "scan-stop-test");
    assert(stoppedTask?.status === "cancelled", "点击停止后数据库扫描任务应转为 cancelled，并解除配置修改锁定");
    assert((await page.locator('[data-testid="btn-stop-organize-top"]').count()) === 0, "停止后顶部停止按钮应消失");

    // 场景 4：触发连续 5 次失败熔断横幅 + 点击「重试失败项」完成全量整理
    const batchScanId = "scan-breaker-batch";
    await scanStore.createTask({
      taskId: batchScanId,
      scope,
      configuration: activeConfig,
      roots: activeConfig.sourceRoots,
      now: new Date().toISOString(),
    });
    const fakeScannerExecutor = createFileBackedFakeStorageExecutor(statePath);
    const scanDriver = new LibraryScanner({ store: scanStore, reader: createStorageDirectoryReader(fakeScannerExecutor), concurrency: 3 });
    await scanDriver.resume(scope, batchScanId);
    await scanDriver.waitForIdle(scope, batchScanId);

    for (let i = 1; i <= 6; i += 1) {
      const fileId = `file-batch-${i}`;
      const movieTitleId = `tmdb_movie_${8800 + i}`;
      await libraryStore.importExistingMedia({
        accountId: ACCOUNT_ID,
        connectedStorageId: STORAGE_ID,
        title: {
          id: movieTitleId,
          tmdbId: 8800 + i,
          type: "movie",
          title: `演练电影${i}`,
          originalTitle: `BatchFilm${i}`,
          year: 2025,
          aliases: [],
        },
        season: {
          id: `${movieTitleId}_movie`,
          mediaTitleId: movieTitleId,
          seasonNumber: 1,
          status: "active",
          qualityPreference: "",
          storageDirectoryId: "dir-batch",
          totalEpisodes: 1,
          latestAiredEpisode: 1,
          latestAiredSource: "unknown",
        },
        episodes: [],
        files: [{ fileId, parentDirectoryId: "dir-batch", episodeCode: "S01E01" }],
        directories: [
          { directoryId: "dir-movies", parentDirectoryId: null },
          { directoryId: "dir-batch", parentDirectoryId: "dir-movies" },
        ],
        now: new Date().toISOString(),
      });
    }

    // 设置整理并发为 1 并注入 10 次写入失败，触发连续 5 次熔断
    const breakerConfig = { ...activeConfig, organizeConcurrency: 1 };
    await scanStore.saveConfiguration(breakerConfig);
    const planInput = await orgStore.derivePlanInput(scope, batchScanId, {
      fileIds: Array.from({ length: 6 }, (_, idx) => `file-batch-${idx + 1}`),
      limit: 10,
      operationKey: "e2e-breaker-plan",
    });
    const orgStorage = createStorageOrganizationStorage(fakeScannerExecutor);
    const organizer = new LibraryOrganizer({ store: orgStore, storage: orgStorage });
    await organizer.plan({ ...planInput, operationKey: "e2e-breaker-plan" });
    await orgStore.requestExecution(scope, batchScanId, "e2e-breaker-plan", new Date().toISOString());

    const stFault = readFakeState(statePath);
    stFault.failWritesRemaining = 10;
    stFault.failErrorMessage = "模拟网盘写入限流 429";
    writeFakeState(statePath, stFault);

    await organizer.execute(scope, batchScanId, "e2e-breaker-plan", { concurrency: 1, maxConsecutiveFailures: 5 });

    await page.click('[data-testid="btn-refresh-history"]');
    await page.waitForSelector('[data-testid="halt-banner"]');
    const haltText = await page.textContent('[data-testid="halt-banner"]');
    assert(haltText?.includes("连续失败过多，已自动停止整理") && haltText.includes("连续失败 5 项"), "应展示熔断告警与失败项计数");

    // 恢复假盘并点击「重试失败项」按钮，由进程内 Worker 实际完成重命名归档
    const stClear = readFakeState(statePath);
    stClear.failWritesRemaining = 0;
    writeFakeState(statePath, stClear);
    await page.click('[data-testid="btn-retry-failed"]');

    await waitFor(
      async () => {
        const plan = await orgStore.get(scope, batchScanId, "e2e-breaker-plan");
        return plan?.status === "completed";
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "后台 Worker 重试完成 6 项整理" },
    );
    await page.click('[data-testid="btn-refresh-history"]');
    await waitFor(
      async () => (await page.locator('[data-testid="halt-banner"]').count()) === 0,
      { label: "重试成功后熔断横幅自动消失" },
    );
    const stAfterBatch = readFakeState(statePath);
    for (let i = 1; i <= 6; i += 1) {
      const f = stAfterBatch.items.find((item) => item.fileId === `file-batch-${i}`);
      assert(f?.name === `演练电影${i} (2025).mkv`, `文件 file-batch-${i} 应已被真实改名为规范名称，实际为 ${f?.name}`);
    }

    // 场景 5：文件名篡改检测 + 忽略快照 + 二次改名再提醒 + 按模板重新整理恢复
    const stTamper1 = readFakeState(statePath);
    const duneItem1 = stTamper1.items.find((item) => item.fileId === "file-dune");
    duneItem1.name = "沙丘_手动乱改.mkv";
    writeFakeState(statePath, stTamper1);

    const runIndexReconcileScan = async (scanId) => {
      const latestCfg = (await scanStore.listConfigurations(scope, 1))[0] ?? breakerConfig;
      await scanStore.createTask({
        taskId: scanId,
        scope,
        configuration: latestCfg,
        roots: latestCfg.sourceRoots,
        now: new Date().toISOString(),
      });
      await scanDriver.resume(scope, scanId);
      await scanDriver.waitForIdle(scope, scanId);
      return indexStore.reconcileScanTask({ scope, taskId: scanId, now: new Date().toISOString() });
    };

    const rec1 = await runIndexReconcileScan("scan-drift-1");
    assert(rec1.drifted === 1, `首次改名应检出 1 条变更，实际 drifted=${rec1.drifted}`);
    await page.reload();
    await page.waitForSelector('[data-testid="drift-panel"]');
    assert((await page.textContent('[data-testid="drift-row-file-dune"]'))?.includes("沙丘_手动乱改.mkv"), "应展示篡改后的文件名");

    // 点击「忽略」
    await page.click('[data-testid="btn-ignore-file-dune"]');
    await waitFor(
      async () => (await page.locator('[data-testid="drift-row-file-dune"]').count()) === 0,
      { label: "点击忽略后待处理行消失" },
    );
    await page.click('[data-testid="drift-tab-ignored"]');
    await page.waitForSelector('[data-testid="drift-row-file-dune"]');

    // 再次扫库应保持忽略、不会再提醒
    const rec2 = await runIndexReconcileScan("scan-drift-2");
    assert(rec2.ignored === 1 && rec2.drifted === 0, "忽略快照生效期间再次扫库不应重复报警");

    // 改为第三个文件名再扫库 -> 应重新提示
    const stTamper2 = readFakeState(statePath);
    stTamper2.items.find((item) => item.fileId === "file-dune").name = "沙丘_又改了.mkv";
    writeFakeState(statePath, stTamper2);
    const rec3 = await runIndexReconcileScan("scan-drift-3");
    assert(rec3.drifted === 1, "文件被改成新名称后应打破忽略并再次提示");

    await page.click('[data-testid="btn-refresh-history"]');
    await page.reload();
    await page.waitForSelector('[data-testid="btn-reorganize-file-dune"]');
    const [reorgResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes("/api/library/organized-index") && res.request().method() === "POST"),
      page.click('[data-testid="btn-reorganize-file-dune"]'),
    ]);
    const reorgBody = await reorgResponse.text();
    console.log(`[E2E] reorganize 响应: status=${reorgResponse.status()} body=${reorgBody}`);

    await waitFor(
      async () => {
        const st = readFakeState(statePath);
        return st.items.find((item) => item.fileId === "file-dune")?.name === "沙丘 (2021) - 2160p.DV.mkv";
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "点击按模板重新整理并无损恢复 2160p.DV 文件名" },
    );

    // 场景 6：状态筛选与实时刷新切换按钮
    await page.click('[data-testid="history-filter-verified"]');
    await page.click('[data-testid="history-filter-failed"]');
    await page.click('[data-testid="history-filter-all"]');
    await page.click('[data-testid="btn-toggle-live-refresh"]');
    await page.click('[data-testid="btn-toggle-live-refresh"]');

    assert(consoleErrors.length === 0, `浏览器存在控制台报错: ${consoleErrors.join(" | ")}`);
    assert(pageErrors.length === 0, `浏览器存在未捕获异常: ${pageErrors.join(" | ")}`);
    assert(serverErrors.length === 0, `服务端出现 5xx 响应: ${serverErrors.join(" | ")}`);

    console.log("[E2E] 5/6 全部 6 大交互场景、无头按钮与真库状态断言通过！");
  } catch (error) {
    if (pool) {
      const safeQuery = async (sql) => {
        try {
          return await pool.query(sql);
        } catch (err) {
          console.error(`[E2E-DEBUG] SQL error (${sql}):`, err instanceof Error ? err.message : String(err));
          return { rows: [] };
        }
      };
      const idx = await safeQuery("SELECT * FROM library_organized_index");
      const plans = await safeQuery("SELECT * FROM library_organization_plans ORDER BY updated_at DESC LIMIT 5");
      const ops = await safeQuery("SELECT * FROM library_organization_operations ORDER BY updated_at DESC LIMIT 8");
      console.error("[E2E-DEBUG] index=", JSON.stringify(idx.rows));
      console.error("[E2E-DEBUG] plans=", JSON.stringify(plans.rows));
      console.error("[E2E-DEBUG] ops=", JSON.stringify(ops.rows));
    }
    try {
      const driftText = await page?.locator('[data-testid="drift-panel"]').innerText().catch(() => "");
      console.error("[E2E-DEBUG] driftPanel=", JSON.stringify(driftText));
    } catch { /* ignore */ }
    try {
      console.error("[E2E-DEBUG] fakeFile=", JSON.stringify(readFileSync(statePath, "utf8")));
    } catch { /* ignore */ }
    throw error;
  } finally {
    console.log("[E2E] 6/6 清理临时进程、假盘文件与 WSL Docker 容器...");
    await browser?.close().catch(() => undefined);
    await killProcessTree(webProcess?.pid);
    await pool?.end().catch(() => undefined);
    await adminPool?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await adminPool?.end().catch(() => undefined);
    await runCmd("wsl", ["-e", "bash", "-lc", `docker rm -f ${PG_CONTAINER} 2>/dev/null || true`]).catch(() => undefined);
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
