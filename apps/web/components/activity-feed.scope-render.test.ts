import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityActiveRunSummary,
  ActivityCompletedSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";

/**
 * Render-only reproduction of the first frame after denied / scope / generation
 * changes. Effects do not run in renderToStaticMarkup, so these assertions cover
 * exactly the window where the previous implementation merged stale tail rows.
 */
const h = vi.hoisted(() => ({
  state: null as unknown,
  values: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)): [T, (value: T | ((prev: T) => T)) => void] => {
      if (h.values.length > 0) return [h.values.shift() as T, () => undefined];
      return actual.useState(initial);
    },
  };
});

vi.mock("./library-progress-provider", () => ({
  useLibraryProgress: () => h.state,
  useLibraryProgressRefresh: () => () => undefined,
}));
vi.mock("../lib/demo-mode", () => ({ isDemoModeClient: () => false }));
vi.mock("../lib/use-demo-session", () => ({
  useDemoAcquisitions: () => [],
  useDemoInProgress: () => [],
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LibraryProgressState } from "../lib/library-progress-client";
import {
  ActivityFeed,
  activeScopeKey,
  type TailPagesState,
} from "./activity-feed";

function run(
  over: Partial<ActivityActiveRunSummary> & { runId: string },
): ActivityActiveRunSummary {
  return {
    runId: over.runId,
    kind: "movie_init",
    tmdbId: over.tmdbId ?? 1,
    title: over.title ?? "示例",
    year: 2026,
    type: "movie",
    posterPath: null,
    seasonNumber: null,
    seasonNumbers: [],
    status: over.status ?? "queued",
    queuePosition: over.queuePosition ?? 1,
    missingCount: 0,
    progress: null,
  };
}

function completed(workflowRunId: string, title: string): ActivityCompletedSummary {
  return {
    workflowRunId,
    title,
    seasonLabel: null,
    status: "acquired",
    posterPath: null,
    sizeText: null,
    createdAt: "2026-11-16T00:00:00.000Z",
  };
}

function page(
  items: ActivityActiveRunSummary[],
  recent: ActivityCompletedSummary[] = [],
): PostgresActivityPage {
  return {
    active: { items, total: items.length, page: 1, pageSize: 48, hasMore: true },
    totals: { queued: items.length, running: 0, active: items.length },
    recentCompleted: { items: recent, nextCursor: null, hasMore: false },
  };
}

function state(over: Partial<LibraryProgressState>): LibraryProgressState {
  return {
    key: activeScopeKey(null, "d1", 0),
    storageId: "d1",
    generation: 0,
    status: "live",
    page: null,
    observedAt: null,
    source: null,
    ...over,
  };
}

function oldTail(binding: string): TailPagesState {
  return {
    binding,
    runs: [run({ runId: "old-tail", title: "旧尾页任务", queuePosition: 2 })],
    pages: 2,
    hasMore: false,
    at: "10:00",
  };
}

function seedFrame({
  tail,
  busyBinding = null,
  error = null,
}: {
  tail: TailPagesState;
  busyBinding?: string | null;
  error?: { binding: string; message: string } | null;
}): void {
  // Main hook order: bumpSeen, tail, tailBusyBinding, tailErrorState.
  h.values = [0, tail, busyBinding, error];
}

const render = (props: { storageId: string }): string =>
  renderToStaticMarkup(createElement(ActivityFeed, props));

beforeEach(() => {
  h.state = state({});
  h.values = [];
});

describe("ActivityFeed — authority 首帧门控", () => {
  it("403/denied 或 page=null 的首帧不合并旧尾页，也不留下旧 runId 操作按钮", () => {
    const binding = activeScopeKey(null, "d1", 0);
    h.state = state({ status: "denied", page: null });
    seedFrame({
      tail: oldTail(binding),
      busyBinding: binding,
      error: { binding, message: "旧错误" },
    });

    const html = render({ storageId: "d1" });
    expect(html).toContain("登录状态或网盘归属已失效");
    expect(html).not.toContain("旧尾页任务");
    expect(html).not.toContain("读取的快照");
    expect(html).not.toContain("刷新列表");
    expect(html).not.toContain("取消获取");
  });

  it("scope prop 切换的首帧只显示新 primary，不显示上一网盘 tail", () => {
    h.state = state({
      key: "d2-scope",
      storageId: "d2",
      generation: 0,
      status: "live",
      page: page([run({ runId: "new-primary", title: "新盘首屏" })]),
    });
    seedFrame({
      tail: oldTail(activeScopeKey(null, "d1", 0)),
    });

    const html = render({ storageId: "d2" });
    expect(html).toContain("新盘首屏");
    expect(html).not.toContain("旧尾页任务");
    expect(html).not.toContain("读取的快照");
  });

  it("pageshow/invalidateAll 换代首帧不合并旧 generation 的 tail/已完成观察", () => {
    h.state = state({
      key: "d1-generation-2",
      storageId: "d1",
      generation: 1,
      status: "connecting",
      page: page(
        [run({ runId: "new-primary", title: "新会话首屏" })],
        [completed("old-completed", "旧账号完成项")],
      ),
    });
    const oldBinding = activeScopeKey(null, "d1", 0);
    seedFrame({
      tail: oldTail(oldBinding),
      busyBinding: oldBinding,
      error: { binding: oldBinding, message: "旧代次错误" },
    });

    const html = render({ storageId: "d1" });
    expect(html).toContain("新会话首屏");
    expect(html).not.toContain("旧尾页任务");
    expect(html).not.toContain("旧账号完成项");
    expect(html).not.toContain("读取的快照");
  });
});
