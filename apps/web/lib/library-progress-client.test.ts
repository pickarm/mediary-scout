import { describe, expect, it } from "vitest";
import type {
  ActivityActiveRunSummary,
  ActivityCompletedSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";
import {
  LibraryProgressDeniedError,
  activityViewFromPage,
  activeTotalOf,
  createLibraryProgressRegistry,
  findActiveRunForMedia,
  loadLibraryActivityPage,
  libraryProgressQueryString,
  parseLibraryActivityPage,
  parseLibraryProgressSnapshot,
  resolveLibraryProgressScope,
  type LibraryProgressRuntime,
  type LibraryProgressState,
  type LibraryProgressStreamHandlers,
  type LibraryProgressTimer,
  type ResolvedLibraryProgressScope,
} from "./library-progress-client";

/** 5 个 microtask 足够跑完 loadPage().then().finally() 链。 */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

interface FakeTimer {
  id: number;
  at: number;
  run: () => void;
}

function fakeClock(startAt = 1_700_000_000_000) {
  let now = startAt;
  let nextId = 1;
  const timers = new Map<number, FakeTimer>();
  return {
    now: () => now,
    setTimeout: (run: () => void, delayMs: number): LibraryProgressTimer => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, at: now + Math.max(0, delayMs), run });
      return id as unknown as LibraryProgressTimer;
    },
    clearTimeout: (handle: LibraryProgressTimer): void => {
      timers.delete(handle as unknown as number);
    },
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.run();
      }
      now = target;
    },
    pendingTimers: (): number => timers.size,
  };
}

interface FakeStream {
  scope: ResolvedLibraryProgressScope;
  handlers: LibraryProgressStreamHandlers;
  closed: boolean;
}

interface PendingLoad {
  scope: ResolvedLibraryProgressScope;
  resolve: (page: PostgresActivityPage) => void;
  reject: (error: unknown) => void;
}

function harness() {
  const clock = fakeClock();
  const streams: FakeStream[] = [];
  const loads: PendingLoad[] = [];
  const runtime: LibraryProgressRuntime = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    openStream(scope, handlers) {
      const stream: FakeStream = { scope, handlers, closed: false };
      streams.push(stream);
      return {
        close() {
          stream.closed = true;
        },
      };
    },
    loadPage(scope) {
      return new Promise<PostgresActivityPage>((resolve, reject) => {
        loads.push({ scope, resolve, reject });
      });
    },
  };
  const registry = createLibraryProgressRegistry({ runtime });
  return { clock, streams, loads, registry };
}

function activeRun(
  over: Partial<ActivityActiveRunSummary> & { runId: string },
): ActivityActiveRunSummary {
  return {
    runId: over.runId,
    kind: over.kind ?? "movie_init",
    tmdbId: over.tmdbId ?? 73,
    title: over.title ?? "示例电影",
    year: over.year ?? 2025,
    type: over.type ?? "movie",
    posterPath: over.posterPath ?? null,
    seasonNumber: over.seasonNumber ?? null,
    seasonNumbers: over.seasonNumbers ?? [],
    status: over.status ?? "running",
    queuePosition: over.queuePosition ?? null,
    missingCount: over.missingCount ?? 0,
    progress: over.progress ?? {
      activity: "搜索资源",
      phase: "search",
      percent: 11,
      updatedAt: "2026-11-16T00:00:00.000Z",
    },
  };
}

function completedItem(
  over: Partial<ActivityCompletedSummary> & { workflowRunId: string },
): ActivityCompletedSummary {
  return {
    workflowRunId: over.workflowRunId,
    title: over.title ?? "示例电影",
    seasonLabel: over.seasonLabel ?? null,
    status: over.status ?? "acquired",
    posterPath: over.posterPath ?? null,
    sizeText: over.sizeText ?? null,
    createdAt: over.createdAt ?? "2026-11-16T00:01:00.000Z",
  };
}

