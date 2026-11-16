import { evaluateReleasePreflight, type PublishedReleaseFact, type ReleasePreflightResult } from "./release-preflight.js";

const RELEASES_PER_PAGE = 100;
const MAX_RELEASE_PAGES = 5;
const API_BASE = "https://api.github.com";

interface ReleasePayload {
  tag_name?: unknown;
  body?: unknown;
  target_commitish?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function commitFromRelease(item: ReleasePayload): string | null {
  const bodyCommit = /提交[：:]\s*`([0-9a-fA-F]{40})`/.exec(text(item.body))?.[1] ?? null;
  if (bodyCommit) return bodyCommit.toLowerCase();
  const target = text(item.target_commitish).trim();
  return /^[0-9a-fA-F]{40}$/.test(target) ? target.toLowerCase() : null;
}

function releaseFact(value: unknown): PublishedReleaseFact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as ReleasePayload;
  if (item.draft === true || item.prerelease === true || typeof item.tag_name !== "string") return null;
  return { tag: item.tag_name, commit: commitFromRelease(item) };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  allow404 = false,
): Promise<unknown | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "xunying-fork-release-preflight",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(`GitHub request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}: ${url}`);
  return (await response.json()) as unknown;
}

async function loadPublishedReleases(
  fetchImpl: typeof fetch,
  repo: string,
  token: string,
): Promise<PublishedReleaseFact[]> {
  const releases: PublishedReleaseFact[] = [];
  for (let page = 1; page <= MAX_RELEASE_PAGES; page += 1) {
    const body = await requestJson(
      fetchImpl,
      `${API_BASE}/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      token,
    );
    if (!Array.isArray(body)) throw new Error("GitHub releases response was not an array");
    for (const item of body) {
      const fact = releaseFact(item);
      if (fact) releases.push(fact);
    }
    if (body.length < RELEASES_PER_PAGE) break;
    if (page === MAX_RELEASE_PAGES) {
      throw new Error(`GitHub release history has ${MAX_RELEASE_PAGES} full pages; refusing a possibly truncated preflight`);
    }
  }
  return releases;
}

export async function runReleasePreflight(input: {
  repo: string;
  tag: string;
  commit: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<ReleasePreflightResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const local = evaluateReleasePreflight({
    targetTag: input.tag,
    targetCommit: input.commit,
    publishedReleases: [],
  });
  if (!local.ok) return local;
  // Fetch the list first: if the repository/releases endpoint is not readable, fail
  // closed. Only after that is a 404 on the tag-specific endpoint interpreted as
  // "this tag has no release yet".
  const publishedReleases = await loadPublishedReleases(fetchImpl, input.repo, input.token);
  const existingBody = await requestJson(
    fetchImpl,
    `${API_BASE}/repos/${input.repo}/releases/tags/${encodeURIComponent(input.tag)}`,
    input.token,
    true,
  );
  if (existingBody !== null) {
    const existing = releaseFact(existingBody);
    if (!existing) {
      throw new Error(`existing release for ${input.tag} is not a valid published release`);
    }
    if (!publishedReleases.some((release) => release.tag === existing.tag)) {
      publishedReleases.push(existing);
    }
  }
  return evaluateReleasePreflight({
    targetTag: input.tag,
    targetCommit: input.commit,
    publishedReleases,
  });
}
