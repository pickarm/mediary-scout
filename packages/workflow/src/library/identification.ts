import { generateText, type LanguageModel } from "ai";
import type { EpisodeState, MediaTitle, MediaType, TrackedSeason } from "../domain.js";
import { createEpisodeStates, episodeCode, movieAnchorSeason } from "../domain.js";
import { classifyMediaType } from "../media-classification.js";
import type { MediaSearchCandidate, MediaSearchProvider } from "../search-view.js";
import type { TmdbMetadataProvider } from "../tmdb-provider.js";
import type { ExistingMediaFile } from "./types.js";

export type IdentificationStatus = "confirmed" | "pending" | "ignored";
export interface IdentityEvidence { kind: string; value: string; source: "filename" | "directory" | "metadata" | "ai" }
export interface IdentityCandidate { tmdbId: number; mediaType: MediaType; title: string; originalTitle: string; year: number; reason: string }
export interface IdentificationResult {
  status: IdentificationStatus; fileId: string; reason: string; evidence: IdentityEvidence[]; candidates: IdentityCandidate[];
  title?: MediaTitle; season?: TrackedSeason; episodes: EpisodeState[]; existingMediaFiles: ExistingMediaFile[];
  autoAcquire: false; directoryExclusive: false;
}
/** Structural ScanFileFact contract: scan facts enter as JSON-compatible values only. */
export interface ScanFileFactInput { fileId: string; parentDirectoryId: string; name: string; path: string; sizeBytes: number | null; modifiedAt: string | null; isDirectory: boolean }
export type IdentificationMediaKind = "movie" | "tv" | "mixed";
export interface IdentificationTitleDetails {
  id: number; mediaType: "movie" | "tv" | "anime"; title: string; originalTitle: string; year: number;
  releaseDate?: string | null; overview: string; posterPath: string | null; backdropPath: string | null;
  originCountries: string[]; genreIds: number[]; seasons: Array<{ seasonNumber: number; episodeCount: number }>;
}
export interface IdentificationTmdbPort {
  search(query: string, mediaKind: IdentificationMediaKind): Promise<IdentityCandidate[]>;
  getTitle(tmdbId: number, mediaType: "movie" | "tv"): Promise<IdentificationTitleDetails>;
  getSeason(tmdbId: number, seasonNumber: number): Promise<Array<{ episodeNumber: number; airDate: string | null; title: string }>>;
}
export interface IdentitySuggestion { title: string; year?: number; tmdbId?: number; mediaType?: "movie" | "tv" | "anime" }
export type IdentitySuggester = (input: { filename: string; directoryName: string; mediaKind: IdentificationMediaKind }) => Promise<IdentitySuggestion | null>;
export interface IdentifyScanFileInput {
  file: ScanFileFactInput; parentDirectoryName?: string; ancestorDirectoryNames?: readonly string[]; mediaKind: IdentificationMediaKind; existingTmdbId?: number;
  existingMediaTitle?: MediaTitle; qualityPreference?: string; now?: Date;
}
export interface IdentifyScanFileDependencies { tmdb: IdentificationTmdbPort; suggester?: IdentitySuggester }

