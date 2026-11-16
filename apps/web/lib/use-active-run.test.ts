import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActivityActiveRunSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";

/**
 * 卡片徽标的取数接线：`useActiveRun` 不再自己请求，而是读页面级共享快照。
 * 这里把 provider 的 hook 换成固定快照，验证「取的是共享快照」且
 * 「媒体身份含类型」——同 tmdbId 的电影与剧集不会互相串进度。
 */
const h = vi.hoisted(() => ({ state: null as unknown }));
vi.mock("../components/library-progress-provider", () => ({
  useLibraryProgress: () => h.state,
}));

import { useActiveRun } from "./use-active-run";
import type { LibraryProgressState } from "./library-progress-client";

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

function withPage(items: ActivityActiveRunSummary[]): LibraryProgressState {
  const page: PostgresActivityPage = {
    active: { items, total: items.length, page: 1, pageSize: 48, hasMore: false },
    totals: { queued: 0, running: items.length, active: items.length },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
  return {
    key: "k",
    storageId: null,
    generation: 0,
    status: "live",
    page,
    observedAt: null,
    source: "stream",
  };
}

beforeEach(() => {
  h.state = {
    key: "k",
    storageId: null,
    generation: 0,
    status: "connecting",
    page: null,
    observedAt: null,
    source: null,
  };
});

describe("useActiveRun — 共享快照取数", () => {
  it("没有快照时返回 null（不自己发请求、不猜）", () => {
    expect(useActiveRun(73, null, undefined)).toBeNull();
  });

  it("从共享快照里取本卡片的 running 进度（step 语义保留）", () => {
    h.state = withPage([
      run({
        runId: "r1",
        progress: {
          activity: "转存第 3 集",
          phase: "transfer",
          percent: 52,
          updatedAt: "2026-11-16T00:00:05.000Z",
          obtained: 2,
          needed: 8,
        },
      }),
    ]);
    const found = useActiveRun(73, null, undefined, "movie");
    expect(found?.runId).toBe("r1");
    expect(found?.progress?.activity).toBe("转存第 3 集");
    expect(found?.progress?.needed).toBe(8);
  });

  it("同 tmdbId 的电影与剧集按媒体类型区分", () => {
    h.state = withPage([
      run({ runId: "movie-73", tmdbId: 73, type: "movie" }),
      run({ runId: "tv-73", tmdbId: 73, type: "tv", seasonNumber: 1, seasonNumbers: [1] }),
    ]);
    expect(useActiveRun(73, null, undefined, "tv")?.runId).toBe("tv-73");
    expect(useActiveRun(73, null, undefined, "movie")?.runId).toBe("movie-73");
    // 类型缺省且同号冲突 → 不猜，卡片退回静态「已请求」而不是串进度
    expect(useActiveRun(73, null, undefined)).toBeNull();
  });

  it("类型缺省但同号只有一种媒体类型时仍能唯一确定", () => {
    h.state = withPage([run({ runId: "only-movie", tmdbId: 73, type: "movie" })]);
    expect(useActiveRun(73, null, undefined)?.runId).toBe("only-movie");
  });

  it("指定季只匹配该季的 run", () => {
    h.state = withPage([
      run({ runId: "s1", tmdbId: 9, type: "tv", seasonNumber: 1, seasonNumbers: [1] }),
      run({ runId: "s2", tmdbId: 9, type: "tv", seasonNumber: 2, seasonNumbers: [2] }),
    ]);
    expect(useActiveRun(9, 2, undefined, "tv")?.runId).toBe("s2");
    expect(useActiveRun(9, 1, undefined, "tv")?.runId).toBe("s1");
    expect(useActiveRun(9, 3, undefined, "tv")).toBeNull();
  });
});
