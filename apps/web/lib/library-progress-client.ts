import type {
  ActivityActiveRunSummary,
  ActivityCompletedSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";

/**
 * 原任务页共享实时进度客户端（F13）。
 *
 * 一个浏览器页面会话里，(账号代次, 网盘, 有界查询参数) 相同的**所有**消费者共用
 * 一条 `GET /api/library/progress` SSE：活动页、导航角标、卡片徽标都不再各自轮询。
 * 断线时该 scope 只启动一份低频后备轮询（`GET /api/library/activity`，同一请求参数
 * 与同一有界 DTO），并在后台重连；重新连上后立即以服务端新快照覆盖。
 *
 * 本模块刻意不依赖 React，也**不需要** root provider：共享状态就是模块级注册表，
 * 组件用 `components/library-progress-provider.tsx` 的 hook 订阅即可。
 *
 * 账号边界：
 * - 服务端在**建立连接时**认证，cookie 之后变化不会让既有 SSE 重新认证；因此切换
 *   账号/网盘时必须丢弃旧快照。现有登录、退出、改密码都走整页导航
 *   （`window.location.href`），客户端模块随之销毁；这里再补三道防线：
 *   1. scope 里可带 `accountKey`（账号代次，不给就为 null），不同代次互不可见；
 *   2. bfcache 恢复（`pageshow.persisted`）时自动 reopen 连接、清空旧快照；
 *   3. 后备轮询收到 401/403/404 即终止并清空该 scope 的全部进度。
 * 需要显式切换时调用 `resetLibraryProgressSubscriptions()` / `refreshLibraryProgressSubscriptions()`。
 */

export type LibraryProgressMediaType = ActivityActiveRunSummary["type"];

/** 连接状态。`denied` = 认证/网盘归属已失效，终止且不再重试。 */
export type LibraryProgressStatus = "idle" | "connecting" | "live" | "polling" | "denied";

export interface LibraryProgressScope {
  /** 当前网盘工作区；null/undefined = 账号级（全部网盘）。 */
  storageId?: string | null;
  /**
   * 账号代次（不是 accountId）。同一标签页内账号变化必须换一个值，
   * 否则会读到上一个账号留下的快照。缺省 null。
   */
  accountKey?: string | null;
  activePage?: number;
  activePageSize?: number;
  recentLimit?: number;
}

export interface ResolvedLibraryProgressScope {
  readonly key: string;
  readonly storageId: string | null;
  readonly activePage: number;
  readonly activePageSize: number;
  readonly recentLimit: number;
}

export interface LibraryProgressSnapshot {
  readonly page: PostgresActivityPage;
  readonly observedAt: string;
}

export interface LibraryProgressState {
  readonly key: string;
  readonly storageId: string | null;
  /**
   * 会话代次。bfcache 恢复、账号重认证或显式 reset 时递增；
   * 旧代次的尾页快照、观察集合、在途响应和操作入口必须立即失效。
   */
  readonly generation: number;
  readonly status: LibraryProgressStatus;
  readonly page: PostgresActivityPage | null;
  /** 服务端发布快照的时刻（SSE），或后备轮询收到响应的本地时刻。仅用于展示。 */
  readonly observedAt: string | null;
  readonly source: "stream" | "poll" | null;
}

export interface LibraryProgressStreamHandlers {
  onOpen(): void;
  onSnapshot(snapshot: LibraryProgressSnapshot): void;
  onError(): void;
}

export interface LibraryProgressStreamHandle {
  close(): void;
}

export type LibraryProgressTimer = ReturnType<typeof setTimeout>;

export interface LibraryProgressRuntime {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): LibraryProgressTimer;
  clearTimeout(handle: LibraryProgressTimer): void;
  /** 打开 SSE；同步抛错或触发 onError 都视为断线，转入统一后备轮询。 */
  openStream(
    scope: ResolvedLibraryProgressScope,
    handlers: LibraryProgressStreamHandlers,
  ): LibraryProgressStreamHandle;
  /** 后备轮询的一次读取；401/403/404 抛 `LibraryProgressDeniedError`。 */
  loadPage(scope: ResolvedLibraryProgressScope): Promise<PostgresActivityPage>;
}

/** 认证或网盘归属已失效：该 scope 终止，不再重试。 */
export class LibraryProgressDeniedError extends Error {
  constructor(message = "登录状态或网盘归属已失效。") {
    super(message);
    this.name = "LibraryProgressDeniedError";
  }
}