function activityPage(
  items: ActivityActiveRunSummary[] = [],
  recent: ActivityCompletedSummary[] = [],
): PostgresActivityPage {
  return {
    active: { items, total: items.length, page: 1, pageSize: 48, hasMore: false },
    totals: {
      queued: items.filter((item) => item.status === "queued").length,
      running: items.filter((item) => item.status === "running").length,
      active: items.length,
    },
    recentCompleted: { items: recent, nextCursor: null, hasMore: false },
  };
}

function snapshot(page: PostgresActivityPage, observedAt: string) {
  return { page, observedAt };
}

describe("libraryProgressScope — 同 scope 才共享", () => {
  it("默认有界分页参数，并忽略未提供的网盘", () => {
    const scope = resolveLibraryProgressScope({ storageId: "   " });
    expect(scope.storageId).toBeNull();
    expect(scope.activePage).toBe(1);
    expect(scope.activePageSize).toBe(48);
    expect(scope.recentLimit).toBe(30);
    expect(libraryProgressQueryString(scope)).toBe("activePage=1&activePageSize=48&recentLimit=30");
  });

  it("分页参数收敛到接口上限，网盘参数被编码", () => {
    const scope = resolveLibraryProgressScope({
      storageId: " 盘 1 ",
      activePage: 2,
      activePageSize: 5_000,
      recentLimit: 500,
    });
    expect(scope.storageId).toBe("盘 1");
    expect(scope.activePageSize).toBe(100);
    expect(scope.recentLimit).toBe(100);
    const query = new URLSearchParams(libraryProgressQueryString(scope));
    expect(query.get("storageId")).toBe("盘 1");
    expect(query.get("activePage")).toBe("2");
    // 客户端绝不发送 accountId —— 账号由服务端会话派生。
    expect(query.has("accountId")).toBe(false);
  });

  it("账号代次参与 scope key：同一网盘的不同代次是两条独立订阅", () => {
    const a = resolveLibraryProgressScope({ storageId: "d1" }).key;
    const b = resolveLibraryProgressScope({ storageId: "d1", accountKey: "gen-2" }).key;
    expect(a).not.toBe(b);
  });
});

