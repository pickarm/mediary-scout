/**
 * Fork release identity. The application is shipped as a prebuilt linux/amd64
 * image; a deployment never builds source and never needs a Docker socket.
 *
 * Keep these values in one place so the settings UI, the image update checker
 * and the compose/CI tests all describe the same artifact.
 */
export const FORK_REPO = "pickarm/mediary-scout";
export const FORK_REPO_URL = `https://github.com/${FORK_REPO}`;
export const FORK_RELEASES_URL = `${FORK_REPO_URL}/releases`;
export const FORK_IMAGE = "ghcr.io/pickarm/mediary-scout";
export const FORK_DEFAULT_IMAGE_TAG = "latest";
export const FORK_COMPOSE_FILE = "docker-compose.fork.yml";

/** `MEDIA_TRACK_DISTRIBUTION` values controlling update behavior. */
export const FORK_IMAGE_DISTRIBUTION = "fork-image";
export const LOCAL_SOURCE_DISTRIBUTION = "local-source";

export type UpdateDistribution = "fork-image" | "local-source";

export type TrackedImageRef =
  | {
      ok: true;
      registry: string;
      repository: string;
      tag: string;
      /** Normalized full reference (`<registry>/<repository>:<tag>`). */
      fullRef: string;
    }
  | {
      ok: false;
      reason: "invalid_ref";
      rawImage: string;
      rawTag: string;
    };

/**
 * Resolve the active distribution mode from environment variables.
 * Prebuilt container images do not require `MEDIA_TRACK_DISTRIBUTION` to be
 * explicitly set: `fork-image` is the default, and only an explicit
 * `local-source` selects the legacy source-checkout updater.
 */
export function resolveUpdateDistribution(
  env: Record<string, string | undefined> = process.env,
): UpdateDistribution {
  return env.MEDIA_TRACK_DISTRIBUTION?.trim() === LOCAL_SOURCE_DISTRIBUTION
    ? LOCAL_SOURCE_DISTRIBUTION
    : FORK_IMAGE_DISTRIBUTION;
}

/** True unless the deployment explicitly opted into `local-source`. */
export function isForkImageDistribution(value: string | undefined): boolean {
  return value?.trim() !== LOCAL_SOURCE_DISTRIBUTION;
}

const CONTROL_OR_SPACE_RE = /[\u0000-\u001f\u007f\s]/;
const REGISTRY_HOST_RE =
  /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)(?::([1-9][0-9]{0,4}))?$/;
const REPOSITORY_RE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function isValidRegistry(registry: string): boolean {
  const match = REGISTRY_HOST_RE.exec(registry);
  if (!match) return false;
  if (!match[1]) return true;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Parse and strictly validate a container image reference (`<registry>/<repo>[:<tag>]`)
 * plus an optional fallback tag. Handles `host:port/repo:tag` without confusing the port
 * for a tag, normalizes registry and repository to lowercase, and rejects invalid/unsafe chars.
 */
export function parseImageReference(
  rawImage: string,
  rawTag: string = FORK_DEFAULT_IMAGE_TAG,
): TrackedImageRef {
  const trimmedImage = rawImage.trim();
  const trimmedTag = rawTag.trim() || FORK_DEFAULT_IMAGE_TAG;
  const fail = (): TrackedImageRef => ({
    ok: false,
    reason: "invalid_ref",
    rawImage,
    rawTag,
  });

  if (
    !trimmedImage ||
    CONTROL_OR_SPACE_RE.test(trimmedImage) ||
    CONTROL_OR_SPACE_RE.test(trimmedTag) ||
    trimmedImage.includes("..") ||
    trimmedTag.includes("..") ||
    trimmedImage.includes("://") ||
    trimmedImage.includes("@") ||
    trimmedImage.includes("?") ||
    trimmedImage.includes("#")
  ) {
    return fail();
  }

  const slashIdx = trimmedImage.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmedImage.length - 1) {
    return fail();
  }

  const registry = trimmedImage.slice(0, slashIdx).toLowerCase();
  const rest = trimmedImage.slice(slashIdx + 1);
  if (!isValidRegistry(registry)) {
    return fail();
  }

  const colonIdx = rest.lastIndexOf(":");
  let repoRaw = rest;
  let tag = trimmedTag;
  if (colonIdx !== -1) {
    repoRaw = rest.slice(0, colonIdx);
    const embeddedTag = rest.slice(colonIdx + 1);
    if (!embeddedTag) {
      return fail();
    }
    tag = embeddedTag;
  }

  const repository = repoRaw.toLowerCase();
  if (!REPOSITORY_RE.test(repository) || !TAG_RE.test(tag)) {
    return fail();
  }

  return {
    ok: true,
    registry,
    repository,
    tag,
    fullRef: `${registry}/${repository}:${tag}`,
  };
}

/** Resolve the tracked image reference from `MEDIA_TRACK_IMAGE` and `MEDIA_TRACK_IMAGE_TAG`. */
export function resolveTrackedImageRef(
  env: Record<string, string | undefined> = process.env,
): TrackedImageRef {
  const rawImage = env.MEDIA_TRACK_IMAGE?.trim() || FORK_IMAGE;
  const rawTag = env.MEDIA_TRACK_IMAGE_TAG?.trim() || FORK_DEFAULT_IMAGE_TAG;
  return parseImageReference(rawImage, rawTag);
}

/** The exact two commands a NAS user runs after a Fork release. */
export function imageUpdateCommand(composeFile: string = FORK_COMPOSE_FILE): string {
  return `docker compose -f ${composeFile} pull web && docker compose -f ${composeFile} up -d --force-recreate web`;
}

/** Immutable tag shown in release notes and used for a pinned deployment. */
export function releaseImage(tag: string): string {
  return `${FORK_IMAGE}:${tag}`;
}
