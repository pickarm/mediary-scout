/**
 * Pure naming template parser and renderer for the library organizer.
 * Templates use `/` between relative path segments. Backslashes are rejected
 * so a template has the same meaning on every host platform.
 */

export type NamingTemplateKind =
  | "movieDirectory"
  | "movieFile"
  | "tvDirectory"
  | "seasonDirectory"
  | "episodeFile";

export const DEFAULT_ORGANIZE_CONCURRENCY = 3;
export const MIN_ORGANIZE_CONCURRENCY = 1;
export const MAX_ORGANIZE_CONCURRENCY = 10;

export const DEFAULT_NAMING_TEMPLATES: Readonly<Record<NamingTemplateKind, string>> = {
  movieDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
  movieFile: "{title}{{ ({year})}}{{ - {mediaTags}}}{{-{releaseGroup}}}{ext}",
  tvDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
  seasonDirectory: "Season {season:02}",
  episodeFile: "{title} - {episodeCode}{{ - {mediaTags}}}{{-{releaseGroup}}}{ext}",
};

export interface NamingTemplatePreset {
  readonly id: "perfect" | "emby-compact" | "classic";
  readonly name: string;
  readonly badge: string;
  readonly description: string;
  readonly sample: string;
  readonly templates: Readonly<Record<NamingTemplateKind, string>>;
}

export const NAMING_TEMPLATE_PRESETS: readonly NamingTemplatePreset[] = [
  {
    id: "perfect",
    name: "完美全息版",
    badge: "推荐默认",
    description: "包含中文片名、年份、TMDB ID、清晰度、片源、杜比视界/HDR、音轨及压制组",
    sample: "沙丘2 (2024) - 2160p.REMUX.DV.HDR10+.HEVC.TrueHD.Atmos-CHD.mkv",
    templates: DEFAULT_NAMING_TEMPLATES,
  },
  {
    id: "emby-compact",
    name: "Emby · 精简版",
    badge: "轻量清晰",
    description: "只保留片名、年份、TMDB ID 与核心画质/动态范围/音轨，文件名更短",
    sample: "沙丘2 (2024) - 2160p.DV.HDR10+.TrueHD.Atmos.mkv",
    templates: {
      movieDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
      movieFile: "{title}{{ ({year})}}{{ - {resolution}}}{{.{dynamicRange}}}{{.{audioCodec}}}{ext}",
      tvDirectory: "{title}{{ ({year})}}{{ [tmdbid={tmdbId}]}}",
      seasonDirectory: "Season {season:02}",
      episodeFile: "{title} - {episodeCode}{{ - {resolution}}}{{.{dynamicRange}}}{{.{audioCodec}}}{ext}",
    },
  },
  {
    id: "classic",
    name: "经典纯净版",
    badge: "极简目录",
    description: "仅保留片名、年份与集号，完全隐藏画质和压制组技术标识",
    sample: "沙丘2 (2024).mkv",
    templates: {
      movieDirectory: "{title}{{ ({year})}}",
      movieFile: "{title}{{ ({year})}}{ext}",
      tvDirectory: "{title}{{ ({year})}}",
      seasonDirectory: "Season {season:02}",
      episodeFile: "{title} - {episodeCode}{ext}",
    },
  },
];

export type NamingField =
  | "title"
  | "originalTitle"
  | "year"
  | "tmdbId"
  | "season"
  | "episode"
  | "episodeCode"
  | "resolution"
  | "videoSource"
  | "dynamicRange"
  | "videoCodec"
  | "audioCodec"
  | "fps"
  | "edition"
  | "releaseGroup"
  | "mediaTags"
  | "originalName"
  | "ext";

export type NamingValues = Partial<Record<NamingField, string | number | null | undefined>>;

export interface MediaTechTags {
  readonly resolution: string;
  readonly videoSource: string;
  readonly dynamicRange: string;
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly fps: string;
  readonly edition: string;
  readonly releaseGroup: string;
  readonly mediaTags: string;
}

export type NamingTemplateLeafToken =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "field"; readonly field: NamingField; readonly padding?: 2 };

export type NamingTemplateToken =
  | NamingTemplateLeafToken
  | { readonly type: "optional"; readonly tokens: readonly NamingTemplateLeafToken[] };

