// apps/web/components/library-progress-provider.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 接线测试：这些 hook 只是共享注册表的薄封装。测试运行在 DOM-less 的 node 环境，
 * 所以照 library-quick-find.test.ts 的做法把 React 的 hook 换成可观测的替身：
 * 断言「组件用的是 (网盘, 账号代次) 这个共享 scope」「useSyncExternalStore 的
 * 服务端/客户端快照一致」。真正的去重/清理/重连在
 * lib/library-progress-client.test.ts 覆盖。
 */
const h = vi.hoisted(() => ({
  scopeCalls: [] as unknown[],
  subscriptions: [] as Array<{ scope: unknown; listener: unknown; active: boolean }>,
  refreshes: [] as unknown[],
  state: null as unknown,
  stores: [] as Array<{
    subscribe: (onChange: () => void) => () => void;
    getSnapshot: () => unknown;
    getServer: () => unknown;
  }>,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: (fn: unknown) => fn,
    useSyncExternalStore: (
      subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => unknown,
      getServer: () => unknown,
    ) => {
      h.stores.push({ subscribe, getSnapshot, getServer });
      return getSnapshot();
    },
  };
});

vi.mock("../lib/library-progress-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/library-progress-client")>();
  return {
    ...actual,
    subscribeLibraryProgress: (scope: unknown, listener: unknown) => {
      const record = { scope, listener, active: true };
      h.subscriptions.push(record);
      return () => {
        record.active = false;
      };
    },
    getLibraryProgressState: (scope: unknown) => {
      h.scopeCalls.push(scope);
      return h.state;
    },
    refreshLibraryProgress: (scope: unknown) => {
      h.refreshes.push(scope);
    },
  };
});

import type { PostgresActivityPage } from "@media-track/workflow/activity-query";
import {
  useLibraryActiveTotal,
  useLibraryProgress,
  useLibraryProgressRefresh,
} from "./library-progress-provider";
import type { LibraryProgressState } from "../lib/library-progress-client";

function state(page: PostgresActivityPage | null): LibraryProgressState {
  return {
    key: "k",
    storageId: "d1",
    generation: 0,
    status: page ? "live" : "connecting",
    page,
    observedAt: null,
    source: page ? "stream" : null,
  };
}

function pageWithActive(active: number): PostgresActivityPage {
  return {
    active: { items: [], total: active, page: 1, pageSize: 48, hasMore: false },
    totals: { queued: 0, running: active, active },
    recentCompleted: { items: [], nextCursor: null, hasMore: false },
  };
}

beforeEach(() => {
  h.scopeCalls = [];
  h.subscriptions = [];
  h.refreshes = [];
  h.stores = [];
  h.state = state(null);
});

describe("useLibraryProgress / useLibraryActiveTotal", () => {
  it("同 (网盘, 账号代次) 的两个消费者落到同一个共享 scope", () => {
    useLibraryActiveTotal("d1");
    useLibraryActiveTotal("d1");
    // React 订阅时才真正建立订阅（这里手动触发），scope 必须完全一致 → 注册表去重
    h.stores[0]?.subscribe(() => undefined);
    h.stores[1]?.subscribe(() => undefined);
    expect(h.subscriptions).toHaveLength(2);
    expect(h.subscriptions[0]?.scope).toEqual({ storageId: "d1", accountKey: null });
    expect(h.subscriptions[1]?.scope).toEqual(h.subscriptions[0]?.scope);
    // 服务端快照与客户端快照必须是同一个函数 → 水合不会闪不同的值
    expect(h.stores[0]?.getServer).toBe(h.stores[0]?.getSnapshot);
  });

  it("不同网盘 / 不同账号代次是不同 scope（不会读到别人/上一个账号的快照）", () => {
    useLibraryActiveTotal("d1");
    useLibraryActiveTotal("d2");
    useLibraryActiveTotal("d1", "gen-2");
    for (const store of h.stores) store.subscribe(() => undefined);
    expect(h.subscriptions[0]?.scope).toEqual({ storageId: "d1", accountKey: null });
    expect(h.subscriptions[1]?.scope).toEqual({ storageId: "d2", accountKey: null });
    expect(h.subscriptions[2]?.scope).toEqual({ storageId: "d1", accountKey: "gen-2" });
  });

  it("角标计数来自共享快照的总数；没有快照时按 0 处理（而不是 null 崩掉）", () => {
    h.state = state(pageWithActive(3));
    expect(useLibraryActiveTotal("d1")).toBe(3);
    h.state = state(null);
    expect(useLibraryActiveTotal("d1")).toBe(0);
  });

  it("null 网盘 = 账号级 scope（不传 storageId 给接口）", () => {
    useLibraryProgress(null);
    h.stores[0]?.subscribe(() => undefined);
    expect(h.subscriptions[0]?.scope).toEqual({ storageId: null, accountKey: null });
    expect(h.scopeCalls[0]).toEqual({ storageId: null, accountKey: null });
  });

  it("取消/重试后的主动重读走同一个 scope", () => {
    const refresh = useLibraryProgressRefresh("d1");
    expect(h.refreshes).toHaveLength(0);
    refresh();
    expect(h.refreshes).toEqual([{ storageId: "d1", accountKey: null }]);
  });

  it("卸载时把退订交还注册表（最后一个消费者才关闭连接）", () => {
    useLibraryProgress("d1");
    const unsubscribe = h.stores[0]?.subscribe(() => undefined);
    expect(h.subscriptions[0]?.active).toBe(true);
    unsubscribe?.();
    expect(h.subscriptions[0]?.active).toBe(false);
  });
});
