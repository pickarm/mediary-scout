import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  enqueueForScan: vi.fn(),
  retryFailed: vi.fn(),
  list: vi.fn(),
  identificationStore: { getJob: vi.fn() },
}));
const runtime = vi.hoisted(() => ({ getLibraryIdentificationService: vi.fn(), getLibraryReadIdentificationService: vi.fn(), watchLibraryScanForIdentification: vi.fn() }));

vi.mock("../../../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "account_test") };
});
vi.mock("../../../../../../lib/library-identification-runtime", () => runtime);

import { GET, POST } from "./route.js";

describe("scan identifications route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.getLibraryIdentificationService.mockResolvedValue(service);
    runtime.getLibraryReadIdentificationService.mockResolvedValue(service);
    runtime.watchLibraryScanForIdentification.mockResolvedValue(undefined);
    service.list.mockResolvedValue({ summary: { job: { status: "completed", scanStatus: "completed", afterFileId: "file-1", attempts: 1, lastError: null }, total: 1, confirmed: 1, pending: 0, ignored: 0, failed: 0, imported: 1 }, items: [], nextCursor: null, hasMore: false });
    service.identificationStore.getJob.mockResolvedValue({ status: "pending" });
    service.retryFailed.mockResolvedValue(true);
  });

  it("reads bounded results without starting recognition", async () => {
    const request = new NextRequest("http://localhost/api/library/scans/task-1/identifications?storageId=storage-1&limit=20");
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-1" }) });
    expect(response.status).toBe(200);
    expect(runtime.getLibraryReadIdentificationService).toHaveBeenCalledWith({ accountId: "account_test", connectedStorageId: "storage-1" });
    expect(service.list).toHaveBeenCalledWith("task-1", { limit: 20 });
    expect(runtime.getLibraryIdentificationService).not.toHaveBeenCalled();
    expect(service.enqueueForScan).not.toHaveBeenCalled();
  });

  it("passes the requested size and decoded filters to the service", async () => {
    const request = new NextRequest("http://localhost/api/library/scans/task-1/identifications?storageId=storage-1&limit=200&cursor=ZmlsZS0wMTA&status=confirmed");
    const response = await GET(request, { params: Promise.resolve({ taskId: "task-1" }) });
    expect(response.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(
      "task-1",
      { limit: 200, afterFileId: "file-010", status: "confirmed" },
    );
  });

  it("enqueues asynchronously and rejects unsupported request fields", async () => {
    const request = new NextRequest("http://localhost/api/library/scans/task-1/identifications", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ storageId: "storage-1", action: "start" }),
    });
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1" }) });
    expect(response.status).toBe(202);
    expect(service.enqueueForScan).toHaveBeenCalledWith({ accountId: "account_test", connectedStorageId: "storage-1" }, "task-1");
    expect(runtime.watchLibraryScanForIdentification).toHaveBeenCalled();

    const invalid = new NextRequest("http://localhost/api/library/scans/task-1/identifications", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ storageId: "storage-1", title: "untrusted" }),
    });
    expect((await POST(invalid, { params: Promise.resolve({ taskId: "task-1" }) })).status).toBe(400);
  });
});
