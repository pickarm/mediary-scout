import type { MediaTitle } from "../domain.js";
import type { StorageExecutor } from "../ports.js";
import { legacyMediaLibraryFolderName, mediaLibraryFolderName } from "../media-library-folder.js";
import type { LibraryDirectoryBinding, LibraryPhysicalFileBinding, LibraryStore } from "./types.js";

/**
 * F14a — bind an already-imported provider directory ID to the original
 * acquisition path. The binding is attached to the run's StorageExecutor by the
 * web runtime (which owns the PG pool), so the worker -> runner signature does not
 * change and every acquisition still uses the original executor/sandbox.
 */
export const ACQUISITION_LIBRARY_STORE: unique symbol = Symbol.for("media-track.acquisition-library-store");

export type AcquisitionBindingErrorCode =
  | "ACQUISITION_BINDING_OUTSIDE_SANDBOX"
  | "ACQUISITION_BINDING_NOT_EXCLUSIVE"
  | "ACQUISITION_BINDING_AMBIGUOUS"
  | "ACQUISITION_BINDING_UNVERIFIED";

export class AcquisitionBindingSafetyError extends Error {
  readonly code: AcquisitionBindingErrorCode;

  constructor(code: AcquisitionBindingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AcquisitionBindingSafetyError";
    this.code = code;
  }
}

export interface AcquisitionDirectoryBindingPlan {
  accountId: string;
  connectedStorageId: string;
  mediaTitleId: string;
  mediaType: MediaTitle["type"];
  tmdbId: number;
  kind: "movie" | "tv";
  /** TV/anime: the existing show directory, which is also the staging parent. */
  showDirectoryId: string | null;
  /** Actual provider parent of the show/movie title root (not a trusted identity). */
  titleRootParentDirectoryId: string | null;
  /** TV/anime: requested season number -> already-imported target directory. */
  seasonDirectoryIds: Record<number, string>;
  /** Movie: the already-imported movie directory (staging === target). */
  movieDirectoryId: string | null;
  /** Every episode code represented by the imported target files. */
  importedEpisodeCodes: string[];
  /** Episode codes with more than one distinct imported file (multi-version). */
  multiVersionEpisodeCodes: string[];
  /** Names used only by the existing name-based lookup path; never identities. */
  showCanonicalName: string;
  showLegacyName: string;
}

export interface ResolveAcquisitionBindingPlanInput {
  storage: StorageExecutor;
  library: Pick<LibraryStore, "findDirectoryBinding" | "listPhysicalFileBindings">;
  accountId: string;
  connectedStorageId: string;
  title: Pick<MediaTitle, "id" | "type" | "title" | "year" | "tmdbId">;
  categoryParentId: string;
  /** Requested season numbers; movie callers pass [1]. */
  seasons: readonly number[];
}

export interface ProtectExistingEpisodes {
  episodes: string[] | "unknown";
}

type StorageWithLibraryStore = StorageExecutor & {
  readonly [ACQUISITION_LIBRARY_STORE]?: LibraryStore;
};

