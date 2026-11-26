import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  account: vi.fn<() => Promise<string>>(),
  storages: vi.fn<() => Promise<Array<{ id: string; accountId: string; provider?: string; label?: string | null; status?: string }>>>(),
  getPage: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));
vi.mock("../../../../lib/library-api", () => ({
  libraryAccount: state.account,
  apiErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: (error as { status?: number }).status ?? 500 }),
  LibraryApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
  requireString: (value: unknown, name: string, max = 300) => { if (typeof value !== "string" || !value.trim() || value.length > max) throw Object.assign(new Error(`${name} invalid`), { status: 400 }); return value.trim(); },
}));
vi.mock("../../../../lib/library-media-runtime", () => ({ getLibraryMediaPage: state.getPage }));
vi.mock("../../../../lib/workflow-runtime", () => ({ getWorkflowRepository: () => ({ listConnectedStorages: state.storages }) }));

import { GET } from "./route";

function req(query = ""): NextRequest { return new NextRequest(`https://example.test/api/library/media${query}`); }

describe("GET /api/library/media", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.account.mockResolvedValue("acct_current");
    state.storages.mockResolvedValue([{ id: "owned", accountId: "acct_current" }]);
    state.getPage.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 48, hasMore: false });
  });

  it("derives account and defaults to the account-wide bounded page", async () => {
    expect((await GET(req())).status).toBe(200);
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acct_current", connectedStorageId: null, page: 1, pageSize: 48 }));
  });

  it("validates storage ownership and passes normalized cross-page search filters", async () => {
    expect((await GET(req("?storageId=owned&type=tv&state=partial&search=%20Moon%20&page=2&pageSize=48"))).status).toBe(200);
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({ connectedStorageId: "owned", type: "tv", state: "partial", search: "Moon", page: 2 }));
    state.getPage.mockClear();
    expect((await GET(req("?storageId=foreign"))).status).toBe(404);
    expect(state.getPage).not.toHaveBeenCalled();
  });

  it("accepts the public DTO states, sort and direction within the bounded page size", async () => {
    expect((await GET(req("?state=reserved&sort=year&direction=desc&page=3&pageSize=100"))).status).toBe(200);
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({
      state: "reserved", sort: "year", direction: "desc", page: 3, pageSize: 100,
    }));
  });

  it("accepts updatedAt sort and optionally returns sanitized connected storages", async () => {
    state.storages.mockResolvedValue([
      { id: "owned", accountId: "acct_current", provider: "quark", label: "主盘", status: "active" },
      { id: "other", accountId: "acct_other", provider: "pan115", label: "别人的", status: "active" },
    ]);
    const res = await GET(req("?sort=updatedAt&direction=desc&includeStorages=1"));
    expect(res.status).toBe(200);
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({
      sort: "updatedAt",
      direction: "desc",
    }));
    const body = await res.json() as { storages?: Array<{ id: string; label: string; provider: string; status: string }> };
    expect(body.storages).toEqual([
      { id: "owned", provider: "quark", label: "夸克网盘（主盘）", status: "active" },
    ]);
  });

  it("rejects unbounded or unsupported query values before querying", async () => {
    expect((await GET(req("?pageSize=101"))).status).toBe(400);
    expect((await GET(req("?pageSize=0"))).status).toBe(400);
    expect((await GET(req("?page=0"))).status).toBe(400);
    expect((await GET(req("?type=book"))).status).toBe(400);
    expect((await GET(req("?state=unknown"))).status).toBe(400);
    expect((await GET(req("?sort=popularity"))).status).toBe(400);
    expect((await GET(req("?direction=sideways"))).status).toBe(400);
    expect((await GET(req(`?search=${"a".repeat(201)}`))).status).toBe(400);
    expect(state.getPage).not.toHaveBeenCalled();
  });
});
