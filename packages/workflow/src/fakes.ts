import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type PackageTreeFile,
  type ResourceCandidate,
  type ResourceSnapshot,
  type TransferAttempt,
  type TransferStatus,
  type VerifiedFile,
} from "./domain.js";
import { episodeCodeFromFileName } from "./episode-code.js";
import type {
  ResourceProvider,
  StorageDirectoryPage,
  StorageExecutor,
  UnparsedVideoFile,
} from "./ports.js";

export type FakePackageTreeFile = PackageTreeFile & { episodeCode?: string };

const FIXED_CREATED_AT = "2026-01-01T00:00:00.000Z";

export interface CandidateFixture {
  title: string;
  source?: string;
  providerPayload?: Record<string, unknown>;
}

export interface TransferOutcome {
  status: TransferStatus;
  providerMessage: string;
  files: VerifiedFile[];
}


export class FakeResourceProvider implements ResourceProvider {
  private readonly keywordResults: Record<string, CandidateFixture[]>;
  private readonly keywordErrors: Record<string, string>;
  private nextSnapshotNumber = 1;

  constructor(input: { keywordResults: Record<string, CandidateFixture[]>; keywordErrors?: Record<string, string> }) {
    this.keywordResults = input.keywordResults;
    this.keywordErrors = input.keywordErrors ?? {};
  }

  // `workflowRunId` is accepted for contract parity with real providers but does
  // NOT scope the id: the fake's per-instance counter is already unique within a
  // test, and stable `snapshot_N` ids keep fixtures readable. Cross-run id
  // scoping is a content-hashing-provider concern, covered by the PanSou tests.
  async search(input: { keyword: string; workflowRunId?: string }): Promise<ResourceSnapshot> {
    const error = this.keywordErrors[input.keyword];
    if (error !== undefined) {
      throw new Error(error);
    }

    const snapshotId = `snapshot_${this.nextSnapshotNumber}`;
    this.nextSnapshotNumber += 1;
    const fixtures = this.keywordResults[input.keyword] ?? [];
    const candidates: ResourceCandidate[] = fixtures.map((fixture, index) => ({
      id: `${snapshotId}_candidate_${index + 1}`,
      snapshotId,
      index,
      title: fixture.title,
      type: "115",
      source: fixture.source ?? "fake",
      providerPayload: { ...(fixture.providerPayload ?? {}) },
    }));

    return {
      id: snapshotId,
      provider: "fake",
      keyword: input.keyword,
      candidates,
      createdAt: FIXED_CREATED_AT,
    };
  }
}

export class FakeStorageExecutor implements StorageExecutor {
  private readonly directories: Map<string, VerifiedFile[]>;
  private readonly transferOutcomes: Record<string, TransferOutcome>;
  private readonly nestedDirectories: Set<string>;
  private nextDirectoryNumber = 1;
  private nextTransferNumber = 1;

  private readonly packageTrees: Map<string, FakePackageTreeFile[]>;

  private readonly unparsedFiles: Map<string, UnparsedVideoFile[]>;