/** Attach the read-only F02 store without changing the executor's own methods. */
export function attachAcquisitionLibraryStore<T extends StorageExecutor>(storage: T, library: LibraryStore): T {
  Object.defineProperty(storage, ACQUISITION_LIBRARY_STORE, {
    value: library,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return storage;
}

export function acquisitionLibraryStoreOf(storage: object): LibraryStore | null {
  const value = (storage as StorageWithLibraryStore)[ACQUISITION_LIBRARY_STORE];
  return value ?? null;
}

/** The protectExisting value for the already-imported files in this plan. */
export function protectExistingFromPlan(plan: AcquisitionDirectoryBindingPlan | null): ProtectExistingEpisodes | null {
  if (!plan || plan.importedEpisodeCodes.length === 0) return null;
  // A multi-version episode is named so the prompt never proposes keep-larger
  // dedup for it. When no imported episode has multiple versions, the generic
  // "all existing files are protected" form is used.
  return plan.multiVersionEpisodeCodes.length > 0
    ? { episodes: [...plan.multiVersionEpisodeCodes] }
    : { episodes: "unknown" };
}

const PAGE_SIZE = 500;
const MAX_FILES = 5_000;
const VIDEO_EXTENSIONS = new Set([
  ".mkv",
  ".mp4",
  ".m4v",
  ".avi",
  ".mov",
  ".wmv",
  ".flv",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".webm",
  ".3gp",
]);

function hasVideoExtension(path: string): boolean {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

function seasonDirectoryName(seasonNumber: number): string {
  return `Season ${String(seasonNumber).padStart(2, "0")}`;
}

function nonEmpty(value: string, name: string): string {
  if (!value.trim()) throw new Error(`ACQUISITION_BINDING_INPUT: ${name} is required`);
  return value;
}

function bindingMatchesTitle(
  binding: LibraryDirectoryBinding,
  title: Pick<MediaTitle, "id" | "type" | "tmdbId">,
): boolean {
  return binding.mediaTitleId === title.id && binding.mediaType === title.type && binding.tmdbId === title.tmdbId;
}

/**
 * Bounded proof that a directory really sits inside the acquisition root.
 *
 * The acquisition executor's own write-scope guard differs by brand:
 * - quark walks parent links up to 8 levels;
 * - 115 reads a full path and checks for a scope ancestor;
 * - guangya / 123 / tianyi derive scope top-down from a scope root.
 * All of them can write into a nested directory within 8 levels when the chain
 * is real, so the identity proof here uses the same bound. A persisted
 * `parentDirectoryId` is only a hint: every edge below is observed in an actual
 * provider listing before it counts.
 */
const MAX_BINDING_DIRECTORY_DEPTH = 8;
const MAX_BINDING_DIRECTORIES_WALKED = 1_024;

async function listVerifiedChildren(
  storage: Pick<StorageExecutor, "listChildDirectories">,
  directoryId: string,
): Promise<Array<{ id: string; name: string }>> {
  try {
    return await storage.listChildDirectories(directoryId);
  } catch {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_UNVERIFIED",
      `无法读取目录 ${directoryId} 以核实其与获取根的实际父子关系`,
    );
  }
}

/**
 * Follow persisted parent hints from each target up to the acquisition root,
 * verifying every edge with a real listing. Returns null when the hints are
 * incomplete or stale; the caller then walks the real tree instead.
 */
async function proveByPersistedAncestors(input: {
  storage: Pick<StorageExecutor, "listChildDirectories">;
  library: ResolveAcquisitionBindingPlanInput["library"];
  accountId: string;
  connectedStorageId: string;
  categoryParentId: string;
  targetBindings: ReadonlyMap<string, LibraryDirectoryBinding>;
}): Promise<Map<string, string> | null> {
  const buildChain = async (
    targetId: string,
    targetBinding: LibraryDirectoryBinding,
  ): Promise<string[] | null> => {
    const chain = [targetId];
    const seen = new Set<string>([targetId]);
    let parentId = targetBinding.parentDirectoryId;
    for (let depth = 0; parentId !== null && depth < MAX_BINDING_DIRECTORY_DEPTH; depth += 1) {
      if (seen.has(parentId)) {
        throw new AcquisitionBindingSafetyError(
          "ACQUISITION_BINDING_AMBIGUOUS",
          `已导入目录 ${targetId} 的持久父目录关系成环，不能安全复用`,
        );
      }
      seen.add(parentId);
      chain.push(parentId);
      if (parentId === input.categoryParentId) return chain;
      const ancestor = await input.library.findDirectoryBinding({
        accountId: input.accountId,
        connectedStorageId: input.connectedStorageId,
        directoryId: parentId,
      });
      parentId = ancestor?.parentDirectoryId ?? null;
    }
    return null;
  };

  const chains: string[][] = [];
  for (const [targetId, targetBinding] of input.targetBindings) {
    const chain = await buildChain(targetId, targetBinding);
    if (chain === null) return null;
    chains.push(chain);
  }

  const childrenByParent = new Map<string, Promise<Array<{ id: string; name: string }>>>();
  const childrenOf = (directoryId: string) => {
    const cached = childrenByParent.get(directoryId);
    if (cached) return cached;
    const promise = listVerifiedChildren(input.storage, directoryId);
    childrenByParent.set(directoryId, promise);
    return promise;
  };

  const parentById = new Map<string, string>();
  for (const chain of chains) {
    // Verify top-down (root -> ... -> target). This order matters on drives
    // whose write scope is derived by listing an in-scope parent: every next
    // directory becomes writable only after its real parent has been listed.
    for (let index = chain.length - 1; index > 0; index -= 1) {
      const parentId = chain[index]!;
      const childId = chain[index - 1]!;
      const children = await childrenOf(parentId);
      if (!children.some((child) => child.id === childId)) {
        return null;
      }
      parentById.set(childId, parentId);
    }
  }
  return parentById;
}

/**
 * Fallback when the persisted hints cannot prove the chain: walk the real
 * provider tree from the acquisition root. Depth and breadth are both bounded;
 * a target that cannot be reached within the bounds fails closed.
 */
async function proveByBoundedWalk(input: {
  storage: Pick<StorageExecutor, "listChildDirectories">;
  categoryParentId: string;
  targetIds: ReadonlySet<string>;
  candidateParentIds: ReadonlySet<string>;
}): Promise<Map<string, string>> {
  const parentById = new Map<string, string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: input.categoryParentId, depth: 0 }];
  const queued = new Set<string>([input.categoryParentId]);
  let expanded = 0;
  let breadthLimited = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_BINDING_DIRECTORY_DEPTH) continue;
    if (expanded >= MAX_BINDING_DIRECTORIES_WALKED) {
      breadthLimited = true;
      break;
    }
    expanded += 1;
    const children = await listVerifiedChildren(input.storage, current.id);
    // Persisted parents are hints only, but visiting them first avoids listing
    // every sibling's subtree on a large category root. The actual edge is still
    // verified below by the provider listing.
    const orderedChildren = [...children].sort((left, right) => {
      const leftCandidate = input.candidateParentIds.has(left.id) ? 1 : 0;
      const rightCandidate = input.candidateParentIds.has(right.id) ? 1 : 0;
      return rightCandidate - leftCandidate;
    });
    for (const child of orderedChildren) {
      if (child.id === current.id) {
        throw new AcquisitionBindingSafetyError(
          "ACQUISITION_BINDING_AMBIGUOUS",
          `目录 ${child.id} 在自己的子目录列表中出现，无法安全核实`,
        );
      }
      const knownParent = parentById.get(child.id);
      if (knownParent !== undefined && knownParent !== current.id) {
        throw new AcquisitionBindingSafetyError(
          "ACQUISITION_BINDING_AMBIGUOUS",
          `目录 ${child.id} 同时出现在多个父目录下，无法安全核实`,
        );
      }
      parentById.set(child.id, current.id);
      if (!queued.has(child.id)) {
        queued.add(child.id);
        queue.push({ id: child.id, depth: current.depth + 1 });
      }
    }
    if ([...input.targetIds].every((targetId) => parentById.has(targetId))) {
      return parentById;
    }
  }

  if (breadthLimited) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_UNVERIFIED",
      `获取根 ${input.categoryParentId} 的目录树超过 ${MAX_BINDING_DIRECTORIES_WALKED} 个目录，无法安全核实已导入目录；请手动整理或缩小获取根`,
    );
  }
  return parentById;
}