describe("共享订阅注册表", () => {
  it("同一 scope 的多个消费者共用一条 SSE，后来的订阅者立即拿到当前快照", () => {
    const h = harness();
    const first: LibraryProgressState[] = [];
    const second: LibraryProgressState[] = [];
    const offFirst = h.registry.subscribe({ storageId: "d1" }, (state) => first.push(state));
    expect(h.streams).toHaveLength(1);
    expect(first.at(-1)?.status).toBe("connecting");

    const page = activityPage([activeRun({ runId: "r1" })]);
    h.streams[0]!.handlers.onSnapshot(snapshot(page, "2026-11-16T00:00:05.000Z"));

    const offSecond = h.registry.subscribe({ storageId: "d1" }, (state) => second.push(state));
    expect(h.streams).toHaveLength(1); // 仍是一条连接
    expect(second.at(-1)?.page).toBe(page); // 新订阅者拿到已缓存快照
    expect(first.at(-1)?.page).toBe(page);
    expect(second.at(-1)?.status).toBe("live");

    offFirst();
    offSecond();
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.registry.activeChannelCount()).toBe(0);
  });

  it("不同网盘、不同账号代次的快照互不可见", () => {
    const h = harness();
    const d1: LibraryProgressState[] = [];
    const d2: LibraryProgressState[] = [];
    const gen2: LibraryProgressState[] = [];
    h.registry.subscribe({ storageId: "d1" }, (state) => d1.push(state));
    h.registry.subscribe({ storageId: "d2" }, (state) => d2.push(state));
    h.registry.subscribe({ storageId: "d1", accountKey: "gen-2" }, (state) => gen2.push(state));
    expect(h.streams).toHaveLength(3);

    const page = activityPage([activeRun({ runId: "only-d1" })]);
    h.streams[0]!.handlers.onSnapshot(snapshot(page, "2026-11-16T00:00:05.000Z"));

    expect(d1.at(-1)?.page).toBe(page);
    expect(d2.at(-1)?.page ?? null).toBeNull();
    expect(gen2.at(-1)?.page ?? null).toBeNull();
    expect(h.registry.getState({ storageId: "d2" }).page).toBeNull();
    expect(h.registry.getState({ storageId: "d1", accountKey: "gen-2" }).page).toBeNull();
  });

  it("最后一个消费者退订后关闭连接、清空计时器，迟到事件不再通知任何人", () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "r1" })]), "2026-11-16T00:00:05.000Z"),
    );
    off();

    expect(h.streams[0]!.closed).toBe(true);
    expect(h.streams).toHaveLength(1);
    expect(h.clock.pendingTimers()).toBe(0);
    expect(h.registry.activeChannelCount()).toBe(0);
    expect(h.registry.getState({ storageId: "d1" }).status).toBe("idle");

    const before = seen.length;
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "late" })]), "2026-11-16T00:00:09.000Z"),
    );
    expect(seen).toHaveLength(before);
  });

  it("断线后立即重读一次，其后统一低频轮询", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "r1" })]), "2026-11-16T00:00:05.000Z"),
    );

    h.streams[0]!.handlers.onError();
    expect(h.streams[0]!.closed).toBe(true);
    expect(seen.at(-1)?.status).toBe("polling");
    expect(seen.at(-1)?.page).not.toBeNull(); // 断线不清空已显示的进度

    // 断线重读：立刻发一次（0ms），而不是等一个轮询周期
    h.clock.advance(0);
    expect(h.loads).toHaveLength(1);
    expect(h.loads[0]!.scope.storageId).toBe("d1");

    const polled = activityPage([activeRun({ runId: "r1", progress: {
      activity: "转存文件",
      phase: "transfer",
      percent: 46,
      updatedAt: "2026-11-16T00:00:10.000Z",
    } })]);
    h.loads[0]!.resolve(polled);
    await flush();
    expect(seen.at(-1)?.page).toBe(polled);
    expect(seen.at(-1)?.source).toBe("poll");

    // 统一低频：15s 一拍，期间不再另发请求
    h.clock.advance(14_999);
    expect(h.loads).toHaveLength(1);
    h.clock.advance(1);
    expect(h.loads).toHaveLength(2);

    off();
    expect(h.clock.pendingTimers()).toBe(0);
  });

  it("重连成功后停止轮询；旧连接/旧响应都不会回退进度", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "r1" })]), "2026-11-16T00:00:05.000Z"),
    );

    h.streams[0]!.handlers.onError();
    h.clock.advance(0);
    expect(h.loads).toHaveLength(1); // 在途的旧读取

    // 20s 后自动重连（服务端会重新认证并立刻发新快照）
    h.clock.advance(20_000);
    expect(h.streams).toHaveLength(2);
    expect(h.streams[1]!.closed).toBe(false);

    const fresh = activityPage([activeRun({ runId: "r1" })]);
    h.streams[1]!.handlers.onSnapshot(snapshot(fresh, "2026-11-16T00:00:25.000Z"));
    expect(seen.at(-1)?.status).toBe("live");
    expect(seen.at(-1)?.page).toBe(fresh);

    // 旧轮询这时才返回：必须丢弃（既不回退页面，也不恢复轮询）
    h.loads[0]!.resolve(activityPage([]));
    await flush();
    expect(seen.at(-1)?.page).toBe(fresh);
    // 轮询已停：跨过两个轮询周期也不再有请求（90s 静默看门狗仍在窗口内）。
    h.clock.advance(60_000);
    expect(h.loads).toHaveLength(1);

    // 旧连接的迟到快照同样无效
    h.streams[0]!.handlers.onSnapshot(snapshot(activityPage([]), "2026-11-16T00:00:40.000Z"));
    expect(seen.at(-1)?.page).toBe(fresh);
    off();
  });

  it("401/403/404 终止该 scope：清空快照、停止计时器，不再重试", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "r1" })]), "2026-11-16T00:00:05.000Z"),
    );
    h.streams[0]!.handlers.onError();
    h.clock.advance(0);
    h.loads[0]!.reject(new LibraryProgressDeniedError());
    await flush();

    expect(seen.at(-1)?.status).toBe("denied");
    expect(seen.at(-1)?.page).toBeNull();
    expect(h.clock.pendingTimers()).toBe(0);
    h.clock.advance(300_000);
    expect(h.loads).toHaveLength(1);
    expect(h.streams).toHaveLength(1);
    off();
  });

  it("瞬时轮询失败保留上一份快照并继续轮询", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    const page = activityPage([activeRun({ runId: "r1" })]);
    h.streams[0]!.handlers.onSnapshot(snapshot(page, "2026-11-16T00:00:05.000Z"));
    h.streams[0]!.handlers.onError();
    h.clock.advance(0);
    h.loads[0]!.reject(new Error("网络抖动"));
    await flush();
    expect(seen.at(-1)?.page).toBe(page);
    h.clock.advance(15_000);
    expect(h.loads).toHaveLength(2);
    off();
  });

  it("账号代次切换：generation 递增，旧快照/旧在途读取失效，但订阅者无需重新订阅", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    const oldPage = activityPage([activeRun({ runId: "r1" })]);
    h.streams[0]!.handlers.onSnapshot(snapshot(oldPage, "2026-11-16T00:00:05.000Z"));
    const originalGeneration = seen.at(-1)?.generation ?? 0;

    // 让一个读取在 invalidateAll 前真实处于在途状态。
    h.registry.refresh({ storageId: "d1" });
    expect(h.loads).toHaveLength(1);

    h.registry.invalidateAll();
    expect(h.streams[0]!.closed).toBe(true);
    expect(h.streams).toHaveLength(2); // 用新会话重新认证
    expect(seen.at(-1)?.page).toBeNull(); // 旧账号的快照立刻丢弃
    expect(seen.at(-1)?.status).toBe("connecting");
    expect(seen.at(-1)?.generation).toBe(originalGeneration + 1);

    // 旧 manual poll 在换代后才返回：不能把旧账号页面写回。
    h.loads[0]!.resolve(activityPage([activeRun({ runId: "stale-poll" })]));
    await flush();
    expect(seen.at(-1)?.page).toBeNull();
    expect(seen.at(-1)?.generation).toBe(originalGeneration + 1);

    h.streams[0]!.handlers.onSnapshot(snapshot(activityPage([]), "2026-11-16T00:00:08.000Z"));
    expect(seen.at(-1)?.page).toBeNull(); // 旧连接的迟到快照被忽略

    const newPage = activityPage([activeRun({ runId: "r2" })]);
    h.streams[1]!.handlers.onSnapshot(snapshot(newPage, "2026-11-16T00:00:09.000Z"));
    expect(seen.at(-1)?.page).toBe(newPage);
    expect(seen.at(-1)?.status).toBe("live");
    expect(seen.at(-1)?.generation).toBe(originalGeneration + 1);
    expect(seen.filter((state) => state.page === newPage)).toHaveLength(1);
    off();
  });

  it("主动重读（取消/重试之后）不会把 live 降级成 polling", async () => {
    const h = harness();
    const seen: LibraryProgressState[] = [];
    const off = h.registry.subscribe({ storageId: "d1" }, (state) => seen.push(state));
    h.streams[0]!.handlers.onSnapshot(
      snapshot(activityPage([activeRun({ runId: "r1" })]), "2026-11-16T00:00:05.000Z"),
    );

    h.registry.refresh({ storageId: "d1" });
    expect(h.loads).toHaveLength(1);
    const afterCancel = activityPage([]);
    h.loads[0]!.resolve(afterCancel);
    await flush();
    expect(seen.at(-1)?.page).toBe(afterCancel);
    expect(seen.at(-1)?.status).toBe("live");
    off();
  });

  it("reset 销毁全部共享订阅", () => {
    const h = harness();
    h.registry.subscribe({ storageId: "d1" }, () => undefined);
    h.registry.subscribe({ storageId: null }, () => undefined);
    expect(h.registry.activeChannelCount()).toBe(2);
    h.registry.reset();
    expect(h.registry.activeChannelCount()).toBe(0);
    expect(h.streams.every((stream) => stream.closed)).toBe(true);
    expect(h.clock.pendingTimers()).toBe(0);
  });
});

