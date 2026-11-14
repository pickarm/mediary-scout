import { describe, expect, it, vi } from "vitest";
import type { MediaTitle } from "../src/domain.js";
import { identifyScanFile, type IdentificationTmdbPort, type IdentityCandidate, type IdentificationTitleDetails } from "../src/library/identification.js";
import type { ScanFileFact } from "../src/library/types.js";

const film: IdentityCandidate = { tmdbId: 27205, mediaType: "movie", title: "盗梦空间", originalTitle: "Inception", year: 2010, reason: "TMDB" };
const series: IdentityCandidate = { tmdbId: 42009, mediaType: "tv", title: "黑镜", originalTitle: "Black Mirror", year: 2011, reason: "TMDB" };
function facts(name: string, parent = "电影"): ScanFileFact {
  return { fileId: "provider-file-1", parentDirectoryId: "dir-1", name, isDirectory: false, sizeBytes: 1024, path: "/" + parent + "/" + name, modifiedAt: null };
}
function detail(candidate: IdentityCandidate, extra: Partial<IdentificationTitleDetails> = {}): IdentificationTitleDetails {
  return { id: candidate.tmdbId, mediaType: candidate.mediaType, title: candidate.title, originalTitle: candidate.originalTitle, year: candidate.year,
    overview: "简介", posterPath: null, backdropPath: null, originCountries: ["CN"], genreIds: [], seasons: candidate.mediaType === "tv" ? [{ seasonNumber: 1, episodeCount: 3 }, { seasonNumber: 0, episodeCount: 1 }] : [], ...extra };
}
function provider(options: { candidates?: IdentityCandidate[]; details?: IdentificationTitleDetails; seasons?: Array<{ episodeNumber: number; airDate: string | null; title: string }>; getTitle?: (id: number) => IdentificationTitleDetails } = {}): IdentificationTmdbPort {
  return {
    search: vi.fn(async () => options.candidates ?? [film]),
    getTitle: vi.fn(async (id: number) => options.getTitle?.(id) ?? options.details ?? detail(id === series.tmdbId ? series : film)),
    getSeason: vi.fn(async () => options.seasons ?? []),
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
});
