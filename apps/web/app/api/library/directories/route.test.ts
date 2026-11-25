import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getServices: vi.fn() }));

vi.mock("../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "directory-account") };
});

vi.mock("../../../../lib/library-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-runtime")>();
  return { ...actual, getLibraryServices: mocks.getServices };
});

import { GET } from "./route";

describe("library directory browsing", () => {
  const listPage = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listPage.mockResolvedValue({
      items: [
        { fileId: "season-2", parentDirectoryId: "root", name: "第二季", isDirectory: true, sizeBytes: null, path: "第二季", modifiedAt: null },
        { fileId: "episode-1", parentDirectoryId: "root", name: "S02E01.mkv", isDirectory: false, sizeBytes: 10, path: "S02E01.mkv", modifiedAt: null },
      ],
      nextPage: 4,
      nextCursor: "native-cursor",
    });
    mocks.getServices.mockResolvedValue({
      reader: { listPage },
      storage: { provider: "pan123", status: "active" },
    });
  });

  it("uses the generic paginated reader and preserves the native continuation cursor", async () => {
    const response = await GET(new NextRequest(
      "https://library.example/api/library/directories?storageId=storage-123&parentId=root&page=3&cursor=previous-cursor",
    ));

    expect(response.status).toBe(200);
    expect(listPage).toHaveBeenCalledWith(expect.objectContaining({
      directoryId: "root",
      page: 3,
      cursor: "previous-cursor",
      pageSize: 200,
    }));
    expect(await response.json()).toMatchObject({
      items: [{ directoryId: "season-2", name: "第二季" }],
      nextPage: 4,
      nextCursor: "native-cursor",
    });
  });

  it("uses the provider provision root when no parent is supplied", async () => {
    mocks.getServices.mockResolvedValueOnce({
      reader: { listPage },
      storage: { provider: "tianyi", status: "active" },
    });
    const response = await GET(new NextRequest(
      "https://library.example/api/library/directories?storageId=storage-tianyi",
    ));

    expect(response.status).toBe(200);
    expect(listPage).toHaveBeenCalledWith(expect.objectContaining({
      directoryId: "-11",
      page: 0,
      pageSize: 200,
    }));
  });
});
