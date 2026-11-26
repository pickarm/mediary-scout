import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn(async () => undefined) };
});

const isDemoMode = vi.fn(() => false);
vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: () => isDemoMode(),
}));

const resolveCurrentIsOwner = vi.fn(async () => true);
vi.mock("../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: () => resolveCurrentIsOwner(),
}));

const getUpdaterStatus = vi.fn(async () => ({ phase: "idle", message: "" }));
vi.mock("../../../../lib/updater-client", () => ({
  getUpdaterStatus: () => getUpdaterStatus(),
}));

import { GET } from "./route";

describe("GET /api/update/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isDemoMode.mockReturnValue(false);
    resolveCurrentIsOwner.mockResolvedValue(true);
    getUpdaterStatus.mockResolvedValue({ phase: "verifying", message: "正在检查新版本是否正常。" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is 404 in demo mode and does not ask the updater", async () => {
    isDemoMode.mockReturnValue(true);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(resolveCurrentIsOwner).not.toHaveBeenCalled();
    expect(getUpdaterStatus).not.toHaveBeenCalled();
  });

  it("is 404 for a non-owner", async () => {
    resolveCurrentIsOwner.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(getUpdaterStatus).not.toHaveBeenCalled();
  });

  it("returns { updater: null } without calling updater in fork-image (default) mode", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updater: null });
    expect(getUpdaterStatus).not.toHaveBeenCalled();
  });

  it("returns the updater status to the owner in local-source mode", async () => {
    vi.stubEnv("MEDIA_TRACK_DISTRIBUTION", "local-source");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updater: { phase: "verifying", message: "正在检查新版本是否正常。" } });
    expect(getUpdaterStatus).toHaveBeenCalledTimes(1);
  });
});
