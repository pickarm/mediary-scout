import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemInfoSnapshot } from "../../../../lib/system-info-format";

const mocks = vi.hoisted(() => ({
  isDemoMode: vi.fn(() => false),
  isMultiUserEnabled: vi.fn(() => true),
  hasLoginPassword: vi.fn<() => Promise<boolean | "unknown">>(async () => true),
  requireAuthenticatedAccountId: vi.fn(async () => "acct_default"),
  resolveCurrentIsOwner: vi.fn(async () => true),
  collectSystemInfo: vi.fn<(opts: { accountId: string; canViewInfraDetails: boolean }) => Promise<SystemInfoSnapshot>>(),
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, connection: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("../../../../lib/demo-mode", () => ({
  isDemoMode: mocks.isDemoMode,
}));
vi.mock("../../../../lib/settings-attention-server", () => ({
  resolveCurrentIsOwner: mocks.resolveCurrentIsOwner,
}));
vi.mock("../../../../lib/system-info-server", () => ({
  collectSystemInfo: mocks.collectSystemInfo,
}));
vi.mock("../../../../lib/workflow-runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/workflow-runtime")>(
    "../../../../lib/workflow-runtime",
  );
  return {
    hasLoginPassword: mocks.hasLoginPassword,
    isMultiUserEnabled: mocks.isMultiUserEnabled,
    requireAuthenticatedAccountId: mocks.requireAuthenticatedAccountId,
    UnauthenticatedAccountError: actual.UnauthenticatedAccountError,
  };
});

import { UnauthenticatedAccountError } from "../../../../lib/workflow-runtime";
import { GET } from "./route";

const SAMPLE_SNAPSHOT: SystemInfoSnapshot = {
  collectedAt: "2026-11-26T14:00:00.000Z",
  process: {
    startedAt: "2026-11-26T13:00:00.000Z",
    uptimeSeconds: 3600,
    nodeVersion: "v22.13.0",
    platform: "linux",
    arch: "x64",
    memoryRssMb: 128.4,
    memoryHeapUsedMb: 64.2,
    pid: 123,
  },
  version: {
    buildVersion: "v2026.11.26",
    buildCommit: "abcdef1234567890",
    distribution: "fork-image",
    imageRef: "ghcr.io/pickarm/mediary-scout:latest",
    demoMode: false,
    rehearsalMode: false,
  },
  database: {
    engine: "postgresql",
    status: "connected",
    latencyMs: 3,
    serverVersion: "PostgreSQL 16.4",
    target: "db.internal:5432",
    databaseName: "media_track",
    sslMode: null,
    message: null,
  },
  redis: {
    status: "connected",
    latencyMs: 2,
    serverVersion: "Redis 7.2.5",
    target: "redis.internal:6379",
    dbIndex: "db0",
    tls: false,
    summaryCacheReady: true,
    namespace: "mediary-scout",
    message: null,
  },
  library: {
    landedTotal: 12,
    landedMovies: 8,
    landedTv: 3,
    landedAnime: 1,
    trackedTotal: 14,
    obtainedEpisodes: 42,
    activeDrives: 2,
    totalDrives: 2,
  },
  canViewInfraDetails: true,
};

describe("GET /api/system/info", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoMode.mockReturnValue(false);
    mocks.isMultiUserEnabled.mockReturnValue(true);
    mocks.hasLoginPassword.mockResolvedValue(true);
    mocks.requireAuthenticatedAccountId.mockResolvedValue("acct_default");
    mocks.resolveCurrentIsOwner.mockResolvedValue(true);
    mocks.collectSystemInfo.mockResolvedValue(SAMPLE_SNAPSHOT);
  });

  it("returns 401 when caller is unauthenticated or single-user password is unset", async () => {
    mocks.requireAuthenticatedAccountId.mockRejectedValueOnce(new UnauthenticatedAccountError());
    const unauth = await GET();
    expect(unauth.status).toBe(401);

    mocks.isMultiUserEnabled.mockReturnValueOnce(false);
    mocks.hasLoginPassword.mockResolvedValueOnce(false);
    const unset = await GET();
    expect(unset.status).toBe(401);
    expect(mocks.collectSystemInfo).not.toHaveBeenCalled();
  });

  it("returns system snapshot with no-store header and passes owner privilege flag", async () => {
    mocks.requireAuthenticatedAccountId.mockResolvedValueOnce("acct_member");
    mocks.resolveCurrentIsOwner.mockResolvedValueOnce(false);

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.collectSystemInfo).toHaveBeenCalledWith({
      accountId: "acct_member",
      canViewInfraDetails: false,
    });
    expect(await res.json()).toEqual(SAMPLE_SNAPSHOT);
  });
});
