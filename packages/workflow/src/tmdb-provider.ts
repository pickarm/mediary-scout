import type {
  LatestAiredSource,
  MediaTitle,
  MediaType,
  TrackedSeason,
} from "./domain.js";
import { classifyMediaType } from "./media-classification.js";
import type { MediaSearchCandidate, MediaSearchProvider } from "./search-view.js";

/** Refine a TV details record into tv/anime by genre + origin. */
function tvMediaType(details: TmdbTvDetails): MediaType {
  return classifyMediaType({
    baseType: "tv",
    genreIds: details.genres,
    originCountries: details.origin_country,
  });
}

export interface TmdbFetchInit {
  method: "GET";
  headers: Record<string, string>;
  /** Per-hop timeout the access chain picked for this access (direct = fail-fast,
   *  proxy = patient). defaultFetchJson honors it; injected fetchJson may ignore. */
  timeoutMs?: number;
}

export type TmdbFetchJson = (url: string, init: TmdbFetchInit) => Promise<unknown>;

export class TmdbHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "TmdbHttpError";
    this.status = status;
  }
}

export class TmdbNotFoundError extends TmdbHttpError {
  constructor(message: string) {
    super(message, 404);
    this.name = "TmdbNotFoundError";
  }
}

export const TMDB_DIRECT_BASE_URL = "https://api.themoviedb.org/3";

/** One way to reach TMDB: a base URL and an optional bearer token. The proxy
 *  access omits the token (the Worker injects the author's key server-side). */
export interface TmdbAccess {
  baseURL: string;
  readToken?: string;
}

function normalizeAccess(access: TmdbAccess): TmdbAccess {
  const baseURL = access.baseURL.replace(/\/+$/, "");
  return access.readToken === undefined ? { baseURL } : { baseURL, readToken: access.readToken };
}

const TMDB_DEAD_ACCESS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SEARCH_MAX_RESULTS = 40;
const DEFAULT_TV_DETAILS_LIMIT = 8;
const MAX_SEARCH_PAGES = 3;
const TV_DETAILS_CONCURRENCY = 6;
const MAX_CAST_MEMBERS = 10;

/** Shared 5-minute TTL circuit breaker for default-fetch TMDB accesses. */
const sharedDeadAccesses = new Map<string, number>();

export function resetSharedTmdbDeadAccessesForTests(): void {
  sharedDeadAccesses.clear();
}

function isDeadAccess(
  deadAccesses: Map<string, number> | undefined,
  key: string,
  now: number,
): boolean {
  if (!deadAccesses) return false;
  const expiresAt = deadAccesses.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    deadAccesses.delete(key);
    return false;
  }
  return true;
}

/** Try each access in order; first success wins, all-fail throws. This is the
 *  one chokepoint where user-key → proxy fallback lives.
 *
 *  `deadAccesses` (5-minute TTL map: shared across default-fetch callers, or
 *  per-instance when tests inject a custom `fetchJson`) memoizes which accesses
 *  have already failed so later calls skip them instead of re-paying the cost.
 *  Without it, a user TMDB token whose direct api.themoviedb.org hop is blocked
 *  makes EVERY call (a search fires ~11) re-time-out on that hop before falling
 *  back — the cumulative stall shows as "A server error occurred" (issue #68).
 *  Keyed by baseURL + token (accessKey), so two accesses sharing a host but
 *  carrying different tokens (user key, then env token) are tracked independently
 *  — a failing user key must not skip a still-working env-token access. When every
 *  access is already marked dead the map is left untouched and all are retried
 *  (the prior failures may have been transient) rather than throwing blind. */
async function fetchViaAccessChain(
  accesses: TmdbAccess[],
  path: string,
  query: Record<string, string>,
  fetchJson: TmdbFetchJson,
  deadAccesses?: Map<string, number>,
): Promise<unknown> {
  let lastError: unknown = new Error("no TMDB access configured");
  let sawTimeout = false;
  let allErrorsWereNotFound = accesses.length > 0;
  // NUL sentinel for a token-less access (undefined) so it never collides with a
  // real (even empty-string) token on the same host — the function treats those
  // distinctly when setting Authorization, and the dead key must too.
  const accessKey = (a: TmdbAccess) => `${a.baseURL}\n${a.readToken === undefined ? "\u0000" : a.readToken}`;
  const isTimeout = (error: unknown): boolean =>
    (error instanceof Error && error.name === "TimeoutError") || /timeout/i.test(String(error));
  const tryOnce = async (list: TmdbAccess[]): Promise<{ ok: true; value: unknown } | { ok: false }> => {
    for (const access of list) {
      const url = `${access.baseURL}/${path}?${new URLSearchParams(query).toString()}`;
      const headers: Record<string, string> = { "Content-Type": "application/json;charset=utf-8" };
      if (access.readToken !== undefined) {
        headers.Authorization = `Bearer ${access.readToken}`;
      }
      // Per-hop timeout: the DIRECT api.themoviedb.org hop keeps the fail-fast
      // budget (a GFW-blackholed connection must not stall the chain — #68/#69);
      // any OTHER hop is a proxy we chose on purpose (CF Worker / self-hosted),
      // whose round-trip from a China router measures ~2.4s baseline — live
      // stress-testing (2026-07-02) showed jitter breaching 4.5s and crashing
      // the search page / acquire action, so the proxy gets a patient budget.
      const timeoutMs = access.baseURL.includes("api.themoviedb.org")
        ? TMDB_DIRECT_TIMEOUT_MS
        : TMDB_PROXY_TIMEOUT_MS;
      try {
        const value = await fetchJson(url, { method: "GET", headers, timeoutMs });
        // Self-heal: a hop that answers is not dead — clear any stale mark so
        // later calls go straight through instead of relying on the all-dead
        // retry fallback.
        deadAccesses?.delete(accessKey(access));
        return { ok: true, value };
      } catch (error) {
        lastError = error;
        const notFound = error instanceof TmdbHttpError && error.status === 404;
        if (!notFound) {
          allErrorsWereNotFound = false;
        }
        if (isTimeout(error)) {
          sawTimeout = true;
        }
        // A 404 is this resource's answer, not a dead hop — the access responded.
        if (!notFound) {
          deadAccesses?.set(accessKey(access), Date.now() + TMDB_DEAD_ACCESS_TTL_MS);
        }
      }
    }
    return { ok: false };
  };
  const now = Date.now();
  const live = deadAccesses
    ? accesses.filter((a) => !isDeadAccess(deadAccesses, accessKey(a), now))
    : accesses;
  const candidates = live.length > 0 ? live : accesses;
  const first = await tryOnce(candidates);
  if (first.ok) {
    return first.value;
  }
  // A timeout is the transient failure mode (network jitter, Worker cold start)
  // — give the FULL chain exactly one more pass before surfacing an error to
  // the page/action. Non-timeout failures (401/404/parse) are deterministic;
  // retrying them only adds latency.
  if (sawTimeout) {
    const second = await tryOnce(accesses);
    if (second.ok) {
      return second.value;
    }
  }
  if (allErrorsWereNotFound) {
    throw new TmdbNotFoundError(`All ${candidates.length} TMDB access(es) returned HTTP 404`);
  }
  throw new Error(`All ${candidates.length} TMDB access(es) failed: ${String(lastError)}`);
}

