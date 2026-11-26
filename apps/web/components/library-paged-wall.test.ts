import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryQueryItem, LibraryQueryPage } from "@media-track/workflow/library-query";
import { LibraryPagedWall, type LibraryCategoryPreview } from "./library-paged-wall";

function item(type: "movie" | "tv" | "anime", state: LibraryQueryItem["state"]): LibraryQueryItem {
  return {
    tmdbId: 73, type, title: `${type} title`, year: 2025, posterPath: null, releaseDate: null,
    seasonCount: type === "movie" ? 0 : 1, obtainedEpisodes: 2, totalAiredEpisodes: 3,
    totalEpisodes: 5, state, airing: state === "partial", acquiring: false, autoAcquire: null,
  };
}

function page(items: LibraryQueryItem[], total = items.length): LibraryQueryPage {
  return { items, total, page: 1, pageSize: 12, hasMore: total > items.length };
}

describe("LibraryPagedWall", () => {
  it("renders bounded category previews with distinct movie and TV identity links", () => {
    const previews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([item("movie", "complete")], 80) },
      { type: "tv", page: page([item("tv", "partial")], 91) },
      { type: "anime", page: page([], 0) },
    ];
    const html = renderToStaticMarkup(createElement(LibraryPagedWall, { previews, mediaType: null, filter: "all" }));
    expect(html).toContain("电影 80");
    expect(html).toContain("电视剧 91");
    expect(html).toContain("/show/73?from=library&amp;t=movie");
    expect(html).toContain("/show/73?from=library&amp;t=tv");
    expect(html).toContain("有缺集");
  });

  it("keeps acquiring items as non-clickable placeholders", () => {
    const previews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([{ ...item("movie", "complete"), acquiring: true }]) },
      { type: "tv", page: page([]) },
      { type: "anime", page: page([]) },
    ];
    const html = renderToStaticMarkup(createElement(LibraryPagedWall, { previews, mediaType: null, filter: "all" }));
    expect(html).toContain("获取中");
    expect(html).not.toContain("/show/73?from=library&amp;t=movie");
  });

  it("renders tmdbImageUrl proxy paths, toolbar controls and summary bar", () => {
    const previews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([{ ...item("movie", "complete"), posterPath: "/poster-movie.jpg" }], 12) },
      { type: "tv", page: page([{ ...item("tv", "tracking"), posterPath: "https://evil.example/x.jpg" }], 5) },
      { type: "anime", page: page([], 0) },
    ];
    const html = renderToStaticMarkup(createElement(LibraryPagedWall, {
      previews,
      mediaType: null,
      filter: "all",
      storages: [{ id: "drive-a", label: "夸克网盘" }],
    }));
    expect(html).toContain("/api/tmdb/image/w342/poster-movie.jpg");
    expect(html).not.toContain("image.tmdb.org");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("共 17 部");
    expect(html).toContain("最近更新");
    expect(html).toContain("夸克网盘");
    expect(html).toContain("海报墙");
    expect(html).toContain("紧凑列表");
  });
});
