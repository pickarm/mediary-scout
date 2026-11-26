import { describe, expect, it, vi } from "vitest";
import type { MediaTitle } from "../src/domain.js";
import { identifyScanFile, type IdentificationTmdbPort, type IdentityCandidate, type IdentificationTitleDetails, type ScanFileFactInput } from "../src/library/identification.js";

const film: IdentityCandidate = { tmdbId: 27205, mediaType: "movie", title: "盗梦空间", originalTitle: "Inception", year: 2010, reason: "TMDB" };
const series: IdentityCandidate = { tmdbId: 42009, mediaType: "tv", title: "黑镜", originalTitle: "Black Mirror", year: 2011, reason: "TMDB" };
function facts(name: string, parent = "电影"): ScanFileFactInput {
  return { fileId: "provider-file-1", parentDirectoryId: "dir-1", name, isDirectory: false, sizeBytes: 1024, path: "/" + parent + "/" + name, modifiedAt: null };
}
function detail(candidate: IdentityCandidate, extra: Partial<IdentificationTitleDetails> = {}): IdentificationTitleDetails {
  return { id: candidate.tmdbId, mediaType: candidate.mediaType, title: candidate.title, originalTitle: candidate.originalTitle, year: candidate.year,
    overview: "简介", posterPath: null, backdropPath: null, originCountries: ["CN"], genreIds: [], seasons: candidate.mediaType === "tv" ? [{ seasonNumber: 1, episodeCount: 3 }, { seasonNumber: 0, episodeCount: 1 }] : [], ...extra };
}
function provider(options: { candidates?: IdentityCandidate[]; details?: IdentificationTitleDetails; seasons?: Array<{ episodeNumber: number; airDate: string | null; title: string }>; getTitle?: (id: number) => IdentificationTitleDetails; getSeason?: () => Promise<Array<{ episodeNumber: number; airDate: string | null; title: string }>> } = {}): IdentificationTmdbPort {
  return {
    search: vi.fn(async () => options.candidates ?? [film]),
    getTitle: vi.fn(async (id: number) => options.getTitle?.(id) ?? options.details ?? detail(id === series.tmdbId ? series : film)),
    getSeason: vi.fn(async () => options.getSeason ? options.getSeason() : options.seasons ?? []),
  };
}

