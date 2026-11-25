import type { NextRequest } from "next/server";
import { DEFAULT_NAMING_TEMPLATES, parseNamingTemplate, SCAN_SCHEDULE_TIME_ZONE, type ScanConfiguration, type ScanMediaKind } from "@media-track/workflow/library";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, readJson, requireString, parseLimit, LibraryApiError } from "../../../../lib/library-api";
import { getLibraryReadServices, getLibraryServices, verifyDirectorySelectionTicket } from "../../../../lib/library-runtime";

const allowed = new Set(["storageId", "configId", "sourceRoots", "movieTargetDirectoryId", "movieTargetSelectionToken", "tvTargetDirectoryId", "tvTargetSelectionToken", "mediaKind", "dailyScheduleEnabled", "dailyScheduleTime", "autoOrganize", "templates"]);
const kinds = new Set<ScanMediaKind>(["movie", "tv", "mixed"]);
const templateKeys = Object.keys(DEFAULT_NAMING_TEMPLATES);

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request);
    const storageId = requireString(request.nextUrl.searchParams.get("storageId"), "网盘");
    const limit = parseLimit(request.nextUrl.searchParams.get("limit"), 20, 99);
    const afterConfigId = decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const { scanStore } = await getLibraryReadServices({ accountId, connectedStorageId: storageId });
    const rows = await scanStore.listConfigurations({ accountId, connectedStorageId: storageId }, limit + 1, afterConfigId);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return Response.json({ items, nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!.configId) : null, hasMore });
  } catch (error) { return apiErrorResponse(error); }
}

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const accountId = await libraryAccount(request, true);
    const body = await readJson(request);
    if (Object.keys(body).some((key) => !allowed.has(key))) throw new LibraryApiError(400, "配置包含不支持的字段。");
    const storageId = requireString(body.storageId, "网盘");
    const scope = { accountId, connectedStorageId: storageId };
    const { scanStore, reader } = await getLibraryServices(scope);
    const configId = body.configId === undefined ? crypto.randomUUID() : requireString(body.configId, "配置 ID", 100);
    const previous = await scanStore.getConfiguration(scope, configId);
    if (!Array.isArray(body.sourceRoots) || body.sourceRoots.length < 1 || body.sourceRoots.length > 20) throw new LibraryApiError(400, "来源目录需选择 1 到 20 个。");
    const roots: Array<{ directoryId: string; name: string }> = [];
    const seen = new Set<string>();
    for (const value of body.sourceRoots) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "directoryId" && key !== "selectionToken")) throw new LibraryApiError(400, "来源目录格式无效。");
      const directoryId = requireString((value as Record<string, unknown>).directoryId, "来源目录 ID");
      if (directoryId === "" || seen.has(directoryId)) throw new LibraryApiError(400, "来源目录不能为空或重复。");
      seen.add(directoryId);
      const oldRoot = previous?.sourceRoots.find((root) => root.directoryId === directoryId);
      if (oldRoot) { roots.push({ directoryId, name: oldRoot.name }); continue; }
      const token = (value as Record<string, unknown>).selectionToken;
      if (typeof token !== "string") throw new LibraryApiError(400, "请从目录选择器重新选择来源目录。");
      const ticket = verifyDirectorySelectionTicket(token, scope);
      if (!ticket || ticket.directoryId !== directoryId) throw new LibraryApiError(400, "目录选择已过期或无效，请重新选择。");
      const match = await verifyTicketDirectory(reader, ticket, directoryId);
      roots.push({ directoryId, name: match.name });
    }
    const mediaKind = body.mediaKind;
    if (typeof mediaKind !== "string" || !kinds.has(mediaKind as ScanMediaKind)) throw new LibraryApiError(400, "媒体类型无效。");
    const target = async (value: unknown, selectionToken: unknown, oldValue: string | null, oldName: string | null | undefined, label: string): Promise<{ directoryId: string | null; name: string | null }> => {
      if (value === null || value === undefined || value === "") return { directoryId: null, name: null };
      const directoryId = requireString(value, label);
      if (directoryId === oldValue && (oldName || typeof selectionToken !== "string")) return { directoryId, name: oldName ?? null };
      if (typeof selectionToken !== "string") throw new LibraryApiError(400, "请从目录选择器重新选择目标目录。");
      const ticket = verifyDirectorySelectionTicket(selectionToken, scope);
      if (!ticket || ticket.directoryId !== directoryId) throw new LibraryApiError(400, "目录选择已过期或无效，请重新选择。");
      const match = await verifyTicketDirectory(reader, ticket, directoryId);
      return { directoryId, name: match.name };
    };
    const movieTarget = await target(body.movieTargetDirectoryId, body.movieTargetSelectionToken, previous?.movieTargetDirectoryId ?? null, previous?.movieTargetDirectoryName, "电影目标目录");
    const tvTarget = await target(body.tvTargetDirectoryId, body.tvTargetSelectionToken, previous?.tvTargetDirectoryId ?? null, previous?.tvTargetDirectoryName, "剧集目标目录");
    if (body.dailyScheduleEnabled !== undefined && typeof body.dailyScheduleEnabled !== "boolean") throw new LibraryApiError(400, "每日扫描开关无效。");
    const dailyScheduleEnabled = body.dailyScheduleEnabled === true;
    let dailyScheduleTime: string | null = null;
    if (dailyScheduleEnabled) {
      if (typeof body.dailyScheduleTime !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(body.dailyScheduleTime)) throw new LibraryApiError(400, "每日扫描时间须为 HH:mm。");
      dailyScheduleTime = body.dailyScheduleTime;
    } else if (body.dailyScheduleTime !== undefined && body.dailyScheduleTime !== null && body.dailyScheduleTime !== "") {
      throw new LibraryApiError(400, "未启用每日扫描时不能设置时间。");
    }
    if (body.autoOrganize !== undefined && typeof body.autoOrganize !== "boolean") throw new LibraryApiError(400, "自动整理开关无效。");
    // Old clients omit the field entirely. Keep an explicitly enabled value instead of silently
    // disabling automatic organization on their next save; a brand-new configuration stays off.
    const autoOrganize = body.autoOrganize === undefined ? (previous?.autoOrganize ?? false) : body.autoOrganize;
    const rawTemplates = body.templates === undefined ? DEFAULT_NAMING_TEMPLATES : body.templates;
    if (!rawTemplates || typeof rawTemplates !== "object" || Array.isArray(rawTemplates) || Object.keys(rawTemplates).length !== templateKeys.length || Object.keys(rawTemplates).some((key) => !templateKeys.includes(key))) throw new LibraryApiError(400, "命名模板必须恰好包含五种模板。");
    const templates = {} as Record<(typeof templateKeys)[number], string>;
    for (const key of templateKeys) {
      const template = (rawTemplates as Record<string, unknown>)[key];
      if (typeof template !== "string" || template.length > 500 || !parseNamingTemplate(template).ok) throw new LibraryApiError(400, `命名模板“${key}”无效。`);
      templates[key as (typeof templateKeys)[number]] = template;
    }
    const configuration: ScanConfiguration = {
      configId, scope, sourceRoots: roots, movieTargetDirectoryId: movieTarget.directoryId, movieTargetDirectoryName: movieTarget.name,
      tvTargetDirectoryId: tvTarget.directoryId, tvTargetDirectoryName: tvTarget.name,
      mediaKind: mediaKind as ScanMediaKind, dailyScheduleEnabled, dailyScheduleTime,
      dailyScheduleTimezone: SCAN_SCHEDULE_TIME_ZONE, autoOrganize, autoAcquire: false, templates,
    };
    await scanStore.saveConfiguration(configuration);
    return Response.json({ item: configuration }, { status: 201 });
  } catch (error) { return apiErrorResponse(error); }
}

async function verifyTicketDirectory(
  reader: Awaited<ReturnType<typeof getLibraryServices>>["reader"],
  ticket: NonNullable<ReturnType<typeof verifyDirectorySelectionTicket>>,
  directoryId: string,
) {
  const parentPage = await reader.listPage({
    directoryId: ticket.parentId,
    directoryPath: "",
    page: ticket.page,
    pageSize: 200,
    ...(ticket.cursor === undefined ? {} : { cursor: ticket.cursor }),
  });
  const match = parentPage.items.find((item) => item.fileId === directoryId && item.isDirectory && item.name === ticket.name);
  if (!match) throw new LibraryApiError(400, "所选目录已不存在或不属于所选上级目录。");
  return match;
}
