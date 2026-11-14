import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getServices: vi.fn() }));
vi.mock("../../../../lib/library-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-api")>();
  return { ...actual, libraryAccount: vi.fn(async () => "api-test-account") };
});
vi.mock("../../../../lib/library-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/library-runtime")>();
  return { ...actual, getLibraryServices: mocks.getServices };
});

import { POST } from "./route";
import { issueDirectorySelectionTicket } from "../../../../lib/library-runtime";

const scope = { accountId: "api-test-account", connectedStorageId: "storage-a" };
const templateSet = {
  movieDirectory: "{title} ({year})",
  movieFile: "{title} ({year}){ext}",
  tvDirectory: "{title} ({year})",
  seasonDirectory: "Season {season:02}",
  episodeFile: "{title} - {episodeCode}{ext}",
};

function post(body: unknown): NextRequest {
  return new NextRequest("https://library.example/api/library/configurations", {
    method: "POST",
    headers: { origin: "https://library.example", host: "library.example", "x-forwarded-proto": "https" },
    body: JSON.stringify(body),
  });
}

describe("configuration source directory authorization", () => {
  const saved: unknown[] = [];
  let previous: { sourceRoots: Array<{ directoryId: string; name: string }>; movieTargetDirectoryId: string | null; movieTargetDirectoryName?: string | null; tvTargetDirectoryId: string | null; tvTargetDirectoryName?: string | null } | null = null;
  const listing = vi.fn(async (parentId: string, page: number, pageSize?: number) => {
    expect(pageSize).toBe(200);
    if (parentId === "parent-deep" && page === 17) return { items: [{ fileId: "dir-deep", parentId, fileName: "Season 2", fileSize: 0, resType: 2 }], hasMore: false };
    if (parentId === "target-parent" && page === 3) return { items: [{ fileId: "target-dir", parentId, fileName: "电影归档", fileSize: 0, resType: 2 }], hasMore: false };
    return { items: [], hasMore: false };
  });

  beforeEach(() => {
    saved.length = 0;
    previous = null;
    listing.mockClear();
    mocks.getServices.mockResolvedValue({
      client: { listFilesPage: listing },
      scanStore: {
        getConfiguration: vi.fn(async () => previous),
        saveConfiguration: vi.fn(async (value: unknown) => { saved.push(value); }),
      },
    });
  });

  it("accepts deep paginated choices only after rereading the signed parent page", async () => {
    const ticket = issueDirectorySelectionTicket({
      ...scope, directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
    });
    const response = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep", selectionToken: ticket }],
      mediaKind: "mixed", templates: templateSet,
    }));
    expect(response.status).toBe(201);
    expect(listing).toHaveBeenCalledWith("parent-deep", 17, 200);
    expect(saved[0]).toMatchObject({ sourceRoots: [{ directoryId: "dir-deep", name: "Season 2" }], autoAcquire: false, autoOrganize: false });
  });

  it("rejects forged IDs, cross-account tickets, stale tickets, and non-directory entries", async () => {
    const valid = issueDirectorySelectionTicket({
      ...scope, directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
    });
    const otherAccount = issueDirectorySelectionTicket({
      ...scope, accountId: "other-account", directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
    });
    const expired = issueDirectorySelectionTicket({
      ...scope, directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
    }, Date.now() - 700_000);
    for (const [directoryId, selectionToken] of [
      ["forged-id", valid], ["dir-deep", otherAccount], ["dir-deep", expired],
    ]) {
      const response = await POST(post({ storageId: "storage-a", sourceRoots: [{ directoryId, selectionToken }], mediaKind: "mixed", templates: templateSet }));
      expect(response.status).toBe(400);
    }
    listing.mockImplementationOnce(async (parentId, page) => ({ items: [{ fileId: "dir-deep", parentId, fileName: "Season 2", fileSize: 5, resType: 1 }], hasMore: false }));
    const notDirectory = await POST(post({ storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep", selectionToken: valid }], mediaKind: "mixed", templates: templateSet }));
    expect(notDirectory.status).toBe(400);
  });

  it("derives target display names from the verified parent page and retains a saved name for the same ID", async () => {
    const ticket = issueDirectorySelectionTicket({
      ...scope, directoryId: "target-dir", parentId: "target-parent", name: "电影归档", page: 3,
    });
    const response = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep", selectionToken: issueDirectorySelectionTicket({
        ...scope, directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
      }) }],
      movieTargetDirectoryId: "target-dir", movieTargetSelectionToken: ticket,
      tvTargetDirectoryId: null, mediaKind: "mixed", templates: templateSet,
    }));
    expect(response.status).toBe(201);
    expect(saved.at(-1)).toMatchObject({ movieTargetDirectoryId: "target-dir", movieTargetDirectoryName: "电影归档" });

    previous = {
      sourceRoots: [{ directoryId: "dir-deep", name: "Season 2" }],
      movieTargetDirectoryId: "target-dir", movieTargetDirectoryName: "电影归档",
      tvTargetDirectoryId: null,
    };
    const retained = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep" }],
      movieTargetDirectoryId: "target-dir", tvTargetDirectoryId: null, mediaKind: "mixed", templates: templateSet,
    }));
    expect(retained.status).toBe(201);
    expect(saved.at(-1)).toMatchObject({ movieTargetDirectoryId: "target-dir", movieTargetDirectoryName: "电影归档" });

    previous = {
      sourceRoots: [{ directoryId: "dir-deep", name: "Season 2" }],
      movieTargetDirectoryId: "target-dir", tvTargetDirectoryId: null,
    };
    const legacyRetained = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep" }],
      movieTargetDirectoryId: "target-dir", tvTargetDirectoryId: null, mediaKind: "mixed", templates: templateSet,
    }));
    expect(legacyRetained.status).toBe(201);
    expect(saved.at(-1)).toMatchObject({ movieTargetDirectoryId: "target-dir", movieTargetDirectoryName: null });

    const reselected = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep" }],
      movieTargetDirectoryId: "target-dir", movieTargetSelectionToken: ticket,
      tvTargetDirectoryId: null, mediaKind: "mixed", templates: templateSet,
    }));
    expect(reselected.status).toBe(201);
    expect(saved.at(-1)).toMatchObject({ movieTargetDirectoryId: "target-dir", movieTargetDirectoryName: "电影归档" });
  });

  it("rejects client-supplied target display names", async () => {
    const ticket = issueDirectorySelectionTicket({
      ...scope, directoryId: "target-dir", parentId: "target-parent", name: "电影归档", page: 3,
    });
    const response = await POST(post({
      storageId: "storage-a", sourceRoots: [{ directoryId: "dir-deep", selectionToken: issueDirectorySelectionTicket({
        ...scope, directoryId: "dir-deep", parentId: "parent-deep", name: "Season 2", page: 17,
      }) }],
      movieTargetDirectoryId: "target-dir", movieTargetSelectionToken: ticket,
      movieTargetDirectoryName: "伪造名称", mediaKind: "mixed", templates: templateSet,
    }));
    expect(response.status).toBe(400);
  });
});
