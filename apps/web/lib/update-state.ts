import type { CommitRelation, DesktopRelease, ReleaseEntry } from "./release-feed-server";
import { compareReleaseTags } from "./release-version";
import type { UpdaterPhase, UpdaterStatus } from "./updater-client";
import {
  FORK_DEFAULT_IMAGE_TAG,
  FORK_IMAGE,
  FORK_REPO_URL,
  type TrackedImageRef,
  type UpdateDistribution,
} from "./fork-release";
import type { ImageCheckFailureReason, RemoteImageResult } from "./image-update-server";

/** Phases during which an update is in progress (the tab polls; the scheduler must not start another). */
export const ACTIVE_UPDATER_PHASES: ReadonlySet<UpdaterPhase> = new Set<UpdaterPhase>([
  "waiting",
  "backing_up",
  "building",
  "switching",
  "verifying",
]);

/**
 * available — a newer release or remote image exists (see `available`).
 * latest    — compared, nothing newer: running the newest release/image, or a build ahead of it.
 * unknown   — could not compare: no stamped commit, or remote lacks comparable metadata.
 * offline   — remote source unreachable / unauthorized / not found / invalid ref.
 */
export type UpdateStatus = "available" | "latest" | "unknown" | "offline";

/** Where the desktop app gets the newer release: this platform's installer, or the release page. */
export interface DesktopDownload {
  url: string;
  file: "dmg" | "exe" | null;
}

export type ImageUpdateReason =
  | ImageCheckFailureReason
  | "missing_local_commit"
  | "missing_remote_revision";

export interface ImageUpdateInfo {
  fullRef: string;
  registry: string;
  repository: string;
  tag: string;
  currentCommit: string | null;
  currentVersion: string | null;
  remoteCommit: string | null;
  remoteVersion: string | null;
  remoteCreatedAt: string | null;
  manifestDigest: string | null;
  compareUrl: string | null;
  checkedAt: string;
  reason?: ImageUpdateReason;
}

export interface UpdateView {
  current: {
    label: string;
    tag: string | null;
    commit?: string | null;
    version?: string | null;
  };
  /** The newest release or image strictly different/newer than what is running, or null. */
  available: ReleaseEntry | null;
  status: UpdateStatus;
  releases: Array<ReleaseEntry & { isCurrent: boolean }>;
  updater: UpdaterStatus | null;
  /** The updater's token volume is mounted, even if it did not answer just now. */
  updaterInstalled: boolean;
  /** Desktop only, and only while a newer release is offered. */
  download: DesktopDownload | null;
  /** Prebuilt image (pull/recreate) or a local source checkout (legacy updater). */
  distribution: UpdateDistribution;
  /** Prebuilt container image comparison metadata, when in `fork-image` mode. */
  image?: ImageUpdateInfo | null;
}

function normalizeDisplayVersion(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
  return trimmed;
}