/** Build the access list from either the new `accesses` or the legacy single
 *  `{readToken, baseURL}` options shape. */
function resolveAccesses(options: {
  accesses?: TmdbAccess[];
  readToken?: string;
  baseURL?: string;
}): TmdbAccess[] {
  if (options.accesses && options.accesses.length > 0) {
    return options.accesses.map(normalizeAccess);
  }
  if (options.readToken !== undefined) {
    return [normalizeAccess({ baseURL: options.baseURL ?? TMDB_DIRECT_BASE_URL, readToken: options.readToken })];
  }
  throw new Error("TmdbMetadataProvider requires `accesses` or `readToken`");
}

export interface TmdbMetadataProviderOptions {
  readToken?: string;
  accesses?: TmdbAccess[];
  baseURL?: string;
  language?: string;
  fetchJson?: TmdbFetchJson;
}

export interface TmdbSearchProviderOptions extends TmdbMetadataProviderOptions {
  maxResults?: number;
  tvDetailsLimit?: number;
}

export interface TvTrackingTargetInput {
  tmdbId: number;
  mediaType: Extract<MediaType, "tv">;
  seasonNumber: number;
  qualityPreference: string;
  storageDirectoryId?: string;
  metadataProvider: TmdbMetadataProvider;
  now?: Date;
}

export interface PreparedTrackingTarget {
  title: MediaTitle;
  season: TrackedSeason;
  keyword: string;
}

export interface TmdbCastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  original_name: string;
  first_air_date: string;
  number_of_episodes: number;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  last_episode_to_air?: {
    season_number?: number;
    episode_number?: number;
  } | null;
  seasons?: Array<{
    season_number?: number;
    episode_count?: number;
  }>;
  genres: number[];
  origin_country: string[];
  voteAverage?: number | null;
  genreNames?: string[];
  runtime?: number | null;
  cast?: TmdbCastMember[];
  creators?: string[];
}

export interface TmdbSeasonDetails {
  season_number: number;
  episodes?: Array<{
    episode_number?: number;
    name?: string | null;
    air_date?: string | null;
  }>;
}

interface TmdbEpisodeGroupSummary {
  id: string;
  type?: number;
}

interface TmdbEpisodeGroupEpisode {
  order?: number;
  name?: string | null;
  air_date?: string | null;
}

interface TmdbEpisodeGroupSubgroup {
  name: string;
  order?: number;
  episodes: TmdbEpisodeGroupEpisode[];
}

interface TmdbEpisodeGroupDetails {
  type?: number;
  groups: TmdbEpisodeGroupSubgroup[];
}

export interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title: string;
  release_date: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  genres: number[];
  origin_country: string[];
  voteAverage?: number | null;
  genreNames?: string[];
  runtime?: number | null;
  cast?: TmdbCastMember[];
  directors?: string[];
}

export class TmdbMetadataProvider {
  private readonly accesses: TmdbAccess[];
  private readonly language: string;
  private readonly fetchJson: TmdbFetchJson;
  /** Memo of accesses that already failed (issue #68): shared 5-minute TTL table
   *  when using default fetchJson; isolated per-instance when tests inject fetchJson. */
  private readonly deadAccesses: Map<string, number>;

  constructor(options: TmdbMetadataProviderOptions) {
    this.accesses = resolveAccesses(options);
    this.language = options.language ?? "zh-CN";
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.deadAccesses = options.fetchJson ? new Map<string, number>() : sharedDeadAccesses;
  }

  async getTvDetails(tmdbId: number): Promise<TmdbTvDetails> {
    return parseTvDetails(
      await this.get(`tv/${tmdbId}`, {
        language: this.language,
        append_to_response: "credits",
      }),
    );
  }

  async getTvSeason(tmdbId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
    return parseSeasonDetails(
      await this.get(`tv/${tmdbId}/season/${seasonNumber}`, {
        language: this.language,
      }),
    );
  }

