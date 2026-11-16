import { normalizeCommit } from "./deployment-update.js";
import { compareReleaseTags, parseReleaseTag } from "./release-version.js";

export interface PublishedReleaseFact {
  tag: string;
  /** Commit recorded by the release body or a valid 40-hex target_commitish. */
  commit: string | null;
}

export type ReleasePreflightReason =
  | "first_release"
  | "same_tag_same_commit"
  | "newer_release"
  | "invalid_tag"
  | "invalid_commit"
  | "older_than_latest"
  | "same_tag_different_commit"
  | "existing_commit_unknown";

export interface ReleasePreflightResult {
  ok: boolean;
  reason: ReleasePreflightReason;
  latestTag: string | null;
}

/** Pure, fail-closed release gate. It never infers a missing existing commit as safe. */
export function evaluateReleasePreflight(input: {
  targetTag: string;
  targetCommit: string;
  publishedReleases: readonly PublishedReleaseFact[];
}): ReleasePreflightResult {
  const latestTag = newestPublishedTag(input.publishedReleases);
  if (!parseReleaseTag(input.targetTag)) {
    return { ok: false, reason: "invalid_tag", latestTag };
  }
  const targetCommit = normalizeCommit(input.targetCommit);
  if (!targetCommit) {
    return { ok: false, reason: "invalid_commit", latestTag };
  }

  const existing = input.publishedReleases.find((release) => release.tag === input.targetTag) ?? null;
  if (existing) {
    const existingCommit = normalizeCommit(existing.commit);
    if (!existingCommit) {
      return { ok: false, reason: "existing_commit_unknown", latestTag };
    }
    if (existingCommit !== targetCommit) {
      return { ok: false, reason: "same_tag_different_commit", latestTag };
    }
  }

  if (latestTag && compareReleaseTags(input.targetTag, latestTag) < 0) {
    return { ok: false, reason: "older_than_latest", latestTag };
  }
  if (existing) {
    return { ok: true, reason: "same_tag_same_commit", latestTag };
  }
  return {
    ok: true,
    reason: latestTag ? "newer_release" : "first_release",
    latestTag,
  };
}

export function newestPublishedTag(releases: readonly PublishedReleaseFact[]): string | null {
  let newest: string | null = null;
  for (const release of releases) {
    if (!parseReleaseTag(release.tag)) continue;
    if (!newest || compareReleaseTags(release.tag, newest) > 0) newest = release.tag;
  }
  return newest;
}
