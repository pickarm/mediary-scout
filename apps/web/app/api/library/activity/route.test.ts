import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  account: vi.fn<() => Promise<string>>(),
  storages: vi.fn<() => Promise<Array<{ id: string; accountId: string }>>>(),
  getPage: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));
vi.mock("../../../../lib/library-api", () => ({
  libraryAccount: state.account,
  apiErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: (error as { status?: number }).status ?? 500 }),
  LibraryApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
  parseLimit: (value: string | null, fallback: number, max: number) => { const n = value === null ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Object.assign(new Error("limit invalid"), { status: 400 }); return n; },
  requireString: (value: unknown, name: string, max = 300) => { if (typeof value !== "string" || !value || value.length > max) throw Object.assign(new Error(`${name} invalid`), { status: 400 }); return value; },
}));
vi.mock("../../../../lib/library-activity-runtime", () => ({ getLibraryActivityPage: state.getPage }));
vi.mock("../../../../lib/workflow-runtime", () => ({ getWorkflowRepository: () => ({ listConnectedStorages: state.storages }) }));

import { GET } from "./route";

function req(query = ""): NextRequest { return new NextRequest(`https://example.test/api/library/activity${query}`); }
describe("GET /api/library/activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.account.mockResolvedValue("acct_current");
    state.storages.mockResolvedValue([{ id: "owned", accountId: "acct_current" }]);
    state.getPage.mockResolvedValue({ active: { items: [] } });
  });
  it("derives account from authentication and validates selected storage ownership", async () => {
    const response = await GET(req("?storageId=owned"));
    expect(response.status).toBe(200);
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acct_current", connectedStorageId: "owned" }));
    state.getPage.mockClear();
    expect((await GET(req("?storageId=foreign"))).status).toBe(404);
    expect(state.getPage).not.toHaveBeenCalled();
  });
  it("allows account-wide reads and rejects page/ID bounds before query", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(state.getPage).toHaveBeenLastCalledWith(expect.objectContaining({ connectedStorageId: null }));
    expect((await GET(req("?activePage=0"))).status).toBe(400);
    expect((await GET(req(`${Array.from({ length: 101 }, (_, i) => `?runId=${i}`).join("")}`))).status).toBe(400);
  });
});
