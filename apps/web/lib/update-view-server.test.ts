import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "./updater-client";

vi.mock("./deployment-update-server", () => ({
  readBuildCommit: vi.fn(),
  readBuildVersion: vi.fn(),
}));
vi.mock("./image-update-server", () => ({
  fetchRemoteImageStatus: vi.fn(),
}));
vi.mock("./release-feed-server", () => ({
  fetchReleaseFeed: vi.fn(),
  fetchCommitRelation: vi.fn(),
  fetchLatestDesktopRelease: vi.fn(),
}));
vi.mock("./updater-client", async () => {
  const actual = await vi.importActual<typeof import("./updater-client")>("./updater-client");
  return { ...actual, getUpdaterStatus: vi.fn(), isUpdaterInstalled: vi.fn(async () => false) };
});
vi.mock("./workflow-runtime", () => ({
  resolveIsDesktop: vi.fn(() => false),
}));

import { readBuildCommit, readBuildVersion } from "./deployment-update-server";
import { fetchRemoteImageStatus } from "./image-update-server";
import { fetchCommitRelation, fetchLatestDesktopRelease, fetchReleaseFeed } from "./release-feed-server";
import { loadUpdateView } from "./update-view-server";
import { getUpdaterStatus, isUpdaterInstalled } from "./updater-client";
import { resolveIsDesktop } from "./workflow-runtime";

const feed = [
  { tag: "v2026.10.02", date: "2026-10-02", commit: "c".repeat(40), notes: [] },
  { tag: "v2026.09.28", date: "2026-09-28", commit: "b".repeat(40), notes: [] },
];
const published = {
  tag: "v2026.10.02",
  pageUrl: "https://github.com/fancydirty/mediary-scout/releases/tag/v2026.10.02",
  dmgUrl: "https://github.com/fancydirty/mediary-scout/releases/download/v2026.10.02/a.dmg",
  exeUrl: "https://github.com/fancydirty/mediary-scout/releases/download/v2026.10.02/a.exe",
};
const idle: UpdaterStatus = {
  phase: "idle",
  targetTag: null,
  fromCommit: null,
  startedAt: null,
  finishedAt: null,
  message: "",
  logTail: "",
  repoCommit: "d".repeat(40),
};
const remoteNewer = {
  ok: true as const,
  registry: "ghcr.io",
  repository: "pickarm/mediary-scout",
  tag: "latest",
  fullRef: "ghcr.io/pickarm/mediary-scout:latest",
  manifestDigest: "sha256:abcd",
  configDigest: "sha256:efgh",
  commit: "c".repeat(40),
  version: "edge",
  createdAt: "2026-11-26T08:00:00Z",
  sourceUrl: "https://github.com/pickarm/mediary-scout",
  checkedAt: "2026-11-26T09:00:00Z",
};

