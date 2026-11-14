import { describe, expect, it } from "vitest";
import { buildTemplatePreview, DEFAULT_TEMPLATES } from "./library-management-demo";

describe("library management demo fixtures", () => {
  it("provides five independent templates with the expected movie and episode fields", () => {
    expect(Object.keys(DEFAULT_TEMPLATES)).toHaveLength(5);
    expect(DEFAULT_TEMPLATES["电影文件"]).toBe("{title} ({year}){ext}");
    expect(DEFAULT_TEMPLATES["电影目录"]).toBe("{title} ({year})");
    expect(DEFAULT_TEMPLATES["季目录"]).toBe("Season {season:02}");
    expect(DEFAULT_TEMPLATES["剧集文件"]).toContain("{episodeCode}");
    expect(DEFAULT_TEMPLATES["剧集文件"]).toContain("{ext}");
  });

  it("previews movie directory and file templates independently", () => {
    expect(buildTemplatePreview("电影目录", DEFAULT_TEMPLATES["电影目录"]).after).toBe("布达佩斯大饭店 (2014)");
    expect(buildTemplatePreview("电影文件", DEFAULT_TEMPLATES["电影文件"]).after).toBe("布达佩斯大饭店 (2014).mkv");
  });

  it("uses the Severance sample for all TV templates and renders season and episode values", () => {
    expect(buildTemplatePreview("剧集目录", DEFAULT_TEMPLATES["剧集目录"]).after).toBe("人生切割术 (2022)");
    expect(buildTemplatePreview("季目录", DEFAULT_TEMPLATES["季目录"])).toMatchObject({ before: "Season 1", after: "Season 01" });
    expect(buildTemplatePreview("剧集文件", DEFAULT_TEMPLATES["剧集文件"]).after).toBe("人生切割术 - S01E01.mkv");
    expect(buildTemplatePreview("剧集目录", DEFAULT_TEMPLATES["剧集目录"]).before).toBe("人生切割术 (2022)");
  });
});