  async getTvEpisodeGroups(tmdbId: number): Promise<TmdbEpisodeGroupSummary[]> {
    return parseEpisodeGroupSummaries(
      await this.get(`tv/${tmdbId}/episode_groups`, {
        language: this.language,
      }),
    );
  }

  async getTvEpisodeGroup(groupId: string): Promise<TmdbEpisodeGroupDetails> {
    return parseEpisodeGroupDetails(
      await this.get(`tv/episode_group/${encodeURIComponent(groupId)}`, {
        language: this.language,
      }),
    );
  }

  async getMovieDetails(tmdbId: number): Promise<TmdbMovieDetails> {
    return parseMovieDetails(
      await this.get(`movie/${tmdbId}`, {
        language: this.language,
        append_to_response: "credits",
      }),
    );
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    return fetchViaAccessChain(this.accesses, path, query, this.fetchJson, this.deadAccesses);
  }
}

export class TmdbSearchProvider implements MediaSearchProvider {
  private readonly accesses: TmdbAccess[];
  private readonly language: string;
  private readonly fetchJson: TmdbFetchJson;
  /** Memo of accesses that already failed (issue #68): shared 5-minute TTL table
   *  when using default fetchJson; isolated per-instance when tests inject fetchJson. */
  private readonly deadAccesses: Map<string, number>;
  private readonly maxResults: number;
  private readonly tvDetailsLimit: number;

  constructor(options: TmdbSearchProviderOptions) {
    this.accesses = resolveAccesses(options);
    this.language = options.language ?? "zh-CN";
    this.fetchJson = options.fetchJson ?? defaultFetchJson;
    this.deadAccesses = options.fetchJson ? new Map<string, number>() : sharedDeadAccesses;
    this.maxResults = options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS;
    this.tvDetailsLimit = options.tvDetailsLimit ?? DEFAULT_TV_DETAILS_LIMIT;
  }

  async searchMedia(input: { query: string }): Promise<MediaSearchCandidate[]> {
    const query = normalizeTitle(input.query);
    if (!query || this.maxResults <= 0) {
      return [];
    }

    const firstPage = await this.get("search/multi", {
      query,
      include_adult: "false",
      language: this.language,
      page: "1",
    });
    const rawResults: TmdbSearchResult[] = [...parseSearchResults(firstPage)];
    const totalPages = parseTotalPages(firstPage);
    let deduped = dedupeSearchResults(rawResults);

    if (deduped.length < this.maxResults && totalPages > 1) {
      const lastPage = Math.min(totalPages, MAX_SEARCH_PAGES);
      const extraPages = Array.from({ length: lastPage - 1 }, (_, index) => index + 2);
      const outcomes = await Promise.allSettled(
        extraPages.map((page) =>
          this.get("search/multi", {
            query,
            include_adult: "false",
            language: this.language,
            page: String(page),
          }),
        ),
      );
      for (const outcome of outcomes) {
        if (outcome.status === "fulfilled") {
          rawResults.push(...parseSearchResults(outcome.value));
        }
      }
      deduped = dedupeSearchResults(rawResults);
    }

    const results = deduped.slice(0, this.maxResults);
    const tvLimit = Math.max(0, this.tvDetailsLimit);
    const tvItems = results
      .filter((result): result is Extract<TmdbSearchResult, { media_type: "tv" }> => result.media_type === "tv")
      .slice(0, tvLimit);
    const tvDetailsById = new Map<number, TmdbTvDetails | null>();

    await mapWithConcurrency(tvItems, TV_DETAILS_CONCURRENCY, async (tv) => {
      try {
        tvDetailsById.set(tv.id, await this.getTvDetails(tv.id));
      } catch {
        tvDetailsById.set(tv.id, null);
      }
    });

    return results.map((result) =>
      result.media_type === "movie"
        ? movieSearchCandidate(result)
        : tvSearchCandidate(result, tvDetailsById.get(result.id) ?? null),
    );
  }

  private async getTvDetails(tmdbId: number): Promise<TmdbTvDetails> {
    return parseTvDetails(
      await this.get(`tv/${tmdbId}`, {
        language: this.language,
      }),
    );
  }

  private async get(path: string, query: Record<string, string>): Promise<unknown> {
    return fetchViaAccessChain(this.accesses, path, query, this.fetchJson, this.deadAccesses);
  }
}

export function createTmdbMetadataProvider(
  accesses: TmdbAccess[],
  opts: { language?: string; fetchJson?: TmdbFetchJson } = {},
): TmdbMetadataProvider {
  return new TmdbMetadataProvider({ accesses, ...opts });
}

export function createTmdbSearchProvider(
  accesses: TmdbAccess[],
  opts: { language?: string; fetchJson?: TmdbFetchJson; maxResults?: number; tvDetailsLimit?: number } = {},
): TmdbSearchProvider {
  return new TmdbSearchProvider({ accesses, ...opts });
}

/** Fetch an arbitrary TMDB list path (e.g. trending/discover) through the same
 *  user-key → proxy access chain every provider uses — the single chokepoint for
 *  fallback + timeout + dead-access memoization. Returns the raw parsed body
 *  (typically `{ results: [...] }`); callers map it. Lives here (not in apps/web)
 *  because defaultFetchJson is module-private and the fallback logic must not be
 *  duplicated. */
export async function fetchTmdbList(
  accesses: TmdbAccess[],
  path: string,
  query: Record<string, string> = {},
  opts: { fetchJson?: TmdbFetchJson } = {},
): Promise<unknown> {
  const deadAccesses = opts.fetchJson ? new Map<string, number>() : sharedDeadAccesses;
  return fetchViaAccessChain(accesses, path, query, opts.fetchJson ?? defaultFetchJson, deadAccesses);
}

