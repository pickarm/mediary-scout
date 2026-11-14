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

export const DEFAULT_NAMING_TEMPLATES: Readonly<Record<NamingTemplateKind, string>> = {
  movieDirectory: "{title} ({year})",
  movieFile: "{title} ({year}){ext}",
  tvDirectory: "{title} ({year})",
  seasonDirectory: "Season {season:02}",
  episodeFile: "{title} - {episodeCode}{ext}",
};

export type NamingField =
  | "title"
  | "originalTitle"
  | "year"
  | "tmdbId"
  | "season"
  | "episode"
  | "episodeCode"
  | "resolution"
  | "edition"
  | "originalName"
  | "ext";

export type NamingValues = Partial<Record<NamingField, string | number | null | undefined>>;

export type NamingTemplateToken =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "field"; readonly field: NamingField; readonly padding?: 2 };

export interface ParsedNamingTemplate {
  readonly segments: readonly (readonly NamingTemplateToken[])[];
}

export type ParseNamingTemplateResult =
  | { readonly ok: true; readonly template: ParsedNamingTemplate }
  | { readonly ok: false; readonly errors: readonly string[] };

const FIELDS = new Set<NamingField>([
  "title", "originalTitle", "year", "tmdbId", "season", "episode",
  "episodeCode", "resolution", "edition", "originalName", "ext",
]);

const WINDOWS_INVALID = /[<>:"|?*\\/\u0000-\u001f]/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;

function isField(value: string): value is NamingField {
  return FIELDS.has(value as NamingField);
}

function validateLiteral(value: string): string | null {
  if (WINDOWS_INVALID.test(value)) return "模板文字含有 Windows 文件名非法字符";
  if (value.includes("..")) return "模板不能包含 ..";
  return null;
}

function parseSegment(segment: string): NamingTemplateToken[] {
  const tokens: NamingTemplateToken[] = [];
  let cursor = 0;

  while (cursor < segment.length) {
    const open = segment.indexOf("{", cursor);
    const strayClose = segment.indexOf("}", cursor);
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      throw new Error("模板包含未配对的 }");
    }
    if (open === -1) {
      const literal = segment.slice(cursor);
      const error = validateLiteral(literal);
      if (error) throw new Error(error);
      if (literal) tokens.push({ type: "literal", value: literal });
      break;
    }

    const literal = segment.slice(cursor, open);
    const literalError = validateLiteral(literal);
    if (literalError) throw new Error(literalError);
    if (literal) tokens.push({ type: "literal", value: literal });

    const close = segment.indexOf("}", open + 1);
    if (close === -1) throw new Error("模板包含未配对的 {");
    const body = segment.slice(open + 1, close);
    if (body.includes("{")) throw new Error("模板字段不能嵌套");
    const match = /^([A-Za-z][A-Za-z0-9]*)(?::(02))?$/u.exec(body);
    if (!match || !isField(match[1]!)) throw new Error(`未知或非法模板字段：{${body}}`);
    const field = match[1];
    const hasPadding = match[2] === "02";
    if (hasPadding && field !== "season" && field !== "episode") {
      throw new Error(`字段 ${field} 不支持 :02 格式`);
    }
    tokens.push(hasPadding
      ? { type: "field", field, padding: 2 }
      : { type: "field", field });
    cursor = close + 1;
  }

  if (segment.length === 0) throw new Error("模板不能包含空路径段");
  return tokens;
}

/** Parse a relative template. Only the documented fields and `{season:02}` / `{episode:02}` are accepted. */
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

function renderField(token: Extract<NamingTemplateToken, { type: "field" }>, values: NamingValues): string {
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

function validateRenderedSegment(segment: string): void {
  if (segment.length === 0) throw new Error("渲染结果包含空路径段");
  if (segment === "." || segment === ".." || segment.includes("..")) {
    throw new Error("渲染结果包含不安全的点路径");
  }
  if (WINDOWS_INVALID.test(segment)) throw new Error("渲染结果含有 Windows 文件名非法字符");
  if (/[. ]$/u.test(segment)) throw new Error("Windows 文件名不能以句点或空格结尾");
  if (WINDOWS_DEVICE_NAME.test(segment)) throw new Error("渲染结果不能使用 Windows 保留设备名");
}

/** Render a parsed template as a relative `/`-separated path. Empty optional values render as empty text. */
export function renderParsedNamingTemplate(template: ParsedNamingTemplate, values: NamingValues): string {
  const segments = template.segments.map((tokens) => {
    const rendered = tokens.map((token) => token.type === "literal" ? token.value : renderField(token, values)).join("");
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
