import { describe, expect, it } from "vitest";
import { buildTemplatePreview, DEFAULT_TEMPLATES } from "./library-management-demo";

describe("library management demo fixtures", () => {
  it("provides five independent MoviePilot-style templates with tmdbid and tech tags", () => {
    expect(Object.keys(DEFAULT_TEMPLATES)).toHaveLength(5);
    expect(DEFAULT_TEMPLATES["电影目录"]).toBe("{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}");
    expect(DEFAULT_TEMPLATES["电影文件"]).toContain("{mediaTags}");
    expect(DEFAULT_TEMPLATES["电影文件"]).toContain("{releaseGroup}");
    expect(DEFAULT_TEMPLATES["季目录"]).toBe("Season {season:02}");
    expect(DEFAULT_TEMPLATES["剧集文件"]).toContain("{episodeCode}");
    expect(DEFAULT_TEMPLATES["剧集文件"]).toContain("{ext}");
  });

  it("previews movie directory and file templates with extracted Dolby Vision and Atmos tags", () => {
    expect(buildTemplatePreview("电影目录", DEFAULT_TEMPLATES["电影目录"]).after).toBe("沙丘2 (2024) [tmdbid=693134]");
    expect(buildTemplatePreview("电影文件", DEFAULT_TEMPLATES["电影文件"]).after)
      .toBe("沙丘2 (2024) - 2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.mkv");
  });

  it("uses the Severance 4K DV sample for TV templates and renders clean optional segments", () => {
    expect(buildTemplatePreview("剧集目录", DEFAULT_TEMPLATES["剧集目录"]).after).toBe("人生切割术 (2022) [tmdbid=95396]");
    expect(buildTemplatePreview("季目录", DEFAULT_TEMPLATES["季目录"])).toMatchObject({ before: "Season 1", after: "Season 01" });
    expect(buildTemplatePreview("剧集文件", DEFAULT_TEMPLATES["剧集文件"]).after)
      .toBe("人生切割术 - S01E01 - 2160p.WEB-DL.DV.HEVC.DDP.Atmos-NTb.mkv");
  });
});