async function listAllPhysicalFiles(input: {
  library: ResolveAcquisitionBindingPlanInput["library"];
  accountId: string;
  connectedStorageId: string;
  mediaTitleId: string;
}): Promise<LibraryPhysicalFileBinding[]> {
  const out: LibraryPhysicalFileBinding[] = [];
  let afterFileId: string | undefined;
  for (let pageNumber = 0; pageNumber < Math.ceil(MAX_FILES / PAGE_SIZE); pageNumber += 1) {
    const page = await input.library.listPhysicalFileBindings({
      accountId: input.accountId,
      connectedStorageId: input.connectedStorageId,
      mediaTitleId: input.mediaTitleId,
      limit: PAGE_SIZE,
      ...(afterFileId === undefined ? {} : { afterFileId }),
    });
    out.push(...page);
    if (page.length < PAGE_SIZE) return out;
    const last = page[page.length - 1];
    if (!last) return out;
    afterFileId = last.fileId;
  }
  throw new AcquisitionBindingSafetyError(
    "ACQUISITION_BINDING_UNVERIFIED",
    `已导入文件超过 ${MAX_FILES} 个，无法安全证明目标目录只属于本作品；请先在媒体库中整理该作品`,
  );
}

/**
 * Resolve the already-imported target directories for one title on one drive.
 *
 * Nothing here trusts a caller-supplied directory ID: the IDs come only from F02
 * physical-file bindings, their unique F02 directory binding, and an actual walk
 * from the acquisition category root. No match means the caller keeps the old
 * name-based behavior; an unsafe/ambiguous match fails closed with a stable code.
 */
