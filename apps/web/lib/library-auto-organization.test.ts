import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn() })),
  getWrite: vi.fn(),
  getReadServices: vi.fn(),
  constructStore: vi.fn(),
  storeGet: vi.fn(),
}));

vi.mock("./library-runtime", () => ({ getLibraryPool: mocks.getPool, getLibraryReadServices: mocks.getReadServices }));
vi.mock("./library-organization-runtime", () => ({ getLibraryOrganizationService: mocks.getWrite }));
vi.mock("@media-track/workflow/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@media-track/workflow/library")>();
  class PostgresOrganizationStore {
    constructor(pool: object) {
      mocks.constructStore(pool);
    }
    get(scope: { accountId: string; connectedStorageId: string }, taskId: string, operationKey: string) {
      return mocks.storeGet(scope, taskId, operationKey);
    }
  }
  return { ...actual, PostgresOrganizationStore };
});

import { LibraryAutoOrganizationExecutionPort } from "./library-auto-organization";

const scope = { accountId: "account-a", connectedStorageId: "storage-a" };

describe("LibraryAutoOrganizationExecutionPort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews and requests execution through the F08c write service", async () => {
    const preview = vi.fn(async (_taskId: string, _selection: { fileIds: readonly string[] }) => ({ operationKey: "op-a" }));
    const requestExecution = vi.fn(async (_scope: typeof scope, _taskId: string, _operationKey: string, _now: string, _options?: unknown) => true);
    mocks.getWrite.mockResolvedValue({ scope, preview, store: { requestExecution } });
    const port = new LibraryAutoOrganizationExecutionPort();

    await expect(port.preview(scope, "task-a", ["file-a", "file-b"], "2026-11-16T00:00:00.000Z"))
      .resolves.toEqual({ operationKey: "op-a" });
    expect(preview).toHaveBeenCalledWith("task-a", { fileIds: ["file-a", "file-b"] });

    await expect(port.requestExecution(scope, "task-a", "op-a", "2026-11-16T00:01:00.000Z", { batchId: "batch-a", leaseId: "lease-a" }))
      .resolves.toBe(true);
    expect(requestExecution).toHaveBeenCalledWith(
      scope, "task-a", "op-a", "2026-11-16T00:01:00.000Z",
      { autoOrganization: { batchId: "batch-a", leaseId: "lease-a" } },
    );
  });

  it("reads plan state through the read-only PG port so frozen credentials do not create a client", async () => {
    const pool = { poolName: "read-one" };
    mocks.getReadServices.mockResolvedValue({ pool, scanStore: {} });
    mocks.storeGet.mockResolvedValue({ status: "requested", executeRequested: true });
    const port = new LibraryAutoOrganizationExecutionPort();
    await expect(port.getPlan(scope, "task-a", "op-a")).resolves.toEqual({ status: "requested", executeRequested: true });
    await expect(port.getPlan(scope, "task-b", "op-b")).resolves.toEqual({ status: "requested", executeRequested: true });
    expect(mocks.getReadServices).toHaveBeenCalledTimes(2);
    expect(mocks.getReadServices).toHaveBeenNthCalledWith(1, scope);
    expect(mocks.getReadServices).toHaveBeenNthCalledWith(2, scope);
    expect(mocks.constructStore).toHaveBeenCalledTimes(1);
    expect(mocks.constructStore).toHaveBeenCalledWith(pool);
    expect(mocks.storeGet).toHaveBeenCalledTimes(2);
    expect(mocks.getWrite).not.toHaveBeenCalled();
  });

  it("distinguishes a missing plan from an unrequested plan", async () => {
    mocks.getReadServices.mockResolvedValue({ pool: { poolName: "read-two" }, scanStore: {} });
    mocks.storeGet.mockResolvedValue(null);
    await expect(new LibraryAutoOrganizationExecutionPort().getPlan(scope, "task-a", "op-a")).resolves.toBeNull();
  });
});
