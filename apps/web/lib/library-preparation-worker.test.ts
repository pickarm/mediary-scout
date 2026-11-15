import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreparationDescriptor } from "@media-track/workflow/library";

const { query, tick, register, resolveDescriptors } = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  tick: vi.fn(async () => 0),
  register: vi.fn(async () => true),
  resolveDescriptors: vi.fn(async () => [] as PreparationDescriptor[]),
}));
vi.mock("./library-preparation-runtime", () => ({
  getLibraryPreparationPool: () => ({ query }),
  getLibraryPreparationService: () => ({ tick, register }),
  ensureLibraryPreparationRuntime: vi.fn(async () => undefined),
}));
vi.mock("./workflow-runtime", () => ({
  resolveLibraryPreparationDescriptorsForPage: resolveDescriptors,
}));

import { runLibraryPreparationWorkerTick, startLibraryPreparationWorker } from "./library-preparation-worker";
import { clearUpdateHold, setUpdateHold } from "./update-hold";

afterEach(() => {
  vi.unstubAllEnvs();
  clearUpdateHold();
  query.mockClear();
  tick.mockClear();
  register.mockReset().mockResolvedValue(true);
  resolveDescriptors.mockReset().mockResolvedValue([]);
  vi.restoreAllMocks();
});

describe("library preparation worker gates", () => {
  it("does not start or touch the queue when workers are disabled", async () => {
    vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "0");
    startLibraryPreparationWorker();
    await runLibraryPreparationWorkerTick();
    expect(query).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it.each([
    ["demo", "MEDIA_TRACK_DEMO_MODE", "1"],
    ["rehearsal", "MEDIA_TRACK_REHEARSAL", "1"],
  ])("does not query during %s mode", async (_label, key, value) => {
    vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "1");
    vi.stubEnv(key, value);
    await runLibraryPreparationWorkerTick();
    expect(query).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("stops starting a tick while update hold is active", async () => {
    vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "1");
    setUpdateHold(Date.now(), 60_000);
    await runLibraryPreparationWorkerTick();
    expect(query).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("pages the native queue independently before draining preparation jobs", async () => {
    vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "1");
    await runLibraryPreparationWorkerTick();
    expect(query).toHaveBeenCalledOnce();
    expect(tick).toHaveBeenCalledOnce();
  });

  it("continues registering the page when an individual row fails", async () => {
    vi.stubEnv("MEDIA_TRACK_INPROCESS_WORKER", "1");
    const descriptor = (workflowRunId: string): PreparationDescriptor => ({
      accountId: "acct", connectedStorageId: "drive", workflowRunId, mediaType: "movie", tmdbId: 7,
      title: "Example", aliases: [], year: 2020, searchConfigFingerprint: "fingerprint-valid",
    });
    resolveDescriptors.mockResolvedValue([descriptor("bad-register"), descriptor("good-register")]);
    register.mockRejectedValueOnce(new Error("database error"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await runLibraryPreparationWorkerTick();
    expect(register).toHaveBeenCalledTimes(2);
    expect(register).toHaveBeenNthCalledWith(1, expect.objectContaining({ workflowRunId: "bad-register" }));
    expect(register).toHaveBeenNthCalledWith(2, expect.objectContaining({ workflowRunId: "good-register" }));
    expect(tick).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith("[library-preparation] registration failed (Error); continuing");
  });
});