const DEFAULT_ACTIVE_PAGE = 1;
const DEFAULT_ACTIVE_PAGE_SIZE = 48;
const DEFAULT_RECENT_LIMIT = 30;
const MAX_ACTIVE_PAGE = 1_000_000;
const MAX_ACTIVE_PAGE_SIZE = 100;
const MAX_RECENT_LIMIT = 100;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_RECONNECT_DELAY_MS = 20_000;
const DEFAULT_STREAM_SILENCE_MS = 90_000;
const MIN_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 120_000;
const MIN_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 300_000;
const MIN_STREAM_SILENCE_MS = 30_000;
const MAX_STREAM_SILENCE_MS = 600_000;

const WORKFLOW_KINDS = new Set<string>([
  "type1_package_init",
  "type2_init",
  "type3_monitor",
  "movie_init",
  "replace_request",
  "staging_recovery",
]);
const MEDIA_TYPES = new Set<string>(["movie", "tv", "anime"]);
const REPORT_STATUSES = new Set<string>([
  "complete",
  "acquired",
  "airing",
  "partial",
  "no_coverage",
  "failed",
  "retrying",
  "replaced",
]);

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value!))) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalCount(value: unknown): number | undefined {
  return isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : undefined;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** 归一化 scope —— 同一个 (账号代次, 网盘, 分页参数) 才是同一条订阅。 */
export function resolveLibraryProgressScope(scope: LibraryProgressScope): ResolvedLibraryProgressScope {
  const accountKey = trimmedOrNull(scope.accountKey);
  const storageId = trimmedOrNull(scope.storageId);
  const activePage = boundedInt(scope.activePage, DEFAULT_ACTIVE_PAGE, 1, MAX_ACTIVE_PAGE);
  const activePageSize = boundedInt(
    scope.activePageSize,
    DEFAULT_ACTIVE_PAGE_SIZE,
    1,
    MAX_ACTIVE_PAGE_SIZE,
  );
  const recentLimit = boundedInt(scope.recentLimit, DEFAULT_RECENT_LIMIT, 1, MAX_RECENT_LIMIT);
  return {
    key: JSON.stringify([accountKey, storageId, activePage, activePageSize, recentLimit]),
    storageId,
    activePage,
    activePageSize,
    recentLimit,
  };
}

/** SSE 与 JSON 活动接口共用同一组有界请求参数（不传 accountId，账号由服务端派生）。 */
export function libraryProgressQueryString(scope: ResolvedLibraryProgressScope): string {
  const params = new URLSearchParams();
  if (scope.storageId !== null) params.set("storageId", scope.storageId);
  params.set("activePage", String(scope.activePage));
  params.set("activePageSize", String(scope.activePageSize));
  params.set("recentLimit", String(scope.recentLimit));
  return params.toString();
}

function toProgress(value: unknown): ActivityActiveRunSummary["progress"] {
  if (!isRecord(value)) return null;
  if (typeof value.activity !== "string" || typeof value.phase !== "string") return null;
  if (typeof value.updatedAt !== "string" || !isFiniteNumber(value.percent)) return null;
  const obtained = optionalCount(value.obtained);
  const needed = optionalCount(value.needed);
  return {
    activity: value.activity,
    phase: value.phase,
    percent: Math.max(0, Math.min(100, value.percent)),
    updatedAt: value.updatedAt,
    ...(obtained === undefined ? {} : { obtained }),
    ...(needed === undefined ? {} : { needed }),
  };
}

function toActiveRun(value: unknown): ActivityActiveRunSummary | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const type = value.type;
  if (typeof value.runId !== "string" || !value.runId) return null;
  if (typeof kind !== "string" || !WORKFLOW_KINDS.has(kind)) return null;
  if (typeof type !== "string" || !MEDIA_TYPES.has(type)) return null;
  if (!isFiniteNumber(value.tmdbId) || typeof value.title !== "string") return null;
  if (value.status !== "queued" && value.status !== "running") return null;
  if (!Array.isArray(value.seasonNumbers)) return null;
  return {
    runId: value.runId,
    kind: kind as ActivityActiveRunSummary["kind"],
    tmdbId: value.tmdbId,
    title: value.title,
    year: isFiniteNumber(value.year) ? value.year : null,
    type: type as ActivityActiveRunSummary["type"],
    posterPath: typeof value.posterPath === "string" ? value.posterPath : null,
    seasonNumber: isFiniteNumber(value.seasonNumber) ? value.seasonNumber : null,
    seasonNumbers: value.seasonNumbers.filter(isFiniteNumber),
    status: value.status,
    queuePosition: isFiniteNumber(value.queuePosition) ? value.queuePosition : null,
    missingCount: isFiniteNumber(value.missingCount) ? value.missingCount : 0,
    progress: toProgress(value.progress),
  };
}

