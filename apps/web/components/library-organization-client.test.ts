import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrganizationPayloadError,
  controlOrganizationPlan,
  createOrganizationPreview,
  loadOrganizationOperations,
  loadOrganizationPlans,
  type OrganizationOperation,
  type OrganizationPlanSummary,
} from "./library-organization-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function plan(operationKey: string, overrides: Partial<OrganizationPlanSummary> = {}): OrganizationPlanSummary {
  return {
    operationKey, status: "planned", createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z",
    operationCount: 1, skippedFiles: [], ...overrides,
  };
}
const operation: OrganizationOperation = {
  operationId: "operation-1", fileId: "provider-file-1", originalParentId: "parent-1", originalName: "old.mkv",
  targetRootId: "root-1", targetRelativePath: "Film/new.mkv", targetParentId: "target-parent-1", targetName: "new.mkv",
  pairedFileId: "provider-subtitle-1", pairedVideoTargetPath: "Film/new.mkv", status: "planned", error: null,
};

describe("library organization API client", () => {
  it("uses bounded cursor pages for plan and operation history", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ plans: [], nextCursor: "plan-cursor" }))
      .mockResolvedValueOnce(response({ plan: plan("key/1"), operations: [], nextCursor: null }));
    globalThis.fetch = fetchMock;
    await loadOrganizationPlans("storage/a", "task 1", null);
    await loadOrganizationOperations("storage/a", "task 1", "key/1", "operation-cursor");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("limit=20");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("storage%2Fa");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cursor=operation-cursor");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("key%2F1");
  });

  it("posts only selected provider file IDs to create a plan and uses explicit execute or pause actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ plan: plan("plan-1") }, 201))
      .mockResolvedValueOnce(response({ operationKey: "plan-1", status: "queued", accepted: true }));
    globalThis.fetch = fetchMock;
    await createOrganizationPreview("storage-1", "task-1", ["provider-file-1", "provider-file-2"]);
    await controlOrganizationPlan("storage-1", "task-1", "plan-1", "execute");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ storageId: "storage-1", fileIds: ["provider-file-1", "provider-file-2"] });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ storageId: "storage-1", action: "execute" });
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("normalizes missing skipped files and filters null list rows", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ plans: [plan("plan-1"), null, plan("plan-2", { executeRequested: true })], nextCursor: null }))
      .mockResolvedValueOnce(response({ plan: { ...plan("plan-1"), skippedFiles: undefined }, operations: [operation, null], nextCursor: null }));
    globalThis.fetch = fetchMock;
    const plans = await loadOrganizationPlans("storage-1", "task-1", null);
    const detail = await loadOrganizationOperations("storage-1", "task-1", "plan-1", null);
    expect(plans.plans.map((item) => item.operationKey)).toEqual(["plan-1", "plan-2"]);
    expect(plans.plans[0]?.executeRequested).toBeUndefined();
    expect(plans.plans[1]?.executeRequested).toBe(true);
    expect(detail.plan.skippedFiles).toEqual([]);
    expect(detail.operations.map((item) => item.operationId)).toEqual(["operation-1"]);
  });

  it("rejects structurally invalid successful responses at the client boundary", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ plans: "not-a-list", nextCursor: null }))
      .mockResolvedValueOnce(response({ operations: [] }))
      .mockResolvedValueOnce(response({ plan: plan("plan-1"), operations: [{ ...operation, targetRelativePath: undefined }] }));
    globalThis.fetch = fetchMock;
    await expect(loadOrganizationPlans("storage-1", "task-1", null)).rejects.toBeInstanceOf(OrganizationPayloadError);
    await expect(loadOrganizationOperations("storage-1", "task-1", "plan-1", null)).rejects.toThrow("缺少清单摘要");
    await expect(loadOrganizationOperations("storage-1", "task-1", "plan-1", null)).rejects.toThrow("整理目标路径无效");
  });

  it("preserves HTTP rejection status while leaving transport failures distinguishable", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response({ error: "整理清单状态冲突。" }, 409));
    globalThis.fetch = fetchMock;
    await expect(loadOrganizationPlans("storage-1", "task-1", null)).rejects.toMatchObject({
      name: "ApiRequestError", status: 409, message: "整理清单状态冲突。",
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("network down"));
    await expect(loadOrganizationPlans("storage-1", "task-1", null)).rejects.toMatchObject({ name: "TypeError", message: "network down" });
  });
});
