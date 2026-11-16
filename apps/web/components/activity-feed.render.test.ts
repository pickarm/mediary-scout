import { describe, expect, it, vi } from "vitest";
import type {
  ActivityActiveRunSummary,
  ActivityCompletedSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";

/**
 * 活动页把「共享快照（PostgresActivityPage）」适配成原来的三类行：
 * 获取中（进度条 + step 文案）、排队中（位次 + 缺集）、已完成（本次浏览观察到的）。
 * 重点是 F13 换数据源时不能丢 step/进度/排队语义。
 */
const h = vi.hoisted(() => ({ state: null as unknown, refresh: null as unknown }));
vi.mock("./library-progress-provider", () => ({
  useLibraryProgress: () => h.state,
  useLibraryProgressRefresh: () => h.refresh,
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryProgressState } from "../lib/library-progress-client";
import { ActivityFeed, TailSnapshotNotice } from "./activity-feed";

function run(over: Partial<ActivityActiveRunSummary> & { runId: string }): ActivityActiveRunSummary {
  return {
    runId: over.runId,
    kind: over.kind ?? "movie_init",
    tmdbId: over.tmdbId ?? 73,
    title: over.title ?? "示例",
    year: over.year ?? 2025,
    type: over.type ?? "movie",
    posterPath: over.posterPath ?? null,
    seasonNumber: over.seasonNumber ?? null,
    seasonNumbers: over.seasonNumbers ?? [],
    status: over.status ?? "running",
    queuePosition: over.queuePosition ?? null,
    missingCount: over.missingCount ?? 0,
    progress: over.progress ?? null,
  };
}

function completed(over: Partial<ActivityCompletedSummary> & { workflowRunId: string }): ActivityCompletedSummary {
  return {
    workflowRunId: over.workflowRunId,
    title: over.title ?? "旧任务",
    seasonLabel: over.seasonLabel ?? null,
    status: over.status ?? "acquired",
    posterPath: over.posterPath ?? null,
    sizeText: over.sizeText ?? null,
    createdAt: over.createdAt ?? "2026-11-16T00:00:00.000Z",
  };
}

function page(
  items: ActivityActiveRunSummary[],
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

function state(over: Partial<LibraryProgressState>): LibraryProgressState {
  return {
    key: "k",
    storageId: null,
    generation: 0,
    status: "live",
    page: null,
    observedAt: null,
    source: null,
    ...over,
  };
}

const render = (): string => renderToStaticMarkup(createElement(ActivityFeed, {}));

describe("ActivityFeed — 共享快照渲染", () => {
  it("获取中行保留进度条与 agent step；排队行保留位次与缺集", () => {
    h.state = state({
      page: page([
        run({
          runId: "r1",
          title: "测试电影",
          progress: {
            activity: "正在转存第 3 集",
            phase: "transfer",
            percent: 52,
            updatedAt: "2026-11-16T00:00:05.000Z",
            obtained: 2,
            needed: 8,
          },
        }),
        run({
          runId: "q1",
          title: "排队剧集",
          type: "tv",
          status: "queued",
          queuePosition: 1,
          missingCount: 4,
        }),
      ]),
    });
    const html = render();
    expect(html).toContain("测试电影");
    expect(html).toContain("正在转存第 3 集");
    expect(html).toContain("已确认 2 / 8 集");
    expect(html).toContain("width:52%");
    expect(html).toContain("排队剧集");
    expect(html).toContain("第 1 位");
    expect(html).toContain("缺 4 集");
  });

  it("已完成只显示本次浏览观察到的 run（历史仍在通知里）", () => {
    h.state = state({
      page: page(
        [run({ runId: "r1", title: "正在获取" })],
        [completed({ workflowRunId: "unseen", title: "本次没见过的旧任务" })],
      ),
    });
    const html = render();
    expect(html).toContain("正在获取");
    expect(html).not.toContain("本次没见过的旧任务");
  });

  it("还没有快照时给出读取中，而不是谎报空队列", () => {
    h.state = state({ page: null, status: "connecting" });
    expect(render()).toContain("正在读取获取进度…");
  });

  it("断线后备 / 认证失效各有一句明确状态，不静默", () => {
    h.state = state({ page: page([]), status: "polling" });
    expect(render()).toContain("实时连接已断开，正在低频同步进度。");
    h.state = state({ page: null, status: "denied" });
    expect(render()).toContain("登录状态或网盘归属已失效");
  });

  it("活动页分页有界：超出本页的进行中任务如实提示数量", () => {
    const base = page([run({ runId: "r1" })]);
    h.state = state({ page: { ...base, active: { ...base.active, total: 61, hasMore: true } } });
    const html = render();
    expect(html).toContain("还有 60 个进行中任务未显示。");
    expect(html).toContain("加载更多");
  });
});

describe("ActivityFeed — 页外快照提示", () => {
  it("页外任务明确标为读取时刻的快照，并提供「刷新列表」重读入口", () => {
    const html = renderToStaticMarkup(
      createElement(TailSnapshotNotice, {
        tail: {
          binding: "tail-binding",
          runs: [run({ runId: "tail-1", status: "queued" })],
          pages: 2,
          hasMore: false,
          at: "14:05",
        },
        busy: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toContain('role="note"');
    expect(html).toContain("页外任务为 14:05 读取的快照");
    expect(html).toContain("任务完成或取消后请刷新列表");
    expect(html).toContain("刷新列表");
    expect(html).not.toContain("刷新中…");
  });

  it("刷新中禁用按钮，不会并发重复读取", () => {
    const html = renderToStaticMarkup(
      createElement(TailSnapshotNotice, {
        tail: {
          binding: "tail-binding",
          runs: [run({ runId: "tail-1", status: "running" })],
          pages: 2,
          hasMore: false,
          at: "14:05",
        },
        busy: true,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toContain("刷新中…");
    expect(html).toContain("disabled");
  });

  it("只有共享第一页时不出现快照提示", () => {
    const html = renderToStaticMarkup(
      createElement(TailSnapshotNotice, {
        tail: { binding: null, runs: [], pages: 1, hasMore: false, at: null },
        busy: false,
        onRefresh: () => undefined,
      }),
    );
    expect(html).toBe("");
  });
});