export interface ParsedNamingTemplate {
  readonly segments: readonly (readonly NamingTemplateToken[])[];
}

export type ParseNamingTemplateResult =
  | { readonly ok: true; readonly template: ParsedNamingTemplate }
  | { readonly ok: false; readonly errors: readonly string[] };

const FIELDS = new Set<NamingField>([
  "title", "originalTitle", "year", "tmdbId", "season", "episode",
  "episodeCode", "resolution", "videoSource", "dynamicRange", "videoCodec",
  "audioCodec", "fps", "edition", "releaseGroup", "mediaTags",
  "originalName", "ext",
]);

const WINDOWS_INVALID = /[<>:"|?*\\/\u0000-\u001f]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const RELEASE_GROUP_NOISE = /^(?:dl|rip|hd|ma|x264|x265|h264|h265|hevc|avc|av1|vp9|atmos|remux|bluray|10bit|8bit|60fps|120fps|web|dts|hdr|hdr10|dv|ac3|aac|ddp|truehd|flac)$/iu;

function isField(value: string): value is NamingField {
  return FIELDS.has(value as NamingField);
}

/** 从原视频文件名中提取清晰度、片源、杜比/HDR、编码、音轨、帧率与压制组技术标签。 */
export function extractMediaTechTags(
  filename: string,
  overrides?: { resolution?: string | null | undefined; edition?: string | null | undefined },
): MediaTechTags {
  const leaf = splitParentAndName(filename.trim()).name;
  const { stem } = splitExtension(leaf);

  const overrideResolution = overrides?.resolution?.trim() ?? "";
  let resolution = overrideResolution;
  if (!resolution) {
    if (/(?:^|[.\s_\-[({])(2160p|4k|uhd)(?=$|[.\s_\-}\])])/iu.test(stem)) resolution = "2160p";
    else if (/(?:^|[.\s_\-[({])(1080p|1080i)(?=$|[.\s_\-}\])])/iu.test(stem)) resolution = "1080p";
    else if (/(?:^|[.\s_\-[({])720p(?=$|[.\s_\-}\])])/iu.test(stem)) resolution = "720p";
  }

  let videoSource = "";
  if (/\bremux\b/iu.test(stem)) videoSource = "REMUX";
  else if (/\bweb[-.\s_]?dl\b/iu.test(stem)) videoSource = "WEB-DL";
  else if (/\bweb[-.\s_]?rip\b/iu.test(stem)) videoSource = "WEBRip";
  else if (/\bblu[-.\s_]?ray\b|\bbdrip\b/iu.test(stem)) videoSource = "BluRay";
  else if (/\bhdtv\b/iu.test(stem)) videoSource = "HDTV";

  const hasDv = /(?:^|[.\s_\-[({])(dv|dovi|dolby[.\s_]?vision)(?=$|[.\s_\-}\])])/iu.test(stem);
  const hasHdr10Plus = /hdr10\+|hdr10plus/iu.test(stem);
  const hasHdr10 = !hasHdr10Plus && /hdr10/iu.test(stem);
  const hasHdr = !hasHdr10Plus && !hasHdr10 && /\bhdr\b/iu.test(stem);
  const hasHlg = /\bhlg\b/iu.test(stem);

  const drParts: string[] = [];
  if (hasDv) drParts.push("DV");
  if (hasHdr10Plus) drParts.push("HDR10+");
  else if (hasHdr10) drParts.push("HDR10");
  else if (hasHdr) drParts.push("HDR");
  else if (hasHlg) drParts.push("HLG");
  const dynamicRange = drParts.join(".");

  let videoCodec = "";
  if (/\b(hevc|h[.\s_]?265|x265)\b/iu.test(stem)) videoCodec = "HEVC";
  else if (/\b(avc|h[.\s_]?264|x264)\b/iu.test(stem)) videoCodec = "AVC";
  else if (/\bav1\b/iu.test(stem)) videoCodec = "AV1";
  else if (/\bvp9\b/iu.test(stem)) videoCodec = "VP9";

  const hasTrueHd = /truehd/iu.test(stem);
  const hasDdp = /\b(ddp|dd\+|eac3|e-ac-3)\b|ddp\s*5\.1|ddp\s*7\.1/iu.test(stem);
  const hasAtmos = /atmos/iu.test(stem);
  const hasDtsHdMa = /dts[-.\s_]?hd[-.\s_]?ma/iu.test(stem);
  const hasDtsHd = !hasDtsHdMa && /dts[-.\s_]?hd/iu.test(stem);
  const hasDtsX = /dts[-.\s_]?x\b/iu.test(stem);
  const hasDts = /\bdts\b/iu.test(stem);
  const hasAc3 = /\b(ac3|dd5\.1)\b/iu.test(stem);
  const hasFlac = /\bflac\b/iu.test(stem);
  const hasAac = /\baac\b/iu.test(stem);

  let audioCodec = "";
  if (hasTrueHd && hasAtmos) audioCodec = "TrueHD.Atmos";
  else if (hasDdp && hasAtmos) audioCodec = "DDP.Atmos";
  else if (hasAtmos) audioCodec = "Atmos";
  else if (hasTrueHd) audioCodec = "TrueHD";
  else if (hasDtsHdMa) audioCodec = "DTS-HD.MA";
  else if (hasDtsHd) audioCodec = "DTS-HD";
  else if (hasDtsX) audioCodec = "DTS-X";
  else if (hasDts) audioCodec = "DTS";
  else if (hasDdp) audioCodec = "DDP";
  else if (hasAc3) audioCodec = "AC3";
  else if (hasFlac) audioCodec = "FLAC";
  else if (hasAac) audioCodec = "AAC";

  let fps = "";
  const fpsMatch = /\b(60|120)fps\b/iu.exec(stem);
  if (fpsMatch?.[1]) fps = `${fpsMatch[1]}fps`;

  const overrideEdition = overrides?.edition?.trim() ?? "";
  let edition = overrideEdition;
  if (!edition) {
    if (/\bimax\b/iu.test(stem)) edition = "IMAX";
    else if (/director'?s[.\s_]?cut/iu.test(stem)) edition = "Director's Cut";
    else if (/\bextended\b/iu.test(stem)) edition = "Extended";
    else if (/\bremastered\b/iu.test(stem)) edition = "Remastered";
  }

  let releaseGroup = "";
  const groupMatch = /-([A-Za-z0-9][A-Za-z0-9_@]{1,20})$/u.exec(stem);
  if (groupMatch?.[1]) {
    const candidate = groupMatch[1];
    if (
      !RELEASE_GROUP_NOISE.test(candidate)
      && !WINDOWS_INVALID.test(candidate)
      && !WINDOWS_DEVICE_NAME.test(candidate)
    ) {
      releaseGroup = candidate;
    }
  }

  const orderedTags = [resolution, edition, videoSource, dynamicRange, videoCodec, audioCodec, fps].filter(Boolean);
  const mediaTags = [...new Set(orderedTags)].join(".");

  return {
    resolution,
    videoSource,
    dynamicRange,
    videoCodec,
    audioCodec,
    fps,
    edition,
    releaseGroup,
    mediaTags,
  };
}

function validateLiteral(value: string): string | null {
  if (WINDOWS_INVALID.test(value)) return "模板文字含有 Windows 文件名非法字符";
  if (value.includes("..")) return "模板不能包含 ..";
  return null;
}

function parseFieldToken(segment: string, openIndex: number): { token: NamingTemplateLeafToken; nextCursor: number } {
  const close = segment.indexOf("}", openIndex + 1);
  if (close === -1) throw new Error("模板包含未配对的 {");
  const body = segment.slice(openIndex + 1, close);
  if (body.includes("{")) throw new Error("模板字段不能嵌套");
  const match = /^([A-Za-z][A-Za-z0-9]*)(?::(02))?$/u.exec(body);
  if (!match || !isField(match[1]!)) throw new Error(`未知或非法模板字段：{${body}}`);
  const field = match[1];
  const hasPadding = match[2] === "02";
  if (hasPadding && field !== "season" && field !== "episode") {
    throw new Error(`字段 ${field} 不支持 :02 格式`);
  }
  return {
    token: hasPadding ? { type: "field", field, padding: 2 } : { type: "field", field },
    nextCursor: close + 1,
  };
}

function parseSegment(segment: string): NamingTemplateToken[] {
  if (segment.length === 0) throw new Error("模板不能包含空路径段");
  const rootTokens: NamingTemplateToken[] = [];
  let cursor = 0;

  const pushLiteral = (target: NamingTemplateToken[], value: string): void => {
    if (!value) return;
    const error = validateLiteral(value);
    if (error) throw new Error(error);
    target.push({ type: "literal", value });
  };

  while (cursor < segment.length) {
    if (segment.startsWith("{{", cursor)) {
      cursor += 2;
      const innerTokens: NamingTemplateLeafToken[] = [];
      let literalStart = cursor;
      let closed = false;

      while (cursor < segment.length) {
        if (segment.startsWith("}}", cursor)) {
          pushLiteral(innerTokens, segment.slice(literalStart, cursor));
          cursor += 2;
          closed = true;
          break;
        }
        if (segment.startsWith("{{", cursor)) {
          throw new Error("可选片段不能嵌套");
        }
        if (segment[cursor] === "}") {
          throw new Error("模板包含未配对的 }");
        }
        if (segment[cursor] === "{") {
          pushLiteral(innerTokens, segment.slice(literalStart, cursor));
          const parsed = parseFieldToken(segment, cursor);
          innerTokens.push(parsed.token);
          cursor = parsed.nextCursor;
          literalStart = cursor;
          continue;
        }
        cursor += 1;
      }

      if (!closed) throw new Error("模板包含未配对的 {{");
      if (!innerTokens.some((token) => token.type === "field")) {
        throw new Error("可选片段必须至少包含一个模板字段");
      }
      rootTokens.push({ type: "optional", tokens: innerTokens });
      continue;
    }

    if (segment[cursor] === "}") {
      throw new Error("模板包含未配对的 }");
    }

    if (segment[cursor] === "{") {
      const parsed = parseFieldToken(segment, cursor);
      rootTokens.push(parsed.token);
      cursor = parsed.nextCursor;
      continue;
    }

    let nextSpecial = cursor;
    while (
      nextSpecial < segment.length
      && segment[nextSpecial] !== "{"
      && segment[nextSpecial] !== "}"
    ) {
      nextSpecial += 1;
    }
    pushLiteral(rootTokens, segment.slice(cursor, nextSpecial));
    cursor = nextSpecial;
  }

  return rootTokens;
}

/** Parse a relative template. Supports `{field}`, `{season:02}` / `{episode:02}`, and optional groups `{{...{field}...}}`. */
export function parseNamingTemplate(source: string): ParseNamingTemplateResult {
  if (typeof source !== "string" || source.length === 0) {
    return { ok: false, errors: ["模板不能为空"] };
  }
  if (source.startsWith("/") || /^[A-Za-z]:/u.test(source) || source.startsWith("\\")) {
    return { ok: false, errors: ["模板必须是相对路径"] };
  }

  const rawSegments = source.split("/");
  if (rawSegments.some((part) => part.length === 0)) {
    return { ok: false, errors: ["模板不能以 / 结尾或包含空路径段"] };
  }

  try {
    const segments = rawSegments.map((part) => {
      if (part === "." || part === "..") throw new Error("模板不能包含 . 或 .. 路径段");
      return parseSegment(part);
    });
    return { ok: true, template: { segments } };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "模板无效"] };
  }
}

