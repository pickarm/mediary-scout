import { beforeEach, describe, expect, it, vi } from "vitest";

type EffectRecord = { deps: readonly unknown[] | undefined; cleanup?: () => void };

const rt = vi.hoisted(() => ({
  values: [] as unknown[],
  has: [] as boolean[],
  effects: [] as EffectRecord[],
  refs: [] as Array<{ current: unknown }>,
  slot: 0,
  pendingRender: false,
  pendingEffects: [] as Array<{ index: number; run: () => void | (() => void); cleanup?: () => void }>,
  focus: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: rt.push }) }));

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
    useRef<T>(initial: T): { current: T } {
      const index = rt.slot++;
      if (!rt.refs[index]) {
        rt.refs[index] = { current: initial === null ? ({ focus: rt.focus } as unknown as T) : initial };
      }
      return rt.refs[index] as { current: T };
    },
  };
});

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryQueryItem, LibraryQueryPage } from "@media-track/workflow/library-query";
import { GlobalQuickSearch, tmdbOnlineSearchHref } from "./global-quick-search";

type Props = Parameters<typeof GlobalQuickSearch>[0];
type KeyHandler = (event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing: boolean; keyCode: number };
  preventDefault: () => void;
}) => void;

type PendingRequest = {
  url: URL;
  resolve: (page: LibraryQueryPage) => void;
  reject: (err: Error) => void;
  done: boolean;
};

const requests: PendingRequest[] = [];
const timers = new Map<number, { run: () => void; delay: number }>();
const windowListeners = new Map<string, Set<KeyHandler>>();
let timerId = 0;
let currentProps: Props = {};
let currentTree: ReactElement;

function item(over: Partial<LibraryQueryItem> & { tmdbId: number; title: string }): LibraryQueryItem {
  return {
    type: "movie",
    year: 2025,
    posterPath: "/abc123.jpg",
    releaseDate: null,
    seasonCount: 0,
    obtainedEpisodes: 1,
    totalAiredEpisodes: 1,
    totalEpisodes: 1,
    state: "complete",
    airing: false,
    acquiring: false,
    autoAcquire: null,
    ...over,
  };
}

function queryPage(items: LibraryQueryItem[]): LibraryQueryPage {
  return { items, total: items.length, page: 1, pageSize: 8, hasMore: false };
}

function runEffects(): void {
  while (rt.pendingEffects.length > 0) {
    const pending = rt.pendingEffects.shift()!;
    pending.cleanup?.();
    const cleanup = pending.run();
    if (typeof cleanup === "function") rt.effects[pending.index]!.cleanup = cleanup;
  }
}

function render(props: Props = currentProps): void {
  currentProps = props;
  for (let guard = 0; guard < 20; guard += 1) {
    rt.pendingRender = false;
    rt.slot = 0;
    currentTree = GlobalQuickSearch(props);
    runEffects();
    if (!rt.pendingRender) return;
  }
  throw new Error("render loop did not settle");
}

async function flush(): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
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

function findAll(node: ReactNode, match: (element: ReactElement) => boolean, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, match, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (match(element)) out.push(element);
  return findAll(element.props.children, match, out);
}

function html(): string {
  return renderToStaticMarkup(currentTree);
}

function dispatchWindowKey(event: Omit<Parameters<KeyHandler>[0], "preventDefault">): { prevented: boolean } {
  let prevented = false;
  for (const listener of windowListeners.get("keydown") ?? []) {
    listener({
      ...event,
      preventDefault: () => { prevented = true; },
    });
  }
  render(currentProps);
  return { prevented };
}

function advanceDebounce(): void {
  const entries = [...timers.entries()];
  expect(entries).toHaveLength(1);
  const [id, timer] = entries[0]!;
  expect(timer.delay).toBe(200);
  timers.delete(id);
  timer.run();
  render(currentProps);
}