export async function resolveAcquisitionBindingPlan(
  input: ResolveAcquisitionBindingPlanInput,
): Promise<AcquisitionDirectoryBindingPlan | null> {
  const accountId = nonEmpty(input.accountId, "accountId");
  const connectedStorageId = nonEmpty(input.connectedStorageId, "connectedStorageId");
  const categoryParentId = nonEmpty(input.categoryParentId, "categoryParentId");
  const kind: "movie" | "tv" = input.title.type === "movie" ? "movie" : "tv";
  const requestedSeasons = new Set<number>(
    (kind === "movie" ? [1] : input.seasons).filter(
      (season) => Number.isSafeInteger(season) && season >= 0,
    ),
  );
  if (requestedSeasons.size === 0) return null;

  const files = await listAllPhysicalFiles({
    library: input.library,
    accountId,
    connectedStorageId,
    mediaTitleId: input.title.id,
  });
  if (files.length === 0) return null;

  const filesByParent = new Map<string, LibraryPhysicalFileBinding[]>();
  for (const file of files) {
    const existing = filesByParent.get(file.parentDirectoryId);
    if (existing) existing.push(file);
    else filesByParent.set(file.parentDirectoryId, [file]);
  }

  interface TargetCandidate {
    parentDirectoryId: string;
    binding: LibraryDirectoryBinding;
    files: LibraryPhysicalFileBinding[];
  }

  const targetBySeason = new Map<number, TargetCandidate>();
  const targetDirectoryBySeason = new Map<number, string>();
  for (const [parentDirectoryId, parentFiles] of filesByParent) {
    const binding = await input.library.findDirectoryBinding({
      accountId,
      connectedStorageId,
      directoryId: parentDirectoryId,
    });
    if (!binding) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_NOT_EXCLUSIVE",
        `已导入目录 ${parentDirectoryId} 没有唯一的作品绑定（可能被多个作品或多季共享），不能作为获取目标`,
      );
    }
    if (!bindingMatchesTitle(binding, input.title)) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_UNVERIFIED",
        `已导入目录 ${parentDirectoryId} 的绑定身份与当前作品不一致`,
      );
    }
    if (!requestedSeasons.has(binding.seasonNumber)) continue;
    if (targetBySeason.has(binding.seasonNumber)) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_AMBIGUOUS",
        `第 ${binding.seasonNumber} 季存在多个已导入目录，无法安全选择获取目标`,
      );
    }
    targetBySeason.set(binding.seasonNumber, { parentDirectoryId, binding, files: parentFiles });
    targetDirectoryBySeason.set(binding.seasonNumber, parentDirectoryId);
  }
  if (targetBySeason.size === 0) return null;

  // A season directory must be one identity. One physical directory cannot be the
  // target of two different seasons on the same drive (flat multi-season folders
  // are ambiguous without a reliable season map).
  const parents = new Set(targetDirectoryBySeason.values());
  if (parents.size !== targetDirectoryBySeason.size) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_AMBIGUOUS",
      "多个季指向同一个已导入目录，无法安全区分季目标",
    );
  }

  const targetBindings = new Map<string, LibraryDirectoryBinding>();
  for (const target of targetBySeason.values()) {
    targetBindings.set(target.parentDirectoryId, target.binding);
  }
  const targetIds = new Set(targetBindings.keys());
  const candidateParentIds = new Set<string>();
  for (const target of targetBySeason.values()) {
    if (target.binding.parentDirectoryId !== null) {
      candidateParentIds.add(target.binding.parentDirectoryId);
    }
  }
  const persistedProof = await proveByPersistedAncestors({
    storage: input.storage,
    library: input.library,
    accountId,
    connectedStorageId,
    categoryParentId,
    targetBindings,
  });
  const parentById =
    persistedProof ??
    (await proveByBoundedWalk({
      storage: input.storage,
      categoryParentId,
      targetIds,
      candidateParentIds,
    }));
  const unreachable = [...targetIds].filter((targetId) => !parentById.has(targetId));
  if (unreachable.length > 0) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_OUTSIDE_SANDBOX",
      `已导入目录 ${unreachable[0]} 不在当前获取根 ${categoryParentId} 下（或超过 ${MAX_BINDING_DIRECTORY_DEPTH} 层）；请先在网盘设置中配置对应获取根`,
    );
  }
  const showForSeason = new Map<number, string>();

  for (const [seasonNumber, target] of [...targetBySeason].sort(([left], [right]) => left - right)) {
    const actualParentId = parentById.get(target.parentDirectoryId);
    if (actualParentId === undefined) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_OUTSIDE_SANDBOX",
        `已导入目录 ${target.parentDirectoryId} 不在当前获取根 ${categoryParentId} 下；请先在网盘设置中配置对应获取根`,
      );
    }
    if (kind === "movie") {
      if (
        target.binding.parentDirectoryId !== null &&
        target.binding.parentDirectoryId !== actualParentId
      ) {
        throw new AcquisitionBindingSafetyError(
          "ACQUISITION_BINDING_UNVERIFIED",
          `已导入电影目录 ${target.parentDirectoryId} 的持久父目录与实际目录关系不一致，不能安全复用`,
        );
      }
      if (!target.binding.exclusive) {
        await assertDirectoryOnlyHoldsImportedVideos({
          storage: input.storage,
          directoryId: target.parentDirectoryId,
          files: target.files,
        });
      }
      // The movie directory itself is reachable from the acquisition root; the
      // title-root consistency check below is TV-only.
      showForSeason.set(seasonNumber, categoryParentId);
      continue;
    }
    const boundParent = target.binding.parentDirectoryId;
    let showDirectoryId: string | null = null;
    if (boundParent === null) {
      if (actualParentId === categoryParentId) {
        // Flat layout: the season directory IS the show directory.
        showDirectoryId = target.parentDirectoryId;
      }
    } else if (boundParent === categoryParentId) {
      // Flat layout: the season directory IS the show directory.
      if (actualParentId === categoryParentId) {
        showDirectoryId = target.parentDirectoryId;
      }
    } else if (boundParent !== target.parentDirectoryId && boundParent === actualParentId) {
      // The title root's own parent may itself be nested under the category.
      showDirectoryId = boundParent;
    }
    if (showDirectoryId === null) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_UNVERIFIED",
        `已导入目录 ${target.parentDirectoryId} 缺少可核实的作品父目录，不能作为获取目标`,
      );
    }
    // The show directory must itself be in the verified tree. For a flat
    // layout it is the season target, already checked above.
    let cursor: string | undefined = target.parentDirectoryId;
    let insideShow = false;
    for (let depth = 0; depth < MAX_BINDING_DIRECTORY_DEPTH && cursor !== undefined; depth += 1) {
      if (cursor === showDirectoryId) {
        insideShow = true;
        break;
      }
      cursor = parentById.get(cursor);
    }
    if (!insideShow) {
      throw new AcquisitionBindingSafetyError(
        "ACQUISITION_BINDING_OUTSIDE_SANDBOX",
        `已导入季目录 ${target.parentDirectoryId} 不在作品目录 ${showDirectoryId} 下，不能作为获取目标`,
      );
    }
    if (!target.binding.exclusive) {
      await assertDirectoryOnlyHoldsImportedVideos({
        storage: input.storage,
        directoryId: target.parentDirectoryId,
        files: target.files,
      });
    }
    showForSeason.set(seasonNumber, showDirectoryId);
  }

  const showIds = new Set(showForSeason.values());
  if (showIds.size !== 1) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_AMBIGUOUS",
      "请求的多个季位于不同作品目录，无法在一次获取中安全复用",
    );
  }
  const showDirectoryId = [...showIds][0]!;
  const movieTarget = targetBySeason.get(1);
  if (kind === "movie" && !movieTarget) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_UNVERIFIED",
      "已导入电影文件缺少第 1 季绑定，不能作为获取目标",
    );
  }
  const titleRootId = kind === "movie" ? movieTarget!.parentDirectoryId : showDirectoryId;
  const titleRootParentDirectoryId = parentById.get(titleRootId) ?? null;

  const copiesByEpisode = new Map<string, Set<string>>();
  for (const target of targetBySeason.values()) {
    for (const file of target.files) {
      for (const episodeCode of file.episodeCodes) {
        const known = copiesByEpisode.get(episodeCode);
        if (known) known.add(file.fileId);
        else copiesByEpisode.set(episodeCode, new Set([file.fileId]));
      }
    }
  }
  const importedEpisodeCodes = [...copiesByEpisode.keys()].sort();
  const multiVersionEpisodeCodes = [...copiesByEpisode]
    .filter(([, fileIds]) => fileIds.size > 1)
    .map(([episodeCode]) => episodeCode)
    .sort();

  const seasonDirectoryIds = Object.fromEntries(
    [...targetDirectoryBySeason].sort(([left], [right]) => left - right),
  ) as Record<number, string>;

  return {
    accountId,
    connectedStorageId,
    mediaTitleId: input.title.id,
    mediaType: input.title.type,
    tmdbId: input.title.tmdbId,
    kind,
    showDirectoryId: kind === "tv" ? showDirectoryId : null,
    titleRootParentDirectoryId,
    seasonDirectoryIds,
    movieDirectoryId: kind === "movie" ? movieTarget!.parentDirectoryId : null,
    importedEpisodeCodes,
    multiVersionEpisodeCodes,
    showCanonicalName: mediaLibraryFolderName({
      title: input.title.title,
      year: input.title.year,
      tmdbId: input.title.tmdbId,
    }),
    showLegacyName: legacyMediaLibraryFolderName({
      title: input.title.title,
      year: input.title.year,
    }),
  };
}

