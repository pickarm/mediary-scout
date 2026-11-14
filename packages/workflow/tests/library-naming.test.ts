import { describe, expect, it } from "vitest";
import {
  addStableCollisionSuffix,
  DEFAULT_NAMING_TEMPLATES,
  deriveSubtitlePath,
  parseNamingTemplate,
  previewNamingTemplate,
  renderParsedNamingTemplate,
  validateNamingTemplate,
} from "../src/library/naming.js";

describe("library naming templates", () => {
  it("provides the five default templates from the naming requirements", () => {
    expect(DEFAULT_NAMING_TEMPLATES).toEqual({
      movieDirectory: "{title} ({year})",
      movieFile: "{title} ({year}){ext}",
      tvDirectory: "{title} ({year})",
      seasonDirectory: "Season {season:02}",
      episodeFile: "{title} - {episodeCode}{ext}",
    });
  });

  it("renders Chinese values, episode padding, and source extensions as supplied", () => {
    const result = previewNamingTemplate(
      "{title} ({year})/Season {season:02}/{title} - S{season:02}E{episode:02}{ext}",
      { title: "流浪地球", year: 2019, season: 2, episode: 7, ext: ".MKV" },
    );
    expect(result).toEqual({ ok: true, path: "流浪地球 (2019)/Season 02/流浪地球 - S02E07.MKV" });
  });

  it("accepts absent optional metadata and renders it as empty text", () => {
    expect(previewNamingTemplate("{title} ({year})/{title}{ext}", {
      title: "沙丘", year: null, resolution: undefined, edition: "", ext: ".mkv",
    })).toEqual({ ok: true, path: "沙丘 ()/沙丘.mkv" });
  });

  it("parses only known fields and the supported two digit numeric formats", () => {
    const parsed = parseNamingTemplate("{title}/{season:02}-{episode:02}-{episodeCode}");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(renderParsedNamingTemplate(parsed.template, { title: "剧名", season: 1, episode: 3, episodeCode: "S01E03" }))
      .toBe("剧名/01-03-S01E03");
    expect(validateNamingTemplate("{title}/{unknown}")).toContain("未知或非法模板字段：{unknown}");
    expect(validateNamingTemplate("{title:02}")).toContain("字段 title 不支持 :02 格式");
    expect(validateNamingTemplate("{title.toUpperCase()}")).toContain("未知或非法模板字段：{title.toUpperCase()}");
  });

  it.each([
    ["/absolute/{title}", "相对路径"],
    ["C:/media/{title}", "相对路径"],
    ["../{title}", ".."],
    ["{title}/../file", ".."],
    ["{title}\\file", "Windows"],
    ["{title}//file", "空路径段"],
  ])("rejects unsafe template paths: %s", (template, expected) => {
    expect(validateNamingTemplate(template).join(" ").toLowerCase()).toContain(expected.toLowerCase());
  });

  it.each(["../outside", "a/b", "a\\b", "A:B", "bad?name"]) (
    "rejects unsafe field values: %s",
    (title) => {
      expect(previewNamingTemplate("{title}/movie{ext}", { title, ext: ".mkv" }).ok).toBe(false);
    },
  );

  it("rejects Windows reserved names and malformed extensions", () => {
    expect(previewNamingTemplate("{title}{ext}", { title: "CON", ext: ".mkv" }).ok).toBe(false);
    expect(previewNamingTemplate("{title}{ext}", { title: "COM¹", ext: ".mkv" }).ok).toBe(false);
    expect(previewNamingTemplate("{title}{ext}", { title: "LPT³", ext: ".txt" }).ok).toBe(false);
    expect(previewNamingTemplate("{title}{ext}", { title: "Film", ext: "mkv" }).ok).toBe(false);
    expect(previewNamingTemplate("{title}{ext}", { title: "Film", ext: ".mkv" }))
      .toEqual({ ok: true, path: "Film.mkv" });
  });

  it("adds a repeatable collision suffix before the unchanged extension", () => {
    const first = addStableCollisionSuffix("电影/沙丘 (2021).MKV", "provider-file-42");
    expect(first).toMatch(/^电影\/沙丘 \(2021\) \([0-9a-f]{8}\)\.MKV$/u);
    expect(addStableCollisionSuffix("电影/沙丘 (2021).MKV", "provider-file-42")).toBe(first);
    expect(addStableCollisionSuffix("电影/沙丘 (2021).MKV", "provider-file-43")).not.toBe(first);
  });

  it("moves a paired subtitle suffix and preserves the subtitle extension exactly", () => {
    expect(deriveSubtitlePath(
      "原剧/剧名.S01E02.mkv",
      "原剧/剧名.S01E02.zh-Hans.forced.ASS",
      "新剧/剧名 - S01E02.MKV",
    )).toBe("新剧/剧名 - S01E02.zh-Hans.forced.ASS");
    expect(deriveSubtitlePath("a/video.mkv", "b/video.zh.srt", "c/video.mkv")).toBeNull();
  });
});
