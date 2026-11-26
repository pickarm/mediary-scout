// Interaction harness for LibraryPagedWall. The suite runs DOM-less, so React
// hooks are faked with per-slot storage: each component call is a render, and
// effects are flushed explicitly so the test can interleave 250ms debounces,
// scope switches and out-of-order API responses exactly like the browser can.
// This mirrors library-quick-find.test.ts / use-router.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

type EffectRecord = { deps: readonly unknown[] | undefined; cleanup?: () => void };
type MemoRecord = { deps: readonly unknown[] | undefined; value: unknown };

const rt = vi.hoisted(() => ({
  values: [] as unknown[],
  has: [] as boolean[],
  effects: [] as EffectRecord[],
  memos: [] as MemoRecord[],
  refs: [] as Array<{ current: unknown }>,
  slot: 0,
  pendingRender: false,
  pendingEffects: [] as Array<{ index: number; run: () => void | (() => void); cleanup?: () => void }>,
  progressPage: null as unknown,
}));
const nav = vi.hoisted(() => ({ push: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock("./library-progress-provider", () => ({
  useLibraryProgress: () => ({ page: rt.progressPage, status: rt.progressPage ? "live" : "idle" }),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  type Setter<T> = (next: T | ((previous: T) => T)) => void;
  function changed(previous: readonly unknown[] | undefined, deps: readonly unknown[] | undefined): boolean {
    return previous === undefined || deps === undefined || previous.length !== deps.length
      || deps.some((value, index) => !Object.is(value, previous[index]));
  }
  return {
    ...actual,
    useState<T>(initial: T | (() => T)): [T, Setter<T>] {
      const index = rt.slot++;
      if (!rt.has[index]) {
        rt.values[index] = typeof initial === "function" ? (initial as () => T)() : initial;
        rt.has[index] = true;
      }
      const set: Setter<T> = (next) => {
        const value = typeof next === "function" ? (next as (previous: T) => T)(rt.values[index] as T) : next;
        if (Object.is(rt.values[index], value)) return;
        rt.values[index] = value;
        rt.pendingRender = true;
      };
      return [rt.values[index] as T, set];
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]): void {
      const index = rt.slot++;
      const previous = rt.effects[index];
      if (!changed(previous?.deps, deps)) return;
      rt.effects[index] = { deps };
      rt.pendingEffects.push({ index, run, ...(previous?.cleanup ? { cleanup: previous.cleanup } : {}) });
    },
    useMemo<T>(factory: () => T, deps?: readonly unknown[]): T {
      const index = rt.slot++;
      const previous = rt.memos[index];
      if (previous !== undefined && !changed(previous.deps, deps)) return previous.value as T;
      const value = factory();
      rt.memos[index] = { deps, value };
      return value;
    },
    useRef<T>(initial: T): { current: T } {
      const index = rt.slot++;
      if (!rt.refs[index]) rt.refs[index] = { current: initial };
      return rt.refs[index] as { current: T };
    },
  };
});

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PostgresActivityPage } from "@media-track/workflow/activity-query";
import type { LibraryQueryItem, LibraryQueryPage } from "@media-track/workflow/library-query";
import { LibraryPagedWall, type LibraryCategoryPreview } from "./library-paged-wall";

type Props = Parameters<typeof LibraryPagedWall>[0];

type PendingRequest = {
  url: URL;
  resolve: (page: LibraryQueryPage) => void;
  reject: (reason: Error) => void;
  done: boolean;
};

const requests: PendingRequest[] = [];
const timers = new Map<number, { run: () => void; delay: number }>();
let timerId = 0;
let currentProps: Props;
let currentTree: ReactElement;

function item(over: Partial<LibraryQueryItem> & { tmdbId: number; title: string }): LibraryQueryItem {
  return {
    type: "movie", year: 2025, posterPath: null, releaseDate: null, seasonCount: 0,
    obtainedEpisodes: 1, totalAiredEpisodes: 1, totalEpisodes: 1, state: "complete",
    airing: false, acquiring: false, autoAcquire: null, ...over,
  };
}

function page(items: LibraryQueryItem[], total = items.length, pageSize = 48): LibraryQueryPage {
  return { items, total, page: 1, pageSize, hasMore: total > items.length };
}

function activePage(identities: Array<{ runId: string; type: "movie" | "tv" | "anime"; tmdbId: number; title: string }>): PostgresActivityPage {
  return {
    active: {
      items: identities.map((identity) => ({
        ...identity,
        kind: identity.type === "movie" ? "movie_init" : "type2_init",
        year: 2025,
        posterPath: null,
        seasonNumber: identity.type === "movie" ? null : 1,
        seasonNumbers: identity.type === "movie" ? [] : [1],
        status: "running",
        queuePosition: null,
        missingCount: 0,
        progress: null,
      })),
      total: identities.length,
      page: 1,
      pageSize: 48,
      hasMore: false,
    },
    totals: { queued: 0, running: identities.length, active: identities.length },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

function runEffects(): void {
  while (rt.pendingEffects.length > 0) {
    const pending = rt.pendingEffects.shift()!;
    pending.cleanup?.();
    const cleanup = pending.run();
    if (typeof cleanup === "function") rt.effects[pending.index]!.cleanup = cleanup;
  }
}

/** Render the component and flush its effects, like React after a commit. */
function render(props: Props): void {
  currentProps = props;
  for (let guard = 0; guard < 30; guard += 1) {
    rt.pendingRender = false;
    rt.slot = 0;
    currentTree = LibraryPagedWall(props);
    runEffects();
    if (!rt.pendingRender) return;
  }
  throw new Error("render loop did not settle");
}

/** Let Response body decoding and the fetch continuation run, then re-render. */
async function flush(turns = 3): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  render(currentProps);
}

function find(node: ReactNode, match: (element: ReactElement) => boolean): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (match(element)) return element;
  return find(element.props.children, match);
}

function input(): ReactElement<{ value: string; onChange: (event: { target: { value: string } }) => void; onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }) => void }> {
  const element = find(currentTree, (candidate) => candidate.type === "input");
  expect(element, "search input").not.toBeNull();
  return element as ReactElement<{ value: string; onChange: (event: { target: { value: string } }) => void; onKeyDown: (event: { key: string; nativeEvent: { isComposing: boolean; keyCode: number } }) => void }>;
}