export function createTmdbMetadataProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TmdbMetadataProvider {
  const readToken = env.TMDB_READ_TOKEN;
  if (!readToken) {
    throw new Error("TMDB_READ_TOKEN is required to create TmdbMetadataProvider");
  }
  return new TmdbMetadataProvider({ readToken });
}

export function createTmdbSearchProviderFromEnv(env: NodeJS.ProcessEnv = process.env): TmdbSearchProvider {
  const readToken = env.TMDB_READ_TOKEN;
  if (!readToken) {
    throw new Error("TMDB_READ_TOKEN is required to create TmdbSearchProvider");
  }
  return new TmdbSearchProvider({ readToken });
}

export async function prepareTrackingTarget(input: TvTrackingTargetInput): Promise<PreparedTrackingTarget> {
  const [detailsResult, seasonResult] = await Promise.allSettled([
    input.metadataProvider.getTvDetails(input.tmdbId),
    input.metadataProvider.getTvSeason(input.tmdbId, input.seasonNumber),
  ]);
  if (detailsResult.status === "rejected") {
    throw detailsResult.reason;
  }
  const details = detailsResult.value;
  let seasonDetails: TmdbSeasonDetails;
  if (seasonResult.status === "fulfilled") {
    seasonDetails = seasonResult.value;
  } else if (
    seasonResult.reason instanceof TmdbNotFoundError &&
    !(details.seasons ?? []).some((season) => season.season_number === input.seasonNumber)
  ) {
    seasonDetails = await seasonFromEpisodeGroupFallback({
      metadataProvider: input.metadataProvider,
      tmdbId: input.tmdbId,
      seasonNumber: input.seasonNumber,
      originalError: seasonResult.reason,
    });
  } else {
    throw seasonResult.reason;
  }
  const titleId = `tmdb_tv_${details.id}`;
  const title = normalizeTitle(details.name);
  const totalEpisodes = totalEpisodesForSeason(details, seasonDetails, input.seasonNumber);
  const latestAiredEpisode = latestAiredEpisodeForSeason(
    details,
    seasonDetails,
    input.seasonNumber,
    input.now ?? new Date(),
  );
  const latestAiredSource: LatestAiredSource = "metadata";

  return {
    title: {
      id: titleId,
      tmdbId: details.id,
      type: tvMediaType(details),
      originCountries: details.origin_country,
      title,
      originalTitle: normalizeTitle(details.original_name) || title,
      year: yearFromDate(details.first_air_date),
      aliases: aliasList(title, details.original_name),
      posterPath: details.poster_path,
      backdropPath: details.backdrop_path,
      overview: details.overview,
    },
    season: {
      id: `${titleId}_s${input.seasonNumber}`,
      mediaTitleId: titleId,
      seasonNumber: input.seasonNumber,
      // A freshly-tracked season has obtained NOTHING yet, so it starts "active"
      // (has episodes to acquire) even for a 完结/fully-aired show. The bridge
      // graduates it to "completed" only once actually fully obtained; marking it
      // completed at track time made the patrol skip 完结剧-with-gaps forever.
      status: "active",
      qualityPreference: input.qualityPreference,
      storageDirectoryId: input.storageDirectoryId ?? "",
      totalEpisodes,
      latestAiredEpisode,
      latestAiredSource,
    },
    // Quality preference NEVER enters the keyword (search-methodology law): it
    // filters out title matches and drifts to same-quality wrong works. Quality
    // is post-recall selection guidance (getQualityGuidance), not a search term.
    keyword: title,
  };
}

async function seasonFromEpisodeGroupFallback(input: {
  metadataProvider: TmdbMetadataProvider;
  tmdbId: number;
  seasonNumber: number;
  originalError: TmdbNotFoundError;
}): Promise<TmdbSeasonDetails> {
  // Fetch failures propagate as themselves: a transient error must not read as "this season is gone".
  const summaries = await input.metadataProvider.getTvEpisodeGroups(input.tmdbId);
  const groupDetails = await Promise.all(
    summaries.map(async (summary) => ({ summary, details: await input.metadataProvider.getTvEpisodeGroup(summary.id) })),
  );
  const preferredTypes = new Set([1, 6, 7]);
  // Match by name only: a subgroup's order is its position in the group (a Specials subgroup shifts it),
  // so it cannot identify a season on its own.
  const matches = groupDetails.flatMap(({ summary, details }) =>
    details.groups
      .filter((group) => seasonGroupNameMatches(group.name, input.seasonNumber))
      .map((group) => ({ group, preferred: preferredTypes.has(summary.type ?? details.type ?? 0) })),
  );
  const preferredMatches = matches.filter((match) => match.preferred);
  const selected = preferredMatches.length > 0 ? preferredMatches : matches;
  if (selected.length !== 1) {
    throw input.originalError;
  }
  const episodes = [...selected[0]!.group.episodes]
    .sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER))
    .map((episode, index) => ({
      episode_number: index + 1,
      name: episode.name ?? null,
      air_date: episode.air_date ?? null,
    }));
  return { season_number: input.seasonNumber, episodes };
}

function seasonGroupNameMatches(name: string, seasonNumber: number): boolean {
  return new RegExp(`^season\\s*${seasonNumber}$`, "i").test(name) ||
    new RegExp(`^第\\s*${seasonNumber}\\s*季$`).test(name);
}

