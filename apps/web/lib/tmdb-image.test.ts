import { describe, expect, it } from "vitest";
import {
  ALLOWED_TMDB_IMAGE_SIZES,
  isAllowedTmdbImageSize,
  isValidTmdbImageFilename,
  tmdbImageUrl,
  type TmdbImageSize,
} from "./tmdb-image";

const ALL_SIZES: readonly TmdbImageSize[] = [
  "w92",
  "w154",
  "w185",
  "w342",
  "w500",
  "w780",
  "w1280",
  "original",
];

describe("tmdb-image", () => {
  it("exposes all allowed TMDB image sizes", () => {
    expect(ALLOWED_TMDB_IMAGE_SIZES.size).toBe(ALL_SIZES.length);
    for (const size of ALL_SIZES) {
      expect(ALLOWED_TMDB_IMAGE_SIZES.has(size)).toBe(true);
      expect(isAllowedTmdbImageSize(size)).toBe(true);
    }
    expect(isAllowedTmdbImageSize("w300")).toBe(false);
    expect(isAllowedTmdbImageSize("w342/extra")).toBe(false);
  });

  it("builds proxy URLs across all valid sizes and extensions", () => {
    expect(tmdbImageUrl("/kqjL17yufvn9OVLyXYpvtyrFfak.jpg")).toBe(
      "/api/tmdb/image/w342/kqjL17yufvn9OVLyXYpvtyrFfak.jpg",
    );

    for (const size of ALL_SIZES) {
      expect(tmdbImageUrl("/poster_01-a.jpeg", size)).toBe(`/api/tmdb/image/${size}/poster_01-a.jpeg`);
      expect(tmdbImageUrl("/backdrop-2.png", size)).toBe(`/api/tmdb/image/${size}/backdrop-2.png`);
      expect(tmdbImageUrl("/still_3.webp", size)).toBe(`/api/tmdb/image/${size}/still_3.webp`);
      expect(tmdbImageUrl("/UPPER_CASE.JPG", size)).toBe(`/api/tmdb/image/${size}/UPPER_CASE.JPG`);
    }
  });

  it("returns null for empty or non-string inputs", () => {
    expect(tmdbImageUrl(null)).toBeNull();
    expect(tmdbImageUrl(undefined)).toBeNull();
    expect(tmdbImageUrl("")).toBeNull();
    expect(tmdbImageUrl("   ")).toBeNull();
  });

  it.each([
    ["missing leading slash", "poster.jpg"],
    ["double leading slash", "//poster.jpg"],
    ["multi-segment path", "/t/p/w342/poster.jpg"],
    ["nested directory", "/sub/poster.jpg"],
    ["parent traversal", "/../poster.jpg"],
    ["encoded traversal", "/%2e%2e/poster.jpg"],
    ["encoded slash", "/foo%2fposter.jpg"],
    ["backslash", "/\\poster.jpg"],
    ["double dot inside stem", "/poster..jpg"],
    ["dot inside stem", "/poster.v2.jpg"],
    ["query string", "/poster.jpg?foo=bar"],
    ["hash fragment", "/poster.jpg#hash"],
    ["leading whitespace", " /poster.jpg"],
    ["trailing whitespace", "/poster.jpg "],
    ["internal whitespace", "/my poster.jpg"],
    ["newline", "/poster.jpg\n"],
    ["unsupported extension svg", "/poster.svg"],
    ["unsupported extension html", "/poster.html"],
    ["missing extension", "/poster"],
    ["empty stem", "/.jpg"],
    ["full https url", "https://image.tmdb.org/t/p/w342/poster.jpg"],
  ])("rejects invalid path: %s", (_label, input) => {
    expect(tmdbImageUrl(input)).toBeNull();
  });

  it("returns null for invalid image size even when path is valid", () => {
    expect(tmdbImageUrl("/poster.jpg", "w999" as TmdbImageSize)).toBeNull();
    expect(tmdbImageUrl("/poster.jpg", "../w342" as TmdbImageSize)).toBeNull();
  });

  it("validates standalone filenames strictly", () => {
    expect(isValidTmdbImageFilename("abc_123-xyz.webp")).toBe(true);
    expect(isValidTmdbImageFilename("../abc.jpg")).toBe(false);
    expect(isValidTmdbImageFilename("a/b.jpg")).toBe(false);
    expect(isValidTmdbImageFilename("abc.jpg?x=1")).toBe(false);
  });
});
