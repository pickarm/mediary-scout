import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryOrganizationRuntimeError } from "../../../../lib/library-organization-runtime";

const mocks = vi.hoisted(() => ({
  listOperationHistory: vi.fn(),
  query: vi.fn(),
  listFailedPlans: vi.fn(),
  requestExecution: vi.fn(),
  getOrgService: vi.fn(),
  wakeOrgWorker: vi.fn(),
}));

vi.mock("../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "account-a") };
});

vi.mock("../../../../lib/library-read-runtime", () => ({
  getLibraryReadOrganizationService: vi.fn(async () => ({
    scope: { accountId: "account-a", connectedStorageId: "storage-a" },
    store: { listOperationHistory: mocks.listOperationHistory },
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

vi.mock("../../../../lib/library-runtime", () => ({
  getLibraryReadServices: vi.fn(async () => ({
    pool: { query: mocks.query },
  })),
}));

import { GET, POST } from "./route";

describe("organization history API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrgService.mockResolvedValue({
      scope: { accountId: "account-a", connectedStorageId: "storage-a" },
      store: {
        listFailedPlans: mocks.listFailedPlans,
        requestExecution: mocks.requestExecution,
      },
    });
  });

  it("returns paginated history with status counts and active summary", async () => {
    mocks.listOperationHistory.mockResolvedValue({
      items: [
        {
          taskId: "scan-1",
          operationKey: "org-1",
          operationId: "op-1",
          fileId: "file-1",
          originalParentId: "src",
          originalName: "Dune.mkv",
          targetRootId: "movies",
          targetRelativePath: "沙丘2 (2024)/沙丘2 (2024).mkv",
          targetParentId: "dir-1",
          targetName: "沙丘2 (2024).mkv",
          identity: null,
          pairedFileId: "file-1",
          pairedVideoTargetPath: "沙丘2 (2024)/沙丘2 (2024).mkv",
          status: "verified",
          error: null,
          updatedAt: "2026-11-27T12:00:00.000Z",
        },
      ],
      page: 2,
      pageSize: 20,
      total: 42,
      totalPages: 3,
      counts: { all: 42, running: 1, planned: 2, verified: 38, failed: 1 },
    });
    mocks.query
      .mockResolvedValueOnce({
        rows: [
          {
            task_id: "scan-1",
            config_id: "cfg-1",
            status: "running",
            directories_done: 1,
            directories_discovered: 3,
            files_discovered: 15,
            updated_at: "2026-11-27T12:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ active_count: "2" }] });

    const response = await GET(new NextRequest("https://app.example/api/library/organization-history?storageId=storage-a&page=2&pageSize=20&status=verified"));
    expect(response.status).toBe(200);
    expect(mocks.listOperationHistory).toHaveBeenCalledWith(
      { accountId: "account-a", connectedStorageId: "storage-a" },
      { page: 2, pageSize: 20, status: "verified" },
    );
    expect(await response.json()).toMatchObject({
      page: 2,
      total: 42,
      totalPages: 3,
      counts: { all: 42, running: 1, planned: 2, verified: 38, failed: 1 },
      activeSummary: {
        hasActiveWork: true,
        activePlanCount: 2,
        latestScanTask: { taskId: "scan-1", status: "running", directoriesDone: 1, directoriesDiscovered: 3, filesDiscovered: 15 },
      },
    });
  });

  it("rejects invalid page, pageSize, or status values", async () => {
    for (const query of [
      "storageId=storage-a&page=0",
      "storageId=storage-a&page=abc",
      "storageId=storage-a&pageSize=200",
      "storageId=storage-a&status=unknown",
    ]) {
      const response = await GET(new NextRequest(`https://app.example/api/library/organization-history?${query}`));
      expect(response.status).toBe(400);
    }
  });

  it("retries failed organization plans on POST retry_failed and rejects frozen storages or invalid actions", async () => {
    mocks.listFailedPlans.mockResolvedValue([
      { taskId: "task-1", operationKey: "org-1" },
      { taskId: "task-1", operationKey: "org-2" },
    ]);
    mocks.requestExecution.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const response = await POST(new NextRequest("https://app.example/api/library/organization-history", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "retry_failed" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ retriedPlans: 2, accepted: true });
    expect(mocks.wakeOrgWorker).toHaveBeenCalledTimes(1);

    const badAction = await POST(new NextRequest("https://app.example/api/library/organization-history", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "delete" }),
    }));
    expect(badAction.status).toBe(400);

    mocks.getOrgService.mockRejectedValueOnce(new LibraryOrganizationRuntimeError("storage_frozen", "已冻结"));
    const frozenRes = await POST(new NextRequest("https://app.example/api/library/organization-history", {
      method: "POST",
      headers: { origin: "https://app.example", host: "app.example", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ storageId: "storage-a", action: "retry_failed" }),
    }));
    expect(frozenRes.status).toBe(409);
  });
});
