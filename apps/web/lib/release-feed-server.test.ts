import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchCommitRelation,
  fetchLatestDesktopRelease,
  fetchReleaseFeed,
  invalidateReleaseFeedCache,
} from "./release-feed-server";

function fakeFetch(routes: Record<string, { status: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status });
  }) as unknown as typeof fetch;
}

const TAGS = "https://api.github.com/repos/pickarm/mediary-scout/git/matching-refs/tags/v";
const releasesUrl = (page: number) =>
  `https://api.github.com/repos/pickarm/mediary-scout/releases?per_page=100&page=${page}`;
const ref = (tag: string, sha: string, type = "commit") => ({ ref: `refs/tags/${tag}`, object: { sha, type } });
const release = (tag: string, body = "", extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  body,
  draft: false,
  prerelease: false,
  target_commitish: "main",
  ...extra,
});

describe("fetchReleaseFeed", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("keeps only published date releases, newest first, with notes from the release body", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: {
        status: 200,
        body: JSON.stringify([
          ref("v1.4.1", "a".repeat(40)),
          ref("v2099.12.31", "d".repeat(40)),
          // Outside 2000–2099: not a release tag.
          ref("v3000.01.01", "e".repeat(40)),
          ref("v2026.09.28", "b".repeat(40)),
          ref("v2026.10.02", "c".repeat(40)),
          // A bare tag with no release must never be advertised.
          ref("v2026.10.03", "f".repeat(40)),
        ]),
      },
      [releasesUrl(1)]: {
        status: 200,
        body: JSON.stringify([
          release("v1.4.1", "- 新增 旧版本"),
          release("v2099.12.31", "- 新增 未来版本"),
          release("v3000.01.01", "- 新增 非法版本"),
          release("v2026.10.02", "- 新增 一键更新"),
          release("v2026.09.28"),
        ]),
      },
    });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed.map((r) => r.tag)).toEqual(["v2099.12.31", "v2026.10.02", "v2026.09.28"]);
    expect(feed[1]).toMatchObject({ commit: "c".repeat(40), notes: [{ kind: "add", text: "一键更新" }] });
    expect(feed[2]!.notes).toEqual([]);
  });

  it("never offers a draft, a prerelease, or a tag whose image release is not published", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: {
        status: 200,
        body: JSON.stringify([ref("v2026.10.02", "c".repeat(40)), ref("v2026.10.03", "d".repeat(40))]),
      },
      [releasesUrl(1)]: {
        status: 200,
        body: JSON.stringify([
          release("v2026.10.02", "- 修复 已发布", { draft: true }),
          release("v2026.10.03", "- 修复 预发布", { prerelease: true }),
        ]),
      },
    });
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
  });

  it("keeps every published release, not just a first page", async () => {
    const tags = Array.from({ length: 150 }, (_, index) => {
      const day = new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10);
      return ref(`v${day.replaceAll("-", ".")}`, index.toString(16).padStart(40, "0"));
    });
    const releases = tags.map((item) => release(item.ref.replace("refs/tags/", "")));
    const fetchImpl = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify(tags) },
      [releasesUrl(1)]: { status: 200, body: JSON.stringify(releases.slice(0, 100)) },
      [releasesUrl(2)]: { status: 200, body: JSON.stringify(releases.slice(100)) },
    });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed).toHaveLength(150);
    expect(feed.at(-1)?.tag).toBe("v2026.01.01");
    expect(vi.mocked(fetchImpl).mock.calls.filter(([url]) => String(url).includes("/releases?"))).toHaveLength(2);
  });

  it("skips annotated tags (their sha is a tag object, not a commit)", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: {
        status: 200,
        body: JSON.stringify([ref("v2026.10.02", "c".repeat(40), "tag"), ref("v2026.09.28", "b".repeat(40))]),
      },
      [releasesUrl(1)]: {
        status: 200,
        body: JSON.stringify([release("v2026.10.02"), release("v2026.09.28")]),
      },
    });
    expect((await fetchReleaseFeed(fetchImpl)).map((r) => r.tag)).toEqual(["v2026.09.28"]);
  });

  it("falls back to the SHA stamped in the release body when the tag is annotated", async () => {
    const commit = "c".repeat(40);
    const fetchImpl = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "d".repeat(40), "tag")]) },
      [releasesUrl(1)]: {
        status: 200,
        body: JSON.stringify([release("v2026.10.02", `- 新增 镜像发布\n提交：\`${commit}\``)]),
      },
    });
    expect(await fetchReleaseFeed(fetchImpl)).toMatchObject([{ tag: "v2026.10.02", commit }]);
  });

  it("callers that arrive while a cold fetch is running share it (one burst of requests, not one per caller)", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "c".repeat(40))]) },
      [releasesUrl(1)]: { status: 200, body: JSON.stringify([release("v2026.10.02", "- 新增 一键更新")]) },
    });
    const [first, second, third] = await Promise.all([
      fetchReleaseFeed(fetchImpl),
      fetchReleaseFeed(fetchImpl),
      fetchReleaseFeed(fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // tags + release page
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("a fetch that started before 「检查更新」 does not refill the cache after it", async () => {
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const stale = vi.fn(async (url: string) => {
      await gate;
      return url === TAGS
        ? new Response(JSON.stringify([ref("v2026.10.01", "b".repeat(40))]), { status: 200 })
        : new Response(JSON.stringify([release("v2026.10.01")]), { status: 200 });
    }) as unknown as typeof fetch;
    const pending = fetchReleaseFeed(stale);
    invalidateReleaseFeedCache();
    const fresh = fakeFetch({
      [TAGS]: { status: 200, body: JSON.stringify([ref("v2026.10.02", "c".repeat(40))]) },
      [releasesUrl(1)]: { status: 200, body: JSON.stringify([release("v2026.10.02")]) },
    });
    expect((await fetchReleaseFeed(fresh))[0]?.tag).toBe("v2026.10.02");
    releaseGate();
    await pending;
    expect((await fetchReleaseFeed(fresh))[0]?.tag).toBe("v2026.10.02");
  });

  it("returns [] when GitHub is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    // The cold fetch starts the tag and release requests together; the cached
    // failure prevents a second burst.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("fetchCommitRelation", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  const compare = (base: string, head: string) =>
    `https://api.github.com/repos/pickarm/mediary-scout/compare/${base}...${head}`;

  it("returns where head stands relative to base", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    const fetchImpl = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "ahead" }) } });
    expect(await fetchCommitRelation(base, head, fetchImpl)).toBe("ahead");
  });

  it("returns null on failure or an unknown status", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    expect(await fetchCommitRelation(base, head, fakeFetch({}))).toBeNull();
    const odd = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "weird" }) } });
    invalidateReleaseFeedCache();
    expect(await fetchCommitRelation(base, head, odd)).toBeNull();
  });

  it("callers that arrive while the comparison is running share it", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    const fetchImpl = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "behind" }) } });
    const both = await Promise.all([fetchCommitRelation(base, head, fetchImpl), fetchCommitRelation(base, head, fetchImpl)]);
    expect(both).toEqual(["behind", "behind"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a comparison that started before 「检查更新」 does not overwrite the fresh answer", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    // The old request fails (a cached null would hide the update for five minutes).
    const stale = vi.fn(async () => {
      await gate;
      return new Response("", { status: 502 });
    }) as unknown as typeof fetch;
    const pending = fetchCommitRelation(base, head, stale);
    invalidateReleaseFeedCache();
    const fresh = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "behind" }) } });
    expect(await fetchCommitRelation(base, head, fresh)).toBe("behind");
    releaseGate();
    await pending;
    expect(await fetchCommitRelation(base, head, fakeFetch({}))).toBe("behind");
  });
});

