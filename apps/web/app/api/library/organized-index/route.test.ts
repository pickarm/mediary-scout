import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryOrganizationRuntimeError } from "../../../../lib/library-organization-runtime";

const mocks = vi.hoisted(() => ({
  listDrifts: vi.fn(),
  ignoreDrifts: vi.fn(),
  unignoreDrifts: vi.fn(),
  listByFileIds: vi.fn(),
  listAllDriftedFileIds: vi.fn(),
  syncScannedParentBindings: vi.fn(),
  query: vi.fn(),
  getOrgService: vi.fn(),
  preview: vi.fn(),
  requestExecution: vi.fn(),
  wakeOrgWorker: vi.fn(),
}));

vi.mock("../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "account-a") };
});

vi.mock("@media-track/workflow/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@media-track/workflow/library")>();
  return {
    ...actual,
    PostgresOrganizedIndexStore: vi.fn().mockImplementation(function () {
      return {
        listDrifts: mocks.listDrifts,
        ignoreDrifts: mocks.ignoreDrifts,
        unignoreDrifts: mocks.unignoreDrifts,
        listByFileIds: mocks.listByFileIds,
        listAllDriftedFileIds: mocks.listAllDriftedFileIds,
        syncScannedParentBindings: mocks.syncScannedParentBindings,
      };
    }),
  };
});

vi.mock("../../../../lib/library-runtime", () => ({
  getLibraryReadServices: vi.fn(async () => ({
    pool: { query: mocks.query },
  })),
}));

vi.mock("../../../../lib/library-organization-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-organization-runtime")>();
  return {
    ...actual,
    getLibraryOrganizationService: mocks.getOrgService,
  };
});

vi.mock("../../../../lib/library-organization-worker", () => ({
  wakeLibraryOrganizationWorker: mocks.wakeOrgWorker,
}));

import { GET, POST } from "./route";

describe("organized index API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrgService.mockResolvedValue({
      scope: { accountId: "account-a", connectedStorageId: "storage-a" },
      preview: mocks.preview,
      store: { requestExecution: mocks.requestExecution },
      organizedIndexStore: {
        listByFileIds: mocks.listByFileIds,
        listAllDriftedFileIds: mocks.listAllDriftedFileIds,
        syncScannedParentBindings: mocks.syncScannedParentBindings,
      },
    });
  });

  it("lists drifted or ignored entries on GET and validates query parameters", async () => {
    mocks.listDrifts.mockResolvedValue({
      items: [{ fileId: "f-1", driftStatus: "drifted" }],
      page: 1,
      pageSize: 20,
      total: 1,
      totalPages: 1,
      counts: { totalIndexed: 12, drifted: 1, ignored: 0 },
    });

    const okRes = await GET(new NextRequest("https://app.example/api/library/organized-index?storageId=storage-a&status=drifted"));
    expect(okRes.status).toBe(200);
    expect(mocks.listDrifts).toHaveBeenCalledWith(
      { accountId: "account-a", connectedStorageId: "storage-a" },
      { status: "drifted", page: 1, pageSize: 20 },
    );

    const badRes = await GET(new NextRequest("https://app.example/api/library/organized-index?storageId=storage-a&status=clean"));
    expect(badRes.status).toBe(400);
  });

  it("ignores and unignores drifts via POST", async () => {
    mocks.ignoreDrifts.mockResolvedValueOnce(1);
    const ignoreRes = await POST(new NextRequest("https://app.example/api/library/organized-index", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "ignore", fileIds: ["f-1"] }),
    }));
    expect(ignoreRes.status).toBe(200);
    expect(await ignoreRes.json()).toEqual({ updatedCount: 1, accepted: true });
    expect(mocks.ignoreDrifts).toHaveBeenCalledTimes(1);

    mocks.unignoreDrifts.mockResolvedValueOnce(1);
    const unignoreRes = await POST(new NextRequest("https://app.example/api/library/organized-index", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "unignore", fileIds: ["f-1"] }),
    }));
    expect(unignoreRes.status).toBe(200);
    expect(await unignoreRes.json()).toEqual({ updatedCount: 1, accepted: true });
  });

  it("queues reorganization plans for drifted entries and rejects frozen drives", async () => {
    mocks.listAllDriftedFileIds.mockResolvedValue(["f-1"]);
    mocks.listByFileIds.mockResolvedValue([
      { fileId: "f-1", observedTaskId: "scan-1" },
    ]);
    mocks.syncScannedParentBindings.mockResolvedValue(undefined);
    mocks.preview.mockResolvedValue({
      operationKey: "org-reorg-1",
      operations: [{ operationId: "op-1" }],
    });
    mocks.requestExecution.mockResolvedValue(true);

    const okRes = await POST(new NextRequest("https://app.example/api/library/organized-index", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "reorganize", allDrifted: true }),
    }));
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ queuedPlans: 1, queuedFiles: 1 });
    expect(mocks.syncScannedParentBindings).toHaveBeenCalledWith(
      { accountId: "account-a", connectedStorageId: "storage-a" },
      "scan-1",
      ["f-1"],
      expect.any(String),
    );
    expect(mocks.wakeOrgWorker).toHaveBeenCalledTimes(1);

    mocks.getOrgService.mockRejectedValueOnce(new LibraryOrganizationRuntimeError("storage_frozen", "已冻结"));
    const frozenRes = await POST(new NextRequest("https://app.example/api/library/organized-index", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "reorganize", fileIds: ["f-1"] }),
    }));
    expect(frozenRes.status).toBe(409);
  });
});
