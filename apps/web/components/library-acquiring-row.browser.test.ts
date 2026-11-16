import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import type { ActivityActiveRunSummary, PostgresActivityPage } from "@media-track/workflow/activity-query";
import type { LibraryQueryItem, LibraryQueryPage } from "@media-track/workflow/library-query";

const enabled = process.env.RUN_LIBRARY_SCAN_BROWSER === "1";
const browserDescribe = enabled ? describe : describe.skip;
const PREVIEW_URL = "http://127.0.0.1:4326";

function previewItem(tmdbId: number): LibraryQueryItem {
  return {
    tmdbId, type: "movie", title: `PREVIEW_${tmdbId}`, year: 2025, posterPath: null,
    releaseDate: null, seasonCount: 0, obtainedEpisodes: 1, totalAiredEpisodes: 1,
    totalEpisodes: 1, state: "complete", airing: false, acquiring: false, autoAcquire: null,
  };
}

function previewPage(): LibraryQueryPage {
  return { items: Array.from({ length: 12 }, (_, index) => previewItem(index + 1)), total: 12, page: 1, pageSize: 48, hasMore: false };
}

function acquiringPage(): PostgresActivityPage {
  return {
    active: {
      items: [{
        runId: "active-outside-preview", kind: "movie_init", tmdbId: 9001,
        title: "ROW_ONLY_ACTIVE", year: 2025, type: "movie", posterPath: null,
        seasonNumber: null, seasonNumbers: [], status: "running", queuePosition: null,
        missingCount: 0, progress: null,
      }],
      total: 1, page: 1, pageSize: 48, hasMore: false,
    },
    totals: { queued: 0, running: 1, active: 1 },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

function activeRun(runId: string, tmdbId: number, type: "tv" | "movie", title: string): ActivityActiveRunSummary {
  return {
    runId, kind: type === "movie" ? "movie_init" : "type2_init", tmdbId, title,
    year: 2025, type, posterPath: null, seasonNumber: type === "movie" ? null : 1,
    seasonNumbers: type === "movie" ? [] : [1], status: "running", queuePosition: null,
    missingCount: 0, progress: null,
  };
}

function otherTypePage(): PostgresActivityPage {
  return {
    active: {
      items: Array.from({ length: 48 }, (_, index) => activeRun(`tv-${index}`, 1000 + index, "tv", `TV_ACTIVE_${index}`)),
      total: 100, page: 1, pageSize: 48, hasMore: true,
    },
    totals: { queued: 0, running: 100, active: 100 },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

function duplicatePreviewPage(): LibraryQueryPage {
  return {
    items: [
      { ...previewItem(9001), title: "ACTIVE_DUP" },
      ...Array.from({ length: 11 }, (_, index) => previewItem(index + 2)),
    ],
    total: 12, page: 1, pageSize: 48, hasMore: false,
  };
}

function duplicateSearchPage(): LibraryQueryPage {
  return { items: [
    { ...previewItem(9001), title: "ACTIVE_DUP" },
    { ...previewItem(9002), title: "SEARCH_NORMAL" },
  ], total: 2, page: 1, pageSize: 48, hasMore: false };
}

function snapshotBody(page: PostgresActivityPage, observedAt = "2026-11-16T00:00:00.000Z"): string {
  return `event: snapshot\ndata: ${JSON.stringify({ version: 1, observedAt, page })}\n\n`;
}

browserDescribe("LibraryAcquiringRow browser integration", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
  });
  afterAll(async () => { await browser?.close(); });

  it("shows a bounded active title outside the twelve previews with one shared-scope SSE", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    // Count live EventSource instances and the high-water mark. A dev StrictMode
    // remount may close/reopen sequentially; consumers on one scope must still
    // never create two live streams at once.
    await page.addInitScript(() => {
      const state = { opened: 0, active: 0, maximum: 0 };
      Object.defineProperty(window, "__libraryProgressEvents", { value: state });
      const NativeEventSource = window.EventSource;
      const CountedEventSource = function CountedEventSource(url: string | URL, init?: EventSourceInit) {
        const source = new NativeEventSource(url, init);
        if (String(url).includes("/api/library/progress")) {
          state.opened += 1;
          state.active += 1;
          state.maximum = Math.max(state.maximum, state.active);
          const close = source.close.bind(source);
          let closed = false;
          source.close = () => {
            if (!closed) { closed = true; state.active -= 1; }
            close();
          };
        }
        return source;
      } as unknown as typeof EventSource;
      CountedEventSource.prototype = NativeEventSource.prototype;
      window.EventSource = CountedEventSource;
    });

    let progressRequests = 0;
    await page.route("**/api/library/progress**", async (route) => {
      progressRequests += 1;
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
        body: snapshotBody(acquiringPage()),
      });
    });
    await page.route("**/api/library/activity**", async (route) => route.fulfill({ json: acquiringPage() }));
    await page.route("**/api/library/media**", async (route) => route.fulfill({ json: previewPage() }));

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    await page.getByText("PREVIEW_12", { exact: true }).waitFor();
    await page.getByText("ROW_ONLY_ACTIVE", { exact: true }).waitFor();

    const acquiring = page.locator('.category-section[aria-label="获取中"]');
    expect(await acquiring.getByRole("heading", { name: "获取中 1" }).count()).toBe(1);
    expect(await acquiring.locator("a.wall-card").count()).toBe(0);
    expect(await page.getByText("PREVIEW_1", { exact: true }).count()).toBe(1);
    expect(await page.getByText("ROW_ONLY_ACTIVE", { exact: true }).count()).toBe(1);

    const events = await page.evaluate(() => (window as unknown as {
      __libraryProgressEvents: { opened: number; active: number; maximum: number };
    }).__libraryProgressEvents);
    expect(events.opened).toBeGreaterThanOrEqual(1);
    expect(events.maximum).toBe(1);
    expect(progressRequests).toBe(1);
    await context.close();
  }, 30_000);

  it("keeps a neutral activity entry when the bounded page has only other media types", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/api/library/progress**", async (route) => route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      body: snapshotBody(otherTypePage()),
    }));
    await page.route("**/api/library/activity**", async (route) => route.fulfill({ json: otherTypePage() }));
    await page.route("**/api/library/media**", async (route) => route.fulfill({ json: previewPage() }));

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    await page.getByText("PREVIEW_12", { exact: true }).waitFor();
    await page.getByRole("heading", { name: "获取中活动", exact: true }).waitFor();
    const hint = page.locator('.category-section[aria-label="获取中活动"]');
    expect(await hint.getByRole("link", { name: "查看全部获取中活动（共 100 项）" }).count()).toBe(1);
    expect(await page.getByText("获取中 0", { exact: true }).count()).toBe(0);
    expect(await hint.locator(".wall-card").count()).toBe(0);
    await context.close();
  }, 30_000);

  it("renders an active identity once across the acquiring row, preview and search cards", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const active = {
      active: { items: [activeRun("dup-active", 9001, "movie", "ACTIVE_DUP")], total: 1, page: 1, pageSize: 48, hasMore: false },
      totals: { queued: 0, running: 1, active: 1 },
      recentCompleted: { items: [], nextCursor: null, hasMore: false },
    } satisfies PostgresActivityPage;
    await page.route("**/api/library/progress**", async (route) => route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      body: snapshotBody(active),
    }));
    await page.route("**/api/library/activity**", async (route) => route.fulfill({ json: active }));
    await page.route("**/api/library/media**", async (route) => {
      const search = new URL(route.request().url()).searchParams.get("search");
      await route.fulfill({ json: search ? duplicateSearchPage() : duplicatePreviewPage() });
    });

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    await page.getByText("PREVIEW_2", { exact: true }).waitFor();
    await page.getByText("ACTIVE_DUP", { exact: true }).waitFor();
    expect(await page.getByText("ACTIVE_DUP", { exact: true }).count()).toBe(1);

    await page.getByLabel("在库中查找").fill("active");
    await page.getByText("SEARCH_NORMAL", { exact: true }).waitFor();
    expect(await page.getByText("ACTIVE_DUP", { exact: true }).count()).toBe(1);
    expect(await page.getByText("SEARCH_NORMAL", { exact: true }).count()).toBe(1);
    expect(await page.getByText("匹配 2 部", { exact: true }).count()).toBe(1);
    await context.close();
  }, 30_000);

  it("uses the server-matched identity when only the original title matches", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const active = {
      active: { items: [activeRun("original-active", 7001, "movie", "DISPLAY_TITLE")], total: 1, page: 1, pageSize: 48, hasMore: false },
      totals: { queued: 0, running: 1, active: 1 },
      recentCompleted: { items: [], nextCursor: null, hasMore: false },
    } satisfies PostgresActivityPage;
    await page.route("**/api/library/progress**", async (route) => route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      body: snapshotBody(active),
    }));
    await page.route("**/api/library/activity**", async (route) => route.fulfill({ json: active }));
    await page.route("**/api/library/media**", async (route) => {
      const search = new URL(route.request().url()).searchParams.get("search");
      await route.fulfill({ json: search === "original"
        ? { items: [{ ...previewItem(7001), title: "DISPLAY_TITLE", acquiring: true }], total: 1, page: 1, pageSize: 48, hasMore: false }
        : previewPage() });
    });

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    await page.getByLabel("在库中查找").fill("original");
    await page.getByText("匹配 1 部", { exact: true }).waitFor();
    await page.getByText("DISPLAY_TITLE", { exact: true }).waitFor();
    expect(await page.getByText("DISPLAY_TITLE", { exact: true }).count()).toBe(1);
    expect(await page.locator(".poster-wall .wall-card").count()).toBe(0);
    expect(await page.locator('.category-section[aria-label="获取中"]').count()).toBe(1);
    expect(await page.getByText(/没找到/).count()).toBe(0);
    await context.close();
  }, 30_000);

  it("does not Enter a result that a newer shared snapshot has already marked active", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const active = {
      active: { items: [activeRun("enter-active", 9101, "movie", "ACTIVE_ENTER")], total: 1, page: 1, pageSize: 48, hasMore: false },
      totals: { queued: 0, running: 1, active: 1 },
      recentCompleted: { items: [], nextCursor: null, hasMore: false },
    } satisfies PostgresActivityPage;
    await page.route("**/api/library/progress**", async (route) => route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
      body: snapshotBody(active),
    }));
    await page.route("**/api/library/activity**", async (route) => route.fulfill({ json: active }));
    await page.route("**/api/library/media**", async (route) => {
      const search = new URL(route.request().url()).searchParams.get("search");
      await route.fulfill({ json: search === "ACTIVE_ENTER"
        ? { items: [{ ...previewItem(9101), title: "ACTIVE_ENTER", acquiring: false }], total: 1, page: 1, pageSize: 48, hasMore: false }
        : previewPage() });
    });

    await page.goto(`${PREVIEW_URL}/?tab=library&type=movie&filter=all`);
    await page.getByText("PREVIEW_12", { exact: true }).waitFor();
    const input = page.getByLabel("在库中查找");
    await input.fill("ACTIVE_ENTER");
    await page.getByText("匹配 1 部", { exact: true }).waitFor();
    await input.press("Enter");
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).not.toMatch(/^\/show\/9101$/u);
    expect(await page.locator('.category-section[aria-label="获取中"] .wall-card[aria-disabled]').count()).toBe(1);
    expect(await page.locator(".poster-wall .wall-card").count()).toBe(0);
    await context.close();
  }, 30_000);
});
