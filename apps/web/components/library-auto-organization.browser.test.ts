import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { LibraryScanConfiguration } from "./library-scan-client";

const browserDescribe = process.env.RUN_LIBRARY_SCAN_BROWSER === "1" ? describe : describe.skip;
const baseUrl = process.env.LIBRARY_BROWSER_BASE_URL ?? "http://127.0.0.1:4326";

browserDescribe("automatic organization configuration", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it.each([false, true])("loads and saves the explicit opt-in when initially %s", async (initialValue) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    let savedValue = initialValue;
    const posts: boolean[] = [];
    const configuration = (storageId: string): LibraryScanConfiguration => ({
      configId: `auto-${storageId}`, scope: { accountId: "auto-browser", connectedStorageId: storageId },
      sourceRoots: [{ directoryId: "auto-source", name: "演练来源" }],
      movieTargetDirectoryId: "auto-movies", tvTargetDirectoryId: "auto-tv", mediaKind: "mixed",
      dailyScheduleEnabled: false, dailyScheduleTime: null, dailyScheduleTimezone: "Asia/Shanghai",
      autoOrganize: savedValue, autoAcquire: false, templates: {},
    });
    await page.route("**/api/library/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname.endsWith("/configurations")) {
        if (request.method() === "GET") return route.fulfill({ json: { items: [configuration(url.searchParams.get("storageId") ?? "")], nextCursor: null, hasMore: false } });
        const body = request.postDataJSON() as { storageId: string; autoOrganize: boolean; templates: Record<string, string> };
        expect(typeof body.autoOrganize).toBe("boolean");
        savedValue = body.autoOrganize;
        posts.push(body.autoOrganize);
        return route.fulfill({ json: { item: { ...configuration(body.storageId), templates: body.templates } } });
      }
      return route.fulfill({ json: { items: [], nextCursor: null, nextPage: null, hasMore: false } });
    });
    try {
      await page.goto(`${baseUrl}/library/manage`);
      const checkbox = page.getByRole("checkbox", { name: "启用自动整理", exact: true });
      await checkbox.waitFor();
      await expect.poll(() => checkbox.isChecked()).toBe(initialValue);
      // Saving a different field must preserve the previously loaded automatic organization setting.
      await page.getByRole("radio", { name: "电影", exact: true }).check();
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await expect.poll(() => posts.length).toBe(1);
      expect(posts[0]).toBe(initialValue);
      await expect.poll(() => checkbox.isEnabled()).toBe(true);
      await checkbox.setChecked(!initialValue);
      await page.getByText("有未保存的配置或模板修改；整理预览只使用已保存的配置。", { exact: true }).waitFor();
      await page.getByRole("button", { name: "保存配置", exact: true }).click();
      await expect.poll(() => posts.length).toBe(2);
      expect(posts[1]).toBe(!initialValue);
      await expect.poll(() => checkbox.isEnabled()).toBe(true);
      await page.reload();
      await expect.poll(() => checkbox.isChecked()).toBe(!initialValue);
      // The deterministic frozen fixture must exercise a disabled editor.
      const storages = page.getByRole("combobox", { name: "当前网盘" });
      const frozenId = await storages.locator("option").evaluateAll((options) =>
        options.find((option) => option.textContent?.includes("已冻结"))?.getAttribute("value") ?? null);
      expect(frozenId).not.toBeNull();
      await storages.selectOption(frozenId!);
      await expect.poll(() => checkbox.isDisabled()).toBe(true);
      expect(posts).toHaveLength(2);
    } finally {
      await context.close();
    }
  }, 45000);
});
