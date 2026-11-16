import { describe, expect, it } from "vitest";
import type {
  ActivityActiveRunSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";
import {
  EMPTY_TAIL,
  activeScopeKey,
  cancelCopy,
  canLoadMoreActive,
  loadTailRange,
  mergeTailPages,
  observeActiveRuns,
  tailActionAfterActivityChanged,
  tailIsStale,
  visibleObservedRuns,
  visibleTailForAuthority,
  type SeenActiveTracker,
  type TailPagesState,
} from "./activity-feed";

describe("cancelCopy — what cancelling a queued run says it does", () => {
  it("an acquisition goes with its title: 取消并移出", () => {
    expect(cancelCopy("type2_init")).toEqual({ action: "取消获取", confirm: "取消并移出", note: null });
    expect(cancelCopy("movie_init")).toEqual({ action: "取消获取", confirm: "取消并移出", note: null });
  });

  it("a replace run only drops this attempt: the library stays and the swap waits for the next patrol", () => {
    // A patrol-queued replace run may carry only 待换 episodes and no message at all,
    // so the note speaks of the swap, not of a message.
    expect(cancelCopy("replace_request")).toEqual({
      action: "取消这次换源",
      confirm: "取消这次换源",
      note: "等下次巡检再换",
    });
  });
});

function run(
  runId: string,
  status: ActivityActiveRunSummary["status"] = "running",
): ActivityActiveRunSummary {
  return {
    runId,
    kind: "movie_init",
    tmdbId: 73,
    title: "示例",
    year: 2025,
    type: "movie",
    posterPath: null,
    seasonNumber: null,
    seasonNumbers: [],
    status,
    queuePosition: status === "queued" ? 1 : null,
    missingCount: 0,
    progress: null,
  };
}

function page(
  items: ActivityActiveRunSummary[],
  hasMore: boolean,
  total = items.length,
): PostgresActivityPage {
  return {
    active: { items, total, page: 1, pageSize: 48, hasMore },
    totals: { queued: 0, running: items.length, active: total },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

const tail = (over: Partial<TailPagesState> = {}): TailPagesState => ({
  ...EMPTY_TAIL,
  ...over,
});

describe("observeActiveRuns — 本次浏览观察集合按 scope 隔离", () => {
  it("同 scope 只记录新 run；换网盘后清空，上一网盘的 runId 不会混入本 scope 的已完成", () => {
    const tracker: SeenActiveTracker = { scopeKey: null, seen: new Set<string>() };
    const d1 = activeScopeKey(null, "d1");
    const d2 = activeScopeKey(null, "d2");

    expect(observeActiveRuns(tracker, d1, [run("a"), run("b")])).toBe(true);
    expect([...tracker.seen]).toEqual(["a", "b"]);
    expect(observeActiveRuns(tracker, d1, [run("a"), run("b")])).toBe(false);
    expect(observeActiveRuns(tracker, d1, [run("a"), run("b"), run("c")])).toBe(true);

    // 换盘：即使新盘当前没有活跃任务，也必须把 old run 清掉。
    expect(observeActiveRuns(tracker, d2, [])).toBe(true);
    expect(tracker.scopeKey).toBe(d2);
    expect(tracker.seen.size).toBe(0);
    expect(tracker.seen.has("a")).toBe(false);

    // 新盘观察到自己的 run 后，旧 run 仍然不可见。
    expect(observeActiveRuns(tracker, d2, [run("x")])).toBe(true);
    expect([...tracker.seen]).toEqual(["x"]);
  });

  it("同网盘但账号代次变化也清空观察集合（同 tab 换账号不留上一账号的完成项）", () => {
    const tracker: SeenActiveTracker = { scopeKey: null, seen: new Set<string>() };
    const gen1 = activeScopeKey("gen-1", "d1");
    const gen2 = activeScopeKey("gen-2", "d1");
    expect(gen1).not.toBe(gen2);

    observeActiveRuns(tracker, gen1, [run("from-gen-1")]);
    expect(tracker.seen.has("from-gen-1")).toBe(true);

    expect(observeActiveRuns(tracker, gen2, [])).toBe(true);
    expect(tracker.seen.size).toBe(0);
  });

  it("同账号同网盘但 registry generation 变化也是不同观察边界", () => {
    expect(activeScopeKey("gen-1", "d1", 0)).not.toBe(activeScopeKey("gen-1", "d1", 1));
  });

  it("effect 清空之前，旧 scope/generation 的 runId 也不会参与已完成渲染", () => {
    const tracker: SeenActiveTracker = {
      scopeKey: activeScopeKey(null, "d1", 0),
      seen: new Set(["old-completed"]),
    };
    expect(visibleObservedRuns(tracker, activeScopeKey(null, "d1", 0)).has("old-completed")).toBe(true);
    expect(visibleObservedRuns(tracker, null).size).toBe(0);
    expect(visibleObservedRuns(tracker, activeScopeKey(null, "d1", 1)).size).toBe(0);
  });
});

describe("页外任务快照 — 完成/取消与展开范围", () => {
  it("authority 为空（denied/page=null）或 scope/generation 不匹配时，旧尾页立即不可见", () => {
    const bound = tail({
      binding: activeScopeKey(null, "d1", 0),
      runs: [run("old-tail", "queued")],
      pages: 2,
    });
    expect(visibleTailForAuthority(bound, activeScopeKey(null, "d1", 0))).toBe(bound);
    expect(visibleTailForAuthority(bound, null)).toBe(EMPTY_TAIL);
    expect(visibleTailForAuthority(bound, activeScopeKey(null, "d2", 0))).toBe(EMPTY_TAIL);
    expect(visibleTailForAuthority(bound, activeScopeKey(null, "d1", 1))).toBe(EMPTY_TAIL);
  });

  it("SSE 说第一页仍覆盖不完时保留页外快照（由提示标明非实时）", () => {
    const tailState = tail({ runs: [run("t1")], pages: 2, hasMore: false, at: "10:00" });
    expect(tailIsStale(page([run("p1")], true, 60), tailState)).toBe(false);
  });

  it("第一页后来覆盖全部活跃任务：页外旧行全部过期，必须丢弃，不能继续显示排队/获取中", () => {
    const tailState = tail({ runs: [run("t1", "queued")], pages: 2, hasMore: false, at: "10:00" });
    expect(tailIsStale(page([run("p1")], false, 1), tailState)).toBe(true);
    expect(tailIsStale(page([run("p1")], false, 1), EMPTY_TAIL)).toBe(false);
  });

  it("加载更多入口的边界：第一页看共享 hasMore，展开后看最后一页 hasMore", () => {
    expect(canLoadMoreActive(null, EMPTY_TAIL)).toBe(false);
    expect(canLoadMoreActive(page([], true, 60), EMPTY_TAIL)).toBe(true);
    expect(canLoadMoreActive(page([], false, 0), EMPTY_TAIL)).toBe(false);
    expect(
      canLoadMoreActive(page([], false, 60), tail({ pages: 2, hasMore: true })),
    ).toBe(true);
    expect(
      canLoadMoreActive(page([], true, 60), tail({ pages: 2, hasMore: false })),
    ).toBe(false);
  });

  it("取消/重试后：已展开页重读；读取中则清空并作废旧响应；没展开则不动", () => {
    expect(tailActionAfterActivityChanged(EMPTY_TAIL, false)).toBe("none");
    expect(tailActionAfterActivityChanged(tail({ pages: 2 }), false)).toBe("refresh");
    expect(tailActionAfterActivityChanged(tail({ pages: 2 }), true)).toBe("clear");
  });

  it("刷新整体替换旧快照——页外已完成/已取消的行不会继续以旧状态挂着", () => {
    const stale = tail({
      runs: [run("done", "running"), run("cancelled", "queued")],
      pages: 2,
      hasMore: true,
      at: "10:00",
    });
    const refreshed = mergeTailPages(
      "refresh",
      stale,
      { runs: [run("still-running")], pages: 2, hasMore: false },
      "10:01",
      activeScopeKey(null, "d1", 0),
    );
    expect(refreshed.runs.map((item) => item.runId)).toEqual(["still-running"]);
    expect(refreshed.binding).toBe(activeScopeKey(null, "d1", 0));
    expect(refreshed.pages).toBe(2);
    expect(refreshed.hasMore).toBe(false);
    expect(refreshed.at).toBe("10:01");
  });

  it("追加保留已展开页，并记录新快照时间与是否还有更多", () => {
    const appended = mergeTailPages(
      "append",
      tail({ runs: [run("p2")], pages: 2, hasMore: true, at: "10:00" }),
      { runs: [run("p3")], pages: 3, hasMore: false },
      "10:02",
      activeScopeKey(null, "d1", 0),
    );
    expect(appended.runs.map((item) => item.runId)).toEqual(["p2", "p3"]);
    expect(appended.pages).toBe(3);
    expect(appended.hasMore).toBe(false);
    expect(appended.at).toBe("10:02");
  });
});

describe("loadTailRange — 页外按需读取与旧响应丢弃", () => {
  const scope = {
    key: "k",
    storageId: "d1",
    activePage: 1,
    activePageSize: 48,
    recentLimit: 30,
  };

  it("刷新读取已展开的全部页；遇到 hasMore=false 提前停止", async () => {
    const requested: number[] = [];
    const result = await loadTailRange(scope, 2, 3, () => true, async (_scope, target) => {
      requested.push(target);
      return page([run(`p${target}`)], target < 3, 100);
    });
    expect(requested).toEqual([2, 3]);
    expect(result?.runs.map((item) => item.runId)).toEqual(["p2", "p3"]);
    expect(result?.pages).toBe(3);
    expect(result?.hasMore).toBe(false);
  });

  it("切盘/重复读取后不再继续，旧结果返回 null（不覆盖新 scope）", async () => {
    let current = true;
    const requested: number[] = [];
    const result = await loadTailRange(scope, 2, 4, () => current, async (_scope, target) => {
      requested.push(target);
      current = false; // 第一页返回后用户换了网盘
      return page([run(`p${target}`)], true, 100);
    });
    expect(result).toBeNull();
    expect(requested).toEqual([2]);
  });

  it("请求发出后 generation 已变：旧响应即使最后到达也不能写回", async () => {
    let current = activeScopeKey(null, "d1", 0);
    const pendingResponse: { resolve?: (value: PostgresActivityPage) => void } = {};
    const pending = loadTailRange(
      scope,
      2,
      2,
      () => current === activeScopeKey(null, "d1", 0),
      () =>
        new Promise<PostgresActivityPage>((resolve) => {
          pendingResponse.resolve = resolve;
        }),
    );
    current = activeScopeKey(null, "d1", 1);
    pendingResponse.resolve?.(page([run("old-after-pageshow")], false, 60));
    await expect(pending).resolves.toBeNull();
  });

  it("单页读取只发一次请求", async () => {
    const requested: number[] = [];
    const result = await loadTailRange(scope, 2, 2, () => true, async (_scope, target) => {
      requested.push(target);
      return page([run("p2")], true, 100);
    });
    expect(requested).toEqual([2]);
    expect(result?.pages).toBe(2);
    expect(result?.hasMore).toBe(true);
  });
});
