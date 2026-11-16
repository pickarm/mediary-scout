import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";

const enabled = process.env.RUN_LIBRARY_SCAN_BROWSER === "1";
const browserDescribe = enabled ? describe : describe.skip;

function task(taskId: string, configId: string) {
  return { taskId, configId, status: "completed", directoriesDone: 1, directoriesDiscovered: 1, filesDiscovered: 2, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" };
}

function identity(fileId: string, name: string, status: "pending" | "confirmed" = "pending") {
  return {
    fileId, status, reason: status === "pending" ? "文件名包含作品名和年份，仍需确认" : "用户已确认身份，TMDB 季集资料已核实",
    evidence: [{ kind: "title", value: name, source: "filename" }],
    candidates: status === "pending" ? [{ tmdbId: 123, mediaType: "movie", title: "候选电影", originalTitle: "Candidate Movie", year: 2020, reason: "标题和年份吻合" }] : [],
    mediaType: status === "confirmed" ? "movie" : null, tmdbId: status === "confirmed" ? 123 : null,
    seasonNumber: null, episodeCodes: [], importStatus: status === "confirmed" ? "imported" : "not_applicable", manual: status === "confirmed", updatedAt: "2026-11-15T00:00:00Z",
    file: { fileId, parentDirectoryId: "dir", name, isDirectory: false, sizeBytes: 1000, path: `/电影/${name}`, modifiedAt: null },
    tracking: { trackedSeasonId: "season-real", autoAcquire: null },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

browserDescribe("library identification results browser", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("confirms a candidate, pages results, saves one grouped season toggle, and drops a late old-scope response", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { AbortController.prototype.abort = function abortIgnoredByTransport() {}; });
    const oldIdentification = deferred<void>();
    let releaseOld: (() => void) | undefined;
    let currentStorage = "";
    let slowStorage = "";
    let confirmedStorage = "";
    let confirmBody: unknown = null;
    let trackingBody: unknown = null;
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const body = request.postData() ? JSON.parse(request.postData() ?? "{}") as { storageId?: string } : {};
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? "";
      const taskId = url.pathname.split("/")[4] ?? "";
      if (!currentStorage && storageId) currentStorage = storageId;
      const configuration = (configId: string) => ({ configId, scope: { accountId: "browser-test", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "root", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} });
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [configuration(`config-${storageId}`), configuration(`task-config-${storageId}`)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") { currentStorage = storageId; return route.fulfill({ json: { items: [task(`task-${storageId}`, `task-config-${storageId}`)], nextCursor: null, hasMore: false } }); }
      if (/\/scans\/[^/]+$/.test(url.pathname) && request.method() === "GET") return route.fulfill({ json: { item: task(taskId, `config-${storageId}`) } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        // Organizer reads its own confirmed-only page; it must not advance the
        // identification view's mocked polling or pagination state.
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        if (storageId === slowStorage || storageId !== currentStorage) {
          releaseOld = () => { void route.fulfill({ json: { summary: null, counts: { total: 1, pending: 1, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [identity("old-file", "OLD_SCOPE_ONLY.mkv")], nextCursor: null, hasMore: false } }).catch(() => undefined); };
          oldIdentification.resolve(); return;
        }
        const cursor = url.searchParams.get("cursor");
        const confirmed = storageId === confirmedStorage && confirmBody !== null;
        const items = cursor ? [identity("second-file", `SECOND_${storageId}.mkv`)] : [identity(`file-${storageId}`, confirmed ? `CONFIRMED_${storageId}.mkv` : `FIRST_${storageId}.mkv`, confirmed ? "confirmed" : "pending")];
        return route.fulfill({ json: { summary: { status: "completed", scanStatus: "completed", afterFileId: null, attempts: 1, lastError: null }, counts: { total: 2, pending: confirmed ? 1 : 2, confirmed: confirmed ? 1 : 0, failed: 0, ignored: 0, imported: confirmed ? 1 : 0 }, items, nextCursor: cursor ? null : `cursor-${storageId}`, hasMore: !cursor } });
      }
      if (url.pathname.includes("/identifications/") && request.method() === "POST") { confirmBody = JSON.parse(request.postData() ?? "{}"); confirmedStorage = storageId; return route.fulfill({ json: { item: {} } }); }
      if (url.pathname.endsWith("/tracking") && request.method() === "POST") { trackingBody = JSON.parse(request.postData() ?? "{}"); return route.fulfill({ json: trackingBody }); }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });

    await page.goto("http://127.0.0.1:4326/library/manage");
    const storage = page.getByRole("combobox", { name: "当前网盘" });
    await storage.waitFor();
    const options = await storage.locator("option").evaluateAll((entries) => entries.map((entry) => (entry as HTMLOptionElement).value).filter(Boolean));
    expect(options.length).toBeGreaterThanOrEqual(2);
    const storageA = options[0] ?? ""; const storageB = options[1] ?? "";
    slowStorage = storageB;
    currentStorage = storageA;
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${storageA}`) }).click();
    await expect.poll(async () => page.getByRole("combobox", { name: "已保存配置" }).inputValue()).toBe(`task-config-${storageA}`);
    await page.getByRole("heading", { name: `FIRST_${storageA}.mkv` }).waitFor();
    await page.getByRole("button", { name: "确认文件身份" }).click();
    await expect.poll(() => confirmBody).toEqual({ storageId: storageA, tmdbId: 123, mediaType: "movie" });
    await page.getByRole("heading", { name: `CONFIRMED_${storageA}.mkv` }).waitFor();
    const checkbox = page.getByRole("checkbox", { name: /沿用原有行为/ });
    await checkbox.click();
    await expect.poll(() => trackingBody).toEqual({ storageId: storageA, trackedSeasonId: "season-real", autoAcquire: true });
    await page.getByRole("button", { name: "加载更多结果" }).click();
    await page.getByRole("heading", { name: `SECOND_${storageA}.mkv` }).waitFor();

    await storage.selectOption(storageB);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${storageB}`) }).click();
    await oldIdentification.promise;
    await storage.selectOption(storageA);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${storageA}`) }).click();
    releaseOld?.();
    await page.waitForTimeout(100);
    expect(await page.getByText("OLD_SCOPE_ONLY.mkv").count()).toBe(0);
    await context.close();
  }, 30_000);

  it("keeps appended pages and their cursor when an active job is polled", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let storageId = "";
    const cursors: string[] = [];
    let firstPageReads = 0;
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const body = request.postData() ? JSON.parse(request.postData() ?? "{}") as { storageId?: string } : {};
      storageId = url.searchParams.get("storageId") ?? body.storageId ?? storageId;
      const taskId = url.pathname.split("/")[4] ?? "";
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [{ configId: `config-${storageId}`, scope: { accountId: "browser-test", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "root", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} }], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [{ ...task(`task-${storageId}`, `config-${storageId}`), status: "running" }], nextCursor: null, hasMore: false } });
      if (/\/scans\/[^/]+$/.test(url.pathname) && request.method() === "GET") return route.fulfill({ json: { item: { ...task(taskId, `config-${storageId}`), status: "running" } } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        const cursor = url.searchParams.get("cursor");
        if (cursor) cursors.push(cursor); else firstPageReads += 1;
        const items = cursor === "cursor-a" ? [identity("tail-one", "TAIL_ONE.mkv")] : cursor === "cursor-b" ? [identity("tail-two", "TAIL_TWO.mkv")] : [identity(firstPageReads > 1 ? "polled-head" : "head", firstPageReads > 1 ? "POLLED_HEAD.mkv" : "HEAD.mkv")];
        const nextCursor = cursor === "cursor-a" ? "cursor-b" : cursor ? null : "cursor-a";
        const completed = firstPageReads > 1;
        return route.fulfill({ json: { summary: { status: completed ? "completed" : "running", scanStatus: "running", afterFileId: null, attempts: 1, lastError: null }, counts: { total: completed ? 5 : 3, pending: completed ? 5 : 3, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items, nextCursor, hasMore: nextCursor !== null } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });

    await page.goto("http://127.0.0.1:4326/library/manage");
    const storage = page.getByRole("combobox", { name: "当前网盘" });
    await storage.waitFor();
    storageId = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看扫描中任务的识别结果 task-${storageId}`) }).click();
    await page.getByRole("heading", { name: "HEAD.mkv" }).waitFor();
    await page.getByRole("button", { name: "加载更多结果" }).click();
    await page.getByRole("heading", { name: "TAIL_ONE.mkv" }).waitFor();
    await page.getByText("识别状态：已完成").waitFor({ timeout: 10_000 });
    await expect.poll(() => page.getByText("文件 5").count()).toBe(1);
    await page.getByRole("button", { name: "刷新列表" }).waitFor();
    expect(await page.getByText("结果有更新，刷新列表查看最新状态。").count()).toBe(1);
    expect(await page.getByRole("heading", { name: "TAIL_ONE.mkv" }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: "POLLED_HEAD.mkv" }).count()).toBe(0);
    await page.getByRole("button", { name: "加载更多结果" }).click();
    await page.getByRole("heading", { name: "TAIL_TWO.mkv" }).waitFor();
    expect(cursors).toEqual(["cursor-a", "cursor-b"]);
    await page.getByRole("button", { name: "刷新列表" }).click();
    await page.getByRole("heading", { name: "POLLED_HEAD.mkv" }).waitFor();
    expect(await page.getByRole("heading", { name: "TAIL_ONE.mkv" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "加载更多结果" }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: "刷新列表" }).count()).toBe(0);
    await context.close();
  }, 30_000);

  it("shows newly confirmed results when a running job starts with an empty first page", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let storageId = ""; let firstPageReads = 0;
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      storageId = url.searchParams.get("storageId") ?? storageId;
      const taskId = url.pathname.split("/")[4] ?? "";
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [{ configId: `config-${storageId}`, scope: { accountId: "browser-test", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "root", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} }], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [{ ...task(`task-${storageId}`, `config-${storageId}`), status: "running" }], nextCursor: null, hasMore: false } });
      if (/\/scans\/[^/]+$/.test(url.pathname) && request.method() === "GET") return route.fulfill({ json: { item: { ...task(taskId, `config-${storageId}`), status: "running" } } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        firstPageReads += 1;
        const confirmed = firstPageReads > 1;
        const item = identity("new-confirmed", "NEWLY_CONFIRMED.mkv", "confirmed");
        return route.fulfill({ json: { summary: { status: confirmed ? "completed" : "running", scanStatus: "running", afterFileId: null, attempts: 1, lastError: null }, counts: { total: confirmed ? 1 : 0, pending: 0, confirmed: confirmed ? 1 : 0, failed: 0, ignored: 0, imported: confirmed ? 1 : 0 }, items: confirmed ? [item] : [], nextCursor: null, hasMore: false } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto("http://127.0.0.1:4326/library/manage");
    storageId = await page.getByRole("combobox", { name: "当前网盘" }).inputValue();
    await page.getByRole("button", { name: new RegExp(`查看扫描中任务的识别结果 task-${storageId}`) }).click();
    await page.getByText("此任务暂时没有识别结果。识别可能仍在排队，页面不会自动启动识别。").waitFor();
    await page.getByRole("heading", { name: "NEWLY_CONFIRMED.mkv" }).waitFor({ timeout: 10_000 });
    expect(await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "NEWLY_CONFIRMED.mkv" }) }).getByText("已确认", { exact: true }).count()).toBe(1);
    expect(await page.getByText("文件 1").count()).toBe(1);
    await context.close();
  }, 30_000);

  it("updates a pending first-page item to confirmed during polling", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let storageId = ""; let firstPageReads = 0;
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      storageId = url.searchParams.get("storageId") ?? storageId;
      const taskId = url.pathname.split("/")[4] ?? "";
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [{ configId: `config-${storageId}`, scope: { accountId: "browser-test", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "root", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} }], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [{ ...task(`task-${storageId}`, `config-${storageId}`), status: "running" }], nextCursor: null, hasMore: false } });
      if (/\/scans\/[^/]+$/.test(url.pathname) && request.method() === "GET") return route.fulfill({ json: { item: { ...task(taskId, `config-${storageId}`), status: "running" } } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        firstPageReads += 1;
        const confirmed = firstPageReads > 1;
        const item = identity("same-file", confirmed ? "NOW_CONFIRMED.mkv" : "STILL_PENDING.mkv", confirmed ? "confirmed" : "pending");
        return route.fulfill({ json: { summary: { status: confirmed ? "completed" : "running", scanStatus: "running", afterFileId: null, attempts: 1, lastError: null }, counts: { total: 1, pending: confirmed ? 0 : 1, confirmed: confirmed ? 1 : 0, failed: 0, ignored: 0, imported: confirmed ? 1 : 0 }, items: [item], nextCursor: null, hasMore: false } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto("http://127.0.0.1:4326/library/manage");
    storageId = await page.getByRole("combobox", { name: "当前网盘" }).inputValue();
    await page.getByRole("button", { name: new RegExp(`查看扫描中任务的识别结果 task-${storageId}`) }).click();
    await page.getByRole("heading", { name: "STILL_PENDING.mkv" }).waitFor();
    await expect.poll(() => firstPageReads, { timeout: 10_000 }).toBeGreaterThan(1);
    await page.getByRole("heading", { name: "NOW_CONFIRMED.mkv" }).waitFor({ timeout: 10_000 });
    expect(await page.getByRole("article").filter({ has: page.getByRole("heading", { name: "NOW_CONFIRMED.mkv" }) }).getByText("已确认", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: "STILL_PENDING.mkv" }).count()).toBe(0);
    await context.close();
  }, 30_000);

  it("clears a pending load-more busy state when switching result scopes", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { AbortController.prototype.abort = function abortIgnoredByTransport() {}; });
    let storageA = ""; let storageB = ""; let holdOldPage = false; let releaseOldPage: (() => void) | undefined;
    let oldPageRequestedResolve!: () => void;
    const oldPageRequested = new Promise<void>((resolve) => { oldPageRequestedResolve = resolve; });
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const body = request.postData() ? JSON.parse(request.postData() ?? "{}") as { storageId?: string } : {};
      const scope = url.searchParams.get("storageId") ?? body.storageId ?? "";
      const taskId = url.pathname.split("/")[4] ?? "";
      const config = (id: string) => ({ configId: `config-${id}`, scope: { accountId: "browser-test", connectedStorageId: id }, sourceRoots: [{ directoryId: "root", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} });
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(scope)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(`task-${scope}`, `config-${scope}`)], nextCursor: null, hasMore: false } });
      if (/\/scans\/[^/]+$/.test(url.pathname) && request.method() === "GET") return route.fulfill({ json: { item: task(taskId, `config-${scope}`) } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        const cursor = url.searchParams.get("cursor");
        if (holdOldPage && scope === storageA && cursor) {
          oldPageRequestedResolve();
          await new Promise<void>((resolve) => { releaseOldPage = resolve; });
          return route.fulfill({ json: { summary: null, counts: { total: 2, pending: 2, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [identity("old-tail", "OLD_TAIL.mkv")], nextCursor: null, hasMore: false } });
        }
        return route.fulfill({ json: { summary: null, counts: { total: 2, pending: 2, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [identity(`head-${scope}`, `HEAD_${scope}.mkv`)], nextCursor: `cursor-${scope}`, hasMore: true } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto("http://127.0.0.1:4326/library/manage");
    const storage = page.getByRole("combobox", { name: "当前网盘" });
    await storage.waitFor();
    const values = await storage.locator("option").evaluateAll((entries) => entries.map((entry) => (entry as HTMLOptionElement).value).filter(Boolean));
    storageA = values[0] ?? ""; storageB = values[1] ?? "";
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${storageA}`) }).click();
    await page.getByRole("heading", { name: `HEAD_${storageA}.mkv` }).waitFor();
    holdOldPage = true;
    await page.getByRole("button", { name: "加载更多结果" }).click();
    await oldPageRequested;
    await storage.selectOption(storageB);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${storageB}`) }).click();
    await page.getByRole("heading", { name: `HEAD_${storageB}.mkv` }).waitFor();
    expect(await page.getByRole("button", { name: "加载更多结果" }).isEnabled()).toBe(true);
    releaseOldPage?.();
    await page.waitForTimeout(100);
    expect(await page.getByText("OLD_TAIL.mkv").count()).toBe(0);
    expect(await page.getByRole("button", { name: "加载更多结果" }).isEnabled()).toBe(true);
    await context.close();
  }, 30_000);

  it("keeps a newly saved configuration and its source selected after starting a scan", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(5_000);
    let storageId = ""; let savedConfigId = ""; let startedConfigId = "";
    const identificationTaskIds: string[] = [];
    const sourceDirectory = { directoryId: "new-source-root", name: "新配置来源", selectionToken: "mock-selection-token" };
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const body = request.postData() ? JSON.parse(request.postData() ?? "{}") as { storageId?: string; configId?: string } : {};
      const scope = url.searchParams.get("storageId") ?? body.storageId ?? storageId;
      storageId = scope;
      const taskId = url.pathname.split("/")[4] ?? "";
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/configurations") && request.method() === "POST") {
        savedConfigId = "newly-saved-config";
        return route.fulfill({ status: 201, json: { item: { configId: savedConfigId, scope: { accountId: "browser-test", connectedStorageId: scope }, sourceRoots: [{ directoryId: sourceDirectory.directoryId, name: sourceDirectory.name }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: {} } } });
      }
      if (url.pathname.endsWith("/directories") && request.method() === "GET") return route.fulfill({ json: { items: [sourceDirectory], nextPage: null } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "POST") {
        startedConfigId = body.configId ?? "";
        return route.fulfill({ status: 202, json: { item: { ...task("newly-started-task", startedConfigId), status: "completed" } } });
      }
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        if (url.searchParams.get("status") === "confirmed" && url.searchParams.get("limit") === "20") return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
        identificationTaskIds.push(taskId);
        return route.fulfill({ json: { summary: null, counts: { total: 0, pending: 0, confirmed: 0, failed: 0, ignored: 0, imported: 0 }, items: [], nextCursor: null, hasMore: false } });
      }
      return route.fulfill({ json: { items: [], nextPage: null, nextCursor: null, hasMore: false } });
    });

    await page.goto("http://127.0.0.1:4326/library/manage");
    await page.getByRole("combobox", { name: "当前网盘" }).waitFor();
    await page.getByRole("button", { name: "新建配置" }).click();
    await page.getByRole("button", { name: "选择来源目录" }).click();
    await page.getByRole("button", { name: "添加来源" }).click();
    await page.getByRole("button", { name: "保存并开始扫描" }).click();

    await expect.poll(() => startedConfigId).toBe("newly-saved-config");
    await expect.poll(() => page.getByRole("combobox", { name: "已保存配置" }).inputValue()).toBe("newly-saved-config");
    await page.getByText("新配置来源", { exact: true }).waitFor();
    await page.getByRole("button", { name: "查看已完成任务的识别结果 newly-started-task" }).waitFor();
    await expect.poll(() => identificationTaskIds).toContain("newly-started-task");
    expect(startedConfigId).toBe(savedConfigId);
    expect(await page.locator("article").filter({ hasText: "已完成" }).count()).toBe(1);
    await context.close();
  }, 30_000);
});