const LATEST = "https://api.github.com/repos/pickarm/mediary-scout/releases/latest";
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/pickarm/mediary-scout/releases/download/v2026.10.02/${name}`,
});

describe("fetchLatestDesktopRelease", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("reads the latest date release and its two installers", async () => {
    const fetchImpl = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe"), asset("notes.txt")],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(fetchImpl)).toEqual({
      tag: "v2026.10.02",
      pageUrl: "https://github.com/pickarm/mediary-scout/releases/tag/v2026.10.02",
      dmgUrl: asset("Mediary.Scout-2026.1002.0-arm64.dmg").browser_download_url,
      exeUrl: asset("Mediary.Scout.Setup.2026.1002.0.exe").browser_download_url,
    });
  });

  it("callers that arrive while the lookup is running share it", async () => {
    const fetchImpl = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe")],
        }),
      },
    });
    const [first, second] = await Promise.all([fetchLatestDesktopRelease(fetchImpl), fetchLatestDesktopRelease(fetchImpl)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("ignores an old semver release, and installers served from anywhere else", async () => {
    const old = fakeFetch({ [LATEST]: { status: 200, body: JSON.stringify({ tag_name: "v1.4.1", assets: [] }) } });
    expect(await fetchLatestDesktopRelease(old)).toBeNull();
    invalidateReleaseFeedCache();
    const elsewhere = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [
            { name: "a.dmg", browser_download_url: "https://elsewhere.example/a.dmg" },
            { name: "a.exe", browser_download_url: "https://elsewhere.example/a.exe" },
          ],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(elsewhere)).toBeNull();
  });

  it("returns null when only the .exe uploaded so far", async () => {
    const onlyExe = fakeFetch({
      [LATEST]: {
        status: 200,
        body: JSON.stringify({
          tag_name: "v2026.10.02",
          assets: [asset("Mediary.Scout.Setup.2026.1002.0.exe")],
        }),
      },
    });
    expect(await fetchLatestDesktopRelease(onlyExe)).toBeNull();
  });

  it("treats a release that is still missing an installer as a five-minute failure", async () => {
    const failTtl = 5 * 60 * 1000;
    const onlyExe = JSON.stringify({
      tag_name: "v2026.10.02",
      assets: [asset("Mediary.Scout.Setup.2026.1002.0.exe")],
    });
    const both = JSON.stringify({
      tag_name: "v2026.10.02",
      assets: [asset("Mediary.Scout-2026.1002.0-arm64.dmg"), asset("Mediary.Scout.Setup.2026.1002.0.exe")],
    });
    let body = onlyExe;
    const fetchImpl = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-02T00:00:00.000Z");
      vi.setSystemTime(start);
      expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
      vi.setSystemTime(new Date(start.getTime() + failTtl - 1));
      expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      body = both;
      vi.setSystemTime(new Date(start.getTime() + failTtl));
      expect(await fetchLatestDesktopRelease(fetchImpl)).toEqual({
        tag: "v2026.10.02",
        pageUrl: "https://github.com/pickarm/mediary-scout/releases/tag/v2026.10.02",
        dmgUrl: asset("Mediary.Scout-2026.1002.0-arm64.dmg").browser_download_url,
        exeUrl: asset("Mediary.Scout.Setup.2026.1002.0.exe").browser_download_url,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null when GitHub is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
    expect(await fetchLatestDesktopRelease(fetchImpl)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
