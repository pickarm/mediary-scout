import { afterEach, describe, expect, it, vi } from "vitest";

describe("account-owned messaging acquisition entry", () => {
  const previous = process.env.MEDIA_TRACK_MULTI_USER;
  afterEach(() => {
    if (previous === undefined) delete process.env.MEDIA_TRACK_MULTI_USER;
    else process.env.MEDIA_TRACK_MULTI_USER = previous;
    vi.resetModules();
    vi.doUnmock("next/headers");
  });

  it("keeps the web entry authenticated while a trusted account entry reaches storage resolution without cookies", async () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    const runtime = await import("./workflow-runtime");
    expect(await runtime.queueCandidateTracking("tmdb_movie_1")).toMatchObject({ status: "unsupported", message: expect.stringContaining("未登录") });
    expect(await runtime.queueCandidateTrackingForAccount("messaging-account", "tmdb_movie_1", "not-owned"))
      .toMatchObject({ status: "unsupported", message: expect.stringContaining("网盘工作区") });
  });

  it("does not treat an empty or unauthenticated principal as a default account", async () => {
    const runtime = await import("./workflow-runtime");
    for (const account of ["", "acct_unauthenticated"]) {
      expect(await runtime.queueCandidateTrackingForAccount(account, "tmdb_movie_1"))
        .toMatchObject({ status: "unsupported", message: expect.stringContaining("未登录") });
    }
  });

  it("honors account explicit clear over both global text and the old quality", async () => {
    const runtime = await import("./workflow-runtime");
    const settings = {
      getOwnSetting: async (key: string) => key === "selection_preference" ? "" : null,
      getSetting: async (key: string) => key === "selection_preference" ? "全局优先HDR" : "high",
    };
    expect(await runtime.getSelectionPreference(settings)).toBeUndefined();
    expect(await runtime.getQualityPreference(settings)).toBeUndefined();
    const legacyOnly = { getSetting: async (key: string) => key === "quality_preference" ? "high" : null };
    expect(await runtime.getQualityPreference(legacyOnly)).toBe("high");
  });
});