describe("响应解析", () => {
  it("接受自身的有界快照帧", () => {
    const page = activityPage(
      [activeRun({ runId: "r1" })],
      [completedItem({ workflowRunId: "r0" })],
    );
    const parsed = parseLibraryProgressSnapshot(
      JSON.stringify({ version: 1, observedAt: "2026-11-16T00:00:05.000Z", page }),
    );
    expect(parsed?.observedAt).toBe("2026-11-16T00:00:05.000Z");
    expect(parsed?.page.active.items[0]?.runId).toBe("r1");
    expect(parsed?.page.active.items[0]?.progress?.activity).toBe("搜索资源");
    expect(parsed?.page.recentCompleted.items[0]?.workflowRunId).toBe("r0");
  });

  it("拒绝非 JSON、错版本、无 observedAt、半成品 page", () => {
    expect(parseLibraryProgressSnapshot("{")).toBeNull();
    expect(
      parseLibraryProgressSnapshot(JSON.stringify({ version: 2, observedAt: "2026-11-16T00:00:05.000Z", page: activityPage() })),
    ).toBeNull();
    expect(parseLibraryProgressSnapshot(JSON.stringify({ version: 1, page: activityPage() }))).toBeNull();
    expect(
      parseLibraryProgressSnapshot(
        JSON.stringify({ version: 1, observedAt: "not-a-date", page: activityPage() }),
      ),
    ).toBeNull();
    expect(
      parseLibraryProgressSnapshot(
        JSON.stringify({ version: 1, observedAt: "2026-11-16T00:00:05.000Z", page: { active: {} } }),
      ),
    ).toBeNull();
  });

  it("活动页里任一 run 结构不合法即整体拒绝（不把半成品塞进 UI）", () => {
    const page = activityPage([activeRun({ runId: "r1" })]);
    expect(parseLibraryActivityPage(page)).not.toBeNull();
    const broken = { ...page, active: { ...page.active, items: [{ runId: "", tmdbId: 1 }] } };
    expect(parseLibraryActivityPage(broken)).toBeNull();
    expect(parseLibraryActivityPage(null)).toBeNull();
  });

  it("历史里的坏条目只丢该行，不影响正在进行的进度", () => {
    const page = activityPage([activeRun({ runId: "r1" })], [
      completedItem({ workflowRunId: "ok" }),
    ]);
    const mixed = {
      ...page,
      recentCompleted: {
        ...page.recentCompleted,
        items: [{ title: "缺 id 的坏行" }, ...page.recentCompleted.items],
      },
    };
    const parsed = parseLibraryActivityPage(mixed);
    expect(parsed?.active.items[0]?.runId).toBe("r1");
    expect(parsed?.recentCompleted.items.map((item) => item.workflowRunId)).toEqual(["ok"]);
  });
});