const VIDEO_EXTENSIONS = new Set(["mkv", "mp4", "m4v", "avi", "mov", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg", "webm", "3gp"]);
const SUBTITLE_EXTENSIONS = new Set(["srt", "ass", "ssa", "vtt", "sub", "idx", "sup"]);
const NOISE = /\b(?:2160p|1080p|720p|480p|4k|8k|uhd|hdr10?(?:\+)?|dolby[ .-]?vision|dv|web[ ._-]?(?:dl|rip)|blu[ .-]?ray|brrip|bdrip|webrip|hdtv|remux|x26[45]|h\.?26[45]|hevc|avc|av1|vp9|aac\d?(?:\.\d)?|ddp(?:\d\.\d)?|ac3|flac|dts(?:-hd(?:\.?ma)?|-x)?|truehd|atmos|60fps|120fps|proper|repack|extended|uncut|中字|双语|国语|粤语|简体|繁体)(?:-[A-Za-z0-9_@]{1,20})?\b/gi;
interface ParsedName { title: string; year?: number; season?: number; eps: number[]; special: boolean; marker?: { type?: "movie" | "tv"; id: number } }
const EPISODE_PATTERNS = [
  /\bS(\d{1,2})\s*E(\d{1,3})\s*E(\d{1,3})/i,
  /\bS(\d{1,2})\s*E(\d{1,3})(?:\s*[-+&～~至]\s*(?:S\d{1,2}\s*)?E?(\d{1,3}))?/i,
  /\b(\d{1,2})x(\d{1,3})(?:\s*[-+&～~]\s*(?:\d{1,2}x)?(\d{1,3}))?/i,
  /第\s*(\d{1,2})\s*季\s*(?:第\s*)?(\d{1,3})(?:\s*[-+&～~至]\s*(?:第\s*)?(\d{1,3}))?\s*(?:集|话|話)?/,
  /\bSeason\s*(\d{1,2})\s*(?:Episode|Ep\.?|E)\s*(\d{1,3})(?:\s*[-+&～~]\s*(?:Episode|Ep\.?|E)?\s*(\d{1,3}))?/i,
];
function stripNoise(value: string): string {
  return value.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*(?:1080|720|2160|x26[45]|web.?dl|bluray)[^)]*\)/gi, " ")
    .replace(NOISE, " ").replace(/\b(?:字幕组|压制组|内封|外挂|特效字幕)\b/gi, " ").replace(/[._]+/g, " ")
    .replace(/\s+/g, " ").replace(/^[\s\-–—:：]+|[\s\-–—:：]+$/g, "").trim();
}
function parseName(raw: string): ParsedName {
  const m = /tmdb[_ -]?(movie|tv)[_ :\-]?(\d+)/i.exec(raw);
  const generic = /\{tmdb-(\d+)\}|[\[{]\s*tmdbid\s*[=:\-_]\s*(\d+)\s*[\]}]|tmdb(?:id)?[：:=_\-\s](\d+)/i.exec(raw);
  const marker = m ? { type: m[1]?.toLowerCase() === "tv" ? "tv" as const : "movie" as const, id: Number(m[2]) }
    : generic ? { id: Number(generic[1] ?? generic[2] ?? generic[3]) } : undefined;
  let season: number | undefined; let eps: number[] = []; let used: RegExp | undefined;
  for (const pattern of EPISODE_PATTERNS) { const hit = pattern.exec(raw); if (hit) { season = Number(hit[1]); eps = [Number(hit[2])]; if (hit[3]) eps.push(Number(hit[3])); used = pattern; break; } }
  if (season === undefined) {
    const seasonOnly = /(?:\bSeason\s*(\d{1,2})\b|\bS(\d{1,2})\b|第\s*(\d{1,2})\s*季)/i.exec(raw);
    if (seasonOnly) season = Number(seasonOnly[1] ?? seasonOnly[2] ?? seasonOnly[3]);
  }
  const specialMatch = /\bS00E(\d{1,3})(?:\s*[-+&～~]E?(\d{1,3}))?/i.exec(raw);
  let special = false;
  if (!used && specialMatch) { season = 0; eps = [Number(specialMatch[1])]; if (specialMatch[2]) eps.push(Number(specialMatch[2])); special = true; }
  const specialLabel = /(?:\b(?:specials?|ova|oad|sp)\b|特典|特別篇|特别篇|番外篇)/i.test(raw);
  if (season === 0 || (!used && specialLabel)) { special = true; if (season === undefined) { season = 0; eps = [Number(/(?:OVA|OAD|SP|特典|特別篇|特别篇|番外篇)\s*0*(\d{1,3})/i.exec(raw)?.[1] ?? 1)]; } }
  const markerless = raw.replace(/(?:tmdb[_ -]?(?:movie|tv)[_ :\-]?\d+|\{tmdb-\d+\}|[\[{]\s*tmdbid\s*[=:\-_]\s*\d+\s*[\]}]|tmdb(?:id)?[：:=_\-\s]\d+)/ig, " ");
  const y = /(?:19|20)\d{2}/.exec(markerless); const year = y ? Number(y[0]) : undefined;
  let title = markerless;
  if (used) title = title.replace(used, " ");
  title = title.replace(/\bSeason\s*\d{1,2}\b|\bS\d{1,2}\b|第\s*\d{1,2}\s*季/gi, " ");
  title = title.replace(/(?:\b(?:specials?|ova|oad|sp)\b|特典|特別篇|特别篇|番外篇).*$/i, " ");
  if (year !== undefined) title = title.replace(String(year), " ");
  title = title.replace(/\(\s*\)|\[\s*\]/g, " ");
  title = stripNoise(title);
  return { title, ...(year === undefined ? {} : { year }), ...(season === undefined ? {} : { season }), eps: [...new Set(eps)], special, ...(marker ? { marker } : {}) };
}
function identity(c: MediaSearchCandidate): IdentityCandidate { return { tmdbId: c.tmdbId, mediaType: c.mediaType, title: c.title, originalTitle: c.originalTitle, year: c.year, reason: "TMDB 搜索候选" }; }
function norm(s: string): string { return s.toLocaleLowerCase().normalize("NFKC").replace(/[\s\p{P}\p{S}]/gu, ""); }
function meaningfulDirectoryTitle(name: string, parsedTitle: string): boolean {
  return parsedTitle.length > 1 && !new Set(["电影", "电视剧", "动漫", "movies", "movie", "tv", "series", "anime", "video", "videos", "library"]).has(norm(name));
}
function exactTitle(c: IdentityCandidate, q: string): boolean { const n = norm(q); return n.length >= 2 && [c.title, c.originalTitle].some((v) => norm(v) === n); }
function searchType(kind: IdentificationMediaKind, c: MediaSearchCandidate): boolean { return kind === "mixed" || (kind === "movie" ? c.mediaType === "movie" : c.mediaType === "tv"); }
function base(fileId: string, status: IdentificationStatus, reason: string, evidence: IdentityEvidence[] = [], candidates: IdentityCandidate[] = []): IdentificationResult {
  return { status, fileId, reason, evidence, candidates, episodes: [], existingMediaFiles: [], autoAcquire: false, directoryExclusive: false };
}

