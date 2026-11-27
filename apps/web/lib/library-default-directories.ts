export interface DefaultLibraryDirectory {
  directoryId: string;
  name: string;
}

export interface DefaultLibraryDirectories {
  movie: DefaultLibraryDirectory | null;
  tv: DefaultLibraryDirectory | null;
}

interface StorageDefaultSource {
  provider: string;
  moviesCid?: string | null;
  tvCid?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 解析网盘在「设置 → 网盘」已建好的默认电影与剧集目录，不触发外部网盘请求。
 * 仅保留真实目录 ID；`pan115` 兼容全局环境变量 CID 兜底，但绝不回落模拟占位 ID。
 */
export function resolveDefaultLibraryDirectories(
  storage: StorageDefaultSource | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DefaultLibraryDirectories {
  if (!storage) return { movie: null, tv: null };
  const rootName = nonEmpty(env.MEDIA_TRACK_LIBRARY_ROOT_DIR) ?? "Mediary Scout";
  const movieLeaf = nonEmpty(env.MEDIA_TRACK_LIBRARY_MOVIES_DIR) ?? "Movies";
  const tvLeaf = nonEmpty(env.MEDIA_TRACK_LIBRARY_TV_DIR) ?? "TV";

  const is115 = storage.provider === "pan115";
  const envFallbackRoot = is115 ? nonEmpty(env.MEDIA_TRACK_115_TEST_ROOT_CID) : null;
  const movieId = nonEmpty(storage.moviesCid) ?? (is115 ? nonEmpty(env.MEDIA_TRACK_MOVIES_PARENT_CID) ?? envFallbackRoot : null);
  const tvId = nonEmpty(storage.tvCid) ?? (is115 ? nonEmpty(env.MEDIA_TRACK_TV_PARENT_CID) ?? envFallbackRoot : null);

  return {
    movie: movieId ? { directoryId: movieId, name: `${rootName}/${movieLeaf}` } : null,
    tv: tvId ? { directoryId: tvId, name: `${rootName}/${tvLeaf}` } : null,
  };
}

/** 汇总网盘默认电影与剧集目录作为去重后的扫描/整理根目录列表。 */
export function collectDefaultLibraryRoots(defaults: DefaultLibraryDirectories): DefaultLibraryDirectory[] {
  const roots: DefaultLibraryDirectory[] = [];
  const seen = new Set<string>();
  for (const entry of [defaults.movie, defaults.tv]) {
    if (!entry || seen.has(entry.directoryId)) continue;
    seen.add(entry.directoryId);
    roots.push(entry);
  }
  return roots;
}
