import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Route } from "playwright";
import type { LibraryQueryItem, LibraryQueryPage } from "@media-track/workflow/library-query";

// The fake-data preview (local isolated PostgreSQL, fake drive/agent adapters)
// is started by the main agent. This suite only owns its browser context and
// API routes; it never starts or configures the preview service.
const enabled = process.env.RUN_LIBRARY_SCAN_BROWSER === "1";
const browserDescribe = enabled ? describe : describe.skip;
const PREVIEW_URL = "http://127.0.0.1:4326";

function item(over: Partial<LibraryQueryItem> & { tmdbId: number; title: string }): LibraryQueryItem {
  return {
    type: "movie", year: 2025, posterPath: null, releaseDate: null, seasonCount: 0,
    obtainedEpisodes: 1, totalAiredEpisodes: 1, totalEpisodes: 1, state: "complete",
    airing: false, acquiring: false, autoAcquire: null, ...over,
  };
}

function queryPage(items: LibraryQueryItem[], total = items.length, pageSize = 48): LibraryQueryPage {
  return { items, total, page: 1, pageSize, hasMore: total > items.length };
}

browserDescribe("library paged wall browser races", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it("debounces search, ignores a late old response, and only Enters the settled single result", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // A slow transport that still completes after the component aborts it.
    await page.addInitScript(() => { AbortController.prototype.abort = function abortIgnoredByTransport() {}; });
    let slowRoute: Route | null = null;
    let releaseSlow: (() => void) | null = null;
    const slowArrived = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    }).then(() => undefined);

    await page.route("**/api/library/media**", async (route: Route) => {
      const url = new URL(route.request().url());
      const search = url.searchParams.get("search") ?? "";
      if (search === "slow") {
        slowRoute = route;
        return releaseSlow?.();
      }
      if (search === "fast") return route.fulfill({ json: queryPage([item({ tmdbId: 101, title: "FAST_RESULT" })], 1) });
      if (search === "multi") return route.fulfill({ json: queryPage([item({ tmdbId: 201, title: "MULTI_ONE" }), item({ tmdbId: 202, title: "MULTI_TWO" })], 2) });
      if (search === "one") return route.fulfill({ json: queryPage([item({ tmdbId: 301, title: "ONE_RESULT" })], 1) });
      return route.fulfill({ json: queryPage([], 0) });
    });

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    const input = page.getByLabel("在库中查找");
    await input.waitFor();

    await input.fill("slow");
    await slowArrived;
    expect(slowRoute).not.toBeNull();

    // Still inside the 250ms debounce: Enter must not use the old (empty) result.
    await input.fill("fast");
    await input.press("Enter");
    await page.waitForTimeout(100);
    expect(new URL(page.url()).pathname).not.toContain("/show/");

    await page.getByText("FAST_RESULT").waitFor();
    // The superseded slow query resolves afterwards; its result must stay hidden.
    await slowRoute!.fulfill({ json: queryPage([item({ tmdbId: 999, title: "SLOW_STALE" })], 1) }).catch(() => undefined);
    await page.waitForTimeout(150);
    expect(await page.getByText("SLOW_STALE").count()).toBe(0);
    expect(await page.getByText("FAST_RESULT").count()).toBe(1);

    await input.fill("multi");
    await input.press("Enter");
    await page.getByText("MULTI_ONE").waitFor();
    await input.press("Enter");
    await page.waitForTimeout(100);
    expect(new URL(page.url()).pathname).not.toContain("/show/");

    await input.fill("one");
    await page.getByText("ONE_RESULT").waitFor();
    await input.press("Enter");
    await page.waitForURL(/\/show\/301/);
    expect(new URL(page.url()).searchParams.get("from")).toBe("library");
    await context.close();
  }, 30_000);

  it("pages with the server page size and drops a late page after the query changes", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(() => { AbortController.prototype.abort = function abortIgnoredByTransport() {}; });
    let heldPage: Route | null = null;
    let releaseHeld: (() => void) | null = null;
    const heldArrived = new Promise<void>((resolve) => { releaseHeld = resolve; }).then(() => undefined);

    await page.route("**/api/library/media**", async (route: Route) => {
      const url = new URL(route.request().url());
      const search = url.searchParams.get("search") ?? "";
      const pageNumber = url.searchParams.get("page") ?? "1";
      if (search === "paged" && pageNumber === "1") {
        return route.fulfill({ json: queryPage([item({ tmdbId: 11, title: "PAGED_ONE" }), item({ tmdbId: 12, title: "PAGED_TWO" })], 5, 2) });
      }
      if (search === "paged" && pageNumber === "2") {
        heldPage = route;
        return releaseHeld?.();
      }
      if (search === "other") return route.fulfill({ json: queryPage([item({ tmdbId: 21, title: "OTHER_RESULT" })], 1) });
      return route.fulfill({ json: queryPage([], 0) });
    });

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    const input = page.getByLabel("在库中查找");
    await input.waitFor();
    await input.fill("paged");
    await page.getByText("PAGED_ONE").waitFor();
    await page.getByText("第 1 / 3 页 · 共 5 部").waitFor();

    await page.getByRole("button", { name: "下一页" }).click();
    await heldArrived;
    expect(heldPage).not.toBeNull();

    await input.fill("other");
    await page.getByText("OTHER_RESULT").waitFor();
    await heldPage!.fulfill({ json: queryPage([item({ tmdbId: 19, title: "LATE_PAGE_TWO" })], 5, 2) }).catch(() => undefined);
    await page.waitForTimeout(150);
    expect(await page.getByText("LATE_PAGE_TWO").count()).toBe(0);
    expect(await page.getByText("OTHER_RESULT").count()).toBe(1);
    await context.close();
  }, 30_000);
});
