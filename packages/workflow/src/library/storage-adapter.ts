import type { StorageExecutor } from "../ports.js";
import type { OrganizationStorage } from "./organizer.js";
import type { DirectoryPage, DirectoryReader, ScanFileFact } from "./scanner.js";

const ORGANIZATION_PAGE_SIZE = 500;
const MAX_PAGES = 100_000;

interface OrganizationItem {
  fileId: string;
  parentId: string;
  name: string;
  isDirectory: boolean;
}

export function createStorageDirectoryReader(executor: StorageExecutor): DirectoryReader {
  return {
    async listPage(input): Promise<DirectoryPage> {
      const page = await requirePagePort(executor)({
        directoryId: input.directoryId,
        page: input.page,
        pageSize: input.pageSize,
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
      });
      return {
        items: page.items.map((item) => factFromItem(item, input.directoryPath)),
        nextPage: page.nextPage,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };
}

export function createStorageOrganizationStorage(executor: StorageExecutor): OrganizationStorage {
  const pagePort = requirePagePort(executor);
  const knownParents = new Map<string, Set<string>>();

  const cache = (item: OrganizationItem): void => {
    const parents = knownParents.get(item.fileId) ?? new Set<string>();
    parents.add(item.parentId);
    knownParents.set(item.fileId, parents);
  };

  const list = async (parentId: string): Promise<readonly OrganizationItem[]> => {
    const items: OrganizationItem[] = [];
    const seen = new Set<string>();
    let pageNumber = 0;
    let cursor: string | undefined;
    for (let guard = 0; guard < MAX_PAGES; guard += 1) {
      const position = `${pageNumber}\0${cursor ?? ""}`;
      if (seen.has(position)) throw new Error("目录分页游标重复，已停止整理读取");
      seen.add(position);
      const page = await pagePort({
        directoryId: parentId,
        page: pageNumber,
        pageSize: ORGANIZATION_PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const item of page.items) {
        if (item.parentId !== parentId) throw new Error("目录页包含与父目录不匹配的provider文件");
        const mapped = {
          fileId: item.fileId,
          parentId: item.parentId,
          name: item.name,
          isDirectory: item.isDirectory,
        };
        items.push(mapped);
        cache(mapped);
      }
      if (page.nextPage === null) return items;
      pageNumber = page.nextPage;
      cursor = page.nextCursor;
    }
    throw new Error("整理目录分页超过安全上限");
  };

  return {
    list,
    async read(fileId, knownParentIds) {
      const matches: OrganizationItem[] = [];
      for (const parentId of [...new Set(knownParentIds)]) {
        matches.push(...(await list(parentId)).filter((item) => item.fileId === fileId));
      }
      if (matches.length > 1) throw new Error("按已知父目录回读到重复provider ID，无法确定文件位置");
      return matches[0] ?? null;
    },
    createDir: (parentId, name) => executor.createDirectory({ parentId, name }),
    async rename(fileId, name) {
      const parents = knownParents.get(fileId);
      if (!parents || parents.size !== 1) {
        throw new Error("改名文件缺少唯一已知父目录，拒绝盲写");
      }
      await executor.renameFile({
        directoryId: [...parents][0]!,
        fileId,
        newName: name,
      });
    },
    async move(fileId, parentId) {
      const result = await executor.moveFiles({
        fileIds: [fileId],
        targetDirectoryId: parentId,
      });
      if (!result.moved.includes(fileId)) throw new Error("移动返回结果未包含请求的provider ID");
      knownParents.set(fileId, new Set([parentId]));
    },
  };
}

function requirePagePort(
  executor: StorageExecutor,
): NonNullable<StorageExecutor["listDirectoryPage"]> {
  if (!executor.listDirectoryPage) {
    throw new Error("当前网盘执行器未实现原生目录分页");
  }
  return executor.listDirectoryPage.bind(executor);
}

function factFromItem(
  item: {
    fileId: string;
    parentId: string;
    name: string;
    isDirectory: boolean;
    sizeBytes: number | null;
  },
  directoryPath: string,
): ScanFileFact {
  const normalizedParent = directoryPath.replace(/\\/g, "/").replace(/\/+$/u, "");
  return {
    fileId: item.fileId,
    parentDirectoryId: item.parentId,
    name: item.name,
    isDirectory: item.isDirectory,
    sizeBytes: item.sizeBytes,
    path: normalizedParent ? `${normalizedParent}/${item.name}` : item.name,
    modifiedAt: null,
  };
}