describe("library identification", () => {
  it("resolves Chinese movie names and produces the movie S01E01 anchor", async () => {
    const tmdb = provider();
    const result = await identifyScanFile({ file: facts("盗梦空间 (2010) [1080p WEB-DL x265].mkv"), mediaKind: "movie" }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(result.title).toMatchObject({ id: "tmdb_movie_27205", type: "movie" });
    expect(result.season?.id).toBe("tmdb_movie_27205_movie");
    expect(result.episodes.map((ep) => ep.episodeCode)).toEqual(["S01E01"]);
    expect(result.existingMediaFiles).toMatchObject([{ fileId: "provider-file-1", episodeCode: "S01E01" }]);
    expect(result.autoAcquire).toBe(false);
  });

  it("resolves English titles and strips technical tags", async () => {
    const tmdb = provider();
    const result = await identifyScanFile({ file: facts("Inception.2010.2160p.BluRay.REMUX.HEVC.mkv"), mediaKind: "movie" }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(tmdb.search).toHaveBeenCalledWith("Inception", "movie");
  });

  it("uses reliable parent title/year context to interpret a numbered episode file", async () => {
    const tmdb = provider({ candidates: [series], seasons: [{ episodeNumber: 2, airDate: "2011-02-11", title: "Fifteen Million Merits" }] });
    const result = await identifyScanFile({ file: facts("02.mkv", "黑镜 (2011) Season 1"), parentDirectoryName: "黑镜 (2011) Season 1", mediaKind: "tv" }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(result.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E02"]);
  });

  it("does not infer season one for a numbered file without season evidence", async () => {
    const tmdb = provider({ candidates: [series] });
    const result = await identifyScanFile({ file: facts("02.mkv", "黑镜 (2011)"), parentDirectoryName: "黑镜 (2011)", mediaKind: "tv" }, { tmdb });
    expect(result.status).toBe("pending");
    expect(result.reason).toMatch(/季集号/);
  });

  it("recognizes Chinese season/episode syntax and dual episodes", async () => {
    const tmdb = provider({ candidates: [series], seasons: [{ episodeNumber: 1, airDate: "2011-12-04", title: "国歌" }, { episodeNumber: 2, airDate: "2011-12-11", title: "一千万的价值" }] });
    const result = await identifyScanFile({ file: facts("黑镜 第1季 第1-2集.mkv"), mediaKind: "tv" }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(result.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E01", "S01E02"]);
    expect(new Set(result.existingMediaFiles.map((file) => file.fileId))).toEqual(new Set(["provider-file-1"]));
  });

  it("recognizes English SxxExx, specials, and season zero", async () => {
    const tmdb = provider({ candidates: [series] });
    const special = await identifyScanFile({ file: facts("Black Mirror S00E01 Special.mkv"), mediaKind: "tv" }, { tmdb });
    expect(special.status).toBe("confirmed");
    expect(special.season?.seasonNumber).toBe(0);
    expect(special.existingMediaFiles[0]?.episodeCode).toBe("S00E01");
  });

  it("recognizes the compact SxxE01E02 dual episode form", async () => {
    const tmdb = provider({ candidates: [series] });
    const result = await identifyScanFile({ file: facts("Black Mirror S01E01E02.mkv"), mediaKind: "tv" }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(result.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E01", "S01E02"]);
  });

  it("uses the nearest season ancestor and outer work title for nested season files", async () => {
    const tmdb = provider({ candidates: [series] });
    const result = await identifyScanFile({
      file: facts("S01E01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: ["Season 01", "Black Mirror (2011)"], mediaKind: "tv",
    }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(tmdb.search).toHaveBeenCalledWith("Black Mirror", "tv");
    expect(result.season?.seasonNumber).toBe(1);
    expect(result.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E01"]);

    const mixed = await identifyScanFile({
      file: facts("01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: ["Season 01", "Black Mirror (2011)"], mediaKind: "mixed",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(mixed.status).toBe("confirmed");
    expect(mixed.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E01"]);

    const noSeason = await identifyScanFile({ file: facts("01.mkv"), mediaKind: "mixed" }, { tmdb: provider({ candidates: [series] }) });
    expect(noSeason.status).toBe("pending");
  });

  it("does not treat a numbered file inside a season directory as a movie", async () => {
    const directories = ["Season 01", "盗梦空间 (2010)"] as const;
    const movie = await identifyScanFile({
      file: facts("01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: directories, mediaKind: "movie",
    }, { tmdb: provider() });
    expect(movie.status).toBe("pending");
    expect(movie.title).toBeUndefined();
    expect(movie.season).toBeUndefined();
    expect(movie.existingMediaFiles).toEqual([]);

    const tvCandidate: IdentityCandidate = { ...series, title: film.title, originalTitle: film.originalTitle, year: film.year };
    const mixed = await identifyScanFile({
      file: facts("01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: directories, mediaKind: "mixed",
    }, { tmdb: provider({ candidates: [tvCandidate], details: { ...detail(tvCandidate), mediaType: "tv", seasons: [{ seasonNumber: 1, episodeCount: 12 }] } }) });
    expect(mixed.status).toBe("confirmed");
    expect(mixed.title?.type).toBe("tv");
    expect(mixed.existingMediaFiles.map((file) => file.episodeCode)).toEqual(["S01E01"]);
  });

  it("does not mistake an unrelated outer directory for a work title", async () => {
    const tmdb = provider({ candidates: [series] });
    const result = await identifyScanFile({
      file: facts("S01E01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: ["Season 01", "电视剧"], mediaKind: "tv",
    }, { tmdb });
    expect(result.status).toBe("pending");
    expect(tmdb.search).not.toHaveBeenCalled();
  });

  it("rejects marker and year conflicts found in any ancestor directory", async () => {
    const marker = await identifyScanFile({
      file: facts("Black Mirror S01E01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: ["Season 01", "Black Mirror (2011)", "Black Mirror (2011) {tmdb-1}"], mediaKind: "tv",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(marker.status).toBe("pending");
    expect(marker.reason).toMatch(/标记/);

    const year = await identifyScanFile({
      file: facts("Black Mirror S01E01.mkv", "Season 01"), parentDirectoryName: "Season 01",
      ancestorDirectoryNames: ["Season 01", "Black Mirror (2011)", "Collection (2012)"], mediaKind: "tv",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(year.status).toBe("pending");
    expect(year.reason).toMatch(/年份冲突/);
  });

  it("never expands a TMDB season range from the filename episode number", async () => {
    for (const name of ["Black Mirror S01E13.mkv", "Black Mirror S01E999.mkv", "Black Mirror S01E12-13.mkv"]) {
      const result = await identifyScanFile({ file: facts(name), mediaKind: "tv" }, { tmdb: provider({ candidates: [series], details: { ...detail(series), seasons: [{ seasonNumber: 1, episodeCount: 12 }] } }) });
      expect(result.status, name).toBe("pending");
      expect(result.title, name).toBeUndefined();
      expect(result.season, name).toBeUndefined();
      expect(result.existingMediaFiles, name).toEqual([]);
    }
    const valid = await identifyScanFile({ file: facts("Black Mirror S01E12.mkv"), mediaKind: "tv" }, { tmdb: provider({ candidates: [series], details: { ...detail(series), seasons: [{ seasonNumber: 1, episodeCount: 12 }] } }) });
    expect(valid.status).toBe("confirmed");
    const dual = await identifyScanFile({ file: facts("Black Mirror S01E01-02.mkv"), mediaKind: "tv" }, { tmdb: provider({ candidates: [series], details: { ...detail(series), seasons: [{ seasonNumber: 1, episodeCount: 12 }] } }) });
    expect(dual.status).toBe("confirmed");
  });

  it("uses verified episode details when counts are absent, and keeps unknown ranges pending", async () => {
    const noCount: IdentityCandidate = { ...series, tmdbId: 42010 };
    const metadata = [{ episodeNumber: 1, airDate: null, title: "One" }, { episodeNumber: 2, airDate: null, title: "Two" }];
    const verified = await identifyScanFile({ file: facts("Black Mirror S01E02.mkv"), mediaKind: "tv" }, {
      tmdb: provider({ candidates: [noCount], details: { ...detail(noCount), seasons: [{ seasonNumber: 1, episodeCount: 0 }] }, seasons: metadata }),
    });
    expect(verified.status).toBe("confirmed");
    expect(verified.season?.totalEpisodes).toBe(2);

    const unknown = await identifyScanFile({ file: facts("Black Mirror S01E01.mkv"), mediaKind: "tv" }, {
      tmdb: provider({ candidates: [noCount], details: { ...detail(noCount), seasons: [{ seasonNumber: 1, episodeCount: 0 }] }, getSeason: async () => { throw new Error("unavailable"); } }),
    });
    expect(unknown.status).toBe("pending");
    expect(unknown.reason).toMatch(/可验证的季集范围/);
    expect(unknown.title).toBeUndefined();
  });

  it("confirms S00 only within a verified special range", async () => {
    const allowed = await identifyScanFile({ file: facts("Black Mirror S00E01.mkv"), mediaKind: "tv" }, { tmdb: provider({ candidates: [series] }) });
    expect(allowed.status).toBe("confirmed");
    expect(allowed.season?.seasonNumber).toBe(0);
    const outOfRange = await identifyScanFile({ file: facts("Black Mirror S00E02.mkv"), mediaKind: "tv" }, { tmdb: provider({ candidates: [series] }) });
    expect(outOfRange.status).toBe("pending");
    const unknown = await identifyScanFile({ file: facts("Black Mirror S00E01.mkv"), mediaKind: "tv" }, {
      tmdb: provider({ candidates: [series], details: { ...detail(series), seasons: [{ seasonNumber: 1, episodeCount: 3 }, { seasonNumber: 0, episodeCount: 0 }] }, getSeason: async () => { throw new Error("unavailable"); } }),
    });
    expect(unknown.status).toBe("pending");
  });

  it("keeps same-title remakes pending when the year is absent", async () => {
    const old: IdentityCandidate = { ...film, tmdbId: 1, year: 1998 };
    const remake: IdentityCandidate = { ...film, tmdbId: 2, year: 2024 };
    const result = await identifyScanFile({ file: facts("怪奇物语.mkv"), mediaKind: "movie" }, { tmdb: provider({ candidates: [old, remake] }) });
    expect(result.status).toBe("pending");
    expect(result.candidates).toHaveLength(2);
  });

  it("rejects a conflicting filename year and refuses a mismatched TMDB marker", async () => {
    const conflict = await identifyScanFile({ file: facts("盗梦空间 (2011).mkv"), mediaKind: "movie" }, { tmdb: provider() });
    expect(conflict.status).toBe("pending");
    const marker = await identifyScanFile({ file: facts("tmdb_movie_99 盗梦空间 (2010).mkv"), mediaKind: "movie" }, { tmdb: provider() });
    expect(marker.status).toBe("pending");
    expect(marker.reason).toMatch(/标记/);
  });

  it("rejects conflicting file and parent directory TMDB markers", async () => {
    const result = await identifyScanFile({
      file: facts("tmdb_movie_27205 Inception (2010).mkv", "tmdb_movie_1 Inception (2010)"),
      parentDirectoryName: "tmdb_movie_1 Inception (2010)", mediaKind: "movie",
    }, { tmdb: provider() });
    expect(result.status).toBe("pending");
    expect(result.reason).toMatch(/标记冲突/);
  });

  it("does not treat the numeric value in a generic TMDB marker as the release year", async () => {
    const result = await identifyScanFile({
      file: facts("Inception (2010).mkv", "Inception (2010) {tmdb-2020}"),
      parentDirectoryName: "Inception (2010) {tmdb-2020}", mediaKind: "movie",
    }, { tmdb: provider() });
    expect(result.status).toBe("pending");
    expect(result.evidence).toContainEqual({ kind: "year", value: "2010", source: "filename" });
  });

  it("uses a generic TMDB folder marker with real TV metadata and preserves the tv namespace for anime", async () => {
    const tv = provider({ candidates: [series] });
    const tvResult = await identifyScanFile({
      file: facts("Black Mirror S01E01.mkv", "Black Mirror (2011) {tmdb-42009}"),
      parentDirectoryName: "Black Mirror (2011) {tmdb-42009}", mediaKind: "tv",
    }, { tmdb: tv });
    expect(tvResult.status).toBe("confirmed");
    expect(tvResult.title?.id).toBe("tmdb_tv_42009");

    const anime: IdentificationTmdbPort = {
      search: async () => [series],
      getTitle: async () => ({ ...detail(series), mediaType: "anime", genreIds: [16] }),
      getSeason: async () => [],
    };
    const animeResult = await identifyScanFile({
      file: facts("Black Mirror S01E01.mkv", "Black Mirror (2011) {tmdb-42009}"),
      parentDirectoryName: "Black Mirror (2011) {tmdb-42009}", mediaKind: "tv",
    }, { tmdb: anime });
    expect(animeResult.status).toBe("confirmed");
    expect(animeResult.title).toMatchObject({ id: "tmdb_tv_42009", type: "anime" });
  });

  it("allows a matching generic and explicit marker but rejects different IDs or explicit namespaces", async () => {
    const matching = await identifyScanFile({
      file: facts("tmdb_tv_42009 Black Mirror S01E01.mkv", "Black Mirror (2011) {tmdb-42009}"),
      parentDirectoryName: "Black Mirror (2011) {tmdb-42009}", mediaKind: "tv",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(matching.status).toBe("confirmed");

    const differentIds = await identifyScanFile({
      file: facts("tmdb_tv_42009 Black Mirror S01E01.mkv", "Black Mirror (2011) {tmdb-1}"),
      parentDirectoryName: "Black Mirror (2011) {tmdb-1}", mediaKind: "tv",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(differentIds.status).toBe("pending");
    expect(differentIds.reason).toMatch(/标记冲突/);

    const namespaces = await identifyScanFile({
      file: facts("tmdb_movie_42009 Black Mirror S01E01.mkv", "tmdb_tv_42009 Black Mirror (2011)"),
      parentDirectoryName: "tmdb_tv_42009 Black Mirror (2011)", mediaKind: "mixed",
    }, { tmdb: provider({ candidates: [series] }) });
    expect(namespaces.status).toBe("pending");
    expect(namespaces.reason).toMatch(/标记冲突/);
  });

  it("keeps a pure-number file pending without context but uses a reliable movie folder", async () => {
    const noContext = await identifyScanFile({ file: facts("123.mkv"), mediaKind: "movie" }, { tmdb: provider() });
    expect(noContext.status).toBe("pending");
    const contextual = await identifyScanFile({ file: facts("123.mkv", "盗梦空间 (2010)"), parentDirectoryName: "盗梦空间 (2010)", mediaKind: "movie" }, { tmdb: provider() });
    expect(contextual.status).toBe("confirmed");
  });

  it("ignores subtitles, unsupported extensions, samples, and trailers", async () => {
    const tmdb = provider();
    for (const name of ["电影.srt", "notes.txt", "电影-sample.mkv", "电影-预告片.mp4"]) {
      const result = await identifyScanFile({ file: facts(name), mediaKind: "movie" }, { tmdb });
      expect(result.status).toBe("ignored");
    }
    expect(tmdb.search).not.toHaveBeenCalled();
  });

  it("keeps files pending when TMDB metadata is unavailable", async () => {
    const tmdb = provider();
    tmdb.search = vi.fn(async () => { throw new Error("offline"); });
    const result = await identifyScanFile({ file: facts("盗梦空间 (2010).mkv"), mediaKind: "movie" }, { tmdb });
    expect(result.status).toBe("pending");
    expect(result.existingMediaFiles).toEqual([]);
  });

  it("keeps identity pending when TMDB details have no usable year", async () => {
    const tmdb = provider({ details: { ...detail(film), year: 0 } });
    const result = await identifyScanFile({ file: facts("盗梦空间.mkv"), mediaKind: "movie" }, { tmdb });
    expect(result.status).toBe("pending");
    expect(result.reason).toMatch(/验证/);
  });

  it("does not accept hallucinated AI IDs or titles without matching real TMDB evidence", async () => {
    const tmdb = provider({ candidates: [film] });
    const result = await identifyScanFile({ file: facts("mystery-file.mkv"), mediaKind: "movie" }, {
      tmdb,
      suggester: async () => ({ title: "Made Up Film", tmdbId: 999999, year: 2099 }),
    });
    expect(result.status).toBe("pending");
    expect(tmdb.search).toHaveBeenCalledTimes(2);
    expect(result.title).toBeUndefined();
  });

  it("detects existing-title and marker ID conflicts", async () => {
    const existing: MediaTitle = { id: "tmdb_movie_8", tmdbId: 8, type: "movie", title: "别的片", originalTitle: "Else", year: 2010, aliases: [] };
    const result = await identifyScanFile({ file: facts("tmdb_movie_9 盗梦空间 (2010).mkv"), mediaKind: "movie", existingTmdbId: 8, existingMediaTitle: existing }, { tmdb: provider() });
    expect(result.status).toBe("pending");
    expect(result.reason).toMatch(/不一致/);
  });

  it("does not interchange anime and tv for the same TMDB ID", async () => {
    const tmdb: IdentificationTmdbPort = {
      search: async () => [series],
      getTitle: async () => ({ ...detail(series), mediaType: "anime", genreIds: [16] }),
      getSeason: async () => [],
    };
    const existing: MediaTitle = { id: "tmdb_tv_42009", tmdbId: series.tmdbId, type: "tv", title: series.title, originalTitle: series.originalTitle, year: series.year, aliases: [] };
    const result = await identifyScanFile({ file: facts("Black Mirror S01E01.mkv"), mediaKind: "tv", existingMediaTitle: existing }, { tmdb });
    expect(result.status).toBe("pending");
    expect(result.reason).toMatch(/媒体类型/);
  });

  it("does not download or inspect video bytes and defaults directory exclusivity off", async () => {
    const tmdb = provider();
    const result = await identifyScanFile({ file: facts("盗梦空间 (2010).mkv"), mediaKind: "movie" }, { tmdb });
    expect(result.directoryExclusive).toBe(false);
    expect(tmdb.getTitle).toHaveBeenCalledTimes(1);
    expect(tmdb.getSeason).not.toHaveBeenCalled();
  });

  it("recognizes [tmdbid=xxx] markers from default organized folders", async () => {
    const tmdb = provider();
    const result = await identifyScanFile({
      file: facts("盗梦空间 (2010) - 2160p.REMUX.DV.HEVC.TrueHD.Atmos-CHD.mkv", "盗梦空间 (2010) [tmdbid=27205]"),
      parentDirectoryName: "盗梦空间 (2010) [tmdbid=27205]",
      mediaKind: "movie",
    }, { tmdb });
    expect(result.status).toBe("confirmed");
    expect(result.evidence.some((entry) => entry.kind === "tmdb_marker" && entry.value === "generic:27205")).toBe(true);
    expect(tmdb.search).toHaveBeenCalledWith("盗梦空间", "movie");
  });
});
