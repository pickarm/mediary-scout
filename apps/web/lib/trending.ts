import {
  fetchTmdbList,
  isMovieUnreleased,
  isUserVisibleWorkflowKind,
  type PersistedWorkflowRunSnapshot,
  type TrackedSeasonState,
} from "@media-track/workflow";
import { libraryWallState } from "./title-aggregate";
import {
  ensureDemoSeeded,
  getAccountScopedSettings,
  getActiveWorkspaceScope,
  getCurrentAccountId,
  getTmdbAccesses,
  getWorkflowRepository,
} from "./workflow-runtime";

export interface TrendingLibraryBadge {
  label: "已入库" | "追更中" | "部分入库" | "已预定" | "获取中" | "已追踪";
  tone: "green" | "indigo" | "amber" | "blue";
}

export function trendingIdentityKey(mediaType: "movie" | "tv", tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export type TrendingKind = "movie" | "tv" | "anime";

export interface TrendingCard {
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
  mediaType: "movie" | "tv";
}

/** The three discovery feeds, aligned to the app's 电影/剧集/动漫 library types.
 *  path + query MUST match workers/tmdb-proxy TRENDING_FEEDS so the proxy serves
 *  the Cron-warmed KV entry (cacheKey = path + sorted query). */
export const TRENDING_KINDS: Record<
  TrendingKind,
  { label: string; path: string; query: Record<string, string>; mediaType: "movie" | "tv" }
> = {
  movie: { label: "热门电影", path: "trending/movie/week", query: { language: "zh-CN" }, mediaType: "movie" },
  tv: { label: "热门剧集", path: "trending/tv/week", query: { language: "zh-CN" }, mediaType: "tv" },
  anime: {
    label: "热门动漫",
    path: "discover/tv",
    // 静态参数;动态 first_air_date.gte 由 trendingFeedQuery 注入(见下)。
    // include_adult=false + vote_count.gte=50 挡成人/里番,只留主流;first_air_date
    // 门槛保证「近期」而非史上最热老番。契约=与 workers/tmdb-proxy getTrendingFeeds
    // 的 anime feed 同 `now` **参数集(名+值)一致**即可,顺序无关(cacheKeyFor 两边都排序)。
    query: {
      include_adult: "false",
      language: "zh-CN",
      sort_by: "popularity.desc",
      "vote_count.gte": "50",
      with_genres: "16",
      with_original_language: "ja",
    },
    mediaType: "tv",
  },
};

export const TRENDING_KIND_ORDER: TrendingKind[] = ["movie", "tv", "anime"];

/** Last-calendar-year floor (rolls yearly): the anime feed shows RECENT seasons,
 *  not TMDB's all-time-popularity classics (全职猎人1999/死神2004…). MUST match
 *  workers/tmdb-proxy handler.ts animeFirstAirDateFloor. */
export function animeFirstAirDateFloor(now: Date = new Date()): string {
  return `${now.getUTCFullYear() - 1}-01-01`;
}

/** The query for a feed, with the rolling first_air_date.gte injected for anime.
 *  MUST match workers/tmdb-proxy getTrendingFeeds for the same `now` — cacheKeyFor
 *  sorts params, so the param SET (not order) is the contract. */
export function trendingFeedQuery(kind: TrendingKind, now: Date = new Date()): Record<string, string> {
  const query = { ...TRENDING_KINDS[kind].query };
  if (kind === "anime") {
    query["first_air_date.gte"] = animeFirstAirDateFloor(now);
  }
  return query;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function yearOf(value: unknown): number | null {
  if (typeof value !== "string" || value.length < 4) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** Pure: TMDB list body → cards. Tolerates movie(title/release_date) and
 *  tv(name/first_air_date); drops idless/titleless rows; [] on any bad shape. */
export function mapTrendingResults(raw: unknown, kind: TrendingKind): TrendingCard[] {
  const results = isRecord(raw) && Array.isArray(raw.results) ? raw.results : [];
  const mediaType = TRENDING_KINDS[kind].mediaType;
  const cards: TrendingCard[] = [];
  for (const item of results) {
    if (!isRecord(item)) continue;
    const tmdbId = typeof item.id === "number" ? item.id : null;
    const title =
      typeof item.title === "string" ? item.title : typeof item.name === "string" ? item.name : null;
    if (tmdbId === null || !title) continue;
    const poster = typeof item.poster_path === "string" ? item.poster_path : null;
    cards.push({
      tmdbId,
      title,
      year: yearOf(item.release_date) ?? yearOf(item.first_air_date),
      posterPath: poster,
      mediaType,
    });
  }
  return cards;
}

/** Fetch + map one feed. Any failure → [] (silent degrade; the row hides and the
 *  search page falls back to its original empty state). Never throws. */
export async function getTrending(kind: TrendingKind): Promise<TrendingCard[]> {
  try {
    const accesses = await getTmdbAccesses(getAccountScopedSettings(await getCurrentAccountId()));
    const raw = await fetchTmdbList(accesses, TRENDING_KINDS[kind].path, trendingFeedQuery(kind));
    return mapTrendingResults(raw, kind).slice(0, 12);
  } catch {
    return [];
  }
}

/** 纯函数：根据当前工作区的追踪状态与活跃任务计算热门卡片的库内状态徽章。 */
export function resolveTrendingLibraryBadges(
  cards: readonly TrendingCard[],
  trackedStates: readonly TrackedSeasonState[],
  activeRuns: readonly PersistedWorkflowRunSnapshot[],
  now: string = new Date().toISOString(),
): Map<string, TrendingLibraryBadge> {
  const badges = new Map<string, TrendingLibraryBadge>();
  if (cards.length === 0) {
    return badges;
  }

  const cardKeys = new Set(cards.map((card) => trendingIdentityKey(card.mediaType, card.tmdbId)));
  const acquiringKeys = new Set<string>();
  for (const snapshot of activeRuns) {
    if (
      snapshot.workflowRun.kind === "replace_request" ||
      !isUserVisibleWorkflowKind(snapshot.workflowRun.kind)
    ) {
      continue;
    }
    const key = trendingIdentityKey(snapshot.title.type === "movie" ? "movie" : "tv", snapshot.title.tmdbId);
    if (cardKeys.has(key)) {
      acquiringKeys.add(key);
    }
  }

  const statesByKey = new Map<string, TrackedSeasonState[]>();
  for (const state of trackedStates) {
    const key = trendingIdentityKey(state.title.type === "movie" ? "movie" : "tv", state.title.tmdbId);
    if (!cardKeys.has(key)) {
      continue;
    }
    const list = statesByKey.get(key) ?? [];
    list.push(state);
    statesByKey.set(key, list);
  }

  for (const card of cards) {
    const key = trendingIdentityKey(card.mediaType, card.tmdbId);
    if (acquiringKeys.has(key)) {
      badges.set(key, { label: "获取中", tone: "indigo" });
      continue;
    }
    const group = statesByKey.get(key);
    if (!group || group.length === 0) {
      continue;
    }
    if (card.mediaType === "movie") {
      const primary = group[0]!;
      const unreleased = isMovieUnreleased(primary.title.releaseDate, now);
      const obtained = group.some((s) => s.episodes.some((ep) => ep.obtained));
      if (unreleased && !obtained) {
        badges.set(key, { label: "已预定", tone: "blue" });
      } else if (obtained) {
        badges.set(key, { label: "已入库", tone: "green" });
      } else {
        badges.set(key, { label: "已追踪", tone: "amber" });
      }
      continue;
    }

    const bySeason = new Map<number, TrackedSeasonState[]>();
    for (const state of group) {
      const list = bySeason.get(state.season.seasonNumber) ?? [];
      list.push(state);
      bySeason.set(state.season.seasonNumber, list);
    }
    let obtained = 0;
    let aired = 0;
    let anyActive = false;
    for (const seasonStates of bySeason.values()) {
      const primary = seasonStates.reduce((best, cur) =>
        cur.season.latestAiredEpisode > best.season.latestAiredEpisode ? cur : best,
      );
      const seasonAired = Math.min(primary.season.latestAiredEpisode, primary.season.totalEpisodes);
      aired += seasonAired;
      const obtainedCodes = new Set<string>();
      for (const s of seasonStates) {
        for (const ep of s.episodes) {
          if (ep.obtained) obtainedCodes.add(ep.episodeCode);
        }
      }
      const seasonObtained = obtainedCodes.size;
      obtained += seasonObtained;
      const allAiredObtained =
        primary.season.totalEpisodes > 0 &&
        primary.season.latestAiredEpisode >= primary.season.totalEpisodes &&
        seasonObtained >= seasonAired;
      if (!allAiredObtained && seasonStates.some((s) => s.season.status === "active")) {
        anyActive = true;
      }
    }
    const wallState = libraryWallState({ obtained, aired, anyActive, unreleased: false });
    if (wallState === "complete") {
      badges.set(key, { label: "已入库", tone: "green" });
    } else if (wallState === "tracking" || anyActive) {
      badges.set(key, { label: "追更中", tone: "indigo" });
    } else {
      badges.set(key, { label: "部分入库", tone: "amber" });
    }
  }

  return badges;
}

/** 读取当前账号/工作区下的热门卡片已入库与追更状态；失败静默回退为空 Map。 */
export async function getTrendingLibraryBadges(
  cards: readonly TrendingCard[],
  storageId?: string,
): Promise<Map<string, TrendingLibraryBadge>> {
  if (cards.length === 0) {
    return new Map();
  }
  try {
    const repository = getWorkflowRepository();
    await ensureDemoSeeded(repository);
    const scope = await getActiveWorkspaceScope(storageId);
    const allMovies = cards.every((card) => card.mediaType === "movie");
    const [activeRuns, trackedStates] = await Promise.all([
      repository.listActiveWorkflowRuns(scope),
      allMovies && scope.connectedStorageId !== null
        ? Promise.all(
            cards.map((card) =>
              repository.getTrackedSeasonState(`tmdb_movie_${card.tmdbId}_movie`, scope),
            ),
          ).then((rows) => rows.filter((row): row is TrackedSeasonState => row !== null))
        : repository.listTrackedSeasonStates(scope),
    ]);
    return resolveTrendingLibraryBadges(cards, trackedStates, activeRuns);
  } catch {
    return new Map();
  }
}
