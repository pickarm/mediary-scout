import { describe, expect, it } from "vitest";
import {
  addStableCollisionSuffix,
  DEFAULT_NAMING_TEMPLATES,
  deriveSubtitlePath,
  extractMediaTechTags,
  NAMING_TEMPLATE_PRESETS,
  parseNamingTemplate,
  previewNamingTemplate,
  renderParsedNamingTemplate,
  validateNamingTemplate,
} from "../src/library/naming.js";

describe("library naming templates", () => {
  it("provides the five MoviePilot-style default templates and presets", () => {
    expect(DEFAULT_NAMING_TEMPLATES).toEqual({
      movieDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
      movieFile: "{title}{{ ({year})}}{{ - {mediaTags}}}{{-{releaseGroup}}}{ext}",
      tvDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
      seasonDirectory: "Season {season:02}",
      episodeFile: "{title} - {episodeCode}{{ - {mediaTags}}}{{-{releaseGroup}}}{ext}",
    });
    expect(NAMING_TEMPLATE_PRESETS.map((preset) => preset.id)).toEqual(["perfect", "emby-compact", "classic"]);
  });

  it("extracts resolution, source, HDR/DV, codec, audio, fps, edition and release group cleanly", () => {
    expect(
      extractMediaTechTags("Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.7.1.Atmos-CHD.mkv"),
    ).toEqual({
      resolution: "2160p",
      videoSource: "REMUX",
      dynamicRange: "DV.HDR10+",
      videoCodec: "HEVC",
      audioCodec: "TrueHD.Atmos",
      fps: "",
      edition: "",
      releaseGroup: "CHD",
      mediaTags: "2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos",
    });

    expect(
      extractMediaTechTags("Severance.S01E01.2160p.ATVP.WEB-DL.DDP5.1.Atmos.DV.H.265-NTb.mkv"),
    ).toMatchObject({
      resolution: "2160p",
      videoSource: "WEB-DL",
      dynamicRange: "DV",
      videoCodec: "HEVC",
      audioCodec: "DDP.Atmos",
      releaseGroup: "NTb",
      mediaTags: "2160p.WEB-DL.DV.HEVC.DDP.Atmos",
    });

    expect(extractMediaTechTags("The.Grand.Budapest.Hotel.2014.1080p.WEB-DL.x265.mkv")).toMatchObject({
      resolution: "1080p",
      videoSource: "WEB-DL",
      videoCodec: "HEVC",
      releaseGroup: "",
      mediaTags: "1080p.WEB-DL.HEVC",
    });

    expect(extractMediaTechTags("奥本海默.mkv")).toEqual({
      resolution: "",
      videoSource: "",
      dynamicRange: "",
      videoCodec: "",
      audioCodec: "",
      fps: "",
      edition: "",
      releaseGroup: "",
      mediaTags: "",
    });
  });

  it("renders Chinese values, episode padding, and optional groups cleanly without dangling separators", () => {
    const duneTech = extractMediaTechTags("Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10+.HEVC.TrueHD.7.1.Atmos-CHD.mkv");
    expect(
      previewNamingTemplate(`${DEFAULT_NAMING_TEMPLATES.movieDirectory}/${DEFAULT_NAMING_TEMPLATES.movieFile}`, {
        title: "沙丘2",
        year: 2024,
        tmdbId: 693134,
        ...duneTech,
        ext: ".mkv",
      }),
    ).toEqual({
      ok: true,
      path: "沙丘2 (2024) [tmdbid=693134]/沙丘2 (2024) - 2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.mkv",
    });

    expect(
      previewNamingTemplate(`${DEFAULT_NAMING_TEMPLATES.movieDirectory}/${DEFAULT_NAMING_TEMPLATES.movieFile}`, {
        title: "奥本海默",
        year: 2023,
        tmdbId: 872585,
        ...extractMediaTechTags("奥本海默.mkv"),
        ext: ".mkv",
      }),
    ).toEqual({
      ok: true,
      path: "奥本海默 (2023) [tmdbid=872585]/奥本海默 (2023).mkv",
    });

    const result = previewNamingTemplate(
      "{title} ({year})/Season {season:02}/{title} - S{season:02}E{episode:02}{ext}",
      { title: "流浪地球", year: 2019, season: 2, episode: 7, ext: ".MKV" },
    );
    expect(result).toEqual({ ok: true, path: "流浪地球 (2019)/Season 02/流浪地球 - S02E07.MKV" });
  });

  it("accepts absent optional metadata for plain fields and collapses {{...}} groups", () => {
    expect(previewNamingTemplate("{title} ({year})/{title}{ext}", {
      title: "沙丘", year: null, resolution: undefined, edition: "", ext: ".mkv",
    })).toEqual({ ok: true, path: "沙丘 ()/沙丘.mkv" });
    expect(previewNamingTemplate("{title}{{ ({year})}}/{title}{{ - {resolution}}}{{.{dynamicRange}}}{{-{releaseGroup}}}{ext}", {
      title: "沙丘", year: null, resolution: "", dynamicRange: undefined, releaseGroup: null, ext: ".mkv",
    })).toEqual({ ok: true, path: "沙丘/沙丘.mkv" });
  });

  it("rejects malformed optional groups while keeping single-brace diagnostics", () => {
    expect(validateNamingTemplate("{title}{{ - }}")).toContain("可选片段必须至少包含一个模板字段");
    expect(validateNamingTemplate("{title}{{ - {{title}}}}")).toContain("可选片段不能嵌套");
    expect(validateNamingTemplate("{title}{{ - {year}")).toContain("模板包含未配对的 {{");
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