function typeQuery(value: string): void {
  input().props.onChange({ target: { value } });
  render(currentProps);
}

function pressKey(key: string, isComposing = false): void {
  input().props.onKeyDown({ key, nativeEvent: { isComposing, keyCode: isComposing ? 229 : 13 } });
  render(currentProps);
}

/** Fire the single pending 250ms debounce and assert its delay. */
function advanceSearch(): void {
  const entries = [...timers.entries()];
  expect(entries).toHaveLength(1);
  const [id, timer] = entries[0]!;
  expect(timer.delay).toBe(250);
  timers.delete(id);
  timer.run();
  render(currentProps);
}

function pending(predicate: (url: URL) => boolean): PendingRequest[] {
  return requests.filter((request) => !request.done && predicate(request.url));
}

async function respond(request: PendingRequest, body: LibraryQueryPage): Promise<void> {
  request.done = true;
  request.resolve(body);
  await flush();
}

async function fail(request: PendingRequest, message = "媒体库暂时无法加载。"): Promise<void> {
  request.done = true;
  request.reject(new Error(message));
  await flush();
}

function html(): string {
  return renderToStaticMarkup(currentTree);
}

beforeEach(() => {
  for (const effect of rt.effects) effect?.cleanup?.();
  rt.values = [];
  rt.has = [];
  rt.effects = [];
  rt.memos = [];
  rt.refs = [];
  rt.slot = 0;
  rt.pendingRender = false;
  rt.pendingEffects = [];
  rt.progressPage = null;
  requests.length = 0;
  timers.clear();
  timerId = 0;
  nav.push.mockClear();
  vi.stubGlobal("window", {
    setTimeout: (run: () => void, delay?: number) => {
      timerId += 1;
      timers.set(timerId, { run, delay: delay ?? 0 });
      return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  vi.stubGlobal("fetch", vi.fn((inputValue: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
    requests.push({
      url: new URL(String(inputValue), "http://127.0.0.1:4326"),
      resolve: (body) => resolve(Response.json(body)),
      reject,
      done: false,
    });
    // The component aborts superseded requests; these tests deliberately keep
    // the transport alive so a late success still arrives and must be ignored.
    void init?.signal;
  })));
});

describe("LibraryPagedWall queries", () => {
  const previews: LibraryCategoryPreview[] = [
    { type: "movie", page: page([item({ tmdbId: 1, title: "初始电影" })], 1) },
    { type: "tv", page: page([], 0) },
    { type: "anime", page: page([], 0) },
  ];

  it("debounces search 250ms and drops a late response for the previous query", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    expect(html()).toContain("初始电影");
    const initialRequest = pending((url) => !url.searchParams.has("search"))[0]!;
    await respond(initialRequest, page([item({ tmdbId: 1, title: "初始电影" })], 1));
    const callsBeforeTyping = requests.length;

    typeQuery("新");
    // Nothing is requested until the debounce elapses; the old wall is hidden.
    expect(requests).toHaveLength(callsBeforeTyping);
    expect(html()).not.toContain("初始电影");
    expect(html()).toContain("正在查找…");

    advanceSearch();
    const first = pending((url) => url.searchParams.get("search") === "新")[0]!;
    expect(first.url.searchParams.get("type")).toBe("movie");

    typeQuery("新片");
    advanceSearch();
    const second = pending((url) => url.searchParams.get("search") === "新片")[0]!;

    await respond(second, page([item({ tmdbId: 22, title: "新片结果" })], 1));
    await respond(first, page([item({ tmdbId: 11, title: "旧查询结果" })], 1));

    expect(html()).toContain("新片结果");
    expect(html()).not.toContain("旧查询结果");
    expect(html()).toContain("匹配 1 部");
  });

  it("Enter navigates only the settled, uniquely matching current result", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    const initialRequest = pending(() => true)[0]!;
    await respond(initialRequest, page([item({ tmdbId: 1, title: "初始电影" })], 1));

    typeQuery("alpha");
    advanceSearch();
    const alpha = pending((url) => url.searchParams.get("search") === "alpha")[0]!;
    await respond(alpha, page([item({ tmdbId: 101, title: "Alpha" })], 1));
    expect(html()).toContain("Alpha");
    pressKey("Enter");
    expect(nav.push).toHaveBeenCalledWith("/show/101?from=library&t=movie");

    nav.push.mockClear();
    typeQuery("beta");
    // The old Alpha result is hidden and Enter cannot jump to it.
    pressKey("Enter");
    expect(nav.push).not.toHaveBeenCalled();
    expect(html()).not.toContain("Alpha");

    advanceSearch();
    const beta = pending((url) => url.searchParams.get("search") === "beta")[0]!;
    pressKey("Enter");
    expect(nav.push).not.toHaveBeenCalled();

    await respond(beta, page([item({ tmdbId: 201, title: "Beta One" }), item({ tmdbId: 202, title: "Beta Two" })], 2));
    pressKey("Enter");
    expect(nav.push).not.toHaveBeenCalled();

    typeQuery("gamma");
    advanceSearch();
    const gamma = pending((url) => url.searchParams.get("search") === "gamma")[0]!;
    await respond(gamma, page([item({ tmdbId: 301, title: "Gamma" })], 1));
    pressKey("Enter");
    expect(nav.push).toHaveBeenCalledWith("/show/301?from=library&t=movie");

    nav.push.mockClear();
    pressKey("Enter", true);
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("resets paging on a scope switch and ignores late old pages", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    const first = pending(() => true)[0]!;
    await respond(first, page([item({ tmdbId: 1, title: "第一页" })], 120, 24));
    expect(html()).toContain("第 1 / 5 页");

    const nextButton = find(currentTree, (element) => element.type === "button" && (element.props as { children?: ReactNode }).children === "下一页");
    expect(nextButton).not.toBeNull();
    (nextButton!.props as { onClick: () => void }).onClick();
    render(currentProps);
    const pageTwo = pending((url) => url.searchParams.get("page") === "2")[0]!;
    expect(html()).not.toContain("第一页");

    // Parent navigation changes the filter while page 2 is still in flight.
    render({ previews, mediaType: "movie", filter: "complete" });
    const fresh = pending((url) => url.searchParams.get("state") === "complete")[0]!;
    expect(fresh.url.searchParams.get("page")).toBe("1");

    await respond(fresh, page([item({ tmdbId: 3, title: "完结新页" })], 60, 48));
    await respond(pageTwo, page([item({ tmdbId: 2, title: "迟到的第二页" })], 120, 24));
    expect(html()).toContain("完结新页");
    expect(html()).not.toContain("迟到的第二页");
    expect(html()).toContain("第 1 / 2 页");
  });

  it("starts a fresh page for a category or storage switch and drops both late scopes", async () => {
    render({ previews, mediaType: "movie", filter: "all", storageId: "drive-a" });
    await respond(pending(() => true)[0]!, page([item({ tmdbId: 1, title: "A 电影" })], 1));

    typeQuery("共");
    advanceSearch();
    await respond(pending((url) => url.searchParams.get("search") === "共")[0]!, page([item({ tmdbId: 2, title: "A 结果一" })], 100, 24));
    const nextButton = find(currentTree, (element) => element.type === "button" && (element.props as { children?: ReactNode }).children === "下一页");
    expect(nextButton).not.toBeNull();
    (nextButton!.props as { onClick: () => void }).onClick();
    render(currentProps);
    const oldPage = pending((url) => url.searchParams.get("page") === "2")[0]!;
    expect(oldPage.url.searchParams.get("storageId")).toBe("drive-a");
    expect(oldPage.url.searchParams.get("search")).toBe("共");

    const tvPreviews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([], 0) },
      { type: "tv", page: page([], 0) },
      { type: "anime", page: page([], 0) },
    ];
    render({ previews: tvPreviews, mediaType: "tv", filter: "all", storageId: "drive-a" });
    const tvRequest = pending((url) => url.searchParams.get("type") === "tv")[0]!;
    expect(tvRequest.url.searchParams.get("page")).toBe("1");

    await respond(tvRequest, page([item({ tmdbId: 3, type: "tv", title: "B 剧集" })], 1));
    await respond(oldPage, page([item({ tmdbId: 2, title: "迟到的 A 第二页" })], 100, 24));
    expect(html()).toContain("B 剧集");
    expect(html()).not.toContain("迟到的 A 第二页");
    expect(html()).not.toContain("A 结果一");

    render({ previews: tvPreviews, mediaType: "tv", filter: "all", storageId: "drive-b" });
    const storageRequest = pending((url) => url.searchParams.get("storageId") === "drive-b")[0]!;
    expect(storageRequest.url.searchParams.get("page")).toBe("1");
    await respond(storageRequest, page([item({ tmdbId: 4, type: "tv", title: "C 剧集" })], 1));
    expect(html()).toContain("C 剧集");
    expect(html()).not.toContain("B 剧集");
  });

  it("keeps storage-scoped links and the original category previews", () => {
    const home: LibraryCategoryPreview[] = [
      { type: "movie", page: page([item({ tmdbId: 7, title: "电影七" })], 80) },
      { type: "tv", page: page([item({ tmdbId: 7, type: "tv", title: "剧集七", seasonCount: 2, obtainedEpisodes: 3, totalAiredEpisodes: 4, totalEpisodes: 6, state: "partial", airing: true })], 91) },
      { type: "anime", page: page([], 0) },
    ];
    render({ previews: home, mediaType: null, filter: "all", storageId: "drive-a" });
    const markup = html();
    expect(markup).toContain("电影 80");
    expect(markup).toContain("电视剧 91");
    expect(markup).toContain("/w/drive-a?tab=library&amp;type=movie&amp;filter=all");
    expect(markup).toContain("/show/7?from=library&amp;w=drive-a&amp;t=movie");
    expect(markup).toContain("/show/7?from=library&amp;w=drive-a&amp;t=tv");
    expect(markup).toContain("有缺集");
    expect(markup).toContain("追更中");
  });

  it("hides a failed query's error after a scope switch and retries only the current scope", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    await respond(pending(() => true)[0]!, page([item({ tmdbId: 1, title: "初始电影" })], 1));

    typeQuery("broken");
    advanceSearch();
    await fail(pending((url) => url.searchParams.get("search") === "broken")[0]!, "查找失败");
    expect(html()).toContain("查找失败");

    typeQuery("fine");
    expect(html()).not.toContain("查找失败");
    advanceSearch();
    await respond(pending((url) => url.searchParams.get("search") === "fine")[0]!, page([item({ tmdbId: 5, title: "正常结果" })], 1));
    expect(html()).toContain("正常结果");
    expect(html()).not.toContain("查找失败");
  });

  it("adopts a refreshed server preview only while the preview itself is shown", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    await respond(pending(() => true)[0]!, page([item({ tmdbId: 1, title: "初始电影" })], 1));

    typeQuery("refresh");
    advanceSearch();
    await respond(pending((url) => url.searchParams.get("search") === "refresh")[0]!, page([item({ tmdbId: 8, title: "搜索结果仍在" })], 1));
    expect(html()).toContain("搜索结果仍在");

    // A server refresh (e.g. the acquisition poller) must not clear a search.
    const refreshed: LibraryCategoryPreview[] = [
      { type: "movie", page: page([item({ tmdbId: 9, title: "刷新后的预览" })], 10, 5) },
      { type: "tv", page: page([], 0) },
      { type: "anime", page: page([], 0) },
    ];
    render({ previews: refreshed, mediaType: "movie", filter: "all" });
    expect(html()).toContain("搜索结果仍在");
    expect(html()).not.toContain("刷新后的预览");

    pressKey("Escape");
    expect(html()).toContain("刷新后的预览");
    expect(html()).not.toContain("搜索结果仍在");
    expect(html()).toContain("第 1 / 2 页");
  });

  it("keeps a usable server preview when its page-1 refresh fails", async () => {
    render({ previews, mediaType: "movie", filter: "all" });
    await fail(pending(() => true)[0]!);
    expect(html()).toContain("初始电影");
    expect(html()).not.toContain("媒体库暂时无法加载。");
  });

  it("shows active identities once and removes them from normal previews and search cards", async () => {
    rt.progressPage = activePage([{ runId: "active-movie", type: "movie", tmdbId: 1, title: "ACTIVE_MOVIE" }]);
    const activePreviews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([item({ tmdbId: 1, title: "ACTIVE_MOVIE" }), item({ tmdbId: 2, title: "NORMAL_MOVIE" })], 2) },
      { type: "tv", page: page([item({ tmdbId: 1, type: "tv", title: "NORMAL_TV_SAME_ID", seasonCount: 1 })], 1) },
      { type: "anime", page: page([], 0) },
    ];
    render({ previews: activePreviews, mediaType: null, filter: "all" });
    expect((html().match(/ACTIVE_MOVIE/gu) ?? [])).toHaveLength(1);
    expect(html()).toContain("NORMAL_MOVIE");
    expect(html()).toContain("NORMAL_TV_SAME_ID");
    expect(html()).toContain("获取中 1");

    typeQuery("active");
    advanceSearch();
    await respond(pending((url) => url.searchParams.get("search") === "active")[0]!, page([
      item({ tmdbId: 1, title: "ACTIVE_MOVIE" }),
      item({ tmdbId: 1, type: "tv", title: "NORMAL_TV_SAME_ID", seasonCount: 1 }),
    ], 2));
    expect((html().match(/ACTIVE_MOVIE/gu) ?? [])).toHaveLength(1);
    expect(html()).toContain("NORMAL_TV_SAME_ID");
    expect(html()).toContain("匹配 2 部");
    expect(html()).not.toContain("这个分类还没有作品");
  });

  it("does not Enter a search result that the newer shared snapshot marks active", async () => {
    rt.progressPage = activePage([{ runId: "enter-active", type: "movie", tmdbId: 7001, title: "ACTIVE_ENTER" }]);
    render({ previews, mediaType: "movie", filter: "all" });
    typeQuery("ACTIVE_ENTER");
    advanceSearch();
    await respond(pending((url) => url.searchParams.get("search") === "ACTIVE_ENTER")[0]!, page([
      item({ tmdbId: 7001, title: "ACTIVE_ENTER", acquiring: false }),
    ], 1));
    expect(html()).toContain("获取中 1");
    expect(html()).not.toContain('class="poster-wall"');
    pressKey("Enter");
    expect(nav.push).not.toHaveBeenCalled();
  });

  it("supports sort, direction, storage filter resets to page 1, and compact list view toggle", async () => {
    const pagedPreviews: LibraryCategoryPreview[] = [
      { type: "movie", page: page([item({ tmdbId: 1, title: "初始电影", posterPath: "/init.jpg", updatedAt: "2026-11-20T00:00:00Z" })], 120, 48) },
      { type: "tv", page: page([], 0) },
      { type: "anime", page: page([], 0) },
    ];
    render({
      previews: pagedPreviews,
      mediaType: "movie",
      filter: "all",
      storageId: "drive-a",
      storages: [
        { id: "drive-a", label: "夸克网盘" },
        { id: "drive-b", label: "115网盘" },
      ],
    });
    await respond(pending(() => true)[0]!, page([item({ tmdbId: 1, title: "初始电影", posterPath: "/init.jpg", updatedAt: "2026-11-20T00:00:00Z" })], 120, 48));

    // 先翻到第 2 页
    const nextButton = find(currentTree, (element) => element.type === "button" && (element.props as { children?: ReactNode }).children === "下一页");
    expect(nextButton).not.toBeNull();
    (nextButton!.props as { onClick: () => void }).onClick();
    render(currentProps);
    await respond(pending((url) => url.searchParams.get("page") === "2")[0]!, page([item({ tmdbId: 2, title: "第二页电影" })], 120, 48));
    expect(html()).toContain("第 2 / 3 页");

    // 切换排序为「最近更新」应默认降序并重置回第 1 页
    const sortSelect = find(currentTree, (element) => element.type === "select" && (element.props as { "aria-label"?: string })["aria-label"] === "排序方式");
    expect(sortSelect).not.toBeNull();
    (sortSelect!.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: "updatedAt" } });
    render(currentProps);
    const updatedReq = pending((url) => url.searchParams.get("sort") === "updatedAt")[0]!;
    expect(updatedReq.url.searchParams.get("direction")).toBe("desc");
    expect(updatedReq.url.searchParams.get("page")).toBe("1");
    await respond(updatedReq, page([item({ tmdbId: 3, title: "最近更新电影", posterPath: "/recent.jpg", updatedAt: "2026-11-25T10:00:00Z" })], 10, 48));
    expect(html()).toContain("最近更新电影");

    // 切换网盘筛选为「全部网盘」应去掉 storageId 参数并重置回第 1 页
    const storageSelect = find(currentTree, (element) => element.type === "select" && (element.props as { "aria-label"?: string })["aria-label"] === "按网盘筛选");
    expect(storageSelect).not.toBeNull();
    (storageSelect!.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: "" } });
    render(currentProps);
    const allStorageReq = pending((url) => !url.searchParams.has("storageId"))[0]!;
    expect(allStorageReq.url.searchParams.get("page")).toBe("1");
    await respond(allStorageReq, page([item({ tmdbId: 4, title: "全盘电影", posterPath: "/all.jpg", updatedAt: "2026-11-26T00:00:00Z" })], 2, 48));
    expect(html()).toContain("全盘电影");

    // 切换为紧凑列表视图，展示 w92 缩略图与更新日期
    const listButton = find(currentTree, (element) => element.type === "button" && renderToStaticMarkup(element).includes("紧凑列表"));
    expect(listButton).not.toBeNull();
    (listButton!.props as { onClick: () => void }).onClick();
    render(currentProps);
    const markup = html();
    expect(markup).toContain("/api/tmdb/image/w92/all.jpg");
    expect(markup).toContain("更新 2026-11-26");
    expect(markup).not.toContain('class="poster-wall"');
  });
});