export interface PreparedMovieTarget {
  title: MediaTitle;
  keyword: string;
  voteAverage?: number | null;
  genreNames?: string[];
  runtime?: number | null;
  cast?: TmdbCastMember[];
  directors?: string[];
}

/** "获取电影" prepare step: one TMDB movie details call → a movie MediaTitle. */
export async function prepareMovieTarget(input: {
  tmdbId: number;
  qualityPreference: string;
  metadataProvider: TmdbMetadataProvider;
}): Promise<PreparedMovieTarget> {
  const details = await input.metadataProvider.getMovieDetails(input.tmdbId);
  const titleId = `tmdb_movie_${details.id}`;
  const title = normalizeTitle(details.title);
  return {
    title: {
      id: titleId,
      tmdbId: details.id,
      type: classifyMediaType({
        baseType: "movie",
        genreIds: details.genres,
        originCountries: details.origin_country,
      }),
      // Carried so the movie agent can skip the 中文 subtitle floor for 国产片
      // (CN-origin = natively Chinese-spoken; details.origin_country is mapped from
      // the movie's production_countries). Search itself stays origin-independent.
      originCountries: details.origin_country,
      title,
      originalTitle: normalizeTitle(details.original_title) || title,
      year: yearFromDate(details.release_date),
      releaseDate: details.release_date || null,
      aliases: aliasList(title, details.original_title),
      posterPath: details.poster_path,
      backdropPath: details.backdrop_path,
      overview: details.overview,
    },
    // Bare title only — the agent owns keyword variation (year, quality,
    // original title) to maximize coverage. Quality is a preference it applies,
    // not a hardcoded filter baked into the search.
    keyword: title,
    voteAverage: details.voteAverage ?? null,
    genreNames: details.genreNames ?? [],
    runtime: details.runtime ?? null,
    cast: details.cast ?? [],
    directors: details.directors ?? [],
  };
}

export interface PreparedSeriesEpisode {
  episodeNumber: number;
  name: string | null;
  airDate: string | null;
}

export interface PreparedSeriesSeason {
  seasonNumber: number;
  totalEpisodes: number;
  latestAiredEpisode: number;
  episodes?: PreparedSeriesEpisode[];
}

export interface PreparedSeriesTarget {
  title: MediaTitle;
  seasons: PreparedSeriesSeason[];
  keyword: string;
  voteAverage?: number | null;
  genreNames?: string[];
  runtime?: number | null;
  cast?: TmdbCastMember[];
  creators?: string[];
}

/**
 * Title-level prepare step for "获取全剧": one TMDB details call yields every
 * season's shape and the latest-aired cursor. Specials (season 0) are
 * excluded; seasons after the cursor's season have zero aired episodes.
 * Pass `includeEpisodes: true` when episode titles/air dates per season are needed.
 */
export async function prepareSeriesTarget(input: {
  tmdbId: number;
  qualityPreference: string;
  metadataProvider: TmdbMetadataProvider;
  includeEpisodes?: boolean;
}): Promise<PreparedSeriesTarget> {
  const details = await input.metadataProvider.getTvDetails(input.tmdbId);
  const titleId = `tmdb_tv_${details.id}`;
  const title = normalizeTitle(details.name);
  const lastAiredSeason = details.last_episode_to_air?.season_number ?? 0;
  const lastAiredEpisode = details.last_episode_to_air?.episode_number ?? 0;

  const baseSeasons = (details.seasons ?? [])
    .map((season) => ({
      seasonNumber: season.season_number ?? 0,
      totalEpisodes: season.episode_count ?? 0,
    }))
    .filter((season) => season.seasonNumber > 0 && season.totalEpisodes > 0)
    .sort((left, right) => left.seasonNumber - right.seasonNumber)
    .map((season) => ({
      seasonNumber: season.seasonNumber,
      totalEpisodes: season.totalEpisodes,
      latestAiredEpisode:
        season.seasonNumber < lastAiredSeason
          ? season.totalEpisodes
          : season.seasonNumber === lastAiredSeason
            ? lastAiredEpisode
            : 0,
    }));
  if (baseSeasons.length === 0) {
    throw new Error(`TMDB tv/${input.tmdbId} exposes no seasons with episodes`);
  }

  let seasons: PreparedSeriesSeason[] = baseSeasons;
  if (input.includeEpisodes) {
    const seasonEpisodes = await mapWithConcurrency(
      baseSeasons,
      TV_DETAILS_CONCURRENCY,
      async (season): Promise<PreparedSeriesEpisode[] | undefined> => {
        try {
          const seasonDetails = await input.metadataProvider.getTvSeason(input.tmdbId, season.seasonNumber);
          return (seasonDetails.episodes ?? [])
            .filter((ep): ep is { episode_number: number; name?: string | null; air_date?: string | null } =>
              typeof ep.episode_number === "number" && Number.isFinite(ep.episode_number),
            )
            .map((ep) => ({
              episodeNumber: ep.episode_number,
              name: ep.name ?? null,
              airDate: ep.air_date ?? null,
            }));
        } catch {
          return undefined;
        }
      },
    );
    seasons = baseSeasons.map((season, index) => {
      const episodes = seasonEpisodes[index];
      return episodes === undefined ? season : { ...season, episodes };
    });
  }

  return {
    title: {
      id: titleId,
      tmdbId: details.id,
      type: tvMediaType(details),
      originCountries: details.origin_country,
      title,
      originalTitle: normalizeTitle(details.original_name) || title,
      year: yearFromDate(details.first_air_date),
      aliases: aliasList(title, details.original_name),
      posterPath: details.poster_path,
      backdropPath: details.backdrop_path,
      overview: details.overview,
    },
    seasons,
    // Quality preference NEVER enters the keyword (search-methodology law): it
    // filters out title matches and drifts to same-quality wrong works. Quality
    // is post-recall selection guidance (getQualityGuidance), not a search term.
    keyword: title,
    voteAverage: details.voteAverage ?? null,
    genreNames: details.genreNames ?? [],
    runtime: details.runtime ?? null,
    cast: details.cast ?? [],
    creators: details.creators ?? [],
  };
}

