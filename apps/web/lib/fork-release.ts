/**
 * Fork release identity. The application is shipped as a prebuilt linux/amd64
 * image; a deployment never builds source and never needs a Docker socket.
 *
 * Keep these values in one place so the settings UI, the release feed and the
 * compose/CI tests all describe the same artifact.
 */
export const FORK_REPO = "pickarm/mediary-scout";
export const FORK_REPO_URL = `https://github.com/${FORK_REPO}`;
export const FORK_RELEASES_URL = `${FORK_REPO_URL}/releases`;
export const FORK_IMAGE = "qicket/mediary-scout";
export const FORK_COMPOSE_FILE = "docker-compose.fork.yml";

/** `MEDIA_TRACK_DISTRIBUTION` value baked into the prebuilt image/compose. */
export const FORK_IMAGE_DISTRIBUTION = "fork-image";

export type UpdateDistribution = "fork-image" | "local-source";

/** Only an explicit image marker selects the prebuilt-image path. A source
 *  checkout (including tests) keeps the legacy local-source behaviour. */
export function isForkImageDistribution(value: string | undefined): boolean {
  return value?.trim() === FORK_IMAGE_DISTRIBUTION;
}

/** The exact two commands a NAS user runs after a Fork release. */
export function imageUpdateCommand(composeFile: string = FORK_COMPOSE_FILE): string {
  return `docker compose -f ${composeFile} pull web && docker compose -f ${composeFile} up -d --force-recreate web`;
}

/** Immutable tag shown in release notes and used for a pinned deployment. */
export function releaseImage(tag: string): string {
  return `${FORK_IMAGE}:${tag}`;
}