/** Return all template validation errors without rendering or touching the filesystem. */
export function validateNamingTemplate(source: string): readonly string[] {
  const parsed = parseNamingTemplate(source);
  return parsed.ok ? [] : parsed.errors;
}

function validateValue(field: NamingField, value: string): string | null {
  if (value.includes("..")) return `字段 ${field} 不能包含 ..`;
  if (WINDOWS_INVALID.test(value)) return `字段 ${field} 含有非法路径字符`;
  if (field === "ext" && value !== "" && !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    return "ext 必须是带点的扩展名，例如 .mkv";
  }
  return null;
}

function renderField(token: Extract<NamingTemplateLeafToken, { type: "field" }>, values: NamingValues): string {
  const raw = values[token.field];
  if (raw === null || raw === undefined) return "";
  const value = String(raw);
  const error = validateValue(token.field, value);
  if (error) throw new Error(error);
  if (token.padding === 2 && value !== "") {
    if (!/^\d+$/u.test(value)) throw new Error(`字段 ${token.field} 必须是非负整数才能使用 :02`);
    return value.padStart(2, "0");
  }
  return value;
}

function renderOptionalGroup(tokens: readonly NamingTemplateLeafToken[], values: NamingValues): string {
  let hasNonEmptyField = false;
  let rendered = "";
  for (const token of tokens) {
    if (token.type === "literal") {
      rendered += token.value;
    } else {
      const value = renderField(token, values);
      if (value !== "") hasNonEmptyField = true;
      rendered += value;
    }
  }
  return hasNonEmptyField ? rendered : "";
}

