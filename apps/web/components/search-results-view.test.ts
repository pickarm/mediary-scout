import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchCandidateCard } from "@media-track/workflow/search-view";

const h = vi.hoisted(() => ({
  filter: "all" as "all" | "movie" | "tv",
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      if (initial === "all") {
        return [
          h.filter as unknown as T,
          (next: T | ((prev: T) => T)) => {
            h.filter = (
              typeof next === "function" ? (next as (p: "all" | "movie" | "tv") => "all" | "movie" | "tv")(h.filter) : next
            ) as "all" | "movie" | "tv";
          },
        ] as const;
      }
      return actual.useState(initial);
    },
  };
});

vi.mock("../lib/use-router", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../lib/use-demo-session", () => ({
  useDemoAcquiredTmdbIds: () => new Set<number>(),
  useDemoAcquisitions: () => [],
  useDemoInProgress: () => [],
}));
vi.mock("./acquire-progress-badge", () => ({
  AcquireProgressBadge: ({ tmdbId }: { tmdbId: number }) => `acquiring:${tmdbId}`,
}));

import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  filterSearchResultItems,
  SearchResultsView,
  type SearchResultCardItem,
} from "./search-results-view";

function candidate(over: Partial<SearchCandidateCard> & { tmdbId: number; mediaType: "movie" | "tv"; title: string }): SearchCandidateCard {
  return {
    id: `tmdb_${over.mediaType}_${over.tmdbId}`,
    originalTitle: over.title,
    year: 2025,
    overview: "简介",
    posterPath: "/poster.jpg",
    backdropPath: null,
    selectedSeasonNumber: null,
    totalEpisodes: null,
    latestAiredEpisode: null,
    seasonNumbers: [],
    action: { state: "can_request", label: "获取", disabled: false, workflowRunId: null },
    ...over,
  };
}

function item(over: Partial<SearchCandidateCard> & { tmdbId: number; mediaType: "movie" | "tv"; title: string }): SearchResultCardItem {
  return {
    candidate: candidate(over),
    acquiring: false,
    trackedLabel: null,
    trackedSeasonNumbers: [],
  };
}

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (match(element)) return element;
  return find(element.props.children, match);
}

describe("filterSearchResultItems", () => {
  const list: SearchResultCardItem[] = [
    item({ tmdbId: 1, mediaType: "movie", title: "电影甲" }),
    item({ tmdbId: 2, mediaType: "tv", title: "剧集乙", seasonNumbers: [1] }),
  ];

  it("按全部 / 电影 / 剧集过滤且不修改原数组", () => {
    expect(filterSearchResultItems(list, "all")).toHaveLength(2);
    expect(filterSearchResultItems(list, "movie").map((i) => i.candidate.tmdbId)).toEqual([1]);
    expect(filterSearchResultItems(list, "tv").map((i) => i.candidate.tmdbId)).toEqual([2]);
  });
});

describe("SearchResultsView", () => {
  beforeEach(() => {
    h.filter = "all";
  });

  it("展示搜索命中总数、筛选胶囊、站内图片代理与无预取分季剧集的查看详情按钮", () => {
    const items: SearchResultCardItem[] = [
      item({ tmdbId: 101, mediaType: "movie", title: "星际穿越", posterPath: "/m101.jpg" }),
      item({ tmdbId: 202, mediaType: "tv", title: "未预取详情剧集", posterPath: "/tv202.jpg", seasonNumbers: [] }),
      item({ tmdbId: 203, mediaType: "tv", title: "已预取详情剧集", posterPath: "/tv203.jpg", seasonNumbers: [1, 2] }),
    ];

    const markup = renderToStaticMarkup(
      createElement(SearchResultsView, {
        query: "星际",
        cacheStatus: "hit",
        items,
        storageId: "cs_2",
      }),
    );

    expect(markup).toContain("共找到 3 条结果");
    expect(markup).toContain("来自缓存");
    expect(markup).toContain("全部 (3)");
    expect(markup).toContain("电影 (1)");
    expect(markup).toContain("剧集 (2)");
    expect(markup).toContain("/api/tmdb/image/w342/m101.jpg");
    expect(markup).not.toContain("image.tmdb.org");
    expect(markup).toContain('href="/show/202?from=search&amp;w=cs_2&amp;t=tv"');
    expect(markup).toContain("查看详情");

    // 切换为仅看电影
    const props = { query: "星际", cacheStatus: "hit" as const, items, storageId: "cs_2" };
    const moviePill = find(
      SearchResultsView(props),
      (el) => el.type === "button" && String((el.props as { children?: ReactNode }).children).includes("电影"),
    );
    expect(moviePill).not.toBeNull();
    (moviePill!.props as { onClick: () => void }).onClick();

    const filteredMarkup = renderToStaticMarkup(createElement(SearchResultsView, props));
    expect(filteredMarkup).toContain("星际穿越");
    expect(filteredMarkup).not.toContain("未预取详情剧集");
    expect(filteredMarkup).not.toContain("已预取详情剧集");
  });

  it("筛选结果为空时提供一键切回全部", () => {
    h.filter = "tv";
    const items: SearchResultCardItem[] = [item({ tmdbId: 101, mediaType: "movie", title: "纯电影" })];
    const markup = renderToStaticMarkup(
      createElement(SearchResultsView, {
        query: "纯电影",
        cacheStatus: "miss",
        items,
      }),
    );
    expect(markup).toContain("当前筛选下没有剧集结果");
    expect(markup).toContain("查看全部 (1)");
  });
});
