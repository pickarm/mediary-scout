import { describe, expect, it, vi } from "vitest";
import { evaluateReleasePreflight, newestPublishedTag } from "./release-preflight";
import { runReleasePreflight } from "./release-preflight-github";

const sha = (character: string) => character.repeat(40);
const fact = (tag: string, commit: string | null = sha("a")) => ({ tag, commit });
const repo = "pickarm/mediary-scout";
const listUrl = (page = 1) => `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`;
const tagUrl = (tag: string) => `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
const release = (tag: string, commit: string | null = sha("a"), extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  body: commit ? `提交：\`${commit}\`` : "",
  target_commitish: "main",
  ...extra,
});

function fakeFetch(routes: Record<string, Response | (() => Response)>) {
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return typeof hit === "function" ? hit() : hit;
  }) as unknown as typeof fetch;
}

describe("evaluateReleasePreflight", () => {
  it("uses the app calendar parser, so an impossible date is rejected", () => {
    expect(evaluateReleasePreflight({ targetTag: "v2026.02.31", targetCommit: sha("b"), publishedReleases: [] })).toMatchObject({
      ok: false,
      reason: "invalid_tag",
    });
    expect(evaluateReleasePreflight({ targetTag: "v2026.02.28", targetCommit: sha("b"), publishedReleases: [] })).toMatchObject({
      ok: true,
      reason: "first_release",
    });
  });

  it("allows a first release, a forward release, and a same-tag same-commit rerun", () => {
    expect(evaluateReleasePreflight({ targetTag: "v2026.11.16", targetCommit: sha("b"), publishedReleases: [] })).toMatchObject({
      ok: true,
      reason: "first_release",
      latestTag: null,
    });
    expect(
      evaluateReleasePreflight({
        targetTag: "v2026.11.17",
        targetCommit: sha("c"),
        publishedReleases: [fact("v2026.11.16")],
      }),
    ).toMatchObject({ ok: true, reason: "newer_release", latestTag: "v2026.11.16" });
    expect(
      evaluateReleasePreflight({
        targetTag: "v2026.11.16",
        targetCommit: sha("a"),
        publishedReleases: [fact("v2026.11.16")],
      }),
    ).toMatchObject({ ok: true, reason: "same_tag_same_commit" });
  });

  it("rejects an older tag even when it is a rerun, so latest cannot move backwards", () => {
    expect(
      evaluateReleasePreflight({
        targetTag: "v2026.11.15",
        targetCommit: sha("a"),
        publishedReleases: [fact("v2026.11.15"), fact("v2026.11.16")],
      }),
    ).toMatchObject({ ok: false, reason: "older_than_latest", latestTag: "v2026.11.16" });
  });

  it("keeps a published tag immutable and fails closed when its commit is unknown", () => {
    expect(
      evaluateReleasePreflight({
        targetTag: "v2026.11.16",
        targetCommit: sha("b"),
        publishedReleases: [fact("v2026.11.16", sha("a"))],
      }),
    ).toMatchObject({ ok: false, reason: "same_tag_different_commit" });
    expect(
      evaluateReleasePreflight({
        targetTag: "v2026.11.16",
        targetCommit: sha("b"),
        publishedReleases: [fact("v2026.11.16", null)],
      }),
    ).toMatchObject({ ok: false, reason: "existing_commit_unknown" });
  });

  it("compares same-day sequence numbers with the public release order", () => {
    expect(newestPublishedTag([fact("v2026.11.16"), fact("v2026.11.16.10"), fact("v2026.11.16.2")])).toBe(
      "v2026.11.16.10",
    );
  });
});

describe("runReleasePreflight GitHub gate", () => {
  it("rejects an impossible calendar tag before making any GitHub request", async () => {
    const fetchImpl = fakeFetch({});
    await expect(
      runReleasePreflight({ repo, tag: "v2026.02.31", commit: sha("b"), token: "test", fetchImpl }),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_tag" });
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it("treats a tag-specific 404 as first release after the releases list was readable", async () => {
    const fetchImpl = fakeFetch({
      [listUrl()]: new Response("[]", { status: 200 }),
      [tagUrl("v2026.11.16")]: new Response("not found", { status: 404 }),
    });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl }),
    ).resolves.toMatchObject({ ok: true, reason: "first_release" });
  });

  it("fails closed when the releases list itself is not readable", async () => {
    const fetchImpl = fakeFetch({ [listUrl()]: new Response("not found", { status: 404 }) });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl }),
    ).rejects.toThrow("HTTP 404");
    expect(vi.mocked(fetchImpl)).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a tag-release HTTP error or a network failure", async () => {
    const httpError = fakeFetch({
      [listUrl()]: new Response("[]", { status: 200 }),
      [tagUrl("v2026.11.16")]: new Response("boom", { status: 500 }),
    });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl: httpError }),
    ).rejects.toThrow("HTTP 500");

    const network = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl: network }),
    ).rejects.toThrow("offline");
  });

  it("fails closed when the tag-specific response is not a published release", async () => {
    const fetchImpl = fakeFetch({
      [listUrl()]: new Response("[]", { status: 200 }),
      [tagUrl("v2026.11.16")]: new Response(
        JSON.stringify(release("v2026.11.16", sha("b"), { draft: true })),
        { status: 200 },
      ),
    });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl }),
    ).rejects.toThrow("not a valid published release");
  });

  it("rejects an older tag discovered from published releases", async () => {
    const fetchImpl = fakeFetch({
      [listUrl()]: new Response(JSON.stringify([release("v2026.11.16", sha("a"))]), { status: 200 }),
      [tagUrl("v2026.11.15")]: new Response("not found", { status: 404 }),
    });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.15", commit: sha("b"), token: "test", fetchImpl }),
    ).resolves.toMatchObject({ ok: false, reason: "older_than_latest" });
  });

  it("fails closed when the bounded five-page history is completely full", async () => {
    const fullPage = Array.from({ length: 100 }, () => release("v2026.11.15", sha("a")));
    const fetchImpl = fakeFetch({
      [listUrl(1)]: new Response(JSON.stringify(fullPage), { status: 200 }),
      [listUrl(2)]: new Response(JSON.stringify(fullPage), { status: 200 }),
      [listUrl(3)]: new Response(JSON.stringify(fullPage), { status: 200 }),
      [listUrl(4)]: new Response(JSON.stringify(fullPage), { status: 200 }),
      [listUrl(5)]: new Response(JSON.stringify(fullPage), { status: 200 }),
    });
    await expect(
      runReleasePreflight({ repo, tag: "v2026.11.16", commit: sha("b"), token: "test", fetchImpl }),
    ).rejects.toThrow("full pages");
    expect(vi.mocked(fetchImpl).mock.calls).toHaveLength(5);
    expect(vi.mocked(fetchImpl).mock.calls.some(([url]) => String(url).includes("/releases/tags/"))).toBe(false);
  });
});
