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
});