describe("loadUpdateView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveIsDesktop).mockReturnValue(false);
    vi.mocked(readBuildCommit).mockResolvedValue("b".repeat(40));
    vi.mocked(readBuildVersion).mockResolvedValue(null);
    vi.mocked(fetchRemoteImageStatus).mockResolvedValue(remoteNewer);
    vi.mocked(fetchReleaseFeed).mockResolvedValue(feed);
    vi.mocked(fetchCommitRelation).mockResolvedValue(null);
    vi.mocked(fetchLatestDesktopRelease).mockResolvedValue(null);
    vi.mocked(getUpdaterStatus).mockResolvedValue(idle);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to GHCR fork-image mode even when MEDIA_TRACK_DISTRIBUTION is unset", async () => {
    const view = await loadUpdateView();
    expect(fetchRemoteImageStatus).toHaveBeenCalledWith({ allowStale: true });
    expect(getUpdaterStatus).not.toHaveBeenCalled();
    expect(isUpdaterInstalled).not.toHaveBeenCalled();
    expect(fetchLatestDesktopRelease).not.toHaveBeenCalled();
    expect(fetchCommitRelation).not.toHaveBeenCalled();
    expect(view.distribution).toBe("fork-image");
    expect(view.status).toBe("available");
    expect(view.available?.commit).toBe("c".repeat(40));
  });

  it("skips GitHub release feed completely during 8s polling (includeChangelog: false)", async () => {
    const view = await loadUpdateView({ updaterStatus: false, includeChangelog: false });
    expect(fetchReleaseFeed).not.toHaveBeenCalled();
    expect(fetchCommitRelation).not.toHaveBeenCalled();
    expect(fetchRemoteImageStatus).toHaveBeenCalledWith({ allowStale: true });
    expect(view.releases).toEqual([]);
    expect(view.status).toBe("available");
  });

  it("forces fresh GHCR check when forceImageCheck is true", async () => {
    await loadUpdateView({ forceImageCheck: true });
    expect(fetchRemoteImageStatus).toHaveBeenCalledWith({ allowStale: false, force: true });
  });

  it("keeps the image version independent of a stale updater deploy-folder commit", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "fork-image");
    vi.mocked(readBuildCommit).mockResolvedValue(null);
    vi.mocked(getUpdaterStatus).mockResolvedValue({ ...idle, repoCommit: "d".repeat(40) });
    const view = await loadUpdateView();
    expect(view.current).toEqual({ label: "本地开发版", tag: null, commit: null, version: null });
    expect(view.status).toBe("unknown");
    expect(fetchCommitRelation).not.toHaveBeenCalled();
  });

  it("does not ask the updater on desktop, and still offers the published installer", async () => {
    vi.mocked(resolveIsDesktop).mockReturnValue(true);
    vi.mocked(fetchLatestDesktopRelease).mockResolvedValue(published);
    const view = await loadUpdateView();
    expect(getUpdaterStatus).not.toHaveBeenCalled();
    expect(fetchRemoteImageStatus).not.toHaveBeenCalled();
    expect(view.updater).toBeNull();
    expect(view.download).not.toBeNull();
    expect(view.available?.tag).toBe("v2026.10.02");
  });

  it("does not fall back to the updater commit when a desktop build has no stamp", async () => {
    vi.mocked(resolveIsDesktop).mockReturnValue(true);
    vi.mocked(readBuildCommit).mockResolvedValue(null);
    vi.mocked(fetchLatestDesktopRelease).mockResolvedValue(null);
    const view = await loadUpdateView();
    expect(getUpdaterStatus).not.toHaveBeenCalled();
    expect(view.updater).toBeNull();
    expect(view.current.label).toBe("未知版本");
  });

  it("uses the legacy updater path only when MEDIA_TRACK_DISTRIBUTION=local-source", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    const view = await loadUpdateView();
    expect(fetchLatestDesktopRelease).not.toHaveBeenCalled();
    expect(fetchRemoteImageStatus).not.toHaveBeenCalled();
    expect(getUpdaterStatus).toHaveBeenCalledTimes(1);
    expect(view.available?.tag).toBe("v2026.10.02");
    expect(view.updater).toBe(idle);
    expect(view.distribution).toBe("local-source");
  });

  it("skips the updater status in local-source when requested, and still uses a stamped commit", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    const view = await loadUpdateView({ updaterStatus: false });
    expect(getUpdaterStatus).not.toHaveBeenCalled();
    expect(view.updater).toBeNull();
    expect(view.available?.tag).toBe("v2026.10.02");
  });

  it("reuses the commit from the status it already fetched in local-source", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    const older = "d".repeat(40);
    vi.mocked(readBuildCommit).mockResolvedValue(null);
    vi.mocked(getUpdaterStatus).mockResolvedValue({ ...idle, repoCommit: older });
    vi.mocked(fetchCommitRelation).mockResolvedValue("behind");
    const view = await loadUpdateView();
    expect(getUpdaterStatus).toHaveBeenCalledTimes(1);
    expect(view.current.label).toBe("dddddddd · 开发版本");
  });

  it("tells an installed updater apart from no updater in local-source", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    vi.mocked(getUpdaterStatus).mockResolvedValue(null);
    vi.mocked(isUpdaterInstalled).mockResolvedValue(true);
    expect((await loadUpdateView()).updaterInstalled).toBe(true);
    vi.mocked(isUpdaterInstalled).mockResolvedValue(false);
    expect((await loadUpdateView()).updaterInstalled).toBe(false);
  });

  it("does not report deploy commit while an update runs or checkout is pending in local-source", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    vi.mocked(readBuildCommit).mockResolvedValue(null);
    for (const status of [
      { ...idle, phase: "building" as const, repoCommit: "c".repeat(40) },
      { ...idle, phase: "failed" as const, repoCommit: "c".repeat(40), pendingRestore: true },
    ]) {
      vi.mocked(getUpdaterStatus).mockResolvedValue(status);
      const view = await loadUpdateView();
      expect(view.current.label).toBe("未知版本");
      expect(view.current.tag).toBeNull();
    }
  });
});
