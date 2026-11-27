import { afterAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";

const browserTestsEnabled = process.env.RUN_LIBRARY_SCAN_BROWSER === "1";
const browserDescribe = browserTestsEnabled ? describe : describe.skip;
const baseUrl = process.env.LIBRARY_BROWSER_BASE_URL ?? "http://127.0.0.1:4326";

type TaskDto = {
  taskId: string; configId: string; status: "completed"; directoriesDone: number;
  filesDiscovered: number; directoriesDiscovered: number; failures: never[];
  createdAt: string; updatedAt: string;
};

const task = (taskId: string, configId: string): TaskDto => ({
  taskId, configId, status: "completed", directoriesDone: 1, filesDiscovered: 1,
  directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

browserDescribe("library scan settings browser scope races", () => {
  let browser: Browser;
  afterAll(async () => { await browser?.close(); });

  it("drops old task pages and stops the old start phase after switching storage", async () => {
    browser = await chromium.launch({
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    // Model a transport that finishes successfully despite cancellation; scope generation must still reject stale UI results.
    await page.addInitScript(() => { AbortController.prototype.abort = function abortIgnoredByTransport() {}; });
    const oldPage = deferred<void>();
    const oldSave = deferred<void>();
    let finishOldPage: (() => void) | undefined;
    let finishOldSave: (() => void) | undefined;
    let oldStartRequests = 0;
    let storageA = "";
    let storageB = "";
    const requestedUrls: string[] = [];

    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      requestedUrls.push(`${url.pathname}${url.search}`);
      const storageId = url.searchParams.get("storageId") ?? (() => {
        try { return (JSON.parse(request.postData() ?? "{}") as { storageId?: string }).storageId ?? ""; }
        catch { return ""; }
      })();
      if (!storageA) storageA = storageId;
      else if (!storageB && storageId !== storageA) storageB = storageId;
      const config = (id: string, name: string) => ({
        configId: `config-${id}`, scope: { accountId: "browser-test", connectedStorageId: id },
        sourceRoots: [{ directoryId: `root-${id}`, name: `来源 ${id}` }],
        movieTargetDirectoryId: `target-${id}`, movieTargetDirectoryName: name,
        tvTargetDirectoryId: null, tvTargetDirectoryName: null, mediaKind: "mixed",
        dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai",
        autoOrganize: false, autoAcquire: false, templates: {
          movieDirectory: "{title}", movieFile: "{title}{ext}", tvDirectory: "{title}",
          seasonDirectory: "Season {season:02}", episodeFile: "{title}{ext}",
        },
      });
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") {
        await route.fulfill({ json: { items: [config(storageId, `目标 ${storageId}`)], nextCursor: null, hasMore: false } });
        return;
      }
      if (url.pathname.endsWith("/configurations") && request.method() === "POST") {
        const body = JSON.parse(request.postData() ?? "{}") as { storageId?: string };
        if (body.storageId === storageA) {
          finishOldSave = () => { void route.fulfill({ status: 201, json: { item: config(storageA, "旧目标 A") } }).catch(() => undefined); };
          oldSave.resolve();
          return;
        }
        await route.fulfill({ status: 201, json: { item: config(storageId, `目标 ${storageId}`) } });
        return;
      }
      if (url.pathname.endsWith("/scans") && request.method() === "GET") {
        const cursor = url.searchParams.get("cursor");
        if (storageId === storageA && cursor === "older-a") {
          finishOldPage = () => { void route.fulfill({ json: { items: [task("task-old-a", `config-${storageA}`)], nextCursor: null, hasMore: false } }).catch(() => undefined); };
          oldPage.resolve();
          return;
        }
        if (storageId === storageA) await route.fulfill({ json: { items: [], nextCursor: "older-a", hasMore: true } });
        else await route.fulfill({ json: { items: [task("task-current-b", `config-${storageId}`)], nextCursor: null, hasMore: false } });
        return;
      }
      if (url.pathname.endsWith("/scans") && request.method() === "POST") {
        oldStartRequests += 1;
        await route.fulfill({ status: 202, json: { item: task("unexpected-old-start", "config-storage-a") } });
        return;
      }
      await route.fulfill({ status: 200, json: { items: [], nextPage: null } });
    });

    await page.goto(`${baseUrl}/library/manage`);
    const storageGroup = page.getByRole("group", { name: "当前网盘" });
    await storageGroup.waitFor();
    const stackLayout = await page.locator(".library-management-stack").evaluate((element) => ({ display: getComputedStyle(element).display, gap: getComputedStyle(element).rowGap }));
    expect(stackLayout).toEqual({ display: "grid", gap: "18px" });
    const pillButtons = storageGroup.locator("button");
    const count = await pillButtons.count();
    expect(count).toBeGreaterThanOrEqual(2);
    const labelA = (await pillButtons.nth(0).textContent()) ?? "";
    const labelB = (await pillButtons.nth(1).textContent()) ?? "";
    await page.getByRole("tab", { name: "待确认与扫描任务" }).click();
    await page.getByRole("button", { name: "加载更多任务" }).waitFor();
    await page.getByRole("button", { name: "加载更多任务" }).click();
    await oldPage.promise;
    await pillButtons.nth(1).click();
    await page.getByRole("tab", { name: "库整理" }).click();
    await page.getByText(`目标 ${storageB}`).waitFor();
    finishOldPage?.();
    await page.waitForTimeout(250);
    await page.getByRole("tab", { name: "待确认与扫描任务" }).click();
    const tasksPanel = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "扫描任务" }) });
    expect(await tasksPanel.locator("article").count()).toBe(1);
    expect(await tasksPanel.getByRole("button", { name: /task-old-a/ }).count()).toBe(0);
    expect(requestedUrls.filter((entry) => entry.includes(`task-${storageA}`) && entry.includes(`storageId=${storageB}`))).toEqual([]);
    expect(requestedUrls.filter((entry) => entry.includes(`task-${storageB}`) && entry.includes(`storageId=${storageA}`))).toEqual([]);
    expect(labelA).not.toBe(labelB);

    await pillButtons.nth(0).click();
    await page.getByRole("tab", { name: "库整理" }).click();
    await page.getByText(`目标 ${storageA}`).waitFor();
    const startButton = page.getByRole("button", { name: "开始单次整理" });
    await startButton.click();
    await oldSave.promise;
    await pillButtons.nth(1).click();
    await page.getByText(`目标 ${storageB}`).waitFor();
    finishOldSave?.();
    await page.waitForTimeout(250);
    expect(oldStartRequests).toBe(0);
    expect(await page.getByText(`目标 ${storageB}`).isVisible()).toBe(true);
    await context.close();
  }, 45_000);
});
