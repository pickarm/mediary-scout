import { readFile } from "node:fs/promises";
import { normalizeCommit } from "./deployment-update";

async function readStampFile(appPath: string, localPath: string): Promise<string | null> {
  try {
    return await readFile(appPath, "utf8");
  } catch {
    // Docker runner keeps the stamps at /app/BUILD_*; dev / desktop may not.
    try {
      return await readFile(localPath, "utf8");
    } catch {
      return null;
    }
  }
}

export async function readBuildCommit(): Promise<string | null> {
  return normalizeCommit(await readStampFile("/app/BUILD_COMMIT", "BUILD_COMMIT"));
}

export async function readBuildVersion(): Promise<string | null> {
  const raw = await readStampFile("/app/BUILD_VERSION", "BUILD_VERSION");
  const trimmed = raw?.trim() ?? "";
  return trimmed ? trimmed : null;
}
