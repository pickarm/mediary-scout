import type { NextRequest } from "next/server";
import {
  DEFAULT_NAMING_TEMPLATES,
  DEFAULT_ORGANIZE_CONCURRENCY,
  MAX_ORGANIZE_CONCURRENCY,
  MIN_ORGANIZE_CONCURRENCY,
  parseNamingTemplate,
  SCAN_SCHEDULE_TIME_ZONE,
  type ScanConfiguration,
  type ScanMediaKind,
} from "@media-track/workflow/library";
import { apiErrorResponse, decodeCursor, encodeCursor, libraryAccount, readJson, requireString, parseLimit, LibraryApiError } from "../../../../lib/library-api";
import { collectDefaultLibraryRoots, resolveDefaultLibraryDirectories } from "../../../../lib/library-default-directories";
import { getLibraryReadServices, getLibraryServices, verifyDirectorySelectionTicket } from "../../../../lib/library-runtime";

const allowed = new Set([
  "storageId",
  "configId",
  "sourceRoots",
  "useDefaultLibraryDirectories",
  "movieTargetDirectoryId",
  "movieTargetSelectionToken",
  "tvTargetDirectoryId",
  "tvTargetSelectionToken",
  "mediaKind",
  "dailyScheduleEnabled",
  "dailyScheduleTime",
  "autoOrganize",
  "organizeConcurrency",
  "templates",
]);
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
    const services = await getLibraryServices(scope);
    const { scanStore, reader } = services;
    const storageMeta = (services as { storage?: { provider?: string; moviesCid?: string | null; tvCid?: string | null } }).storage;
    if (body.useDefaultLibraryDirectories !== undefined && typeof body.useDefaultLibraryDirectories !== "boolean") {
      throw new LibraryApiError(400, "默认媒体库标识无效。");
    }
    const useDefaultLibraryDirectories = body.useDefaultLibraryDirectories === true;

    let trustedDefaults = resolveDefaultLibraryDirectories(storageMeta?.provider
      ? { provider: storageMeta.provider, moviesCid: storageMeta.moviesCid ?? null, tvCid: storageMeta.tvCid ?? null }
      : null);
    if (useDefaultLibraryDirectories && process.env.MEDIA_TRACK_STORAGE_ADAPTER === "115" && (!trustedDefaults.movie || !trustedDefaults.tv)) {
      try {
        const { getWorkerStorageParents } = await import("../../../../lib/workflow-runtime");
        const parents = await getWorkerStorageParents(accountId, storageId, { strictId: true });
        trustedDefaults = resolveDefaultLibraryDirectories({
          provider: storageMeta?.provider ?? "",
          moviesCid: parents.movies,
          tvCid: parents.tv,
        });
      } catch {
        // 默认目录尚未初始化时由后续逻辑明确提示，不在接口内部静默吞错放行。
      }
    }
    const trustedDefaultRoots = collectDefaultLibraryRoots(trustedDefaults);
    const findTrustedRoot = (directoryId: string) => trustedDefaultRoots.find((entry) => entry.directoryId === directoryId) ?? null;

    const configId = body.configId === undefined ? crypto.randomUUID() : requireString(body.configId, "配置 ID", 100);
    const previous = await scanStore.getConfiguration(scope, configId);
    const roots: Array<{ directoryId: string; name: string }> = [];
    const seen = new Set<string>();
    const suppliedEmptyRoots = body.sourceRoots === undefined || (Array.isArray(body.sourceRoots) && body.sourceRoots.length === 0);
    if (useDefaultLibraryDirectories && suppliedEmptyRoots) {
      if (trustedDefaultRoots.length === 0) {
        throw new LibraryApiError(400, "当前网盘尚未初始化默认媒体库目录，请先前往「设置 → 网盘」检查连接或手动添加其他目录。");
      }
      for (const root of trustedDefaultRoots) {
        seen.add(root.directoryId);
        roots.push({ directoryId: root.directoryId, name: root.name });
      }
    } else {
      if (!Array.isArray(body.sourceRoots) || body.sourceRoots.length < 1 || body.sourceRoots.length > 20) {
        throw new LibraryApiError(400, "来源目录需选择 1 到 20 个。");
      }
      for (const value of body.sourceRoots) {
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "directoryId" && key !== "selectionToken")) throw new LibraryApiError(400, "来源目录格式无效。");
        const directoryId = requireString((value as Record<string, unknown>).directoryId, "来源目录 ID");
        if (directoryId === "" || seen.has(directoryId)) throw new LibraryApiError(400, "来源目录不能为空或重复。");
        seen.add(directoryId);
        const oldRoot = previous?.sourceRoots.find((root) => root.directoryId === directoryId);
        if (oldRoot) { roots.push({ directoryId, name: oldRoot.name }); continue; }
        const token = (value as Record<string, unknown>).selectionToken;
        if (typeof token !== "string") {
          const trustedDefault = findTrustedRoot(directoryId);
          if (trustedDefault) {
            roots.push({ directoryId: trustedDefault.directoryId, name: trustedDefault.name });
            continue;
          }
          throw new LibraryApiError(400, "请从目录选择器重新选择来源目录。");
        }
        const ticket = verifyDirectorySelectionTicket(token, scope);
        if (!ticket || ticket.directoryId !== directoryId) throw new LibraryApiError(400, "目录选择已过期或无效，请重新选择。");
        const match = await verifyTicketDirectory(reader, ticket, directoryId);
        roots.push({ directoryId, name: match.name });
      }
    }

    const mediaKind = body.mediaKind;
    if (typeof mediaKind !== "string" || !kinds.has(mediaKind as ScanMediaKind)) throw new LibraryApiError(400, "媒体类型无效。");
    const target = async (
      value: unknown,
      selectionToken: unknown,
      oldValue: string | null,
      oldName: string | null | undefined,
      trustedFallback: { directoryId: string; name: string } | null,
      label: string,
    ): Promise<{ directoryId: string | null; name: string | null }> => {
      const effectiveValue = value === undefined && useDefaultLibraryDirectories ? trustedFallback?.directoryId ?? null : value;
      if (effectiveValue === null || effectiveValue === undefined || effectiveValue === "") return { directoryId: null, name: null };
      const directoryId = requireString(effectiveValue, label);
      if (directoryId === oldValue && (oldName || typeof selectionToken !== "string")) return { directoryId, name: oldName ?? null };
      if (typeof selectionToken !== "string") {
        const trustedDefault = findTrustedRoot(directoryId);
        if (trustedDefault) return { directoryId: trustedDefault.directoryId, name: trustedDefault.name };
        throw new LibraryApiError(400, "请从目录选择器重新选择目标目录。");
      }
      const ticket = verifyDirectorySelectionTicket(selectionToken, scope);
      if (!ticket || ticket.directoryId !== directoryId) throw new LibraryApiError(400, "目录选择已过期或无效，请重新选择。");
      const match = await verifyTicketDirectory(reader, ticket, directoryId);
      return { directoryId, name: match.name };
    };
    const movieTarget = await target(
      body.movieTargetDirectoryId,
      body.movieTargetSelectionToken,
      previous?.movieTargetDirectoryId ?? null,
      previous?.movieTargetDirectoryName,
      trustedDefaults.movie,
      "电影目标目录",
    );
    const tvTarget = await target(
      body.tvTargetDirectoryId,
      body.tvTargetSelectionToken,
      previous?.tvTargetDirectoryId ?? null,
      previous?.tvTargetDirectoryName,
      trustedDefaults.tv,
      "剧集目标目录",
    );
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
    // 新建配置默认启用「入库后自动整理」；若已有配置显式关闭且旧请求未传该字段，则保留原设置。
    const autoOrganize = body.autoOrganize === undefined ? (previous?.autoOrganize ?? true) : body.autoOrganize;
    let organizeConcurrency = previous?.organizeConcurrency ?? DEFAULT_ORGANIZE_CONCURRENCY;
    if (body.organizeConcurrency !== undefined) {
      if (
        typeof body.organizeConcurrency !== "number"
        || !Number.isSafeInteger(body.organizeConcurrency)
        || body.organizeConcurrency < MIN_ORGANIZE_CONCURRENCY
        || body.organizeConcurrency > MAX_ORGANIZE_CONCURRENCY
      ) {
        throw new LibraryApiError(400, `整理并发须为 ${MIN_ORGANIZE_CONCURRENCY} 到 ${MAX_ORGANIZE_CONCURRENCY} 的整数。`);
      }
      organizeConcurrency = body.organizeConcurrency;
    }

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
      dailyScheduleTimezone: SCAN_SCHEDULE_TIME_ZONE, autoOrganize, organizeConcurrency, autoAcquire: false, templates,
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