function validateRenderedSegment(segment: string): void {
  if (segment.length === 0) throw new Error("渲染结果包含空路径段");
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error("渲染结果包含不安全的点路径");
  }
  if (WINDOWS_INVALID.test(segment)) throw new Error("渲染结果含有 Windows 文件名非法字符");
  if (/[. ]$/u.test(segment)) throw new Error("Windows 文件名不能以句点或空格结尾");
  if (WINDOWS_DEVICE_NAME.test(segment)) throw new Error("渲染结果不能使用 Windows 保留设备名");
}

/** Render a parsed template as a relative `/`-separated path. Empty optional values render as empty text, and `{{...}}` groups collapse when all inner fields are empty. */
export function renderParsedNamingTemplate(template: ParsedNamingTemplate, values: NamingValues): string {
  const segments = template.segments.map((tokens) => {
    const rendered = tokens.map((token) => {
      if (token.type === "literal") return token.value;
      if (token.type === "optional") return renderOptionalGroup(token.tokens, values);
      return renderField(token, values);
    }).join("");
    validateRenderedSegment(rendered);
    return rendered;
  });
  return segments.join("/");
}

/** Pure preview API: invalid templates or values return an error suitable for a UI preview. */
export function previewNamingTemplate(source: string, values: NamingValues):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const parsed = parseNamingTemplate(source);
  if (!parsed.ok) return parsed;
  try {
    return { ok: true, path: renderParsedNamingTemplate(parsed.template, values) };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "无法渲染模板"] };
  }
}

