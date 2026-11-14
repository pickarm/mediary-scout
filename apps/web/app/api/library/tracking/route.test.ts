import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ setLibrarySeasonTracking: vi.fn() }));
vi.mock("../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "account_test") };
});
vi.mock("../../../../lib/library-identification-runtime", () => runtime);

import { POST } from "./route.js";

describe("library tracking route", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("accepts only a season ID and auto-acquire flag", async () => {
    const request = new NextRequest("http://localhost/api/library/tracking", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ storageId: "storage-1", trackedSeasonId: "tmdb_tv_88001_s1", autoAcquire: true }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(runtime.setLibrarySeasonTracking).toHaveBeenCalledWith({ accountId: "account_test", connectedStorageId: "storage-1" }, "tmdb_tv_88001_s1", true);
  });
});