  constructor(input: {
    directories?: Record<string, VerifiedFile[]>;
    transferOutcomes?: Record<string, TransferOutcome>;
    nestedDirectories?: Set<string>;
    packageTrees?: Record<string, FakePackageTreeFile[]>;
    unparsedFiles?: Record<string, UnparsedVideoFile[]>;
  } = {}) {
    this.unparsedFiles = new Map(
      Object.entries(input.unparsedFiles ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.packageTrees = new Map(
      Object.entries(input.packageTrees ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.directories = new Map(
      Object.entries(input.directories ?? {}).map(([directoryId, files]) => [
        directoryId,
        files.map((file) => ({ ...file })),
      ]),
    );
    this.transferOutcomes = cloneTransferOutcomes(input.transferOutcomes ?? {});
    this.nestedDirectories = new Set(input.nestedDirectories ?? []);
  }

  private readonly directoryIdsByName = new Map<string, string>();

  async listDirectoryPage(input: {
    directoryId: string;
    page: number;
    pageSize: number;
    cursor?: string;
  }): Promise<StorageDirectoryPage> {
    const childDirs = await this.listChildDirectories(input.directoryId);
    const verified = this.directories.get(input.directoryId) ?? [];
    const unparsed = this.unparsedFiles.get(input.directoryId) ?? [];
    const seen = new Set<string>();
    const combined: Array<{
      fileId: string;
      parentId: string;
      name: string;
      isDirectory: boolean;
      sizeBytes: number | null;
    }> = [];
    for (const dir of childDirs) {
      if (seen.has(dir.id)) continue;
      seen.add(dir.id);
      combined.push({
        fileId: dir.id,
        parentId: input.directoryId,
        name: dir.name,
        isDirectory: true,
        sizeBytes: null,
      });
    }
    for (const file of verified) {
      const id = file.providerFileId || file.id;
      if (seen.has(id)) continue;
      seen.add(id);
      combined.push({
        fileId: id,
        parentId: input.directoryId,
        name: file.name,
        isDirectory: false,
        sizeBytes: file.sizeBytes,
      });
    }
    for (const file of unparsed) {
      if (seen.has(file.providerFileId)) continue;
      seen.add(file.providerFileId);
      combined.push({
        fileId: file.providerFileId,
        parentId: input.directoryId,
        name: file.name,
        isDirectory: false,
        sizeBytes: file.sizeBytes,
      });
    }
    const pageSize = Math.max(1, Math.trunc(input.pageSize));
    const offset = Math.max(0, Math.trunc(input.page)) * pageSize;
    const slice = combined.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < combined.length;
    return {
      items: slice,
      nextPage: hasMore ? input.page + 1 : null,
    };
  }

  async createDirectory(input: { name: string; parentId: string }): Promise<string> {
    const nameKey = `${input.parentId}::${input.name}`;
    const existing = this.directoryIdsByName.get(nameKey);
    if (existing !== undefined) {
      return existing;
    }
    const directoryId = `${input.parentId}_${input.name}_${this.nextDirectoryNumber}`;
    this.nextDirectoryNumber += 1;
    this.directories.set(directoryId, []);
    this.directoryIdsByName.set(nameKey, directoryId);
    return directoryId;
  }

  /**
   * Test-support: place verified files into a directory (creating it if needed).
   * Use after createDirectory has resolved the canonical id a workflow will
   * verify-or-create, to model files a previous run already landed there.
   */
  seedDirectoryFiles(directoryId: string, files: VerifiedFile[]): void {
    const existing = this.directories.get(directoryId) ?? [];
    this.directories.set(directoryId, [...existing, ...files.map((file) => ({ ...file }))]);
  }

  async listVideoFiles(directoryId: string): Promise<VerifiedFile[]> {
    return this.filesFor(directoryId).map((file) => ({ ...file }));
  }

  async listUnparsedVideoFiles(directoryId: string): Promise<UnparsedVideoFile[]> {
    return (this.unparsedFiles.get(directoryId) ?? []).map((file) => ({ ...file }));
  }

  async renameFile(input: { directoryId: string; fileId: string; newName: string }): Promise<void> {
    const unparsed = this.unparsedFiles.get(input.directoryId) ?? [];
    const unparsedIndex = unparsed.findIndex((file) => file.providerFileId === input.fileId);
    if (unparsedIndex >= 0) {
      const [file] = unparsed.splice(unparsedIndex, 1);
      const episodeCode = episodeCodeFromFileName(input.newName);
      if (episodeCode === null) {
        unparsed.push({ ...file!, name: input.newName });
      } else {
        this.filesFor(input.directoryId).push({
          id: file!.providerFileId,
          storageDirectoryId: input.directoryId,
          name: input.newName,
          sizeBytes: file!.sizeBytes,
          episodeCode,
          providerFileId: file!.providerFileId,
        });
      }
      this.unparsedFiles.set(input.directoryId, unparsed);
      return;
    }
    const files = this.filesFor(input.directoryId);
    const verified = files.find((file) => file.id === input.fileId);
    if (verified === undefined) {
      throw new Error(`fake renameFile: file ${input.fileId} not found in ${input.directoryId}`);
    }
    verified.name = input.newName;
    const episodeCode = episodeCodeFromFileName(input.newName);
    if (episodeCode !== null) {
      verified.episodeCode = episodeCode;
    }
  }

  async transfer(input: {
    workflowRunId: string;
    directoryId: string;
    candidate: ResourceCandidate;
  }): Promise<TransferAttempt> {
    const outcome = this.transferOutcomes[input.candidate.id] ?? {
      status: "failed",
      providerMessage: "no fake transfer outcome configured",
      files: [],
    };
    const materializedFileIds = outcome.files.map((file) => file.id);

    if (outcome.status === "succeeded") {
      const files = this.filesFor(input.directoryId);
      files.push(...outcome.files.map((file) => ({ ...file, storageDirectoryId: input.directoryId })));
    }

    const attempt: TransferAttempt = {
      id: `transfer_${this.nextTransferNumber}`,
      workflowRunId: input.workflowRunId,
      candidateId: input.candidate.id,
      status: outcome.status,
      providerMessage: outcome.providerMessage,
      materializedFileIds,
    };
    this.nextTransferNumber += 1;
    return attempt;
  }

  async flattenDirectory(directoryId: string): Promise<{ moved: string[]; removed: string[] }> {
    if (!this.nestedDirectories.has(directoryId)) {
      return { moved: [], removed: [] };
    }

    return {
      moved: this.filesFor(directoryId).map((file) => file.id),
      removed: [`${directoryId}_nested`],
    };
  }

  async deleteFiles(input: { directoryId: string; fileIds: string[] }): Promise<{ deleted: string[] }> {
    const fileIds = new Set(input.fileIds);
    const files = this.filesFor(input.directoryId);
    const deleted = files.filter((file) => fileIds.has(file.id)).map((file) => file.id);
    this.directories.set(
      input.directoryId,
      files.filter((file) => !fileIds.has(file.id)),
    );
    return { deleted };
  }

  async removeDirectory(directoryId: string): Promise<{ removed: boolean }> {
    const existed =
      this.directories.has(directoryId) ||
      this.unparsedFiles.has(directoryId) ||
      this.packageTrees.has(directoryId);
    this.directories.delete(directoryId);
    this.unparsedFiles.delete(directoryId);
    this.packageTrees.delete(directoryId);
    for (const [nameKey, id] of this.directoryIdsByName) {
      if (id === directoryId) {
        this.directoryIdsByName.delete(nameKey);
      }
    }
    return { removed: existed };
  }

  async listTree(input: { directoryId: string; maxDepth?: number }): Promise<PackageTreeFile[]> {
    const configured = (this.packageTrees.get(input.directoryId) ?? []).map(
      ({ episodeCode: _episodeCode, ...file }) => ({ ...file }),
    );
    const transferred = (this.directories.get(input.directoryId) ?? []).map((file) => ({
      path: file.name,
      providerFileId: file.id,
      sizeBytes: file.sizeBytes,
    }));
    return [...configured, ...transferred];
  }

  async listSubdirectories(input: {
    directoryId: string;
    maxDepth?: number;
  }): Promise<Array<{ id: string; path: string }>> {
    // This fake stores a flat directory map, so subdirectories only exist as
    // path prefixes inside a configured package tree. Derive the distinct prefixes
    // (id = path, since the fake assigns no separate directory ids).
    const seen = new Set<string>();
    const out: Array<{ id: string; path: string }> = [];
    for (const file of this.packageTrees.get(input.directoryId) ?? []) {
      const segments = file.path.split("/").filter((segment) => segment.length > 0);
      segments.pop(); // drop the file name
      let prefix = "";
      for (const segment of segments) {
        prefix = prefix ? `${prefix}/${segment}` : segment;
        if (!seen.has(prefix)) {
          seen.add(prefix);
          out.push({ id: prefix, path: prefix });
        }
      }
    }
    return out;
  }

  async listChildDirectories(directoryId: string): Promise<Array<{ id: string; name: string }>> {
    // Immediate child dirs created under this parent (keyed "parentId::name").
    const out: Array<{ id: string; name: string }> = [];
    for (const [key, id] of this.directoryIdsByName) {
      const sep = key.indexOf("::");
      if (sep !== -1 && key.slice(0, sep) === directoryId) {
        out.push({ id, name: key.slice(sep + 2) });
      }
    }
    return out;
  }

  async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }): Promise<{ moved: string[] }> {
    const wanted = new Set(input.fileIds);
    const moved: string[] = [];
    for (const [directoryId, files] of this.directories) {
      if (directoryId === input.targetDirectoryId) {
        continue;
      }
      const moving = files.filter((file) => wanted.has(file.id));
      if (moving.length === 0) {
        continue;
      }
      this.directories.set(
        directoryId,
        files.filter((file) => !wanted.has(file.id)),
      );
      const target = this.filesFor(input.targetDirectoryId);
      for (const file of moving) {
        target.push({ ...file, storageDirectoryId: input.targetDirectoryId });
        moved.push(file.id);
      }
    }
    for (const [directoryId, files] of this.unparsedFiles) {
      if (directoryId === input.targetDirectoryId) {
        continue;
      }
      const moving = files.filter((file) => wanted.has(file.providerFileId));
      if (moving.length === 0) {
        continue;
      }
      this.unparsedFiles.set(
        directoryId,
        files.filter((file) => !wanted.has(file.providerFileId)),
      );
      const target = this.unparsedFiles.get(input.targetDirectoryId) ?? [];
      target.push(...moving);
      this.unparsedFiles.set(input.targetDirectoryId, target);
      moved.push(...moving.map((file) => file.providerFileId));
    }
    for (const [stagingId, treeFiles] of this.packageTrees) {
      const keep: FakePackageTreeFile[] = [];
      for (const treeFile of treeFiles) {
        if (!wanted.has(treeFile.providerFileId)) {
          keep.push(treeFile);
          continue;
        }
        moved.push(treeFile.providerFileId);
        const baseName = treeFile.path.split("/").at(-1) ?? treeFile.path;
        if (treeFile.episodeCode !== undefined) {
          this.filesFor(input.targetDirectoryId).push({
            id: treeFile.providerFileId,
            storageDirectoryId: input.targetDirectoryId,
            name: baseName,
            sizeBytes: treeFile.sizeBytes,
            episodeCode: treeFile.episodeCode,
            providerFileId: treeFile.providerFileId,
          });
        } else {
          // No episode identity in the name: the real executor cannot see
          // this file as an episode — it lands as an unparsed video.
          const unparsed = this.unparsedFiles.get(input.targetDirectoryId) ?? [];
          unparsed.push({
            providerFileId: treeFile.providerFileId,
            name: baseName,
            sizeBytes: treeFile.sizeBytes,
          });
          this.unparsedFiles.set(input.targetDirectoryId, unparsed);
        }
      }
      this.packageTrees.set(stagingId, keep);
    }
    return { moved };
  }

  private filesFor(directoryId: string): VerifiedFile[] {
    const existing = this.directories.get(directoryId);
    if (existing !== undefined) {
      return existing;
    }

    const files: VerifiedFile[] = [];
    this.directories.set(directoryId, files);
    return files;
  }
}

function cloneTransferOutcomes(transferOutcomes: Record<string, TransferOutcome>): Record<string, TransferOutcome> {
  return Object.fromEntries(
    Object.entries(transferOutcomes).map(([candidateId, outcome]) => [
      candidateId,
      {
        ...outcome,
        files: outcome.files.map((file) => ({ ...file })),
      },
    ]),
  );
}

export interface FileBackedFakeStorageItem {
  fileId: string;
  parentId: string;
  name: string;
  isDirectory: boolean;
  sizeBytes?: number | null;
}

export interface FileBackedFakeStorageState {
  items: FileBackedFakeStorageItem[];
  failWritesRemaining?: number;
  failErrorMessage?: string;
}

/** 仅用于本地全栈演练模式的可控文件状态假网盘，外部可随时改写状态文件模拟改名、删除与写限流。 */
export function createFileBackedFakeStorageExecutor(stateFilePath: string): StorageExecutor {
  const readState = (): FileBackedFakeStorageState => {
    if (!existsSync(stateFilePath)) return { items: [] };
    const raw = readFileSync(stateFilePath, "utf8").trim();
    if (!raw) return { items: [] };
    const parsed = JSON.parse(raw) as Partial<FileBackedFakeStorageState>;
    return {
      items: Array.isArray(parsed.items) ? parsed.items : [],
      ...(typeof parsed.failWritesRemaining === "number" ? { failWritesRemaining: parsed.failWritesRemaining } : {}),
      ...(typeof parsed.failErrorMessage === "string" ? { failErrorMessage: parsed.failErrorMessage } : {}),
    };
  };

  const writeState = (state: FileBackedFakeStorageState): void => {
    mkdirSync(dirname(stateFilePath), { recursive: true });
    const tempPath = `${stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tempPath, stateFilePath);
  };

  const consumeWriteFault = (state: FileBackedFakeStorageState): void => {
    if (typeof state.failWritesRemaining === "number" && state.failWritesRemaining > 0) {
      const next = {
        ...state,
        failWritesRemaining: state.failWritesRemaining - 1,
      };
      writeState(next);
      throw new Error(state.failErrorMessage?.trim() || "模拟网盘写入限流 429");
    }
  };

  return {
    async getSpace() {
      return { totalBytes: 1024 ** 4, usedBytes: 1024 ** 3 };
    },
    async listDirectoryPage({ directoryId, page, pageSize }) {
      const state = readState();
      const children = state.items
        .filter((item) => item.parentId === directoryId)
        .sort((a, b) => a.fileId.localeCompare(b.fileId));
      const safeSize = Math.max(1, Math.trunc(pageSize));
      const offset = Math.max(0, Math.trunc(page)) * safeSize;
      const items = children.slice(offset, offset + safeSize).map((item) => ({
        fileId: item.fileId,
        parentId: item.parentId,
        name: item.name,
        isDirectory: item.isDirectory,
        sizeBytes: item.isDirectory ? null : (item.sizeBytes ?? 1024),
      }));
      return {
        items,
        nextPage: offset + safeSize < children.length ? page + 1 : null,
      };
    },
    async createDirectory({ name, parentId }) {
      const state = readState();
      consumeWriteFault(state);
      const existing = state.items.find(
        (item) => item.parentId === parentId && item.isDirectory && item.name.toLocaleLowerCase("en-US") === name.toLocaleLowerCase("en-US"),
      );
      if (existing) return existing.fileId;
      const fileId = `fake_dir_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      state.items.push({ fileId, parentId, name, isDirectory: true, sizeBytes: null });
      writeState(state);
      return fileId;
    },
    async listVideoFiles(directoryId) {
      const state = readState();
      return state.items
        .filter((item) => item.parentId === directoryId && !item.isDirectory)
        .flatMap((item) => {
          const ep = episodeCodeFromFileName(item.name);
          if (!ep) return [];
          return [{
            id: item.fileId,
            providerFileId: item.fileId,
            storageDirectoryId: directoryId,
            name: item.name,
            sizeBytes: item.sizeBytes ?? 1024,
            episodeCode: ep,
          }];
        });
    },
    async listUnparsedVideoFiles(directoryId) {
      const state = readState();
      return state.items
        .filter((item) => item.parentId === directoryId && !item.isDirectory && episodeCodeFromFileName(item.name) === null)
        .map((item) => ({
          providerFileId: item.fileId,
          name: item.name,
          sizeBytes: item.sizeBytes ?? 1024,
        }));
    },
    async renameFile({ directoryId, fileId, newName }) {
      const state = readState();
      consumeWriteFault(state);
      const target = state.items.find((item) => item.fileId === fileId && item.parentId === directoryId);
      if (!target) {
        throw new Error(`假盘改名失败：目录 ${directoryId} 中找不到文件 ${fileId}`);
      }
      target.name = newName;
      writeState(state);
    },
    async transfer() {
      return {
        id: `fake_tx_${Date.now()}`,
        workflowRunId: "fake",
        candidateId: "fake",
        status: "failed",
        providerMessage: "文件状态假盘仅用于库整理演练",
        materializedFileIds: [],
      };
    },
    async flattenDirectory() {
      return { moved: [], removed: [] };
    },
    async deleteFiles({ directoryId, fileIds }) {
      const state = readState();
      consumeWriteFault(state);
      const removeSet = new Set(fileIds);
      const deleted: string[] = [];
      state.items = state.items.filter((item) => {
        if (item.parentId === directoryId && removeSet.has(item.fileId)) {
          deleted.push(item.fileId);
          return false;
        }
        return true;
      });
      writeState(state);
      return { deleted };
    },
    async removeDirectory(directoryId) {
      const state = readState();
      consumeWriteFault(state);
      const before = state.items.length;
      state.items = state.items.filter((item) => item.fileId !== directoryId && item.parentId !== directoryId);
      writeState(state);
      return { removed: state.items.length < before };
    },
    async listTree({ directoryId }) {
      const state = readState();
      return state.items
        .filter((item) => item.parentId === directoryId && !item.isDirectory)
        .map((item) => ({
          path: item.name,
          providerFileId: item.fileId,
          sizeBytes: item.sizeBytes ?? 1024,
        }));
    },
    async listSubdirectories({ directoryId }) {
      const state = readState();
      return state.items
        .filter((item) => item.parentId === directoryId && item.isDirectory)
        .map((item) => ({ id: item.fileId, path: item.name }));
    },
    async listChildDirectories(directoryId) {
      const state = readState();
      return state.items
        .filter((item) => item.parentId === directoryId && item.isDirectory)
        .map((item) => ({ id: item.fileId, name: item.name }));
    },
    async moveFiles({ fileIds, targetDirectoryId }) {
      const state = readState();
      consumeWriteFault(state);
      const wanted = new Set(fileIds);
      const moved: string[] = [];
      for (const item of state.items) {
        if (wanted.has(item.fileId)) {
          item.parentId = targetDirectoryId;
          moved.push(item.fileId);
        }
      }
      writeState(state);
      return { moved };
    },
  };
}