function splitParentAndName(path: string): { parent: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { parent: "", name: path }
    : { parent: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

function validateRelativePath(path: string): void {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path) || path.includes("\\")) {
    throw new Error("路径必须是安全的相对路径");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0)) throw new Error("路径包含空路径段");
  for (const segment of segments) validateRenderedSegment(segment);
}

function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { stem: name.slice(0, dot), extension: name.slice(dot) } : { stem: name, extension: "" };
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Add a deterministic suffix before the extension when an organizer detects a name collision. */
export function addStableCollisionSuffix(path: string, stableKey: string): string {
  if (stableKey.length === 0) throw new Error("stableKey 不能为空");
  validateRelativePath(path);
  const { parent, name } = splitParentAndName(path);
  const { stem, extension } = splitExtension(name);
  if (!stem) throw new Error("目标文件名不能为空");
  return `${parent}${stem} (${stableHash(stableKey)})${extension}`;
}

function fileStem(path: string): { parent: string; stem: string; extension: string } {
  const { parent, name } = splitParentAndName(path);
  const { stem, extension } = splitExtension(name);
  return { parent, stem, extension };
}

/** Rename a matched subtitle alongside its video while preserving its language/forced suffix and exact extension. */
export function deriveSubtitlePath(sourceVideoPath: string, sourceSubtitlePath: string, targetVideoPath: string): string | null {
  validateRelativePath(sourceVideoPath);
  validateRelativePath(sourceSubtitlePath);
  validateRelativePath(targetVideoPath);
  const sourceVideo = fileStem(sourceVideoPath);
  const sourceSubtitle = fileStem(sourceSubtitlePath);
  const targetVideo = fileStem(targetVideoPath);
  if (!sourceVideo.stem || !sourceSubtitle.stem || !targetVideo.stem || !sourceSubtitle.extension) return null;
  if (sourceSubtitle.parent !== sourceVideo.parent) return null;
  const tail = sourceSubtitle.stem.slice(sourceVideo.stem.length);
  if (tail !== "" && !/^[._ -]/u.test(tail)) return null;
  const suffix = tail;
  const result = `${targetVideo.parent}${targetVideo.stem}${suffix}${sourceSubtitle.extension}`;
  // The helper never permits the source suffix to introduce a different path or unsafe Windows filename.
  const resultName = splitParentAndName(result).name;
  validateRenderedSegment(resultName);
  return result;
}