function toCompletedItem(value: unknown): ActivityCompletedSummary | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (typeof value.workflowRunId !== "string" || !value.workflowRunId) return null;
  if (typeof value.title !== "string" || typeof value.createdAt !== "string") return null;
  if (typeof status !== "string" || !REPORT_STATUSES.has(status)) return null;
  return {
    workflowRunId: value.workflowRunId,
    title: value.title,
    seasonLabel: typeof value.seasonLabel === "string" ? value.seasonLabel : null,
    status: status as ActivityCompletedSummary["status"],
    posterPath: typeof value.posterPath === "string" ? value.posterPath : null,
    sizeText: typeof value.sizeText === "string" ? value.sizeText : null,
    createdAt: value.createdAt,
  };
}

function toCursor(value: unknown): { createdAt: string; id: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.createdAt !== "string" || typeof value.id !== "string") return null;
  return { createdAt: value.createdAt, id: value.id };
}

/**
 * 校验并收窄后端返回的有界活动页。结构不合法时返回 null（调用方按失败处理，
 * 不把半成品塞进 UI）。
 */
export function parseLibraryActivityPage(value: unknown): PostgresActivityPage | null {
  if (!isRecord(value)) return null;
  const active = value.active;
  const totals = value.totals;
  const recent = value.recentCompleted;
  if (!isRecord(active) || !isRecord(totals) || !isRecord(recent)) return null;
  if (!Array.isArray(active.items) || !Array.isArray(recent.items)) return null;
  if (
    !isFiniteNumber(active.total) ||
    !isFiniteNumber(active.page) ||
    !isFiniteNumber(active.pageSize) ||
    typeof active.hasMore !== "boolean" ||
    typeof recent.hasMore !== "boolean"
  ) {
    return null;
  }
  if (!isFiniteNumber(totals.queued) || !isFiniteNumber(totals.running) || !isFiniteNumber(totals.active)) {
    return null;
  }
  const activeItems: ActivityActiveRunSummary[] = [];
  for (const item of active.items) {
    const run = toActiveRun(item);
    if (!run) return null;
    activeItems.push(run);
  }
  // 历史条目只用于「本次浏览的已完成」展示：单条坏数据只丢那一行，
  // 不能因此把整页进度（包括正在跑的任务）判成无效。
  const completedItems: ActivityCompletedSummary[] = [];
  for (const item of recent.items) {
    const completed = toCompletedItem(item);
    if (completed) completedItems.push(completed);
  }
  return {
    active: {
      items: activeItems,
      total: active.total,
      page: active.page,
      pageSize: active.pageSize,
      hasMore: active.hasMore,
    },
    totals: { queued: totals.queued, running: totals.running, active: totals.active },
    recentCompleted: {
      items: completedItems,
      nextCursor: toCursor(recent.nextCursor),
      hasMore: recent.hasMore,
    },
  };
}

/** 解析 SSE `event: snapshot` 的 data（`{version:1, observedAt, page}`）。 */
export function parseLibraryProgressSnapshot(data: unknown): LibraryProgressSnapshot | null {
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload) as unknown;
    } catch {
      return null;
    }
  }
  if (!isRecord(payload)) return null;
  if (payload.version !== 1) return null;
  const observedAt = payload.observedAt;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) return null;
  const page = parseLibraryActivityPage(payload.page);
  return page ? { page, observedAt } : null;
}

/** 旧 `ActivityView` 形状的适配：卡片/活动页继续消费原字段，不做二次猜测。 */
export interface LibraryActivityView {
  active: ActivityActiveRunSummary[];
  recentCompleted: ActivityCompletedSummary[];
}

export function activityViewFromPage(page: PostgresActivityPage): LibraryActivityView {
  return { active: page.active.items, recentCompleted: page.recentCompleted.items };
}