async function respondLatest(body: LibraryQueryPage): Promise<void> {
  const pending = requests.filter((req) => !req.done);
  const req = pending[pending.length - 1]!;
  req.done = true;
  req.resolve(body);
  await flush();
}

function searchInput(): ReactElement<{
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  onKeyDown: KeyHandler;
}> {
  const element = find(currentTree, (node) => node.type === "input");
  expect(element, "quick search input").not.toBeNull();
  return element as ReactElement<{
    value: string;
    onChange: (event: { target: { value: string } }) => void;
    onKeyDown: KeyHandler;
  }>;
}

function typeQuery(value: string): void {
  searchInput().props.onChange({ target: { value } });
  render(currentProps);
}

function pressInputKey(key: string, isComposing = false, keyCode = 0): void {
  searchInput().props.onKeyDown({
    key,
    nativeEvent: { isComposing, keyCode },
    preventDefault: () => undefined,
  });
  render(currentProps);
}

beforeEach(() => {
  for (const effect of rt.effects) effect?.cleanup?.();
  rt.values = [];
  rt.has = [];
  rt.effects = [];
  rt.refs = [];
  rt.slot = 0;
  rt.pendingRender = false;
  rt.pendingEffects = [];
  rt.focus.mockClear();
  rt.push.mockClear();
  requests.length = 0;
  timers.clear();
  windowListeners.clear();
  timerId = 0;

  vi.stubGlobal("window", {
    setTimeout: (run: () => void, delay?: number) => {
      timerId += 1;
      timers.set(timerId, { run, delay: delay ?? 0 });
      return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
    addEventListener: (type: string, handler: KeyHandler) => {
      const set = windowListeners.get(type) ?? new Set<KeyHandler>();
      set.add(handler);
      windowListeners.set(type, set);
    },
    removeEventListener: (type: string, handler: KeyHandler) => {
      windowListeners.get(type)?.delete(handler);
    },
  });

  vi.stubGlobal("fetch", vi.fn((inputValue: RequestInfo | URL) => new Promise<Response>((resolve, reject) => {
    requests.push({
      url: new URL(String(inputValue), "http://127.0.0.1:4326"),
      resolve: (body) => resolve(Response.json(body)),
      reject,
      done: false,
    });
  })));
});

describe("tmdbOnlineSearchHref", () => {
  it("builds root and workspace-scoped TMDB search links", () => {
    expect(tmdbOnlineSearchHref("/", "星际穿越")).toBe("/?q=%E6%98%9F%E9%99%85%E7%A9%BF%E8%B6%8A");
    expect(tmdbOnlineSearchHref("/w/drive-a", "沙丘 2")).toBe("/w/drive-a?q=%E6%B2%99%E4%B8%98%202");
  });
});

describe("GlobalQuickSearch", () => {
  it("opens on Ctrl+K / Cmd+K (ignoring IME composing) and closes on Escape or backdrop click", () => {
    render({ storageId: "drive-a", basePath: "/w/drive-a" });
    expect(html()).not.toContain('role="dialog"');

    // 输入法组合态下忽略 Ctrl+K
    dispatchWindowKey({ key: "k", ctrlKey: true, isComposing: true });
    expect(html()).not.toContain('role="dialog"');

    const opened = dispatchWindowKey({ key: "k", ctrlKey: true });
    expect(opened.prevented).toBe(true);
    expect(html()).toContain('role="dialog"');
    expect(rt.focus).toHaveBeenCalledTimes(1);

    // 按 Escape 关闭
    dispatchWindowKey({ key: "Escape" });
    expect(html()).not.toContain('role="dialog"');

    // Cmd+K 也可打开，点击遮罩关闭
    dispatchWindowKey({ key: "k", metaKey: true });
    expect(html()).toContain('role="dialog"');
    const backdrop = find(currentTree, (node) => (node.props as { role?: string }).role === "presentation");
    expect(backdrop).not.toBeNull();
    (backdrop!.props as { onClick: (event: { target: unknown; currentTarget: unknown }) => void }).onClick({
      target: "backdrop",
      currentTarget: "backdrop",
    });
    render(currentProps);
    expect(html()).not.toContain('role="dialog"');
  });

  it("debounces search to /api/library/media?search=<q>&pageSize=8, renders w92 posters & badges, and navigates with arrows/Enter", async () => {
    render({ storageId: "drive-b", basePath: "/w/drive-b" });
    const trigger = find(currentTree, (node) => node.type === "button" && (node.props as { "aria-label"?: string })["aria-label"] === "打开快速搜索");
    expect(trigger).not.toBeNull();
    (trigger!.props as { onClick: () => void }).onClick();
    render(currentProps);

    typeQuery("沙丘");
    expect(requests).toHaveLength(0);
    advanceDebounce();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe("/api/library/media");
    expect(requests[0]!.url.searchParams.get("search")).toBe("沙丘");
    expect(requests[0]!.url.searchParams.get("pageSize")).toBe("8");
    expect(requests[0]!.url.searchParams.get("storageId")).toBe("drive-b");

    await respondLatest(queryPage([
      item({ tmdbId: 438631, title: "沙丘", type: "movie", year: 2021, posterPath: "/dune.jpg", state: "complete" }),
      item({ tmdbId: 999001, title: "沙丘：预言", type: "tv", year: 2024, posterPath: "/dune-tv.jpg", seasonCount: 1, obtainedEpisodes: 4, totalAiredEpisodes: 6, state: "partial" }),
    ]));

    const markup = html();
    expect(markup).toContain("/api/tmdb/image/w92/dune.jpg");
    expect(markup).toContain("已入库");
    expect(markup).toContain("有缺集");
    expect(markup).toContain("在线搜 TMDB：沙丘");

    // 方向键上下切换选择，回车跳到第 2 个库内条目
    pressInputKey("ArrowDown");
    pressInputKey("Enter");
    expect(rt.push).toHaveBeenCalledWith("/show/999001?from=library&w=drive-b&t=tv");
    expect(html()).not.toContain('role="dialog"');
  });

  it("supports navigating to online TMDB search while keeping workspace context", async () => {
    render({ storageId: "drive-c", basePath: "/w/drive-c" });
    dispatchWindowKey({ key: "k", ctrlKey: true });
    typeQuery("黑客帝国");
    advanceDebounce();
    await respondLatest(queryPage([]));

    expect(html()).toContain("媒体库中未找到『黑客帝国』");
    expect(html()).toContain("在线搜 TMDB：黑客帝国");

    // 输入法组合态的 Enter 不跳转
    pressInputKey("Enter", true, 229);
    expect(rt.push).not.toHaveBeenCalled();

    // 正常 Enter 跳到当前工作区的 TMDB 搜索页
    pressInputKey("Enter");
    expect(rt.push).toHaveBeenCalledWith("/w/drive-c?q=%E9%BB%91%E5%AE%A2%E5%B8%9D%E5%9B%BD");
  });

  it("ignores acquiring items on Enter and allows clicking the bottom TMDB button", async () => {
    render({ basePath: "/" });
    dispatchWindowKey({ key: "k", ctrlKey: true });
    typeQuery("测试获取中");
    advanceDebounce();
    await respondLatest(queryPage([
      item({ tmdbId: 12, title: "测试获取中", acquiring: true }),
    ]));

    // 第 0 项为 acquiring，回车不跳进详情页
    pressInputKey("Enter");
    expect(rt.push).not.toHaveBeenCalled();

    const buttons = findAll(currentTree, (node) => node.type === "button");
    const tmdbButton = buttons.find((btn) => renderToStaticMarkup(btn).includes("在线搜 TMDB：测试获取中"));
    expect(tmdbButton).toBeDefined();
    (tmdbButton!.props as { onClick: () => void }).onClick();
    expect(rt.push).toHaveBeenCalledWith("/?q=%E6%B5%8B%E8%AF%95%E8%8E%B7%E5%8F%96%E4%B8%AD");
  });
});
