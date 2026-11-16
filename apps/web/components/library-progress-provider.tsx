"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  activeTotalOf,
  getLibraryProgressState,
  refreshLibraryProgress,
  subscribeLibraryProgress,
  type LibraryProgressState,
} from "../lib/library-progress-client";

/**
 * 原任务页共享进度的 React 接线（F13）。
 *
 * **不需要 root provider，也不需要 app/layout.tsx 挂载**：去重发生在
 * `lib/library-progress-client.ts` 的模块级注册表里，活动页、侧边栏角标、
 * 每张卡片各自调用下面的 hook 即可，同 (账号代次, 网盘) 只会有一条 SSE。
 * 这些 hook 只是 `useSyncExternalStore` 的薄封装：SSR 时返回同一份空状态，
 * 水合后立即接上共享快照。
 */

/** 共享进度状态。`storageId` 为 null/undefined = 账号级（全部网盘）。 */
export function useLibraryProgress(
  storageId: string | null | undefined,
  accountKey?: string | null,
): LibraryProgressState {
  const storage = storageId ?? null;
  const account = accountKey ?? null;
  const subscribe = useCallback(
    (onChange: () => void) => subscribeLibraryProgress({ storageId: storage, accountKey: account }, onChange),
    [storage, account],
  );
  const snapshot = useCallback(
    () => getLibraryProgressState({ storageId: storage, accountKey: account }),
    [storage, account],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** 活跃任务数（导航角标用）。`0` 也包含“还没拿到快照”。 */
export function useLibraryActiveTotal(
  storageId: string | null | undefined,
  accountKey?: string | null,
): number {
  return activeTotalOf(useLibraryProgress(storageId, accountKey)) ?? 0;
}

/** 用户主动取消/重试后立刻重读一次该 scope，不用等下一个周期快照。 */
export function useLibraryProgressRefresh(
  storageId: string | null | undefined,
  accountKey?: string | null,
): () => void {
  const storage = storageId ?? null;
  const account = accountKey ?? null;
  return useCallback(
    () => refreshLibraryProgress({ storageId: storage, accountKey: account }),
    [storage, account],
  );
}