async function assertDirectoryOnlyHoldsImportedVideos(input: {
  storage: StorageExecutor;
  directoryId: string;
  files: readonly LibraryPhysicalFileBinding[];
}): Promise<void> {
  let tree;
  try {
    tree = await input.storage.listTree({
      directoryId: input.directoryId,
      maxDepth: MAX_BINDING_DIRECTORY_DEPTH,
    });
  } catch {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_UNVERIFIED",
      `无法读取已导入目录 ${input.directoryId} 以证明其只属于本作品`,
    );
  }
  const videos = tree.filter((file) => hasVideoExtension(file.path));
  if (videos.length === 0) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_UNVERIFIED",
      `已导入目录 ${input.directoryId} 中没有可核实的视频，不能作为获取目标`,
    );
  }
  const importedFileIds = new Set(input.files.map((file) => file.fileId));
  const foreign = videos.filter((file) => !importedFileIds.has(file.providerFileId));
  if (foreign.length > 0) {
    throw new AcquisitionBindingSafetyError(
      "ACQUISITION_BINDING_NOT_EXCLUSIVE",
      `已导入目录 ${input.directoryId} 含有未归属于本作品的视频，不能作为获取目标`,
    );
  }
}

/**
 * Make the existing name-based directory lifecycle return the already-imported
 * IDs. Only lookup names are rewritten in the returned lists; no provider file or
 * directory is renamed, moved, created, or added to a sandbox allowlist.
 */
