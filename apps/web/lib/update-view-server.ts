import { readBuildCommit, readBuildVersion } from "./deployment-update-server";
import { fetchRemoteImageStatus } from "./image-update-server";
import { fetchCommitRelation, fetchLatestDesktopRelease, fetchReleaseFeed } from "./release-feed-server";
import {
  buildImageUpdateView,
  buildUpdateView,
  desktopDownload,
  desktopFeed,
  desktopView,
  type UpdateView,
} from "./update-state";
import { getUpdaterStatus, isUpdaterInstalled, servingRepoCommit } from "./updater-client";
import { resolveIsDesktop } from "./workflow-runtime";
import {
  resolveTrackedImageRef,
  resolveUpdateDistribution,
  type UpdateDistribution,
} from "./fork-release";

/** Shared by the 「更新」 tab, 「立即更新」, the daily auto-update and the settings badge.
 *  The badge polls every 8 s per open tab, so it passes `{ updaterStatus: false, includeChangelog: false }`
 *  to avoid polling GitHub REST APIs or the legacy updater.
 *  Container deployments default to `fork-image` (GHCR Registry v2 manifest/config inspection)
 *  unless `MEDIA_TRACK_DISTRIBUTION=local-source` explicitly selects the legacy source updater. */
export async function loadUpdateView(
  options: {
    updaterStatus?: boolean;
    includeChangelog?: boolean;
    forceImageCheck?: boolean;
  } = {},
): Promise<UpdateView> {
  const desktop = resolveIsDesktop();
  const distribution: UpdateDistribution = desktop
    ? "local-source"
    : resolveUpdateDistribution(process.env);

  if (!desktop && distribution === "fork-image") {
    const includeChangelog = options.includeChangelog ?? true;
    const [buildCommit, buildVersion, remote, feed] = await Promise.all([
      readBuildCommit(),
      readBuildVersion(),
      fetchRemoteImageStatus({
        allowStale: !options.forceImageCheck,
        ...(options.forceImageCheck !== undefined ? { force: options.forceImageCheck } : {}),
      }),
      includeChangelog ? fetchReleaseFeed() : Promise.resolve([]),
    ]);
    return buildImageUpdateView({
      currentCommit: buildCommit,
      currentVersion: buildVersion,
      trackedRef: resolveTrackedImageRef(process.env),
      remote,
      feed,
    });
  }

  const [buildCommit, releases, updater, published] = await Promise.all([
    readBuildCommit(),
    fetchReleaseFeed(),
    desktop || options.updaterStatus === false ? Promise.resolve(null) : getUpdaterStatus(),
    desktop ? fetchLatestDesktopRelease() : Promise.resolve(null),
  ]);
  const currentCommit = buildCommit ?? servingRepoCommit(updater);
  const feed = desktop && published ? desktopFeed(releases, published.tag) : releases;
  const newest = feed[0];
  const tagged = feed.some((release) => release.commit === currentCommit);
  const relation =
    newest && currentCommit && !tagged ? await fetchCommitRelation(newest.commit, currentCommit) : null;
  const built = buildUpdateView({ currentCommit, feed, updater, relation, distribution });
  const view = {
    ...built,
    updaterInstalled: updater !== null || (!desktop && (await isUpdaterInstalled())),
  };
  if (!desktop) return view;
  const settled = desktopView(view, published);
  return published && settled.available
    ? { ...settled, download: desktopDownload(published, process.platform) }
    : settled;
}
