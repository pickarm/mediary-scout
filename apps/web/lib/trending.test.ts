import { describe, expect, it, vi } from "vitest";
import {
  createEpisodeStates,
  type PersistedWorkflowRunSnapshot,
  type TrackedSeasonState,
} from "@media-track/workflow";
import {
  animeFirstAirDateFloor,
  mapTrendingResults,
  resolveTrendingLibraryBadges,
  TRENDING_KINDS,
  trendingFeedQuery,
  trendingIdentityKey,
  type TrendingCard,
} from "./trending";

describe("trending feed contract (must match workers/tmdb-proxy getTrendingFeeds)", () => {
  // The Worker Cron warms KV under cacheKeyFor(path + sorted query). The frontend
  // reads the SAME feed. cacheKeyFor sorts params, so what must match is the param
  // SET, captured here as the sorted querystring. If you edit one side, this fails.
  const sortedQuery = (query: Record<string, string>) =>
    new URLSearchParams([...Object.entries(query)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();

  it("movie feed = trending/movie/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.movie.path).toBe("trending/movie/week");
    expect(sortedQuery(TRENDING_KINDS.movie.query)).toBe("language=zh-CN");
  });

  it("tv feed = trending/tv/week?language=zh-CN", () => {
    expect(TRENDING_KINDS.tv.path).toBe("trending/tv/week");
    expect(sortedQuery(TRENDING_KINDS.tv.query)).toBe("language=zh-CN");
  });

  it("anime feed = recent (first_air_date rolls to <year-1>-01-01) + mainstream (vote_count.gte=50) + no adult", () => {
    expect(TRENDING_KINDS.anime.path).toBe("discover/tv");
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("anime", now))).toBe(
      "first_air_date.gte=2025-01-01&include_adult=false&language=zh-CN&sort_by=popularity.desc&vote_count.gte=50&with_genres=16&with_original_language=ja",
    );
  });

  it("movie/tv feed queries carry no dynamic date (unchanged)", () => {
    const now = new Date("2026-07-04T00:00:00Z");
    expect(sortedQuery(trendingFeedQuery("movie", now))).toBe("language=zh-CN");
    expect(sortedQuery(trendingFeedQuery("tv", now))).toBe("language=zh-CN");
  });

  it("anime first-air-date floor rolls with the year (last calendar year onward)", () => {
    expect(animeFirstAirDateFloor(new Date("2026-07-04T00:00:00Z"))).toBe("2025-01-01");
    expect(animeFirstAirDateFloor(new Date("2027-01-01T00:00:00Z"))).toBe("2026-01-01");
  });
});

describe("mapTrendingResults", () => {
  it("maps a movie result (title/release_date/poster_path)", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 27205, title: "盗梦空间", release_date: "2010-07-15", poster_path: "/a.jpg" }] },
      "movie",
    );
    expect(cards).toEqual([
      { tmdbId: 27205, title: "盗梦空间", year: 2010, posterPath: "/a.jpg", mediaType: "movie" },
    ]);
  });

  it("maps a tv/anime result (name/first_air_date) to mediaType tv", () => {
    const cards = mapTrendingResults(
      { results: [{ id: 240411, name: "葬送的芙莉莲", first_air_date: "2023-09-29", poster_path: "/b.jpg" }] },
      "anime",
    );
    expect(cards).toEqual([
      { tmdbId: 240411, title: "葬送的芙莉莲", year: 2023, posterPath: "/b.jpg", mediaType: "tv" },
    ]);
  });

  it("keeps a missing poster_path as null", () => {
    const cards = mapTrendingResults({ results: [{ id: 1, title: "X", release_date: "2020-01-01" }] }, "movie");
    expect(cards[0]!.posterPath).toBeNull();
  });

  it("drops entries with no id or no title, and yields [] on a missing results array", () => {
    expect(mapTrendingResults({ results: [{ title: "no id" }, { id: 2 }] }, "movie")).toEqual([]);
    expect(mapTrendingResults({}, "movie")).toEqual([]);
    expect(mapTrendingResults(null, "movie")).toEqual([]);
  });

  it("null/empty air date → year null", () => {
    const cards = mapTrendingResults({ results: [{ id: 3, title: "Y" }] }, "movie");
    expect(cards[0]!.year).toBeNull();
  });
});

