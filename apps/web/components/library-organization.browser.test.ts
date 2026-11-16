import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";

const enabled = process.env.RUN_LIBRARY_SCAN_BROWSER === "1";
const browserDescribe = enabled ? describe : describe.skip;
const baseUrl = process.env.LIBRARY_BROWSER_BASE_URL ?? "http://127.0.0.1:4326";
const templates = { movieDirectory: "{title} ({year})", movieFile: "{title} ({year}){ext}", tvDirectory: "{title} ({year})", seasonDirectory: "Season {season:02}", episodeFile: "{title} - {episodeCode}{ext}" };

browserDescribe("library organizer browser flow", () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true }); });
  afterAll(async () => { await browser?.close(); });

  it("saves current template edits, gates preview until save, posts only imported IDs, and pages durable plan details", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    const savedPayloads: { templates: typeof templates }[] = []; const previewBodies: { storageId?: string; fileIds?: string[] }[] = [];
    const actions: { storageId?: string; action?: string }[] = []; const saveGates: (() => void)[] = [];
    let activeStorage = ""; let planPageCount = 0; let operationPageCount = 0; let frozenStorageId: string | null = null;
    const config = (storageId: string, id = `config-${storageId}`, currentTemplates = templates) => ({
      configId: id, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: `source-${storageId}`, name: "扫描来源" }],
      movieTargetDirectoryId: `movie-target-${storageId}`, movieTargetDirectoryName: "电影库", tvTargetDirectoryId: `tv-target-${storageId}`, tvTargetDirectoryName: "剧集库",
      mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: currentTemplates,
    });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 2, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = (fileId: string, name: string) => ({
      fileId, status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 123, seasonNumber: null, episodeCodes: [],
      importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId, parentDirectoryId: "real-provider-dir", name, isDirectory: false, sizeBytes: 10, path: `/source/${name}`, modifiedAt: null }, tracking: null,
    });
    const operation = (id: string) => ({ operationId: id, fileId: `provider-${id}`, originalParentId: "real-provider-dir", originalName: `${id}.mkv`, targetRootId: "real-target-root", targetRelativePath: `Film/${id}.mkv`, targetParentId: null, targetName: `${id}.mkv`, pairedFileId: `provider-sub-${id}`, pairedVideoTargetPath: `Film/${id}.mkv`, status: "planned", error: null });
    const frozenPlan = { operationKey: "frozen-plan", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] };
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string; action?: string; fileIds?: string[] } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      const taskId = url.pathname.split("/")[4] ?? `task-${storageId}`;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/configurations") && request.method() === "POST") {
        const payload = body as { templates?: typeof templates };
        savedPayloads.push({ templates: payload.templates ?? templates });
        await new Promise<void>((resolve) => saveGates.push(resolve));
        const saved = config(storageId, `config-${storageId}`, payload.templates ?? templates);
        return route.fulfill({ json: { item: saved } });
      }
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 2, confirmed: 2, imported: 2, pending: 0, ignored: 0, failed: 0 }, items: [imported("provider-file-A", "A.mkv"), imported("provider-file-B", "B.mkv")], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") {
        if (url.searchParams.has("cursor")) { planPageCount += 1; return route.fulfill({ json: { plans: [], nextCursor: null } }); }
        if (storageId === frozenStorageId) return route.fulfill({ json: { plans: [frozenPlan], nextCursor: null } });
        return route.fulfill({ json: { plans: [], nextCursor: "more-plans" } });
      }
      if (url.pathname.endsWith("/organization") && request.method() === "POST") {
        previewBodies.push(body);
        return route.fulfill({ status: 201, json: { plan: { operationKey: "plan-new", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 2, skippedFiles: [{ fileId: "provider-skip", reason: "无可靠季集映射" }] } } });
      }
      if (url.pathname.includes("/organization/") && request.method() === "GET") {
        if (url.pathname.endsWith("/organization/frozen-plan")) return route.fulfill({ json: { plan: frozenPlan, operations: [operation("frozen")], nextCursor: null } });
        if (url.searchParams.has("cursor")) { operationPageCount += 1; return route.fulfill({ json: { plan: { operationKey: "plan-new", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 2, skippedFiles: [] }, operations: [operation("second")], nextCursor: null } }); }
        return route.fulfill({ json: { plan: { operationKey: "plan-new", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 2, skippedFiles: [{ fileId: "provider-skip", reason: "无可靠季集映射" }] }, operations: [operation("first")], nextCursor: "more-operations" } });
      }
      if (url.pathname.includes("/organization/") && request.method() === "POST") { actions.push(body); return route.fulfill({ json: { operationKey: "plan-new", status: body.action === "pause" ? "paused" : "queued", accepted: true } }); }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    await page.getByRole("checkbox", { name: "A.mkv" }).waitFor();
    frozenStorageId = await storage.locator("option").evaluateAll((options) => options.find((option) => (option as HTMLOptionElement).textContent?.includes("已冻结"))?.getAttribute("value") ?? null);
    expect(frozenStorageId).not.toBeNull();
    const frozenId = frozenStorageId!;
    await storage.selectOption(frozenId);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${frozenId}`) }).click();
    const frozenFile = page.getByRole("checkbox", { name: "A.mkv" }); await frozenFile.waitFor();
    await expect.poll(() => frozenFile.isDisabled()).toBe(true);
    await organizer.getByText("此连接已冻结：可查看整理清单，不能创建预览或提交执行操作。", { exact: true }).waitFor();
    await organizer.getByText("frozen-plan", { exact: true }).click();
    await organizer.getByText("目标：real-target-root/Film/frozen.mkv", { exact: true }).waitFor();
    await expect.poll(() => organizer.getByRole("button", { name: "开始整理" }).isDisabled()).toBe(true);
    await expect.poll(() => organizer.getByRole("button", { name: /创建预览/ }).isDisabled()).toBe(true);
    await storage.selectOption(activeStorage);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    await page.getByRole("checkbox", { name: "A.mkv" }).waitFor();
    const movieFile = page.getByRole("textbox", { name: "电影文件模板" });
    await movieFile.fill("{title} - 新版{ext}");
    await page.getByText("扫描配置有未保存修改。请先保存配置，再预览或执行整理。", { exact: true }).waitFor();
    expect(await page.getByText("未保存", { exact: true }).count()).toBe(1);
    const fileCheckbox = page.getByRole("checkbox", { name: "A.mkv" }); await fileCheckbox.check();
    await expect.poll(() => page.getByRole("button", { name: /创建预览/ }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect.poll(() => saveGates.length).toBe(1);
    await expect.poll(() => movieFile.isDisabled()).toBe(true);
    await expect.poll(() => page.getByRole("button", { name: "保存中…" }).isDisabled()).toBe(true);
    expect(await page.getByRole("combobox", { name: "当前网盘" }).isEnabled()).toBe(true);
    saveGates[0]!();
    await expect.poll(() => savedPayloads.length).toBe(1);
    expect((savedPayloads[0] as { templates: typeof templates }).templates.movieFile).toBe("{title} - 新版{ext}");
    await expect.poll(() => movieFile.inputValue()).toBe("{title} - 新版{ext}");
    expect(await page.getByText("未保存", { exact: true }).count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: /创建预览/ }).isEnabled()).toBe(true);
    await page.getByRole("button", { name: /创建预览/ }).click();
    await expect.poll(() => previewBodies.length).toBe(1);
    expect(previewBodies[0]).toEqual({ storageId: activeStorage, fileIds: ["provider-file-A"] });
    expect(actions).toHaveLength(0);
    await organizer.getByText("整理预览清单已创建；这一步没有执行文件移动或改名。", { exact: true }).waitFor();
    await organizer.getByText("provider-skip：无可靠季集映射", { exact: true }).waitFor();
    await organizer.getByText("目标：real-target-root/Film/first.mkv", { exact: true }).waitFor();
    await movieFile.fill("{title} - 草稿{ext}");
    await expect.poll(() => organizer.getByRole("button", { name: "开始整理" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect.poll(() => saveGates.length).toBe(2);
    saveGates[1]!();
    await expect.poll(() => savedPayloads.length).toBe(2);
    expect(savedPayloads[1]!.templates.movieFile).toBe("{title} - 草稿{ext}");
    await expect.poll(() => organizer.getByRole("button", { name: "开始整理" }).isEnabled()).toBe(true);
    await organizer.getByRole("button", { name: "加载更多操作" }).click();
    await expect.poll(() => operationPageCount).toBe(1);
    await organizer.getByText("目标：real-target-root/Film/second.mkv", { exact: true }).waitFor();
    await organizer.getByRole("button", { name: "开始整理" }).click();
    await expect.poll(() => actions.length).toBe(1);
    expect(actions[0]).toEqual({ storageId: activeStorage, action: "execute" });
    await organizer.getByRole("button", { name: "加载更多清单" }).click();
    await expect.poll(() => planPageCount).toBe(1);
    await context.close();
  }, 45_000);

  it("drops a delayed preview response after switching the selected storage", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = ""; let oldStorage = ""; let releasePreview: (() => void) | undefined; let previewStarted!: () => void;
    const started = new Promise<void>((resolve) => { previewStarted = resolve; });
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: "movie-root", movieTargetDirectoryName: "电影", tvTargetDirectoryId: "tv-root", tvTargetDirectoryName: "剧集", mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string; fileIds?: string[] } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [{ fileId: `file-${storageId}`, status: "confirmed", reason: "已导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: `file-${storageId}`, parentDirectoryId: "provider-dir", name: "ready.mkv", isDirectory: false, sizeBytes: 1, path: "/ready.mkv", modifiedAt: null }, tracking: null }], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "POST" && storageId === oldStorage) {
        previewStarted();
        await new Promise<void>((resolve) => { releasePreview = resolve; });
        return route.fulfill({ status: 201, json: { plan: { operationKey: "old-scope-plan", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] } } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    const storageIds = await storage.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));
    expect(storageIds.length).toBeGreaterThan(1);
    oldStorage = await storage.inputValue();
    const newStorage = storageIds.find((id) => id !== oldStorage)!;
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${oldStorage}`) }).click();
    await page.getByRole("checkbox", { name: "ready.mkv" }).check();
    await page.getByRole("button", { name: /创建预览/ }).click();
    await started;
    await storage.selectOption(newStorage);
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${newStorage}`) }).click();
    await page.getByRole("checkbox", { name: "ready.mkv" }).waitFor();
    releasePreview?.();
    await page.getByRole("heading", { name: "整理管理" }).waitFor();
    await expect.poll(() => page.getByText("old-scope-plan", { exact: true }).count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: "开始整理" }).count()).toBe(0);
    await context.close();
  }, 45_000);

  it("ignores same-scope plan and identity responses that resolve after a newer request", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = ""; let releasePlanA: (() => void) | undefined;
    const planRequests: string[] = []; const identityRequests: (string | null)[] = [];
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: "movie-root", movieTargetDirectoryName: "电影", tvTargetDirectoryId: "tv-root", tvTargetDirectoryName: "剧集", mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 2, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = (fileId: string, name: string) => ({ fileId, status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId, parentDirectoryId: "real-provider-dir", name, isDirectory: false, sizeBytes: 1, path: `/source/${name}`, modifiedAt: null }, tracking: null });
    const plan = (operationKey: string) => ({ operationKey, status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] });
    const operation = (id: string) => ({ operationId: id, fileId: `provider-${id}`, originalParentId: "real-provider-dir", originalName: `${id}.mkv`, targetRootId: "real-target-root", targetRelativePath: `Film/${id}.mkv`, targetParentId: null, targetName: `${id}.mkv`, pairedFileId: `provider-sub-${id}`, pairedVideoTargetPath: `Film/${id}.mkv`, status: "planned", error: null });
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") {
        const cursor = url.searchParams.get("cursor"); identityRequests.push(cursor);
        const items = cursor ? [imported("provider-file-C", "C.mkv")] : [imported("provider-file-A", "A.mkv"), imported("provider-file-B", "B.mkv")];
        return route.fulfill({ json: { summary: null, counts: { total: 3, confirmed: 3, imported: 3, pending: 0, ignored: 0, failed: 0 }, items, nextCursor: cursor ? null : "id-page-2", hasMore: !cursor } });
      }
      if (url.pathname.endsWith("/organization/plan-a") && request.method() === "GET") {
        planRequests.push("plan-a");
        await new Promise<void>((resolve) => { releasePlanA = resolve; });
        return route.fulfill({ json: { plan: plan("plan-a"), operations: [operation("a-only")], nextCursor: null } });
      }
      if (url.pathname.endsWith("/organization/plan-b") && request.method() === "GET") {
        planRequests.push("plan-b");
        return route.fulfill({ json: { plan: plan("plan-b"), operations: [operation("b-only")], nextCursor: null } });
      }
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [plan("plan-a"), plan("plan-b")], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    await page.getByRole("checkbox", { name: "A.mkv" }).waitFor();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByText("plan-a", { exact: true }).waitFor();
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      buttons.find((button) => button.textContent?.includes("plan-a"))?.click();
      buttons.find((button) => button.textContent?.includes("plan-b"))?.click();
    });
    await expect.poll(() => planRequests.length).toBe(2);
    await expect.poll(() => organizer.getByText("目标：real-target-root/Film/b-only.mkv", { exact: true }).count()).toBe(1);
    expect(await organizer.getByText("目标：real-target-root/Film/a-only.mkv", { exact: true }).count()).toBe(0);
    expect(planRequests).toEqual(["plan-a", "plan-b"]);
    releasePlanA?.();
    await page.waitForTimeout(250);
    expect(await organizer.getByText("目标：real-target-root/Film/a-only.mkv", { exact: true }).count()).toBe(0);
    expect(await organizer.getByText("目标：real-target-root/Film/b-only.mkv", { exact: true }).count()).toBe(1);
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.includes("下一批"));
      button?.click(); button?.click();
    });
    await page.getByRole("checkbox", { name: "C.mkv" }).waitFor();
    expect(identityRequests.filter((cursor) => cursor === "id-page-2")).toHaveLength(1);
    const beforePrevious = identityRequests.length;
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.includes("上一批"));
      button?.click(); button?.click();
    });
    await page.getByRole("checkbox", { name: "A.mkv" }).waitFor();
    expect(identityRequests.slice(beforePrevious).filter((cursor) => cursor === null)).toHaveLength(1);
    await context.close();
  }, 45_000);

  it("caps a preview to the imported page and posts only provider IDs", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = ""; const previewBodies: { storageId?: string; fileIds?: string[] }[] = [];
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: "movie-root", movieTargetDirectoryName: "电影", tvTargetDirectoryId: "tv-root", tvTargetDirectoryName: "剧集", mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 20, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = (fileId: string, name: string) => ({ fileId, status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId, parentDirectoryId: "real-provider-dir", name, isDirectory: false, sizeBytes: 1, path: `/source/${name}`, modifiedAt: null }, tracking: null });
    const items = Array.from({ length: 20 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return imported(`provider-file-${suffix}`, `file-${suffix}.mkv`);
    });
    const plan = { operationKey: "plan-page", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] };
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string; fileIds?: string[] } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 20, confirmed: 20, imported: 20, pending: 0, ignored: 0, failed: 0 }, items, nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "POST") { previewBodies.push(body); return route.fulfill({ status: 201, json: { plan } }); }
      if (url.pathname.endsWith("/organization/plan-page") && request.method() === "GET") return route.fulfill({ json: { plan, operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    await page.getByRole("checkbox", { name: "file-00.mkv" }).waitFor();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByRole("button", { name: "全选/清空本页" }).click();
    const preview = organizer.getByRole("button", { name: /创建预览（20）/ });
    await expect.poll(() => preview.isEnabled()).toBe(true);
    await preview.click();
    await expect.poll(() => previewBodies.length).toBe(1);
    const fileIds = previewBodies[0]!.fileIds!;
    expect(fileIds).toHaveLength(20);
    expect(new Set(fileIds).size).toBe(20);
    expect(fileIds[0]).toBe("provider-file-00");
    expect(fileIds.at(-1)).toBe("provider-file-19");
    await context.close();
  }, 45_000);

  it("normalizes missing skipped files and null rows while keeping the page usable after an invalid 200", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = "";
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: "movie-root", movieTargetDirectoryName: "电影", tvTargetDirectoryId: null, tvTargetDirectoryName: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = { fileId: "provider-file-A", status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: "provider-file-A", parentDirectoryId: "real-provider-dir", name: "A.mkv", isDirectory: false, sizeBytes: 1, path: "/source/A.mkv", modifiedAt: null }, tracking: null };
    const summary = (operationKey: string) => ({ operationKey, status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1 });
    const operation = { operationId: "normal-operation", fileId: "provider-normal", originalParentId: "real-provider-dir", originalName: "normal.mkv", targetRootId: "real-target-root", targetRelativePath: "Film/normal.mkv", targetParentId: null, targetName: "normal.mkv", pairedFileId: "provider-normal", pairedVideoTargetPath: "Film/normal.mkv", status: "planned", error: null };
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const storageId = url.searchParams.get("storageId") ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [imported], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization/plan-normal") && request.method() === "GET") return route.fulfill({ json: { plan: summary("plan-normal"), operations: [operation, null], nextCursor: null } });
      if (url.pathname.endsWith("/organization/plan-bad") && request.method() === "GET") return route.fulfill({ json: { plan: { status: "planned" }, operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [summary("plan-normal"), null, summary("plan-bad")], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByText("plan-normal", { exact: true }).click();
    await organizer.getByText("目标：real-target-root/Film/normal.mkv", { exact: true }).waitFor();
    expect(await organizer.getByText("跳过的文件", { exact: false }).count()).toBe(0);
    await organizer.getByText("plan-bad", { exact: true }).click();
    await organizer.getByRole("alert").getByText("服务器返回的整理清单键无效。", { exact: true }).waitFor();
    await organizer.getByRole("heading", { name: "整理管理" }).waitFor();
    expect(await page.getByText("页面渲染失败", { exact: false }).count()).toBe(0);
    await context.close();
  }, 45_000);

  it("keeps rejected and unknown action errors instead of clearing them during readback", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = "";
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = { fileId: "provider-file-A", status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: "provider-file-A", parentDirectoryId: "real-provider-dir", name: "A.mkv", isDirectory: false, sizeBytes: 1, path: "/source/A.mkv", modifiedAt: null }, tracking: null };
    const actionPlan = { operationKey: "plan-actions", status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] };
    const operation = { operationId: "action-operation", fileId: "provider-action", originalParentId: "real-provider-dir", originalName: "action.mkv", targetRootId: "real-target-root", targetRelativePath: "Film/action.mkv", targetParentId: null, targetName: "action.mkv", pairedFileId: "provider-action", pairedVideoTargetPath: "Film/action.mkv", status: "planned", error: null };
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string; action?: string } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [imported], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "POST") return route.fulfill({ status: 409, json: { error: "无可整理文件。" } });
      if (url.pathname.endsWith("/organization/plan-actions") && request.method() === "POST") return route.fulfill({ status: 500, json: { error: "执行器暂不可用。" } });
      if (url.pathname.endsWith("/organization/plan-actions") && request.method() === "GET") return route.fulfill({ json: { plan: actionPlan, operations: [operation], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [actionPlan], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByRole("checkbox", { name: "A.mkv" }).check();
    await organizer.getByRole("button", { name: /创建预览/ }).click();
    await organizer.getByRole("alert").getByText("无可整理文件。（HTTP 409）", { exact: true }).waitFor();
    await organizer.getByText("服务器拒绝创建整理预览：无可整理文件。", { exact: true }).waitFor();
    await organizer.getByText("plan-actions", { exact: true }).click();
    await organizer.getByText("目标：real-target-root/Film/action.mkv", { exact: true }).waitFor();
    await organizer.getByRole("button", { name: "开始整理" }).click();
    await organizer.getByRole("alert").getByText("执行器暂不可用。（HTTP 500）", { exact: true }).waitFor();
    await organizer.getByText("开始整理请求结果未能确认。请刷新清单，核实持久化状态后再重试。", { exact: true }).waitFor();
    await expect.poll(() => organizer.getByRole("button", { name: "开始整理" }).isEnabled()).toBe(true);
    await context.close();
  }, 45_000);

  it("keeps a selected hash plan visible when refresh returns only the first page", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = "";
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = { fileId: "provider-file-A", status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: "provider-file-A", parentDirectoryId: "real-provider-dir", name: "A.mkv", isDirectory: false, sizeBytes: 1, path: "/source/A.mkv", modifiedAt: null }, tracking: null };
    const plan = (operationKey: string) => ({ operationKey, status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] });
    const firstPage = Array.from({ length: 20 }, (_, index) => plan(`plan-${String(index).padStart(2, "0")}`));
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [imported], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "POST") return route.fulfill({ status: 201, json: { plan: plan("plan-new") } });
      if (url.pathname.endsWith("/organization/plan-new") && request.method() === "GET") return route.fulfill({ json: { plan: plan("plan-new"), operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: firstPage, nextCursor: "more-plans" } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByRole("checkbox", { name: "A.mkv" }).check();
    await organizer.getByRole("button", { name: /创建预览/ }).click();
    await organizer.getByText("plan-new", { exact: true }).waitFor();
    await organizer.getByRole("button", { name: "刷新", exact: true }).click();
    await expect.poll(() => organizer.getByText("plan-new", { exact: true }).count()).toBe(1);
    await organizer.getByText("当前", { exact: true }).waitFor();
    expect(await organizer.getByText(/项操作 ·/).count()).toBe(21);
    await context.close();
  }, 45_000);

  it("caps a new preview at 100 plans while keeping the created plan selected", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = "";
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = { fileId: "provider-file-A", status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: "provider-file-A", parentDirectoryId: "real-provider-dir", name: "A.mkv", isDirectory: false, sizeBytes: 1, path: "/source/A.mkv", modifiedAt: null }, tracking: null };
    const plan = (operationKey: string) => ({ operationKey, status: "planned", createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 1, skippedFiles: [] });
    const existingPlans = Array.from({ length: 100 }, (_, index) => plan(`plan-${String(index).padStart(3, "0")}`));
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      let body: { storageId?: string } = {};
      try { body = JSON.parse(request.postData() ?? "{}") as typeof body; } catch { /* GET has no body */ }
      const storageId = url.searchParams.get("storageId") ?? body.storageId ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [imported], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization") && request.method() === "POST") return route.fulfill({ status: 201, json: { plan: plan("plan-new") } });
      if (url.pathname.endsWith("/organization/plan-new") && request.method() === "GET") return route.fulfill({ json: { plan: plan("plan-new"), operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: existingPlans, nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByText("plan-000", { exact: true }).waitFor();
    expect(await organizer.getByText(/项操作 ·/).count()).toBe(100);
    await organizer.getByRole("checkbox", { name: "A.mkv" }).check();
    await organizer.getByRole("button", { name: /创建预览/ }).click();
    await organizer.getByText("plan-new", { exact: true }).waitFor();
    expect(await organizer.getByText(/项操作 ·/).count()).toBe(100);
    await organizer.getByText("当前", { exact: true }).waitFor();
    expect(await organizer.getByText("plan-new", { exact: true }).count()).toBe(1);
    expect(await organizer.getByText("plan-099", { exact: true }).count()).toBe(0);
    expect(await organizer.getByText("plan-098", { exact: true }).count()).toBe(1);
    await context.close();
  }, 45_000);

  it("distinguishes system yield, submitted execution, and manual pause states", async () => {
    const context = await browser.newContext(); const page = await context.newPage(); page.setDefaultTimeout(8_000);
    let activeStorage = "";
    const templatesFixture = { ...templates };
    const config = (storageId: string) => ({ configId: `config-${storageId}`, scope: { accountId: "browser-fixture", connectedStorageId: storageId }, sourceRoots: [{ directoryId: "source", name: "来源" }], movieTargetDirectoryId: null, tvTargetDirectoryId: null, mediaKind: "mixed", dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai", autoOrganize: false, autoAcquire: false, templates: templatesFixture });
    const task = (storageId: string) => ({ taskId: `task-${storageId}`, configId: `config-${storageId}`, status: "completed", directoriesDone: 1, filesDiscovered: 1, directoriesDiscovered: 1, failures: [], createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z" });
    const imported = { fileId: "provider-file-A", status: "confirmed", reason: "已确认并导入", evidence: [], candidates: [], mediaType: "movie", tmdbId: 1, seasonNumber: null, episodeCodes: [], importStatus: "imported", manual: true, updatedAt: "2026-11-15T00:00:00Z", file: { fileId: "provider-file-A", parentDirectoryId: "real-provider-dir", name: "A.mkv", isDirectory: false, sizeBytes: 1, path: "/source/A.mkv", modifiedAt: null }, tracking: null };
    const plan = (operationKey: string, status: "planned" | "paused", executeRequested: boolean) => ({ operationKey, status, executeRequested, createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", operationCount: 0, skippedFiles: [] });
    const yielded = plan("system-yield", "paused", true);
    const manual = plan("manual-pause", "paused", false);
    const submitted = plan("submitted-wait", "planned", true);
    await page.route("**/api/library/**", async (route: Route) => {
      const request = route.request(); const url = new URL(request.url());
      const storageId = url.searchParams.get("storageId") ?? activeStorage;
      if (!activeStorage && storageId) activeStorage = storageId;
      if (url.pathname.endsWith("/configurations") && request.method() === "GET") return route.fulfill({ json: { items: [config(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/scans") && request.method() === "GET") return route.fulfill({ json: { items: [task(storageId)], nextCursor: null, hasMore: false } });
      if (url.pathname.includes("/identifications") && request.method() === "GET") return route.fulfill({ json: { summary: null, counts: { total: 1, confirmed: 1, imported: 1, pending: 0, ignored: 0, failed: 0 }, items: [imported], nextCursor: null, hasMore: false } });
      if (url.pathname.endsWith("/organization/system-yield") && request.method() === "GET") return route.fulfill({ json: { plan: yielded, operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization/manual-pause") && request.method() === "GET") return route.fulfill({ json: { plan: manual, operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization/submitted-wait") && request.method() === "GET") return route.fulfill({ json: { plan: submitted, operations: [], nextCursor: null } });
      if (url.pathname.endsWith("/organization") && request.method() === "GET") return route.fulfill({ json: { plans: [yielded, manual, submitted], nextCursor: null } });
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    await page.goto(`${baseUrl}/library/manage`);
    const storage = page.getByRole("combobox", { name: "当前网盘" }); await storage.waitFor();
    activeStorage = await storage.inputValue();
    await page.getByRole("button", { name: new RegExp(`查看已完成任务的识别结果 task-${activeStorage}`) }).click();
    const organizer = page.locator("section").filter({ has: page.getByRole("heading", { name: "整理管理" }) });
    await organizer.getByText("system-yield", { exact: true }).click();
    await organizer.getByRole("heading", { name: "清单状态：等待继续执行" }).waitFor();
    await expect.poll(() => organizer.getByRole("button", { name: "暂停", exact: true }).isEnabled()).toBe(true);
    expect(await organizer.getByRole("button", { name: "继续整理", exact: true }).count()).toBe(0);
    await organizer.getByText("manual-pause", { exact: true }).click();
    await organizer.getByRole("heading", { name: "清单状态：已暂停" }).waitFor();
    await expect.poll(() => organizer.getByRole("button", { name: "继续整理", exact: true }).isEnabled()).toBe(true);
    expect(await organizer.getByRole("button", { name: "暂停", exact: true }).count()).toBe(0);
    await organizer.getByText("submitted-wait", { exact: true }).click();
    await organizer.getByRole("heading", { name: "清单状态：已提交等待" }).waitFor();
    await expect.poll(() => organizer.getByRole("button", { name: "暂停", exact: true }).isEnabled()).toBe(true);
    expect(await organizer.getByRole("button", { name: "开始整理", exact: true }).count()).toBe(0);
    await context.close();
  }, 45_000);
});