/** Per-request timeout for the DIRECT api.themoviedb.org hop. A blocked direct
 *  connection otherwise hangs on the platform default (~10s+), and a search fires
 *  many hops in series — the cumulative stall is what surfaced as a server error
 *  in issue #68. Bounding it lets the access chain fail over to the proxy
 *  well within the page's render budget. TMDB itself answers in well under a second. */
const TMDB_DIRECT_TIMEOUT_MS = 4500;
/** Per-request timeout for PROXY hops (CF Worker / self-hosted). Deliberately
 *  patient: from a China router the Worker round-trip measures ~2.4s baseline,
 *  and live stress-testing (2026-07-02) saw jitter breach 4.5s twice — crashing
 *  the search page and silently dropping an acquire action. A proxy is the LAST
 *  hop in the chain, so patience here delays only the error path, not a fallback. */
const TMDB_PROXY_TIMEOUT_MS = 12000;

async function defaultFetchJson(url: string, init: TmdbFetchInit): Promise<unknown> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    signal: AbortSignal.timeout(init.timeoutMs ?? TMDB_DIRECT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new TmdbHttpError(`TMDB request failed with HTTP ${response.status}`, response.status);
  }
  return response.json();
}

function parseTvDetails(value: unknown): TmdbTvDetails {
  if (!isRecord(value)) {
    throw new Error("TMDB TV details response must be an object");
  }
  return {
    id: numberValue(value["id"]),
    name: stringValue(value["name"]),
    original_name: stringValue(value["original_name"]),
    first_air_date: stringValue(value["first_air_date"]),
    number_of_episodes: numberValue(value["number_of_episodes"]),
    overview: stringValue(value["overview"]),
    poster_path: optionalStringOrNull(value["poster_path"]),
    backdrop_path: optionalStringOrNull(value["backdrop_path"]),
    last_episode_to_air: isRecord(value["last_episode_to_air"])
      ? optionalEpisodePointer(value["last_episode_to_air"])
      : null,
    seasons: Array.isArray(value["seasons"])
      ? value["seasons"].filter(isRecord).map(optionalSeasonSummary)
      : [],
    genres: Array.isArray(value["genres"])
      ? value["genres"]
          .filter(isRecord)
          .map((genre) => optionalNumberValue(genre["id"]))
          .filter((id): id is number => id !== undefined)
      : [],
    origin_country: Array.isArray(value["origin_country"])
      ? value["origin_country"].filter((country): country is string => typeof country === "string")
      : [],
    voteAverage: parseVoteAverage(value["vote_average"]),
    genreNames: parseGenreNames(value["genres"]),
    runtime: parseTvRuntime(value),
    cast: parseCast(value["credits"]),
    creators: parseCreators(value["created_by"]),
  };
}

function parseMovieDetails(value: unknown): TmdbMovieDetails {
  if (!isRecord(value)) {
    throw new Error("TMDB movie details response must be an object");
  }
  return {
    id: numberValue(value["id"]),
    title: stringValue(value["title"]),
    original_title: stringValue(value["original_title"]),
    release_date: stringValue(value["release_date"]),
    overview: stringValue(value["overview"]),
    poster_path: optionalStringOrNull(value["poster_path"]),
    backdrop_path: optionalStringOrNull(value["backdrop_path"]),
    genres: Array.isArray(value["genres"])
      ? value["genres"]
          .filter(isRecord)
          .map((genre) => optionalNumberValue(genre["id"]))
          .filter((id): id is number => id !== undefined)
      : [],
    // Movies expose production_countries rather than origin_country.
    origin_country: Array.isArray(value["production_countries"])
      ? value["production_countries"]
          .filter(isRecord)
          .map((country) => country["iso_3166_1"])
          .filter((code): code is string => typeof code === "string")
      : [],
    voteAverage: parseVoteAverage(value["vote_average"]),
    genreNames: parseGenreNames(value["genres"]),
    runtime: parseMovieRuntime(value),
    cast: parseCast(value["credits"]),
    directors: parseDirectors(value["credits"]),
  };
}

function parseSeasonDetails(value: unknown): TmdbSeasonDetails {
  if (!isRecord(value)) {
    throw new Error("TMDB season response must be an object");
  }
  return {
    season_number: numberValue(value["season_number"]),
    episodes: Array.isArray(value["episodes"])
      ? value["episodes"].filter(isRecord).map(optionalSeasonEpisode)
      : [],
  };
}

function parseEpisodeGroupSummaries(value: unknown): TmdbEpisodeGroupSummary[] {
  if (!isRecord(value) || !Array.isArray(value["results"])) {
    return [];
  }
  return value["results"].filter(isRecord).flatMap((entry) => {
    const id = typeof entry["id"] === "string" ? entry["id"] : "";
    if (!id) return [];
    const type = optionalNumberValue(entry["type"]);
    return [{ id, ...(type === undefined ? {} : { type }) }];
  });
}