export interface ActiveRunLookup {
  tmdbId: number;
  /**
   * 媒体身份是 (媒体类型, TMDB ID)：给了类型就必须一致。
   * 没给类型时，同号但类型冲突（movie/tv/anime）一律视为不可判定 ——
   * 宁可这条进度不显示，也不能把另一部作品的进度显示到这张卡上。
   */
  mediaType?: LibraryProgressMediaType | null;
  /** null/undefined = 该作品任意季（电影、全季请求）；数字 = 指定季。 */
  seasonNumber?: number | null;
}

/** 卡片视角的匹配：优先 running，其次 queued。 */
export function findActiveRunForMedia(
  active: readonly ActivityActiveRunSummary[],
  lookup: ActiveRunLookup,
): ActivityActiveRunSummary | null {
  const mediaType = lookup.mediaType ?? null;
  const seasonNumber = lookup.seasonNumber ?? null;
  const candidates = active.filter(
    (run) =>
      run.tmdbId === lookup.tmdbId &&
      (seasonNumber === null || run.seasonNumber === seasonNumber),
  );
  let matches: readonly ActivityActiveRunSummary[];
  if (mediaType !== null) {
    matches = candidates.filter((run) => run.type === mediaType);
  } else if (new Set(candidates.map((run) => run.type)).size > 1) {
    // 类型未知且同号对象冲突：不猜。
    return null;
  } else {
    matches = candidates;
  }
  return matches.find((run) => run.status === "running") ?? matches[0] ?? null;
}

/** 活跃任务总数；`null` = 还没拿到快照（不要当成 0 去渲染空态/触发刷新）。 */
export function activeTotalOf(state: LibraryProgressState): number | null {
  return state.page ? state.page.totals.active : null;
}

type Listener = (state: LibraryProgressState) => void;

interface Channel {
  readonly scope: ResolvedLibraryProgressScope;
  state: LibraryProgressState;
  readonly listeners: Set<Listener>;
  handle: LibraryProgressStreamHandle | null;
  /** 连接代次：每次重连/降级都 +1，旧连接的迟到回调据此丢弃。 */
  connection: number;
  /** 已应用快照序号：在途读取发起时的序号不一致 → 旧响应。 */
  seq: number;
  closed: boolean;
  denied: boolean;
  loadInFlight: boolean;
  pollTimer: LibraryProgressTimer | null;
  retryTimer: LibraryProgressTimer | null;
  silenceTimer: LibraryProgressTimer | null;
}

export interface LibraryProgressRegistryOptions {
  runtime: LibraryProgressRuntime;
  pollIntervalMs?: number;
  reconnectDelayMs?: number;
  streamSilenceTimeoutMs?: number;
}

export interface LibraryProgressRegistry {
  subscribe(scope: LibraryProgressScope, listener: Listener): () => void;
  getState(scope: LibraryProgressScope): LibraryProgressState;
  /** 立刻重读一次（用户取消/重试之后调用），不改变 stream/poll 状态机。 */
  refresh(scope: LibraryProgressScope): void;
  /** 丢弃全部快照并重开连接，订阅者保留（账号代次/bfcache 恢复用）。 */
  invalidateAll(): void;
  /** 彻底销毁全部订阅（登出等硬切换用）。 */
  reset(): void;
  activeChannelCount(): number;
}

function idleState(scope: ResolvedLibraryProgressScope, generation: number): LibraryProgressState {
  return Object.freeze({
    key: scope.key,
    storageId: scope.storageId,
    generation,
    status: "idle" as const,
    page: null,
    observedAt: null,
    source: null,
  });
}