describe("按需补读一页（活动页加载更多 / 后备轮询共用）", () => {
  const scope = resolveLibraryProgressScope({ storageId: "d1", activePageSize: 48 });

  function jsonResponse(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }

  it("用同一组有界参数读取指定页，不走全量接口", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return jsonResponse(200, activityPage([activeRun({ runId: "p3" })]));
    }) as unknown as typeof fetch;

    const result = await loadLibraryActivityPage(scope, 3, fetchImpl);
    expect(result.active.items[0]?.runId).toBe("p3");
    const requested = calls[0] ?? "";
    expect(requested).toContain("/api/library/activity?");
    expect(requested).toContain("activePage=3");
    expect(requested).toContain("activePageSize=48");
    expect(requested).toContain("storageId=d1");
    expect(requested).not.toContain("accountId");
    expect(requested).not.toContain("/api/activity?");
  });

  it("认证/网盘归属失效映射成 denied（调用方停止重试）", async () => {
    const fetchImpl = (async () => jsonResponse(404, {})) as unknown as typeof fetch;
    await expect(loadLibraryActivityPage(scope, 2, fetchImpl)).rejects.toBeInstanceOf(
      LibraryProgressDeniedError,
    );
  });

  it("非 2xx 与坏结构都抛错，不返回半成品", async () => {
    const failing = (async () => jsonResponse(500, {})) as unknown as typeof fetch;
    await expect(loadLibraryActivityPage(scope, 2, failing)).rejects.toThrow();
    const malformed = (async () => jsonResponse(200, { active: null })) as unknown as typeof fetch;
    await expect(loadLibraryActivityPage(scope, 2, malformed)).rejects.toThrow();
  });
});