function parseEpisodeGroupDetails(value: unknown): TmdbEpisodeGroupDetails {
  if (!isRecord(value)) {
    return { groups: [] };
  }
  const groups = Array.isArray(value["groups"])
    ? value["groups"].filter(isRecord).map((group) => {
        const order = optionalNumberValue(group["order"]);
        return {
          name: stringValue(group["name"]),
          ...(order === undefined ? {} : { order }),
          episodes: Array.isArray(group["episodes"])
            ? group["episodes"].filter(isRecord).map((episode) => {
                const episodeOrder = optionalNumberValue(episode["order"]);
                const name = optionalStringOrNull(episode["name"]);
                return {
                  ...(episodeOrder === undefined ? {} : { order: episodeOrder }),
                  ...(name === null ? {} : { name }),
                  air_date: typeof episode["air_date"] === "string" ? episode["air_date"] : null,
                };
              })
            : [],
        };
      })
    : [];
  const type = optionalNumberValue(value["type"]);
  return { groups, ...(type === undefined ? {} : { type }) };
}

type TmdbSearchResult =
  | {
      id: number;
      media_type: "movie";
      title: string;
      original_title: string;
      release_date: string;
      overview: string;
      poster_path: string | null;
      backdrop_path: string | null;
    }
  | {
      id: number;
      media_type: "tv";
      name: string;
      original_name: string;
      first_air_date: string;
      overview: string;
      poster_path: string | null;
      backdrop_path: string | null;
    };

function parseSearchResults(value: unknown): TmdbSearchResult[] {
  if (!isRecord(value)) {
    throw new Error("TMDB search response must be an object");
  }
  if (!Array.isArray(value["results"])) {
    return [];
  }
  return value["results"].filter(isRecord).flatMap(optionalSearchResult);
}

function optionalSearchResult(value: Record<string, unknown>): TmdbSearchResult[] {
  const mediaType = value["media_type"];
  if (mediaType === "movie") {
    const title = normalizeTitle(stringValue(value["title"]));
    if (!title) {
      return [];
    }
    return [
      {
        id: numberValue(value["id"]),
        media_type: "movie",
        title,
        original_title: stringValue(value["original_title"]),
        release_date: stringValue(value["release_date"]),
        overview: stringValue(value["overview"]),
        poster_path: optionalStringOrNull(value["poster_path"]),
        backdrop_path: optionalStringOrNull(value["backdrop_path"]),
      },
    ];
  }
  if (mediaType === "tv") {
    const name = normalizeTitle(stringValue(value["name"]));
    if (!name) {
      return [];
    }
    return [
      {
        id: numberValue(value["id"]),
        media_type: "tv",
        name,
        original_name: stringValue(value["original_name"]),
        first_air_date: stringValue(value["first_air_date"]),
        overview: stringValue(value["overview"]),
        poster_path: optionalStringOrNull(value["poster_path"]),
        backdrop_path: optionalStringOrNull(value["backdrop_path"]),
      },
    ];
  }
  return [];
}

function tvSearchCandidate(result: Extract<TmdbSearchResult, { media_type: "tv" }>, details: TmdbTvDetails | null): MediaSearchCandidate {
  const title = normalizeTitle(result.name);
  return {
    tmdbId: result.id,
    mediaType: "tv",
    title,
    originalTitle: normalizeTitle(result.original_name) || title,
    year: yearFromDate(result.first_air_date),
    overview: result.overview,
    posterPath: result.poster_path,
    backdropPath: result.backdrop_path,
    seasons: details ? searchSeasonsFromTvDetails(details) : [],
  };
}

function movieSearchCandidate(result: Extract<TmdbSearchResult, { media_type: "movie" }>): MediaSearchCandidate {
  const title = normalizeTitle(result.title);
  return {
    tmdbId: result.id,
    mediaType: "movie",
    title,
    originalTitle: normalizeTitle(result.original_title) || title,
    year: yearFromDate(result.release_date),
    releaseDate: result.release_date || null,
    overview: result.overview,
    posterPath: result.poster_path,
    backdropPath: result.backdrop_path,
    seasons: [],
  };
}

function searchSeasonsFromTvDetails(details: TmdbTvDetails): MediaSearchCandidate["seasons"] {
  return (details.seasons ?? [])
    // Same filter as prepareSeriesTarget: a real season (not specials) that
    // actually HAS episodes. An announced-but-empty season (episode_count 0)
    // must not be offered for acquisition — it would only ever be no_coverage,
    // and it made the card show "共 2 季" while the detail page showed 1.
    .filter((season) => (season.season_number ?? 0) > 0 && (season.episode_count ?? 0) > 0)
    .map((season) => {
      const seasonNumber = season.season_number ?? 0;
      const episodeCount = season.episode_count ?? 0;
      const latestAiredEpisode =
        details.last_episode_to_air?.season_number === seasonNumber
          ? details.last_episode_to_air.episode_number ?? 0
          : episodeCount;
      return {
        seasonNumber,
        episodeCount,
        latestAiredEpisode: Math.min(episodeCount, latestAiredEpisode),
      };
    });
}

function optionalEpisodePointer(value: Record<string, unknown>): {
  season_number?: number;
  episode_number?: number;
} {
  const pointer: {
    season_number?: number;
    episode_number?: number;
  } = {};
  const seasonNumber = optionalNumberValue(value["season_number"]);
  if (seasonNumber !== undefined) {
    pointer.season_number = seasonNumber;
  }
  const episodeNumber = optionalNumberValue(value["episode_number"]);
  if (episodeNumber !== undefined) {
    pointer.episode_number = episodeNumber;
  }
  return pointer;
}