export async function identifyScanFile(input: IdentifyScanFileInput, deps: IdentifyScanFileDependencies): Promise<IdentificationResult> {
  const f = input.file;
  if (f.isDirectory) return base(f.fileId, "ignored", "目录由遍历上下文处理");
  const ext = f.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (SUBTITLE_EXTENSIONS.has(ext)) return base(f.fileId, "ignored", "字幕文件不是视频资源");
  if (!VIDEO_EXTENSIONS.has(ext)) return base(f.fileId, "ignored", "不支持的媒体文件扩展名");
  if (/(?:sample|trailer|preview|teaser|featurette|幕前花絮|预告|預告|样片|樣片)/i.test(f.name)) return base(f.fileId, "ignored", "样片或预告片不作为正片导入");

  const fileParsed = parseName(f.name.replace(/\.[^.]+$/, ""));
  const fallbackParent = input.parentDirectoryName ?? f.path.split(/[\\/]/).filter(Boolean).at(-2) ?? "";
  const directoryNames = [...new Set([...(fallbackParent ? [fallbackParent] : []), ...(input.ancestorDirectoryNames ?? [])])];
  const directories = directoryNames.map((name) => ({ name, parsed: parseName(name) }));
  const usefulDirectories = directories.filter(({ name, parsed }) => meaningfulDirectoryTitle(name, parsed.title));
  const fileHasNumberOnly = /^\d{1,3}$/.test(fileParsed.title);
  const hasFileTitle = fileParsed.title.length > 1 && !fileHasNumberOnly;
  const titleDirectory = usefulDirectories[0];
  const titleQuery = hasFileTitle ? fileParsed.title : titleDirectory?.parsed.title ?? "";
  const titleEvidence = [...new Set([...(hasFileTitle ? [fileParsed.title] : []), ...(titleDirectory ? [titleDirectory.parsed.title] : [])])];
  const directorySeason = directories.find(({ parsed }) => parsed.season !== undefined)?.parsed;
  const fileEpisodeEvidence = fileParsed.eps.length > 0;
  let ep: ParsedName = fileEpisodeEvidence ? fileParsed : directorySeason ?? fileParsed;
  if (!fileEpisodeEvidence && fileHasNumberOnly && input.mediaKind !== "movie" && directorySeason?.season !== undefined) {
    ep = { ...directorySeason, eps: [Number(fileParsed.title)] };
  }
  const years = [fileParsed.year, ...directories.map(({ parsed }) => parsed.year)].filter((value): value is number => value !== undefined);
  const year = fileParsed.year ?? directories.find(({ parsed }) => parsed.year !== undefined)?.parsed.year;
  const evidence: IdentityEvidence[] = [];
  if (fileParsed.title.length > 1) evidence.push({ kind: "filename_title", value: fileParsed.title, source: "filename" });
  for (const { parsed } of usefulDirectories) {
    if (parsed.title !== fileParsed.title) evidence.push({ kind: "directory_title", value: parsed.title, source: "directory" });
  }
  for (const [index, currentYear] of years.entries()) evidence.push({ kind: "year", value: String(currentYear), source: index === 0 && fileParsed.year !== undefined ? "filename" : "directory" });
  if (ep.eps.length && ep.season !== undefined) evidence.push({ kind: ep.special ? "special" : "episode_code", value: "S" + String(ep.season).padStart(2, "0") + "E" + ep.eps.map((n) => String(n).padStart(2, "0")).join("+E"), source: fileParsed.eps.length ? "filename" : "directory" });
  const markers = [fileParsed.marker, ...directories.map(({ parsed }) => parsed.marker)].filter((value): value is NonNullable<typeof value> => value !== undefined);
  const marker = markers[0];
  for (const [index, current] of markers.entries()) evidence.push({ kind: "tmdb_marker", value: (current.type ?? "generic") + ":" + current.id, source: index === 0 && current === fileParsed.marker ? "filename" : "directory" });
  if (markers.some((current) => current.id !== marker?.id || (current.type !== undefined && marker.type !== undefined && current.type !== marker.type))) return base(f.fileId, "pending", "文件名与祖先目录中的 TMDB 标记冲突", evidence);
  if (marker?.type && input.mediaKind !== "mixed" && ((input.mediaKind === "movie") !== (marker.type === "movie"))) return base(f.fileId, "pending", "TMDB 标记类型与扫描媒体类型冲突", evidence);
  if (new Set(years).size > 1) return base(f.fileId, "pending", "文件名与祖先目录年份冲突", evidence);
  if (!titleQuery || /^\d+$/.test(titleQuery)) return base(f.fileId, "pending", "文件名缺少可用于唯一识别的作品标题", evidence);
  if ((input.mediaKind === "movie" && (ep.eps.length > 0 || directorySeason?.season !== undefined)) || (input.mediaKind === "tv" && !ep.eps.length)) {
    return base(f.fileId, "pending", input.mediaKind === "movie" ? "扫描类型为电影，但文件或祖先目录含剧集季集证据" : "剧集文件缺少明确季集号", evidence);
  }
  if (input.existingMediaTitle && input.existingTmdbId !== undefined && input.existingMediaTitle.tmdbId !== input.existingTmdbId) return base(f.fileId, "pending", "已有 TMDB 标记与关联作品 ID 不一致", evidence);

  let candidates: IdentityCandidate[];
  try {
    if (input.existingTmdbId !== undefined && !input.existingMediaTitle && (input.mediaKind !== "mixed" || marker?.type !== undefined)) {
      const d = await deps.tmdb.getTitle(input.existingTmdbId, marker?.type ?? (input.mediaKind === "tv" ? "tv" : "movie"));
      candidates = [{ tmdbId: d.id, mediaType: d.mediaType, title: d.title, originalTitle: d.originalTitle, year: d.year, reason: "TMDB 详情校验" }];
      if (d.id !== input.existingTmdbId) return base(f.fileId, "pending", "TMDB 详情 ID 与已有标记不一致", evidence, candidates);
    } else candidates = (await deps.tmdb.search(titleQuery, input.mediaKind)).filter((c) => input.mediaKind === "mixed" || (input.mediaKind === "movie" ? c.mediaType === "movie" : c.mediaType !== "movie"));
  } catch { return base(f.fileId, "pending", "TMDB 元数据暂不可用，保留文件待确认", evidence); }
  if (input.existingTmdbId !== undefined && markers.some((current) => current.id !== input.existingTmdbId)) return base(f.fileId, "pending", "文件名 TMDB 标记与已有作品 ID 不一致", evidence, candidates);
  if (markers.some((current) => !candidates.some((c) => c.tmdbId === current.id && (current.type === undefined || (current.type === "movie" ? c.mediaType === "movie" : c.mediaType !== "movie"))))) return base(f.fileId, "pending", "文件中的 TMDB 标记与真实 TMDB 搜索结果不一致", evidence, candidates);
  let matches = candidates.filter((c) => titleEvidence.every((name) => exactTitle(c, name)) && (year === undefined || c.year === year));
  if (input.existingTmdbId !== undefined) matches = matches.filter((c) => c.tmdbId === input.existingTmdbId);
  if (matches.length !== 1 && deps.suggester) {
    try {
      const suggestion = await deps.suggester({ filename: f.name, directoryName: directoryNames[0] ?? "", mediaKind: input.mediaKind });
      if (suggestion?.title.trim()) {
        evidence.push({ kind: "ai_suggestion", value: suggestion.title, source: "ai" });
        const ai = (await deps.tmdb.search(suggestion.title, input.mediaKind)).filter((c) => input.mediaKind === "mixed" || (input.mediaKind === "movie" ? c.mediaType === "movie" : c.mediaType !== "movie"));
        candidates = [...new Map([...candidates, ...ai].map((c) => [c.mediaType + ":" + c.tmdbId, c])).values()];
        // Suggestions enrich the review candidates; they never override the
        // title/year evidence parsed from the file and directory.
      }
    } catch { /* AI or TMDB errors cannot raise confidence. */ }
  }
  if (matches.length !== 1) return base(f.fileId, "pending", matches.length > 1 ? "存在多个可匹配作品" : year === undefined ? "同名作品缺少年份，无法唯一判断" : "没有与名称和年份一致的 TMDB 作品", evidence, candidates);
  const c = matches[0]!;
  if (input.existingMediaTitle && input.existingMediaTitle.tmdbId !== c.tmdbId) return base(f.fileId, "pending", "识别结果与已有作品 ID 不一致", evidence, candidates);
  let d: IdentificationTitleDetails;
  try { d = await deps.tmdb.getTitle(c.tmdbId, c.mediaType === "movie" ? "movie" : "tv"); }
  catch { return base(f.fileId, "pending", "无法读取 TMDB 详情，保留文件待确认", evidence, candidates); }
  if (d.id !== c.tmdbId || d.year < 1800 || d.year !== c.year || (year !== undefined && d.year !== year) || !exactTitle(c, titleQuery)) return base(f.fileId, "pending", "TMDB 详情未能验证名称、ID 与年份", evidence, candidates);
  evidence.push({ kind: "tmdb_match", value: d.mediaType + ":" + d.id + ":" + d.year, source: "metadata" });
  const type = d.mediaType === "movie" ? "movie" : classifyMediaType({ baseType: "tv", genreIds: d.genreIds, originCountries: d.originCountries });
  if (type === "movie" && ep.eps.length) return base(f.fileId, "pending", "TMDB 识别为电影，但文件或祖先目录提供了剧集季集证据", evidence, candidates);
  if (input.existingMediaTitle && (input.existingMediaTitle.tmdbId !== d.id || input.existingMediaTitle.type !== type)) return base(f.fileId, "pending", "识别结果与已有作品的 TMDB ID 或媒体类型不一致", evidence, candidates);
  const titleId = (type === "movie" ? "tmdb_movie_" : "tmdb_tv_") + d.id;
  const title: MediaTitle = { id: titleId, tmdbId: d.id, type, title: d.title, originalTitle: d.originalTitle || d.title, year: d.year,
    aliases: [...new Set([d.title, d.originalTitle].filter(Boolean))], originCountries: d.originCountries,
    ...(d.releaseDate === undefined ? {} : { releaseDate: d.releaseDate }), posterPath: d.posterPath, backdropPath: d.backdropPath, overview: d.overview };
  if (type === "movie") {
    const season = movieAnchorSeason({ titleId, qualityPreference: input.qualityPreference ?? "", storageDirectoryId: f.parentDirectoryId });
    const episodes = createEpisodeStates({ trackedSeasonId: season.id, seasonNumber: 1, totalEpisodes: 1, latestAiredEpisode: 1 });
    return confirmed(f, title, season, episodes, [1], evidence, candidates);
  }
  if (ep.season === undefined || ep.eps.length === 0) return base(f.fileId, "pending", "剧集季号或集号无法解析", evidence, candidates);
  const seasonNo = ep.season;
  const seasonInfo = d.seasons.find((s) => s.seasonNumber === seasonNo);
  if (!seasonInfo && seasonNo !== 0) return base(f.fileId, "pending", "TMDB 未列出该季", evidence, candidates);
  let metadata: Array<{ episodeNumber: number; airDate: string | null; title: string }> = [];
  try { metadata = await deps.tmdb.getSeason(d.id, seasonNo); } catch { /* use the season episode count */ }
  const listedCount = seasonInfo?.episodeCount ?? 0;
  const metadataNumbers = metadata.map((item) => item.episodeNumber);
  const metadataRangeIsVerifiable = metadataNumbers.length > 0
    && metadataNumbers.every((number, index) => Number.isInteger(number) && number > 0 && number === index + 1);
  const metadataCount = metadataRangeIsVerifiable ? metadataNumbers.length : 0;
  const total = listedCount > 0 ? listedCount : metadataCount;
  if (total < 1) return base(f.fileId, "pending", "TMDB 未提供可验证的季集范围", evidence, candidates);
  if (ep.eps.some((n) => !Number.isInteger(n) || n < 1 || n > total)) return base(f.fileId, "pending", "集号超出 TMDB 季集范围", evidence, candidates);
  const seasonId = titleId + "_s" + seasonNo;
  const aired = metadata.filter((x) => !x.airDate || x.airDate <= (input.now ?? new Date()).toISOString().slice(0, 10)).map((x) => x.episodeNumber);
  const season: TrackedSeason = { id: seasonId, mediaTitleId: titleId, seasonNumber: seasonNo, status: "active", qualityPreference: input.qualityPreference ?? "",
    storageDirectoryId: f.parentDirectoryId, totalEpisodes: total, latestAiredEpisode: metadata.length ? Math.max(0, ...aired) : total,
    latestAiredSource: metadata.length ? "metadata" : "unknown", autoAcquire: false };
  const episodes = createEpisodeStates({ trackedSeasonId: seasonId, seasonNumber: seasonNo, totalEpisodes: total, latestAiredEpisode: season.latestAiredEpisode })
    .map((state) => { const no = Number(state.episodeCode.match(/E(\d+)$/)?.[1]); const m = metadata.find((x) => x.episodeNumber === no); return m ? { ...state, airDate: m.airDate, title: m.title || state.title } : state; });
  return confirmed(f, title, season, episodes, ep.eps, evidence, candidates);
}
function confirmed(f: ScanFileFactInput, title: MediaTitle, season: TrackedSeason, episodes: EpisodeState[], numbers: number[], evidence: IdentityEvidence[], candidates: IdentityCandidate[]): IdentificationResult {
  return { status: "confirmed", fileId: f.fileId, reason: "作品名称、年份与 TMDB 详情唯一匹配", evidence, candidates, title, season, episodes,
    existingMediaFiles: numbers.map((n) => ({ fileId: f.fileId, parentDirectoryId: f.parentDirectoryId, episodeCode: episodeCode(season.seasonNumber, n), sizeBytes: f.sizeBytes, quality: null })),
    autoAcquire: false, directoryExclusive: false };
}

