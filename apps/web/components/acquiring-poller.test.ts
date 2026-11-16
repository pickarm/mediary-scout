import { describe, expect, it, vi } from "vitest";

// Module-level imports of the component pull next/navigation + the shared hook;
// this test only exercises the pure refresh decision.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("./library-progress-provider", () => ({
  useLibraryProgress: () => ({
    key: "k",
    storageId: null,
    generation: 0,
    status: "live",
    page: null,
    observedAt: null,
    source: null,
  }),
}));

import { shouldRefreshAfterProgress } from "./acquiring-poller";

const ids = (...values: string[]): ReadonlySet<string> => new Set(values);

describe("AcquiringPoller — 每个 run 终态各刷新一次，不再 5 秒轮询", () => {
  it("首次快照已经为空：服务端渲染时还在获取，水合前完成了 → 刷新一次", () => {
    expect(shouldRefreshAfterProgress(null, ids())).toBe(true);
  });

  it("首次快照仍有任务 → 不刷新", () => {
    expect(shouldRefreshAfterProgress(null, ids("a"))).toBe(false);
  });

  it("空闲库页持续观察共享进度，首个空快照不会触发额外刷新", () => {
    expect(shouldRefreshAfterProgress(null, ids(), false, null, 0)).toBe(false);
  });

  it("有界活动页之外的任务完成，总数减少时仍刷新", () => {
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids("a", "b"), false, 49, 48)).toBe(true);
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids("a", "b"), false, 48, 48)).toBe(false);
  });

  it("并发两个作品，先完成一个、另一个仍在跑 → 立即刷新（回归：不能等全部完成）", () => {
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids("b"))).toBe(true);
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids("a"))).toBe(true);
  });

  it("最后一个跑完（2→0 / 1→0）→ 刷新一次", () => {
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids())).toBe(true);
    expect(shouldRefreshAfterProgress(ids("a"), ids())).toBe(true);
  });

  it("新增 run、或活跃集合没变化都不刷新（没有刷新循环）", () => {
    expect(shouldRefreshAfterProgress(ids(), ids())).toBe(false);
    expect(shouldRefreshAfterProgress(ids("a"), ids("a"))).toBe(false);
    expect(shouldRefreshAfterProgress(ids("a"), ids("a", "b"))).toBe(false);
  });

  it("一进一出（取消换源等）也算有 run 进入终态", () => {
    expect(shouldRefreshAfterProgress(ids("a", "b"), ids("b", "c"))).toBe(true);
  });
});
