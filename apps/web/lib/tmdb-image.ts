export type TmdbImageSize =
  | "w92"
  | "w154"
  | "w185"
  | "w342"
  | "w500"
  | "w780"
  | "w1280"
  | "original";

export const ALLOWED_TMDB_IMAGE_SIZES: ReadonlySet<TmdbImageSize> = new Set<TmdbImageSize>([
  "w92",
  "w154",
  "w185",
  "w342",
  "w500",
  "w780",
  "w1280",
  "original",
]);

/** 单段 TMDB 图片文件名白名单：仅允许字母、数字、下划线、短横线及常见位图扩展名。 */
export const TMDB_IMAGE_FILENAME_RE = /^[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;

const TMDB_IMAGE_PATH_RE = /^\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i;

/** 校验尺寸是否在 TMDB 图片代理白名单内。 */
export function isAllowedTmdbImageSize(size: string): size is TmdbImageSize {
  return ALLOWED_TMDB_IMAGE_SIZES.has(size as TmdbImageSize);
}

/** 校验单段图片文件名是否安全合法（不含路径分隔符、穿越符或查询参数）。 */
export function isValidTmdbImageFilename(filename: string): boolean {
  return TMDB_IMAGE_FILENAME_RE.test(filename);
}

/**
 * 将 TMDB 相对图片路径规范化为站内代理 URL（`/api/tmdb/image/${size}/${filename}`）。
 * 非法路径、空值、路径穿越或未知尺寸均返回 `null`。
 */
export function tmdbImageUrl(
  path: string | null | undefined,
  size: TmdbImageSize = "w342",
): string | null {
  if (typeof path !== "string" || !isAllowedTmdbImageSize(size)) {
    return null;
  }
  const match = TMDB_IMAGE_PATH_RE.exec(path);
  if (!match?.[1]) {
    return null;
  }
  return `/api/tmdb/image/${size}/${match[1]}`;
}
