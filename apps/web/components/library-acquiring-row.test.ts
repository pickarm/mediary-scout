import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ActivityActiveRunSummary, PostgresActivityPage } from "@media-track/workflow/activity-query";
import {
  dedupeLibraryAcquiringTitles,
  LibraryAcquiringRow,
} from "./library-acquiring-row";

function run(over: Partial<ActivityActiveRunSummary> & { runId: string; title: string }): ActivityActiveRunSummary {
  return {
    kind: "movie_init",
    tmdbId: 1,
    year: 2025,
    type: "movie",
    posterPath: null,
    seasonNumber: null,
    seasonNumbers: [],
    status: "running",
    queuePosition: null,
    missingCount: 0,
    progress: null,
    ...over,
  };
}

function progressPage(items: ActivityActiveRunSummary[], total = items.length, hasMore = false): PostgresActivityPage {
  return {
    active: { items, total: items.length, page: 1, pageSize: 48, hasMore },
    totals: { queued: items.filter((item) => item.status === "queued").length, running: items.filter((item) => item.status === "running").length, active: total },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

describe("LibraryAcquiringRow", () => {
  it("dedupes by media type plus TMDB id and applies the category filter", () => {
    const runs = [
      run({ runId: "m1-a", tmdbId: 7, title: "电影七" }),
      run({ runId: "m1-b", tmdbId: 7, title: "电影七重复" }),
      run({ runId: "tv1", tmdbId: 7, type: "tv", title: "剧集七", seasonNumber: 1, seasonNumbers: [1] }),
      run({ runId: "m2", tmdbId: 8, title: "电影八" }),
    ];
    expect(dedupeLibraryAcquiringTitles(runs, null).map((title) => `${title.type}:${title.tmdbId}`)).toEqual([
      "movie:7",
      "tv:7",
      "movie:8",
    ]);
    expect(dedupeLibraryAcquiringTitles(runs, "movie").map((title) => title.title)).toEqual(["电影七", "电影八"]);
  });

  it("keeps the original non-clickable poster row and links the bounded remainder to activity", () => {
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      mediaType: null,
      storageId: "drive-a",
      page: progressPage([
        run({ runId: "active-movie", tmdbId: 11, title: "预览外的电影" }),
        run({ runId: "active-tv", tmdbId: 11, type: "tv", title: "预览外的剧集", year: null, seasonNumber: 1, seasonNumbers: [1] }),
      ], 5, true),
    }));
    expect(markup).toContain("获取中 2");
    expect(markup).toContain("预览外的电影");
    expect(markup).toContain("预览外的剧集");
    expect(markup).toContain("年份未知 · 正在获取");
    expect(markup).toContain("title=\"获取中，完成后可进入\"");
    expect(markup).not.toMatch(/<a[^>]*class="wall-card"/u);
    expect(markup).toContain("href=\"/activity?w=drive-a\"");
    expect(markup).toContain("查看全部获取中活动（共 5 项）");
  });

  it("filters a category view and always keeps an activity route for its bounded page", () => {
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      mediaType: "movie",
      storageId: undefined,
      page: progressPage([
        run({ runId: "movie", tmdbId: 21, title: "电影进行中" }),
        run({ runId: "tv", tmdbId: 22, type: "tv", title: "剧集进行中" }),
      ]),
    }));
    expect(markup).toContain("获取中 1");
    expect(markup).toContain("电影进行中");
    expect(markup).not.toContain("剧集进行中");
    expect(markup).toContain("href=\"/activity\"");
  });

  it("shows a neutral activity entry when a bounded category page contains only other media types", () => {
    const items = Array.from({ length: 3 }, (_, index) => run({
      runId: `tv-${index}`,
      tmdbId: 100 + index,
      type: "tv",
      title: `剧集 ${index}`,
      seasonNumber: 1,
      seasonNumbers: [1],
    }));
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      mediaType: "movie",
      storageId: "drive-a",
      page: progressPage(items, 100, true),
    }));
    expect(markup).toContain("获取中活动");
    expect(markup).not.toContain("获取中 0");
    expect(markup).toContain("当前有界列表未包含本分类作品，可查看全部活动。");
    expect(markup).toContain("查看全部获取中活动（共 100 项）");
    expect(markup).toContain("href=\"/activity?w=drive-a\"");
  });

  it("matches the client search text while preserving type-plus-TMDB identity", () => {
    const page = progressPage([
      run({ runId: "movie", tmdbId: 50, title: "Active Movie" }),
      run({ runId: "tv", tmdbId: 50, type: "tv", title: "Active Show", seasonNumber: 1, seasonNumbers: [1] }),
      run({ runId: "other", tmdbId: 51, title: "Other Movie" }),
    ]);
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      page,
      mediaType: null,
      search: "active",
    }));
    expect(markup).toContain("获取中 2");
    expect(markup).toContain("Active Movie");
    expect(markup).toContain("Active Show");
    expect(markup).not.toContain("Other Movie");
    expect(renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      page,
      mediaType: null,
      search: "no match",
    }))).toBe("");
  });

  it("includes only server-matched active identities when the display title does not match", () => {
    const page = progressPage([
      run({ runId: "display-a", tmdbId: 7001, title: "中文显示名" }),
      run({ runId: "display-b", tmdbId: 7001, title: "中文显示名重复" }),
    ]);
    expect(renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      page,
      mediaType: "movie",
      search: "original",
    }))).toBe("");
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      page,
      mediaType: "movie",
      search: "original",
      serverMatchedKeys: new Set(["movie:7001"]),
    }));
    expect((markup.match(/中文显示名/gu) ?? [])).toHaveLength(1);
    expect(markup).toContain("获取中 1");
  });

  it("renders nothing without a snapshot or matching active title", () => {
    expect(renderToStaticMarkup(createElement(LibraryAcquiringRow, { page: null, mediaType: null }))).toBe("");
    expect(renderToStaticMarkup(createElement(LibraryAcquiringRow, { page: progressPage([]), mediaType: "movie" }))).toBe("");
  });

  it("omits the more link when the single active title fills the bounded page", () => {
    const markup = renderToStaticMarkup(createElement(LibraryAcquiringRow, {
      page: progressPage([run({ runId: "one", tmdbId: 40, title: "唯一获取中" })]),
      mediaType: null,
    }));
    expect(markup).toContain("获取中 1");
    expect(markup).not.toContain("查看全部");
  });
});
