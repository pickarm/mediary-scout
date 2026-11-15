import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({ confirmFile: vi.fn() }));
const runtime = vi.hoisted(() => ({ getLibraryIdentificationService: vi.fn() }));

vi.mock("../../../../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "account_test") };
});
vi.mock("../../../../../../../lib/library-identification-runtime", () => runtime);

import { POST } from "./route.js";

describe("manual file identification route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.getLibraryIdentificationService.mockResolvedValue(service);
    service.confirmFile.mockResolvedValue({ item: { fileId: "file-1", status: "confirmed", manual: true } });
  });

  it("accepts only TMDB identity and episode numbers, then delegates server-side verification", async () => {
    const request = new NextRequest("http://localhost/api/library/scans/task-1/identifications/file-1", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ storageId: "storage-1", tmdbId: 88001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [1, 2] }),
    });
    const response = await POST(request, { params: Promise.resolve({ taskId: "task-1", fileId: "file-1" }) });
    expect(response.status).toBe(200);
    expect(service.confirmFile).toHaveBeenCalledWith({ scope: { accountId: "account_test", connectedStorageId: "storage-1" }, taskId: "task-1", fileId: "file-1", tmdbId: 88001, mediaType: "tv", seasonNumber: 1, episodeNumbers: [1, 2] });

    const invalid = new NextRequest("http://localhost/api/library/scans/task-1/identifications/file-1", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ storageId: "storage-1", tmdbId: 88001, mediaType: "tv", title: "spoofed title" }),
    });
    expect((await POST(invalid, { params: Promise.resolve({ taskId: "task-1", fileId: "file-1" }) })).status).toBe(400);
  });
});