/** Reuses the existing authenticated/fallback-aware TMDB providers, without owning credentials. */
export function createTmdbIdentificationAdapter(searchProvider: MediaSearchProvider, metadataProvider: TmdbMetadataProvider): IdentificationTmdbPort {
  return {
    async search(query, kind) { return (await searchProvider.searchMedia({ query })).filter((c) => searchType(kind, c)).map(identity); },
    async getTitle(id, mediaType) {
      if (mediaType === "movie") {
        const d = await metadataProvider.getMovieDetails(id);
        const year = Number(d.release_date.slice(0, 4)) || 0;
        return { id: d.id, mediaType: "movie", title: d.title, originalTitle: d.original_title, year, releaseDate: d.release_date || null,
          overview: d.overview, posterPath: d.poster_path, backdropPath: d.backdrop_path, originCountries: d.origin_country, genreIds: d.genres, seasons: [] };
      }
      const d = await metadataProvider.getTvDetails(id);
      return { id: d.id, mediaType: classifyMediaType({ baseType: "tv", genreIds: d.genres, originCountries: d.origin_country }), title: d.name,
        originalTitle: d.original_name, year: Number(d.first_air_date.slice(0, 4)) || 0, overview: d.overview, posterPath: d.poster_path,
        backdropPath: d.backdrop_path, originCountries: d.origin_country, genreIds: d.genres,
        seasons: (d.seasons ?? []).map((s) => ({ seasonNumber: s.season_number ?? 0, episodeCount: s.episode_count ?? 0 })) };
    },
    async getSeason(id, seasonNumber) {
      const d = await metadataProvider.getTvSeason(id, seasonNumber);
      return (d.episodes ?? []).flatMap((e, index) => typeof e.episode_number === "number"
        ? [{ episodeNumber: e.episode_number, airDate: e.air_date ?? null, title: "Episode " + (e.episode_number || index + 1) }] : []);
    },
  };
}

/** AI suggestions remain untrusted and can only narrow real TMDB search candidates. */
export function createAiIdentitySuggester(model: LanguageModel): IdentitySuggester {
  return async ({ filename, directoryName, mediaKind }) => {
    const { text } = await generateText({ model, maxRetries: 0, prompt: "从媒体文件名提出作品标题。只输出 JSON：{\"title\":string,\"year\"?:number,\"tmdbId\"?:number,\"mediaType\"?:\"movie\"|\"tv\"|\"anime\"}。不确定字段省略，不虚构信息。类型：" + mediaKind + "\n文件名：" + filename + "\n父目录：" + directoryName });
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const r = value as Record<string, unknown>;
      if (typeof r.title !== "string" || !r.title.trim() || r.title.length > 160) return null;
      return { title: r.title.trim(), ...(typeof r.year === "number" && Number.isInteger(r.year) ? { year: r.year } : {}),
        ...(typeof r.tmdbId === "number" && Number.isInteger(r.tmdbId) && r.tmdbId > 0 ? { tmdbId: r.tmdbId } : {}),
        ...(r.mediaType === "movie" || r.mediaType === "tv" || r.mediaType === "anime" ? { mediaType: r.mediaType } : {}) };
    } catch { return null; }
  };
}