export function createLibraryProgressRegistry(options: LibraryProgressRegistryOptions): LibraryProgressRegistry {
  const { runtime } = options;
  const pollIntervalMs = boundedInt(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  const reconnectDelayMs = boundedInt(
    options.reconnectDelayMs,
    DEFAULT_RECONNECT_DELAY_MS,
    MIN_RECONNECT_DELAY_MS,
    MAX_RECONNECT_DELAY_MS,
  );
  const silenceTimeoutMs = boundedInt(
    options.streamSilenceTimeoutMs,
    DEFAULT_STREAM_SILENCE_MS,
    MIN_STREAM_SILENCE_MS,
    MAX_STREAM_SILENCE_MS,
  );

  const channels = new Map<string, Channel>();
  const idleStates = new Map<string, LibraryProgressState>();
  let generation = 0;

  function idleFor(scope: ResolvedLibraryProgressScope): LibraryProgressState {
    const idleKey = JSON.stringify([generation, scope.key]);
    const existing = idleStates.get(idleKey);
    if (existing) return existing;
    const created = idleState(scope, generation);
    idleStates.set(idleKey, created);
    return created;
  }

  function notify(channel: Channel): void {
    for (const listener of [...channel.listeners]) {
      try {
        listener(channel.state);
      } catch {
        // 单个消费者渲染出错不能拖垮共享订阅。
      }
    }
  }

  function setState(channel: Channel, patch: Partial<LibraryProgressState>): void {
    const next: LibraryProgressState = { ...channel.state, ...patch };
    if (
      next.status === channel.state.status &&
      next.generation === channel.state.generation &&
      next.page === channel.state.page &&
      next.observedAt === channel.state.observedAt &&
      next.source === channel.state.source
    ) {
      return;
    }
    channel.state = next;
    notify(channel);
  }

  function isCurrent(channel: Channel, connection: number): boolean {
    return !channel.closed && !channel.denied && channel.connection === connection;
  }

  function closeStream(channel: Channel): void {
    const handle = channel.handle;
    channel.handle = null;
    if (!handle) return;
    try {
      handle.close();
    } catch {
      // 关闭失败不影响后续重连。
    }
  }

  function clearTimer(channel: Channel, which: "poll" | "retry" | "silence"): void {
    if (which === "poll") {
      const handle = channel.pollTimer;
      channel.pollTimer = null;
      if (handle !== null) runtime.clearTimeout(handle);
      return;
    }
    if (which === "retry") {
      const handle = channel.retryTimer;
      channel.retryTimer = null;
      if (handle !== null) runtime.clearTimeout(handle);
      return;
    }
    const handle = channel.silenceTimer;
    channel.silenceTimer = null;
    if (handle !== null) runtime.clearTimeout(handle);
  }

  function clearTimers(channel: Channel): void {
    clearTimer(channel, "poll");
    clearTimer(channel, "retry");
    clearTimer(channel, "silence");
  }

  function applyStreamSnapshot(channel: Channel, snapshot: LibraryProgressSnapshot): void {
    channel.seq += 1;
    clearTimer(channel, "poll");
    clearTimer(channel, "retry");
    setState(channel, {
      status: "live",
      page: snapshot.page,
      observedAt: snapshot.observedAt,
      source: "stream",
    });
  }

  function applyLoadedPage(channel: Channel, page: PostgresActivityPage): void {
    channel.seq += 1;
    setState(channel, {
      status: channel.state.status === "live" ? "live" : "polling",
      page,
      observedAt: new Date(runtime.now()).toISOString(),
      source: "poll",
    });
  }

  function deny(channel: Channel): void {
    if (channel.closed || channel.denied) return;
    channel.denied = true;
    channel.connection += 1;
    channel.loadInFlight = false;
    closeStream(channel);
    clearTimers(channel);
    setState(channel, { status: "denied", page: null, observedAt: null, source: null });
  }

  function scheduleReconnect(channel: Channel): void {
    if (channel.closed || channel.denied || channel.retryTimer !== null) return;
    channel.retryTimer = runtime.setTimeout(() => {
      channel.retryTimer = null;
      connect(channel);
    }, reconnectDelayMs);
  }

  function schedulePoll(channel: Channel, delayMs: number): void {
    if (channel.closed || channel.denied) return;
    if (channel.state.status !== "polling") return;
    if (channel.pollTimer !== null) return;
    channel.pollTimer = runtime.setTimeout(() => {
      channel.pollTimer = null;
      runLoad(channel, "poll");
    }, delayMs);
  }

  function runLoad(channel: Channel, origin: "poll" | "manual"): void {
    if (channel.closed || channel.denied || channel.loadInFlight) return;
    channel.loadInFlight = true;
    const connection = channel.connection;
    const seq = channel.seq;
    void runtime.loadPage(channel.scope).then(
      (page) => {
        channel.loadInFlight = false;
        // 旧连接或旧响应（期间有新快照落地）一律丢弃，绝不回退已显示的进度。
        if (!isCurrent(channel, connection) || channel.seq !== seq) return;
        applyLoadedPage(channel, page);
      },
      (error: unknown) => {
        channel.loadInFlight = false;
        if (!isCurrent(channel, connection)) return;
        if (error instanceof LibraryProgressDeniedError) {
          deny(channel);
          return;
        }
        // 瞬时失败：保留上一份快照，下一拍再试。
      },
    ).finally(() => {
      if (origin === "poll") schedulePoll(channel, pollIntervalMs);
    });
  }

  function armSilenceWatchdog(channel: Channel, connection: number): void {
    clearTimer(channel, "silence");
    channel.silenceTimer = runtime.setTimeout(() => {
      channel.silenceTimer = null;
      if (!isCurrent(channel, connection)) return;
      // 服务端每 5 秒发一次周期快照；超过阈值仍无任何事件 → 当作假连接处理。
      degrade(channel);
    }, silenceTimeoutMs);
  }

  function degrade(channel: Channel): void {
    if (channel.closed || channel.denied) return;
    channel.connection += 1;
    channel.loadInFlight = false;
    closeStream(channel);
    clearTimers(channel);
    setState(channel, { status: "polling" });
    // 断线先重读一次（立即），随后统一低频轮询；同时后台尝试恢复 SSE。
    schedulePoll(channel, 0);
    scheduleReconnect(channel);
  }

  function connect(channel: Channel): void {
    if (channel.closed || channel.denied) return;
    const connection = channel.connection + 1;
    channel.connection = connection;
    closeStream(channel);
    clearTimer(channel, "silence");
    if (channel.state.page === null && channel.state.status !== "polling") {
      setState(channel, { status: "connecting" });
    }
    let handle: LibraryProgressStreamHandle | null = null;
    try {
      handle = runtime.openStream(channel.scope, {
        onOpen: () => {
          if (!isCurrent(channel, connection)) return;
          setState(channel, { status: "live" });
          armSilenceWatchdog(channel, connection);
        },
        onSnapshot: (snapshot) => {
          if (!isCurrent(channel, connection)) return;
          applyStreamSnapshot(channel, snapshot);
          armSilenceWatchdog(channel, connection);
        },
        onError: () => {
          if (!isCurrent(channel, connection)) return;
          degrade(channel);
        },
      });
    } catch {
      handle = null;
    }
    if (!isCurrent(channel, connection)) {
      try {
        handle?.close();
      } catch {
        // 已被新的连接取代。
      }
      return;
    }
    channel.handle = handle;
    armSilenceWatchdog(channel, connection);
    if (handle === null) degrade(channel);
  }

  function createChannel(scope: ResolvedLibraryProgressScope): Channel {
    return {
      scope,
      state: idleFor(scope),
      listeners: new Set<Listener>(),
      handle: null,
      connection: 0,
      seq: 0,
      closed: false,
      denied: false,
      loadInFlight: false,
      pollTimer: null,
      retryTimer: null,
      silenceTimer: null,
    };
  }

  function destroy(channel: Channel): void {
    if (channel.closed) return;
    channel.closed = true;
    channel.connection += 1;
    channel.loadInFlight = false;
    closeStream(channel);
    clearTimers(channel);
    channel.listeners.clear();
    channels.delete(channel.scope.key);
  }

  function channelFor(scope: LibraryProgressScope): { resolved: ResolvedLibraryProgressScope; channel: Channel | null } {
    const resolved = resolveLibraryProgressScope(scope);
    return { resolved, channel: channels.get(resolved.key) ?? null };
  }

  return {
    subscribe(scope, listener) {
      const { resolved, channel: existing } = channelFor(scope);
      let channel = existing;
      const created = channel === null;
      if (channel === null) {
        channel = createChannel(resolved);
        channels.set(resolved.key, channel);
      }
      channel.listeners.add(listener);
      if (created) {
        connect(channel);
      } else {
        try {
          listener(channel.state);
        } catch {
          // 同上：单个消费者出错不影响共享订阅。
        }
      }
      const key = resolved.key;
      return () => {
        const current = channels.get(key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0) destroy(current);
      };
    },
    getState(scope) {
      const { resolved } = channelFor(scope);
      const channel = channels.get(resolved.key);
      return channel ? channel.state : idleFor(resolved);
    },
    refresh(scope) {
      const channel = channels.get(resolveLibraryProgressScope(scope).key);
      if (!channel || channel.closed || channel.denied) return;
      runLoad(channel, "manual");
    },
    invalidateAll() {
      generation += 1;
      idleStates.clear();
      for (const channel of [...channels.values()]) {
        if (channel.closed) continue;
        channel.connection += 1;
        channel.loadInFlight = false;
        channel.denied = false;
        closeStream(channel);
        clearTimers(channel);
        setState(channel, {
          generation,
          status: "connecting",
          page: null,
          observedAt: null,
          source: null,
        });
        connect(channel);
      }
    },
    reset() {
      generation += 1;
      idleStates.clear();
      for (const channel of [...channels.values()]) destroy(channel);
    },
    activeChannelCount() {
      return channels.size;
    },
  };
}

function createBrowserRuntime(): LibraryProgressRuntime {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) => clearTimeout(handle),
    openStream(scope, handlers) {
      if (typeof EventSource !== "function") throw new Error("EventSource 不可用");
      const source = new EventSource(`/api/library/progress?${libraryProgressQueryString(scope)}`);
      let closed = false;
      source.addEventListener("open", () => {
        if (!closed) handlers.onOpen();
      });
      source.addEventListener("snapshot", (event: Event) => {
        if (closed) return;
        const data = (event as MessageEvent<unknown>).data;
        const snapshot = parseLibraryProgressSnapshot(data);
        if (snapshot) handlers.onSnapshot(snapshot);
      });
      source.addEventListener("error", () => {
        if (!closed) handlers.onError();
      });
      return {
        close() {
          closed = true;
          source.close();
        },
      };
    },
    loadPage: (scope) => loadLibraryActivityPage(scope, scope.activePage),
  };
}

