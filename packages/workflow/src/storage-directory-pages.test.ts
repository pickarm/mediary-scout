import { describe, expect, it, vi } from "vitest";
import type { Pan115StorageApi } from "./storage-115-executor.js";
import { Storage115Executor } from "./storage-115-executor.js";
import type { StorageDirectoryPage, StorageExecutor } from "./ports.js";
import type { QuarkCookieClient, QuarkItem } from "./quark-cookie-client.js";
import { QuarkStorageExecutor } from "./quark-storage-executor.js";
import type { Pan123Client, Pan123Item } from "./pan123-client.js";
import { Pan123StorageExecutor } from "./pan123-storage-executor.js";
import type { TianyiClient, TianyiItem } from "./tianyi-client.js";
import { TianyiStorageExecutor } from "./tianyi-storage-executor.js";
import type { GuangYaStorageClient, GuangYaStorageItem } from "./guangya-storage-executor.js";
import { GuangYaStorageExecutor } from "./guangya-storage-executor.js";
import { createExecutorForBrand } from "./storage-executor-factory.js";

type PageCapableExecutor = Pick<StorageExecutor, "listDirectoryPage">;

async function readPage(
  executor: PageCapableExecutor,
  input: { directoryId: string; page: number; pageSize: number; cursor?: string },
): Promise<StorageDirectoryPage> {
  if (typeof executor.listDirectoryPage !== "function") {
    throw new Error("listDirectoryPage is not implemented");
  }
  return executor.listDirectoryPage(input);
}