export function withBoundAcquisitionDirectories(input: {
  storage: StorageExecutor;
  categoryParentId: string;
  plan: AcquisitionDirectoryBindingPlan;
}): StorageExecutor {
  const { storage, categoryParentId, plan } = input;
  const titleRootId = plan.kind === "movie" ? plan.movieDirectoryId : plan.showDirectoryId;
  const titleRootParentId = plan.titleRootParentDirectoryId;
  const isTitleRootParent = (parentId: string): boolean =>
    parentId === categoryParentId || (titleRootParentId !== null && parentId === titleRootParentId);

  const boundCreateTarget = (create: { name: string; parentId: string }): string | null => {
    if (titleRootId !== null && isTitleRootParent(create.parentId)) {
      // Only the title root itself may be redirected. A temporary/recovery
      // directory created under the same parent must still go through the
      // original executor (and the original sandbox), never silently become the
      // already-imported title directory. `titleRootParentId` is the actual
      // parent proven by the traversal, so a multi-level template can also
      // reuse the bound nested title root.
      const name = create.name.trim();
      if (name !== plan.showCanonicalName && name !== plan.showLegacyName) return null;
      return titleRootId;
    }
    if (plan.kind === "tv" && plan.showDirectoryId !== null && create.parentId === plan.showDirectoryId) {
      const match = /^Season\s+(\d{1,4})$/i.exec(create.name.trim());
      if (!match?.[1]) return null;
      return plan.seasonDirectoryIds[Number(match[1])] ?? null;
    }
    return null;
  };

  const presentChildren = async (directoryId: string): Promise<Array<{ id: string; name: string }>> => {
    const actual = await storage.listChildDirectories(directoryId);
    if (directoryId === categoryParentId || (titleRootParentId !== null && directoryId === titleRootParentId)) {
      if (titleRootId === null) return actual;
      const lookupNames = new Set([plan.showCanonicalName, plan.showLegacyName]);
      // Present the one bound provider ID under the canonical lookup name at
      // both its real parent and the acquisition category (the original
      // lifecycle always looks under the category). Drop any same-named foreign
      // entry so a name lookup cannot select a twin, and never list the bound ID
      // twice. This only rewrites lookup results; it does not move or create
      // anything on the provider.
      return [
        ...actual.filter((child) => child.id !== titleRootId && !lookupNames.has(child.name)),
        { id: titleRootId, name: plan.showCanonicalName },
      ];
    }
    if (plan.kind === "tv" && directoryId === plan.showDirectoryId) {
      const seasonDirs = new Map<number, string>();
      for (const [rawSeason, directoryIdForSeason] of Object.entries(plan.seasonDirectoryIds)) {
        const seasonNumber = Number(rawSeason);
        if (directoryIdForSeason !== plan.showDirectoryId) {
          seasonDirs.set(seasonNumber, directoryIdForSeason);
        }
      }
      let rewritten = actual.filter((child) => {
        for (const [seasonNumber, boundId] of seasonDirs) {
          if (child.name === seasonDirectoryName(seasonNumber) && child.id !== boundId) return false;
        }
        return true;
      });
      for (const [seasonNumber, boundId] of seasonDirs) {
        rewritten = rewritten.filter((child) => child.id !== boundId);
        rewritten.push({ id: boundId, name: seasonDirectoryName(seasonNumber) });
      }
      return rewritten;
    }
    return actual;
  };

  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "createDirectory") {
        return async (create: { name: string; parentId: string }): Promise<string> => {
          const bound = boundCreateTarget(create);
          return bound ?? target.createDirectory(create);
        };
      }
      if (property === "listChildDirectories") {
        return presentChildren;
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
