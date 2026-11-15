import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => ({
  account: vi.fn<() => Promise<string>>(),
  storages: vi.fn<() => Promise<Array<{ id: string; accountId: string }>>>(),
  getPage: vi.fn<(...args: never[]) => Promise<unknown>>(),
  subscribe: vi.fn<(listener: () => void) => () => void>(),
  wake: null as (() => void) | null,
}));
vi.mock("../../../../lib/library-api", () => ({
  libraryAccount: state.account,
  apiErrorResponse: (error: unknown) => Response.json({ error: error instanceof Error ? error.message : "error" }, { status: (error as { status?: number }).status ?? 500 }),
  LibraryApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
  parseLimit: (value: string | null, fallback: number, max: number) => { const n = value === null ? fallback : Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Object.assign(new Error("limit invalid"), { status: 400 }); return n; },
  requireString: (value: unknown, name: string, max = 300) => { if (typeof value !== "string" || !value || value.length > max) throw Object.assign(new Error(`${name} invalid`), { status: 400 }); return value; },
}));
vi.mock("../../../../lib/library-activity-runtime", () => ({ getLibraryActivityPage: state.getPage }));
vi.mock("../../../../lib/library-summary-cache", () => ({ subscribeLibrarySummaryWake: state.subscribe }));
vi.mock("../../../../lib/workflow-runtime", () => ({ getWorkflowRepository: () => ({ listConnectedStorages: state.storages }) }));

import { GET } from "./route";

afterEach(() => vi.useRealTimers());

function req(query = "", headers?: HeadersInit): NextRequest { return new NextRequest(`https://example.test/api/library/progress${query}`, headers ? { headers } : {}); }
const page = { active: { items: [], total: 0, page: 1, pageSize: 48, hasMore: false }, totals: { queued: 0, running: 0, active: 0 }, recentCompleted: { items: [], nextCursor: null, hasMore: false } };

describe("GET /api/library/progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.account.mockResolvedValue("acct_current");
    state.storages.mockResolvedValue([{ id: "owned", accountId: "acct_current" }]);
    state.getPage.mockResolvedValue(page);
    state.wake = null;
    state.subscribe.mockImplementation((listener) => { state.wake = listener; return () => undefined; });
  });

  it("derives account from auth, performs an initial fresh snapshot, and ignores replay headers", async () => {
    const response = await GET(req("?storageId=owned&activePage=2&runId=r1&accountId=attacker", { "last-event-id": "999" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(state.account).toHaveBeenCalledOnce();
    expect(state.getPage).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acct_current", connectedStorageId: "owned", activePage: 2, runIds: ["r1"] }));
    const reader = response.body!.getReader();
    const frame = new TextDecoder().decode((await reader.read()).value);
    expect(frame).toContain("event: snapshot");
    expect(frame).toContain('"version":1');
    await reader.cancel();
  });

  it("rejects foreign scope and malformed bounded query before the first snapshot", async () => {
    const foreign = await GET(req("?storageId=foreign"));
    expect(foreign.status).toBe(404);
    expect(state.getPage).not.toHaveBeenCalled();
    const invalid = await GET(req("?activePage=0"));
    expect(invalid.status).toBe(400);
    expect(state.getPage).not.toHaveBeenCalled();
  });

  it("rechecks selected storage ownership before every later snapshot and closes on scope loss", async () => {
    vi.useFakeTimers();
    const response = await GET(req("?storageId=owned"));
    const reader = response.body!.getReader();
    await reader.read();
    state.storages.mockResolvedValue([]);
    state.wake?.();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(state.storages).toHaveBeenCalledTimes(2);
    expect(state.getPage).toHaveBeenCalledOnce();
    expect((await reader.read()).done).toBe(true);
  });

  it("returns unauthorized status before opening a stream", async () => {
    state.account.mockRejectedValue(Object.assign(new Error("not logged in"), { status: 401 }));
    const response = await GET(req());
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(state.getPage).not.toHaveBeenCalled();
  });

  it("returns a normal API error when the first PostgreSQL-backed read fails", async () => {
    state.getPage.mockRejectedValueOnce(new Error("raw database error"));
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