describe("卡片/活动页选择器", () => {
  const movie = activeRun({ runId: "m1", tmdbId: 73, type: "movie" });
  const tv = activeRun({ runId: "t1", tmdbId: 73, type: "tv", seasonNumber: 2, seasonNumbers: [2] });

  it("媒体身份 = (媒体类型, TMDB ID)，不能只按数值 ID 匹配", () => {
    expect(findActiveRunForMedia([movie, tv], { tmdbId: 73, mediaType: "tv" })?.runId).toBe("t1");
    expect(findActiveRunForMedia([movie, tv], { tmdbId: 73, mediaType: "movie" })?.runId).toBe("m1");
    // 没给类型且同号对象类型冲突 → 不猜（宁可少显示一条进度，也不能串到别的作品上）
    expect(findActiveRunForMedia([movie, tv], { tmdbId: 73 })).toBeNull();
    expect(findActiveRunForMedia([movie, tv], { tmdbId: 73, mediaType: "anime" })).toBeNull();
    expect(findActiveRunForMedia([movie, tv], { tmdbId: 74 })).toBeNull();
    // 没给类型但同号只有一种媒体类型 → 仍可唯一确定
    expect(findActiveRunForMedia([tv], { tmdbId: 73 })?.runId).toBe("t1");
  });

  it("优先 running，其次排队；指定季只匹配该季", () => {
    const queued = activeRun({ runId: "t2", tmdbId: 73, type: "tv", status: "queued", seasonNumber: 2 });
    expect(
      findActiveRunForMedia([queued, tv], { tmdbId: 73, mediaType: "tv", seasonNumber: 2 })?.runId,
    ).toBe("t1");
    expect(
      findActiveRunForMedia([queued], { tmdbId: 73, mediaType: "tv", seasonNumber: 2 })?.runId,
    ).toBe("t2");
    expect(
      findActiveRunForMedia([tv], { tmdbId: 73, mediaType: "tv", seasonNumber: 1 }),
    ).toBeNull();
  });

  it("活动页适配保留 progress/step 语义与总数", () => {
    const page = activityPage([movie], [completedItem({ workflowRunId: "m0" })]);
    const view = activityViewFromPage(page);
    expect(view.active[0]?.progress?.activity).toBe("搜索资源");
    expect(view.recentCompleted[0]?.status).toBe("acquired");
    expect(
      activeTotalOf({
        key: "k",
        storageId: null,
        generation: 0,
        status: "live",
        page,
        observedAt: null,
        source: "stream",
      }),
    ).toBe(1);
    expect(
      activeTotalOf({
        key: "k",
        storageId: null,
        generation: 0,
        status: "connecting",
        page: null,
        observedAt: null,
        source: null,
      }),
    ).toBeNull();
  });
});
