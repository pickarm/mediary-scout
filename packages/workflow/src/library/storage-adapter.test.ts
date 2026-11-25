import { describe, expect, it, vi } from "vitest";
import type { StorageExecutor } from "../ports.js";
import { createStorageDirectoryReader, createStorageOrganizationStorage } from "./storage-adapter.js";

describe("storage directory adapter", () => {
  it("maps immediate provider pages into scanner facts and forwards the cursor", async () => {
    const listDirectoryPage = vi.fn<NonNullable<StorageExecutor["listDirectoryPage"]>>(
      async ({ directoryId, page, pageSize, cursor }) => {
        if (page === 0) {
          return {
            items: [
              { fileId: "dir-a", parentId: directoryId, name: "Movies", isDirectory: true, sizeBytes: null },
              { fileId: "file-a", parentId: directoryId, name: "Readme.txt", isDirectory: false, sizeBytes: 12 },
            ],
            nextPage: 1,
            ...(cursor === undefined ? { nextCursor: "cursor-1" } : {}),
          };
        }
        expect(cursor).toBe("cursor-1");
        expect(pageSize).toBe(50);
        return {
          items: [
            { fileId: "file-b", parentId: directoryId, name: "Movie.mkv", isDirectory: false, sizeBytes: 99 },
          ],
          nextPage: null,
        };
      },
    );
    const reader = createStorageDirectoryReader({
      listDirectoryPage,
    } as unknown as StorageExecutor);

    await expect(reader.listPage({
      directoryId: "root",
      directoryPath: "Media",
      page: 0,
      pageSize: 50,
    })).resolves.toEqual({
      items: [
        {
          fileId: "dir-a",
          parentDirectoryId: "root",
          name: "Movies",
          isDirectory: true,
          sizeBytes: null,
          path: "Media/Movies",
          modifiedAt: null,
        },
        {
          fileId: "file-a",
          parentDirectoryId: "root",
          name: "Readme.txt",
          isDirectory: false,
          sizeBytes: 12,
          path: "Media/Readme.txt",
          modifiedAt: null,
        },
      ],
      nextPage: 1,
      nextCursor: "cursor-1",
    });

    await expect(reader.listPage({
      directoryId: "root",
      directoryPath: "Media",
      page: 1,
      pageSize: 50,
      cursor: "cursor-1",
    })).resolves.toMatchObject({
      items: [{ fileId: "file-b", path: "Media/Movie.mkv" }],
      nextPage: null,
    });
    expect(listDirectoryPage).toHaveBeenNthCalledWith(1, {
      directoryId: "root",
      page: 0,
      pageSize: 50,
    });
  });

  it("lists every page and reuses provider-ID ports for create, read, rename, and move", async () => {
    const calls: string[] = [];
    const listDirectoryPage = vi.fn<NonNullable<StorageExecutor["listDirectoryPage"]>>(
      async ({ directoryId, page, cursor }) => {
        calls.push(`list:${directoryId}:${page}:${cursor ?? ""}`);
        if (directoryId === "root" && page === 0) {
          return {
            items: [
              { fileId: "folder", parentId: "root", name: "Folder", isDirectory: true, sizeBytes: null },
            ],
            nextPage: 1,
            nextCursor: "next-root",
          };
        }
        if (directoryId === "root") {
          return {
            items: [
              { fileId: "file-a", parentId: "root", name: "Old.mkv", isDirectory: false, sizeBytes: 10 },
            ],
            nextPage: null,
          };
        }
        return { items: [], nextPage: null };
      },
    );
    const createDirectory = vi.fn(async () => "created");
    const renameFile = vi.fn(async () => undefined);
    const moveFiles = vi.fn(async ({ fileIds }) => ({ moved: fileIds }));
    const listTree = vi.fn(async () => {
      throw new Error("listTree must not build directory relationships");
    });
    const executor = {
      listDirectoryPage,
      createDirectory,
      renameFile,
      moveFiles,
      listTree,
    } as unknown as StorageExecutor;
    const storage = createStorageOrganizationStorage(executor);

    await expect(storage.list("root")).resolves.toEqual([
      { fileId: "folder", parentId: "root", name: "Folder", isDirectory: true },
      { fileId: "file-a", parentId: "root", name: "Old.mkv", isDirectory: false },
    ]);
    expect(listDirectoryPage).toHaveBeenNthCalledWith(2, {
      directoryId: "root",
      page: 1,
      pageSize: 500,
      cursor: "next-root",
    });
    await expect(storage.read("file-a", ["root", "folder"])).resolves.toEqual({
      fileId: "file-a",
      parentId: "root",
      name: "Old.mkv",
      isDirectory: false,
    });
    await storage.rename("file-a", "New.mkv");
    await storage.move("file-a", "folder");
    await storage.rename("file-a", "Moved.mkv");
    await expect(storage.createDir("root", "Folder")).resolves.toBe("created");

    expect(renameFile).toHaveBeenNthCalledWith(1, {
      directoryId: "root",
      fileId: "file-a",
      newName: "New.mkv",
    });
    expect(renameFile).toHaveBeenNthCalledWith(2, {
      directoryId: "folder",
      fileId: "file-a",
      newName: "Moved.mkv",
    });
    expect(moveFiles).toHaveBeenCalledWith({
      fileIds: ["file-a"],
      targetDirectoryId: "folder",
    });
    expect(createDirectory).toHaveBeenCalledWith({ name: "Folder", parentId: "root" });
    expect(listTree).not.toHaveBeenCalled();
    expect(calls).toContain("list:root:0:");
    expect(calls).toContain("list:root:1:next-root");
    expect(calls).toContain("list:root:0:");
    expect(calls).toContain("list:folder:0:");
  });
});
