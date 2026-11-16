import { runReleasePreflight } from "./release-preflight-github.js";

async function main(): Promise<void> {
  const [repo, tag, commit] = process.argv.slice(2);
  const token = process.env.GH_TOKEN?.trim() ?? "";
  if (!repo || !tag || !commit || !token) {
    throw new Error("usage: GH_TOKEN=... release-preflight-cli <owner/repo> <tag> <commit>");
  }

  const result = await runReleasePreflight({ repo, tag, commit, token });
  const detail = result.latestTag ? ` (latest published: ${result.latestTag})` : " (no published release yet)";
  if (!result.ok) {
    throw new Error(`release preflight rejected ${tag}: ${result.reason}${detail}`);
  }
  console.log(`release preflight accepted ${tag}: ${result.reason}${detail}`);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