describe("resolveTrendingLibraryBadges", () => {
  const movieCard: TrendingCard = {
    tmdbId: 27205,
    title: "盗梦空间",
    year: 2010,
    posterPath: "/m.jpg",
    mediaType: "movie",
  };
  const tvCard: TrendingCard = {
    tmdbId: 240411,
    title: "葬送的芙莉莲",
    year: 2023,
    posterPath: "/t.jpg",
    mediaType: "tv",
  };

  function makeState(over: {
    tmdbId: number;
    type: "movie" | "tv" | "anime";
    title: string;
    seasonNumber?: number;
    status?: "active" | "completed";
    totalEpisodes?: number;
    latestAiredEpisode?: number;
    obtainedCount?: number;
    releaseDate?: string | null;
  }): TrackedSeasonState {
    const total = over.totalEpisodes ?? 1;
    const aired = over.latestAiredEpisode ?? total;
    const seasonNumber = over.seasonNumber ?? 1;
    const titleId = `tmdb_${over.type === "movie" ? "movie" : "tv"}_${over.tmdbId}`;
    const seasonId = over.type === "movie" ? `${titleId}_movie` : `${titleId}_s${seasonNumber}`;
    const obtained = over.obtainedCount ?? total;
    return {
      accountId: "acct_1",
      connectedStorageId: "cs_1",
      title: {
        id: titleId,
        tmdbId: over.tmdbId,
        type: over.type,
        title: over.title,
        originalTitle: over.title,
        year: 2025,
        aliases: [],
        releaseDate: over.releaseDate ?? null,
      },
      season: {
        id: seasonId,
        mediaTitleId: titleId,
        seasonNumber,
        status: over.status ?? "completed",
        qualityPreference: "4K",
        storageDirectoryId: "dir_1",
        totalEpisodes: total,
        latestAiredEpisode: aired,
        latestAiredSource: "metadata",
      },
      episodes: createEpisodeStates({
        trackedSeasonId: seasonId,
        seasonNumber,
        totalEpisodes: total,
        latestAiredEpisode: aired,
      }).map((ep, idx) => ({ ...ep, obtained: idx < obtained })),
    };
  }

  it("为已入库电影、追更中动漫和获取中任务返回对应徽章", () => {
    const badges = resolveTrendingLibraryBadges(
      [movieCard, tvCard],
      [
        makeState({ tmdbId: 27205, type: "movie", title: "盗梦空间", obtainedCount: 1 }),
        makeState({
          tmdbId: 240411,
          type: "anime",
          title: "葬送的芙莉莲",
          status: "active",
          totalEpisodes: 28,
          latestAiredEpisode: 12,
          obtainedCount: 12,
        }),
      ],
      [],
    );

    expect(badges.get(trendingIdentityKey("movie", 27205))).toEqual({ label: "已入库", tone: "green" });
    expect(badges.get(trendingIdentityKey("tv", 240411))).toEqual({ label: "追更中", tone: "indigo" });
  });

  it("进行中的获取任务优先级高于已入库快照", () => {
    const activeRun = {
      title: {
        id: "tmdb_movie_27205",
        tmdbId: 27205,
        type: "movie",
        title: "盗梦空间",
        originalTitle: "Inception",
        year: 2010,
        aliases: [],
      },
      workflowRun: {
        id: "run_1",
        kind: "movie_init",
        status: "running",
        trackedSeasonId: "tmdb_movie_27205_movie",
        startedAt: "2026-11-26T00:00:00.000Z",
        finishedAt: null,
        auditEvents: [],
      },
    } as unknown as PersistedWorkflowRunSnapshot;

    const badges = resolveTrendingLibraryBadges([movieCard], [], [activeRun]);
    expect(badges.get(trendingIdentityKey("movie", 27205))).toEqual({ label: "获取中", tone: "indigo" });
  });
});

describe("TrendingRow 渲染", () => {
  it("热门卡片使用 showHref + t 参数直达详情页，使用代理海报并叠加状态徽章", async () => {
    vi.resetModules();
    const movieCard: TrendingCard = {
      tmdbId: 27205,
      title: "盗梦空间",
      year: 2010,
      posterPath: "/inception.jpg",
      mediaType: "movie",
    };
    vi.doMock("./trending", async () => {
      const actual = await vi.importActual<typeof import("./trending")>("./trending");
      return {
        ...actual,
        getTrending: async () => [movieCard],
        getTrendingLibraryBadges: async () =>
          new Map([[actual.trendingIdentityKey("movie", 27205), { label: "已入库", tone: "green" }]]),
      };
    });
    const { TrendingRow } = await import("../components/trending-row");
    const { renderToStaticMarkup } = await import("react-dom/server");

    const element = await TrendingRow({ activeKind: "movie", basePath: "/w/cs_2", storageId: "cs_2" });
    const markup = renderToStaticMarkup(element);

    expect(markup).toContain('href="/show/27205?from=search&amp;w=cs_2&amp;t=movie"');
    expect(markup).toContain("/api/tmdb/image/w342/inception.jpg");
    expect(markup).not.toContain("image.tmdb.org");
    expect(markup).toContain("已入库");
  });
});