describe("StorageExecutor native directory pages", () => {
  it("routes both original quark and uc provider names through the same paged executor", () => {
    for (const provider of ["quark", "uc"] as const) {
      const executor = createExecutorForBrand({
        provider,
        cookie: "__uid=user; __kps=key",
        scopeCids: ["root"],
      });
      expect(executor).toBeInstanceOf(QuarkStorageExecutor);
      expect(executor.listDirectoryPage).toBeTypeOf("function");
    }
  });

  it("maps 115 offset pages without flattening through listItems", async () => {
    const listItemsPage = vi.fn<NonNullable<Pan115StorageApi["listItemsPage"]>>(async () => ({
      items: [
        { fid: "f-1", n: "Movie.mkv", s: "42" },
        { cid: "d-1", n: "Folder", fc: "0" },
      ],
      total: 5,
    }));
    const executor = new Storage115Executor({
      api: { listItemsPage } as unknown as Pan115StorageApi,
    });

    await expect(readPage(executor, { directoryId: "root", page: 1, pageSize: 2 })).resolves.toEqual({
      items: [
        { fileId: "f-1", parentId: "root", name: "Movie.mkv", isDirectory: false, sizeBytes: 42 },
        { fileId: "d-1", parentId: "root", name: "Folder", isDirectory: true, sizeBytes: 0 },
      ],
      nextPage: 2,
      nextCursor: "4",
    });
    expect(listItemsPage).toHaveBeenCalledWith({ directoryId: "root", offset: 2, limit: 2 });
  });

  it("continues a short non-terminal 115 page from its persisted actual offset", async () => {
    const listItemsPage = vi.fn<NonNullable<Pan115StorageApi["listItemsPage"]>>(async ({ offset }) => ({
      items: [{
        fid: `f-${offset}`,
        n: `Episode-${offset}.mkv`,
        s: String(offset),
      }],
      total: 3,
    }));
    const executor = new Storage115Executor({
      api: { listItemsPage } as unknown as Pan115StorageApi,
    });

    const first = await readPage(executor, { directoryId: "root", page: 0, pageSize: 2 });
    expect(first).toMatchObject({ nextPage: 1, nextCursor: "1" });
    if (first.nextPage === null || first.nextCursor === undefined) {
      throw new Error("expected a resumable 115 page");
    }

    await expect(readPage(executor, {
      directoryId: "root",
      page: first.nextPage,
      pageSize: 2,
      cursor: first.nextCursor,
    })).resolves.toMatchObject({
      items: [{ fileId: "f-1", parentId: "root", name: "Episode-1.mkv", isDirectory: false, sizeBytes: 1 }],
      nextPage: 2,
      nextCursor: "2",
    });
    expect(listItemsPage.mock.calls.map(([input]) => input.offset)).toEqual([0, 1]);
  });

  it("maps Quark one-based pages and uses the native total across pages", async () => {
    const listItemsPage = vi.fn(async (_input: { directoryId: string; page?: number; size?: number }) => ({
      items: [{ fid: "q-1", file_name: "Episode.mkv", dir: false, size: 7 }] satisfies QuarkItem[],
      total: 3,
    }));
    const executor = new QuarkStorageExecutor({
      client: { listItemsPage } as unknown as QuarkCookieClient,
    });

    await expect(readPage(executor, { directoryId: "root", page: 1, pageSize: 1 })).resolves.toEqual({
      items: [{ fileId: "q-1", parentId: "root", name: "Episode.mkv", isDirectory: false, sizeBytes: 7 }],
      nextPage: 2,
    });
    expect(listItemsPage).toHaveBeenCalledWith({ directoryId: "root", page: 2, size: 1 });
  });

  it("keeps the 123 Next cursor for restart-safe continuation", async () => {
    const listFilesPage = vi.fn(async (_input: { parentFileId: string; cursor: string; limit: number }) => ({
      items: [{ id: "123-1", name: "Movie.mkv", size: 9, etag: "E", isFolder: false }] satisfies Pan123Item[],
      nextCursor: "next-55",
    }));
    const executor = new Pan123StorageExecutor({
      client: { listFilesPage } as unknown as Pan123Client,
      writeScopeDirectoryIds: ["root"],
    });

    await expect(readPage(executor, {
      directoryId: "root",
      page: 4,
      pageSize: 1,
      cursor: "cursor-17",
    })).resolves.toEqual({
      items: [{ fileId: "123-1", parentId: "root", name: "Movie.mkv", isDirectory: false, sizeBytes: 9 }],
      nextPage: 5,
      nextCursor: "next-55",
    });
    expect(listFilesPage).toHaveBeenCalledWith({
      parentFileId: "root",
      cursor: "cursor-17",
      limit: 1,
    });
  });

  it("maps Tianyi page numbers without the old first-1000-only listing", async () => {
    const listFilesPage = vi.fn(async (_input: { folderId: string; pageNum: number; pageSize: number }) => ({
      items: [{ id: "ty-1", name: "Show.mkv", size: 11, md5: "", isFolder: false }] satisfies TianyiItem[],
      hasMore: true,
    }));
    const executor = new TianyiStorageExecutor({
      client: { listFilesPage } as unknown as TianyiClient,
    });

    await expect(readPage(executor, { directoryId: "root", page: 2, pageSize: 200 })).resolves.toEqual({
      items: [{ fileId: "ty-1", parentId: "root", name: "Show.mkv", isDirectory: false, sizeBytes: 11 }],
      nextPage: 3,
    });
    expect(listFilesPage).toHaveBeenCalledWith({ folderId: "root", pageNum: 3, pageSize: 200 });
  });

  it("maps GuangYa pages through the existing single-page client call", async () => {
    const listFilesPage = vi.fn(async (_parentId: string, _page: number, _pageSize: number) => ({
      items: [{ fileId: "gy-1", parentId: "root", fileName: "Folder", fileSize: 0, resType: 2 }] satisfies GuangYaStorageItem[],
      hasMore: false,
    }));
    const executor = new GuangYaStorageExecutor({
      client: { listFilesPage } as unknown as GuangYaStorageClient,
    });

    await expect(readPage(executor, { directoryId: "root", page: 2, pageSize: 50 })).resolves.toEqual({
      items: [{ fileId: "gy-1", parentId: "root", name: "Folder", isDirectory: true, sizeBytes: 0 }],
      nextPage: null,
    });
    expect(listFilesPage).toHaveBeenCalledWith("root", 2, 50);
  });
});