/**
 * 有界读取活动摘要的一页（与 SSE 相同的 scope 参数与 DTO）。
 * 后备轮询用它；活动页的「加载更多」也用它按需补读第 2..N 页，
 * 不会退回全量 `/api/activity`。
 */
export async function loadLibraryActivityPage(
  scope: ResolvedLibraryProgressScope,
  page: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PostgresActivityPage> {
  const params = new URLSearchParams(
    libraryProgressQueryString({ ...scope, activePage: boundedInt(page, 1, 1, MAX_ACTIVE_PAGE) }),
  );
  const response = await fetchImpl(`/api/library/activity?${params.toString()}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new LibraryProgressDeniedError();
  }
  if (!response.ok) throw new Error(`获取进度读取失败（${response.status}）。`);
  const parsed = parseLibraryActivityPage((await response.json()) as unknown);
  if (!parsed) throw new Error("获取进度响应格式无效。");
  return parsed;
}

let defaultRegistry: LibraryProgressRegistry | null = null;
let pageGuardInstalled = false;

function installPageGuard(): void {
  if (pageGuardInstalled || typeof window === "undefined") return;
  pageGuardInstalled = true;
  window.addEventListener("pageshow", (event: PageTransitionEvent) => {
    // bfcache 恢复：离开期间 cookie 可能已换账号，旧 SSE 连接与快照都不可信。
    if (!event.persisted) return;
    defaultRegistry?.invalidateAll();
  });
}

/** 惰性单例：导入本模块不建连、不注册计时器。 */
export function getLibraryProgressRegistry(): LibraryProgressRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createLibraryProgressRegistry({ runtime: createBrowserRuntime() });
    installPageGuard();
  }
  return defaultRegistry;
}

export function subscribeLibraryProgress(scope: LibraryProgressScope, listener: Listener): () => void {
  return getLibraryProgressRegistry().subscribe(scope, listener);
}

export function getLibraryProgressState(scope: LibraryProgressScope): LibraryProgressState {
  return getLibraryProgressRegistry().getState(scope);
}

/** 用户主动取消/重试后立即重读该 scope（不必等下一个快照）。 */
export function refreshLibraryProgress(scope: LibraryProgressScope): void {
  getLibraryProgressRegistry().refresh(scope);
}

/** 账号代次变化（登录/退出/代次切换）时丢弃快照并重开连接，订阅者保留。 */
export function refreshLibraryProgressSubscriptions(): void {
  getLibraryProgressRegistry().invalidateAll();
}

/** 硬切换：销毁全部共享订阅。 */
export function resetLibraryProgressSubscriptions(): void {
  getLibraryProgressRegistry().reset();
}

export function activeLibraryProgressChannelCount(): number {
  return getLibraryProgressRegistry().activeChannelCount();
}