export function buildImageUpdateView(input: {
  currentCommit: string | null;
  currentVersion: string | null;
  trackedRef: TrackedImageRef;
  remote: RemoteImageResult;
  feed?: ReleaseEntry[];
}): UpdateView {
  const currentVersion = normalizeDisplayVersion(input.currentVersion);
  const short = input.currentCommit?.slice(0, 8) ?? null;

  const currentLabel = short
    ? currentVersion
      ? `${currentVersion} · ${short}`
      : input.trackedRef.ok
        ? `${input.trackedRef.tag} · ${short}`
        : short
    : currentVersion
      ? `${currentVersion} · 本地开发版`
      : "本地开发版";

  const fallbackRegistry = input.trackedRef.ok ? input.trackedRef.registry : "ghcr.io";
  const fallbackRepository = input.trackedRef.ok
    ? input.trackedRef.repository
    : FORK_IMAGE.replace(/^ghcr\.io\//, "");
  const fallbackTag = input.trackedRef.ok
    ? input.trackedRef.tag
    : input.trackedRef.rawTag.trim() || FORK_DEFAULT_IMAGE_TAG;
  const fallbackFullRef = input.trackedRef.ok
    ? input.trackedRef.fullRef
    : input.trackedRef.rawImage.trim()
      ? `${input.trackedRef.rawImage.trim()}:${fallbackTag}`
      : `${FORK_IMAGE}:${fallbackTag}`;

  let status: UpdateStatus;
  let available: ReleaseEntry | null = null;
  let reason: ImageUpdateReason | undefined;

  if (!input.trackedRef.ok) {
    status = "offline";
    reason = "invalid_ref";
  } else if (!input.remote.ok) {
    status = "offline";
    reason = input.remote.reason;
  } else if (!input.currentCommit) {
    status = "unknown";
    reason = "missing_local_commit";
  } else if (!input.remote.commit) {
    status = "unknown";
    reason = "missing_remote_revision";
  } else if (input.remote.commit === input.currentCommit) {
    status = "latest";
  } else {
    status = "available";
    available = {
      tag: input.remote.tag,
      date: input.remote.createdAt ? input.remote.createdAt.slice(0, 10) : "",
      commit: input.remote.commit,
      notes: [],
    };
  }

  const remoteCommit = input.remote.ok ? input.remote.commit : null;
  const compareBase = (input.remote.ok ? input.remote.sourceUrl : null) ?? FORK_REPO_URL;
  const compareUrl =
    input.currentCommit && remoteCommit && input.currentCommit !== remoteCommit
      ? `${compareBase.replace(/\/+$/, "")}/compare/${input.currentCommit}...${remoteCommit}`
      : null;

  const image: ImageUpdateInfo = {
    fullRef: input.remote.ok ? input.remote.fullRef : (input.remote.fullRef ?? fallbackFullRef),
    registry: input.remote.ok ? input.remote.registry : (input.remote.registry ?? fallbackRegistry),
    repository: input.remote.ok
      ? input.remote.repository
      : (input.remote.repository ?? fallbackRepository),
    tag: input.remote.ok ? input.remote.tag : (input.remote.tag ?? fallbackTag),
    currentCommit: input.currentCommit,
    currentVersion,
    remoteCommit,
    remoteVersion: input.remote.ok ? input.remote.version : null,
    remoteCreatedAt: input.remote.ok ? input.remote.createdAt : null,
    manifestDigest: input.remote.ok ? input.remote.manifestDigest : null,
    compareUrl,
    checkedAt: input.remote.checkedAt,
    ...(reason ? { reason } : {}),
  };

  return {
    current: {
      label: currentLabel,
      tag: short ? currentVersion : null,
      commit: input.currentCommit,
      version: currentVersion,
    },
    available,
    status,
    releases: (input.feed ?? []).map((release) => ({
      ...release,
      isCurrent: Boolean(input.currentCommit && release.commit === input.currentCommit),
    })),
    updater: null,
    updaterInstalled: false,
    download: null,
    distribution: "fork-image",
    image,
  };
}

export function buildUpdateView(input: {
  currentCommit: string | null;
  feed: ReleaseEntry[];
  updater: UpdaterStatus | null;
  /** Where the running commit stands relative to the newest release (only used when it is untagged). */
  relation: CommitRelation | null;
  distribution?: UpdateDistribution;
}): UpdateView {
  const currentRelease = input.feed.find((release) => release.commit === input.currentCommit) ?? null;
  const newest = input.feed[0] ?? null;
  const short = input.currentCommit?.slice(0, 8) ?? null;
  let available: ReleaseEntry | null = null;
  if (newest && currentRelease) {
    available = compareReleaseTags(newest.tag, currentRelease.tag) > 0 ? newest : null;
  } else if (newest && input.relation === "behind") {
    available = newest;
  }
  const status: UpdateStatus = !newest
    ? "offline"
    : available
      ? "available"
      : currentRelease || input.relation === "ahead" || input.relation === "identical"
        ? "latest"
        : "unknown";
  return {
    current: currentRelease
      ? { label: currentRelease.tag, tag: currentRelease.tag }
      : !short
        ? // Built without GIT_SHA (plain `docker compose up -d --build`): no stamped commit.
          { label: "未知版本", tag: null }
        : !newest
          ? // No release list: it may be a release or a dev build; say only what we know.
            { label: short, tag: null }
          : input.relation === "ahead"
            ? { label: `${short} · 比 ${newest.tag} 新的开发版本`, tag: null }
            : { label: `${short} · 开发版本`, tag: null },
    available,
    status,
    releases: input.feed.map((release) => ({ ...release, isCurrent: release.tag === currentRelease?.tag })),
    updater: input.updater,
    updaterInstalled: input.updater !== null,
    download: null,
    distribution: input.distribution ?? "local-source",
  };
}

/** Desktop users can install only what was published with installers. A newer tag whose build
 *  is still running (or failed) is left out, so it is neither offered nor listed. */
export function desktopFeed(feed: ReleaseEntry[], publishedTag: string | null): ReleaseEntry[] {
  return publishedTag ? feed.filter((release) => compareReleaseTags(release.tag, publishedTag) <= 0) : [];
}

/** No readable published release (GitHub hiccup, or latest is not a complete date release):
 *  keep the changelog, but do not offer an update. The tab then says it cannot tell. */
export function desktopView(view: UpdateView, published: DesktopRelease | null): UpdateView {
  if (published || !view.available) return view;
  return { ...view, available: null, status: "unknown" };
}

export function desktopDownload(release: DesktopRelease, platform: string): DesktopDownload {
  if (platform === "darwin" && release.dmgUrl) return { url: release.dmgUrl, file: "dmg" };
  if (platform === "win32" && release.exeUrl) return { url: release.exeUrl, file: "exe" };
  return { url: release.pageUrl, file: null };
}
