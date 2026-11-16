import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { tick, isHeld } = vi.hoisted(() => ({
  tick: vi.fn(async () => ({ processed: 0, recovered: 0, cancelled: 0 })),
  isHeld: vi.fn(() => false),
}));
vi.mock("./library-auto-organization", () => ({
  getLibraryAutoOrganizationScheduler: () => ({ tick }),
}));
vi.mock("./update-hold", () => ({
  isUpdateHoldActive: isHeld,
  whileInFlight: async (run: () => Promise<void>) => run(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "1");
  vi.stubEnv("MEDIA_TRACK_REHEARSAL", "0");
  vi.stubEnv("MEDIA_TRACK_DEMO_MODE", "0");
  vi.stubEnv("MEDIA_TRACK_LIBRARY_AUTO_ORGANIZATION_WORKER_POLL_MS", "1000");
  tick.mockReset().mockResolvedValue({ processed: 0, recovered: 0, cancelled: 0 });
  isHeld.mockReset().mockReturnValue(false);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("automatic organization startup integration", () => {
  it.each([
    ["MEDIA_TRACK_INPROCESS_WORKER", "0"],
    ["MEDIA_TRACK_REHEARSAL", "1"],
    ["MEDIA_TRACK_DEMO_MODE", "1"],
  ])("never starts a scheduler with %s=%s", async (key, value) => {
    vi.stubEnv(key, value);
    const { startLibraryAutoOrganizationWorker } = await import("./library-auto-organization-worker");
    startLibraryAutoOrganizationWorker();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits through an update hold, then resumes without a second startup", async () => {
    isHeld.mockReturnValue(true);
    const { startLibraryAutoOrganizationWorker } = await import("./library-auto-organization-worker");
    startLibraryAutoOrganizationWorker();
    startLibraryAutoOrganizationWorker();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).not.toHaveBeenCalled();
    isHeld.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not overlap a slow tick and recovers after it finishes", async () => {
    let release: (() => void) | undefined;
    tick.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return { processed: 0, recovered: 0, cancelled: 0 };
    });
    const { startLibraryAutoOrganizationWorker } = await import("./library-auto-organization-worker");
    startLibraryAutoOrganizationWorker();
    await vi.advanceTimersByTimeAsync(3000);
    expect(tick).toHaveBeenCalledTimes(1);
    expect(release).toBeTypeOf("function");
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