function optionalSeasonSummary(value: Record<string, unknown>): {
  season_number?: number;
  episode_count?: number;
} {
  const summary: {
    season_number?: number;
    episode_count?: number;
  } = {};
  const seasonNumber = optionalNumberValue(value["season_number"]);
  if (seasonNumber !== undefined) {
    summary.season_number = seasonNumber;
  }
  const episodeCount = optionalNumberValue(value["episode_count"]);
  if (episodeCount !== undefined) {
    summary.episode_count = episodeCount;
  }
  return summary;
}

function optionalSeasonEpisode(value: Record<string, unknown>): {
  episode_number?: number;
  name?: string | null;
  air_date?: string | null;
} {
  const episode: {
    episode_number?: number;
    name?: string | null;
    air_date?: string | null;
  } = {};
  const episodeNumber = optionalNumberValue(value["episode_number"]);
  if (episodeNumber !== undefined) {
    episode.episode_number = episodeNumber;
  }
  episode.name = typeof value["name"] === "string" ? value["name"] : null;
  episode.air_date = typeof value["air_date"] === "string" ? value["air_date"] : null;
  return episode;
}

function parseTotalPages(value: unknown): number {
  if (!isRecord(value)) {
    return 1;
  }
  const totalPages = optionalNumberValue(value["total_pages"]);
  return totalPages !== undefined && totalPages > 1 ? Math.trunc(totalPages) : 1;
}

function dedupeSearchResults(results: readonly TmdbSearchResult[]): TmdbSearchResult[] {
  const seen = new Set<string>();
  const deduped: TmdbSearchResult[] = [];
  for (const item of results) {
    const key = `${item.media_type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}

function parseVoteAverage(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseGenreNames(genres: unknown): string[] {
  if (!Array.isArray(genres)) return [];
  return genres
    .filter(isRecord)
    .map((genre) => stringValue(genre["name"]).trim())
    .filter((name) => name.length > 0);
}

function parseMovieRuntime(value: Record<string, unknown>): number | null {
  const runtime = optionalNumberValue(value["runtime"]);
  return runtime !== undefined && runtime > 0 ? runtime : null;
}

function parseTvRuntime(value: Record<string, unknown>): number | null {
  const direct = optionalNumberValue(value["runtime"]);
  if (direct !== undefined && direct > 0) return direct;
  if (Array.isArray(value["episode_run_time"])) {
    for (const item of value["episode_run_time"]) {
      const n = optionalNumberValue(item);
      if (n !== undefined && n > 0) return n;
    }
  }
  if (isRecord(value["last_episode_to_air"])) {
    const epRuntime = optionalNumberValue(value["last_episode_to_air"]["runtime"]);
    if (epRuntime !== undefined && epRuntime > 0) return epRuntime;
  }
  return null;
}

function parseCast(credits: unknown): TmdbCastMember[] {
  if (!isRecord(credits) || !Array.isArray(credits["cast"])) return [];
  const members: TmdbCastMember[] = [];
  for (const entry of credits["cast"]) {
    if (!isRecord(entry)) continue;
    const id = optionalNumberValue(entry["id"]);
    const name = stringValue(entry["name"]).trim();
    if (id === undefined || !name) continue;
    members.push({
      id,
      name,
      character: stringValue(entry["character"]).trim(),
      profilePath: optionalStringOrNull(entry["profile_path"]),
    });
    if (members.length >= MAX_CAST_MEMBERS) break;
  }
  return members;
}

function parseDirectors(credits: unknown): string[] {
  if (!isRecord(credits) || !Array.isArray(credits["crew"])) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of credits["crew"]) {
    if (!isRecord(entry) || entry["job"] !== "Director") continue;
    const name = stringValue(entry["name"]).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function parseCreators(createdBy: unknown): string[] {
  if (!Array.isArray(createdBy)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const entry of createdBy) {
    if (!isRecord(entry)) continue;
    const name = stringValue(entry["name"]).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

function totalEpisodesForSeason(
  details: TmdbTvDetails,
  seasonDetails: TmdbSeasonDetails,
  seasonNumber: number,
): number {
  const seasonEpisodeCount = details.seasons?.find((season) => season.season_number === seasonNumber)?.episode_count;
  return seasonEpisodeCount ?? seasonDetails.episodes?.length ?? details.number_of_episodes;
}

function latestAiredEpisodeForSeason(
  details: TmdbTvDetails,
  seasonDetails: TmdbSeasonDetails,
  seasonNumber: number,
  now: Date,
): number {
  const lastEpisode = details.last_episode_to_air;
  if (lastEpisode?.season_number === seasonNumber && lastEpisode.episode_number !== undefined) {
    return lastEpisode.episode_number;
  }
  const utcToday = now.toISOString().slice(0, 10);
  // The patrol normally runs at 06:00 China time (22:00 UTC the previous day),
  // so a UTC date keeps an episode dated today in Asia from being counted too early.
  // Having an air_date is not having aired: TMDB publishes schedules in advance,
  // and last_episode_to_air lags at a season premiere and for brand-new shows.
  return Math.max(
    0,
    ...(seasonDetails.episodes ?? [])
      .filter(
        (episode) =>
          typeof episode.air_date === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(episode.air_date) &&
          episode.air_date <= utcToday,
      )
      .map((episode) => episode.episode_number ?? 0),
  );
}

function normalizeTitle(value: string): string {
  return value.trim();
}

function aliasList(title: string, originalTitle: string): string[] {
  const normalizedOriginal = normalizeTitle(originalTitle);
  if (!normalizedOriginal || normalizedOriginal === title) {
    return [];
  }
  return [normalizedOriginal];
}

function yearFromDate(value: string): number {
  const match = /^(\d{4})/.exec(value);
  return match ? Number(match[1]) : 0;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
