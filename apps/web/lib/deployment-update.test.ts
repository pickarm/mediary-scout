import { beforeEach, describe, expect, it, vi } from "vitest";

const readFileMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}));

import { normalizeCommit, shortCommit } from "./deployment-update";
import { readBuildCommit, readBuildVersion } from "./deployment-update-server";

const CURRENT = "1111111111111111111111111111111111111111";

describe("normalizeCommit", () => {
  it("accepts exactly 40 lowercase/uppercase hex chars", () => {
    expect(normalizeCommit(CURRENT.toUpperCase())).toBe(CURRENT);
  });

  it("rejects unknown and short build stamps", () => {
    expect(normalizeCommit("unknown")).toBeNull();
    expect(normalizeCommit("1111111")).toBeNull();
    expect(normalizeCommit(`${CURRENT}junk`)).toBeNull();
  });

  it("rejects 39-char prefix and non-hex content", () => {
    expect(normalizeCommit(CURRENT.slice(0, 39))).toBeNull();
    expect(normalizeCommit("g".repeat(40))).toBeNull();
  });
});

describe("shortCommit", () => {
  it("takes the first 7 chars, and passes null through", () => {
    expect(shortCommit(CURRENT)).toBe("1111111");
    expect(shortCommit(null)).toBeNull();
  });
});

describe("readBuildCommit & readBuildVersion", () => {
  beforeEach(() => {
    readFileMock.mockReset();
  });

  it("reads /app/BUILD_COMMIT first and falls back to BUILD_COMMIT", async () => {
    readFileMock.mockResolvedValueOnce(`${CURRENT.toUpperCase()}\n`);
    expect(await readBuildCommit()).toBe(CURRENT);

    readFileMock.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(`${CURRENT}\n`);
    expect(await readBuildCommit()).toBe(CURRENT);

    readFileMock.mockRejectedValue(new Error("ENOENT"));
    expect(await readBuildCommit()).toBeNull();
  });

  it("reads /app/BUILD_VERSION, falls back to BUILD_VERSION, trims whitespace, and returns null when empty", async () => {
    readFileMock.mockResolvedValueOnce(" v2026.11.26 \n");
    expect(await readBuildVersion()).toBe("v2026.11.26");

    readFileMock.mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce("  edge  \n");
    expect(await readBuildVersion()).toBe("edge");

    readFileMock.mockResolvedValueOnce("   \n");
    expect(await readBuildVersion()).toBeNull();

    readFileMock.mockRejectedValue(new Error("ENOENT"));
    expect(await readBuildVersion()).toBeNull();
  });
});
