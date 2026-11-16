"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronDown, ChevronRight, Clock3, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { showHref } from "@media-track/workflow/scope";
import type {
  ActivityActiveRun,
  ActivityCompletedItem,
  ActivityView,
  RetryRefusalReason,
} from "../lib/activity-view";
// The run kind via the view type, NOT the workflow root barrel: the barrel `export *`s
// ./postgres.js (pg), and a type-only barrel import can drag pg into this client bundle
// (see request-track-button.tsx).
type RunKind = ActivityActiveRun["kind"];
import { activeRunLabel } from "../lib/activity-season-label";
import { isDemoModeClient } from "../lib/demo-mode";
import { demoCompletedItems, demoInProgressActivityItems } from "../lib/demo-session";
import { useDemoAcquisitions, useDemoInProgress } from "../lib/use-demo-session";
import {
  LibraryProgressDeniedError,
  activityViewFromPage,
  loadLibraryActivityPage,
  resolveLibraryProgressScope,
} from "../lib/library-progress-client";
import type {
  ActivityActiveRunSummary,
  PostgresActivityPage,
} from "@media-track/workflow/activity-query";
import { useLibraryProgress, useLibraryProgressRefresh } from "./library-progress-provider";

const POSTER = "https://image.tmdb.org/t/p/w185";
const EMPTY_SEEN: ReadonlySet<string> = new Set<string>();

/**
 * 本次浏览「见过它在获取」的 runId 观察集合。**按 scope 隔离**：换网盘/换账号后
 * 必须整体清空，否则上一 scope 的 runId 会让本 scope 的已完成区混入别人的完成项。
 * 返回 true = 集合有变化（需要一次重渲染来重算已完成区）。
 */
export interface SeenActiveTracker {
  scopeKey: string | null;
  seen: Set<string>;
}

/** 观察集合的 scope 键：账号代次 + 网盘 + registry generation。任一变化都清空。 */
export function activeScopeKey(
  accountKey: string | null | undefined,
  storageId: string | null | undefined,
  generation = 0,
): string {
  return JSON.stringify([accountKey ?? null, storageId ?? null, generation]);
}

export function observeActiveRuns(
  tracker: SeenActiveTracker,
  scopeKey: string,
  runs: readonly { runId: string }[],
): boolean {
  let changed = false;
  if (tracker.scopeKey !== scopeKey) {
    tracker.scopeKey = scopeKey;
    tracker.seen.clear();
    changed = true;
  }
  for (const run of runs) {
    if (tracker.seen.has(run.runId)) continue;
    tracker.seen.add(run.runId);
    changed = true;
  }
  return changed;
}

/** 观察集合也必须同步按 authority 门控，不能等 effect 清空后才隐藏旧完成项。 */
export function visibleObservedRuns(
  tracker: SeenActiveTracker,
  authority: string | null,
): ReadonlySet<string> {
  return authority !== null && tracker.scopeKey === authority ? tracker.seen : EMPTY_SEEN;
}

/**
 * 页外（第 2..N 页）按需读取的进行中任务。
 *
 * 共享 SSE 只覆盖第一页并保持实时；页外页是**快照**，所以必须带着读取时刻一起
 * 展示，并给一个「刷新列表」重读入口 —— 页外任务完成/取消后不能继续无声地显示
 * 成排队中/获取中。
 */
export interface TailPagesState {
  /** account + storage + registry generation；旧绑定的页外行不得参与渲染。 */
  binding: string | null;
  runs: ActivityActiveRunSummary[];
  /** 已读到的最后一页（1 = 只有共享的第一页）。 */
  pages: number;
  /** 最后一页之后还有数据。 */
  hasMore: boolean;
  /** 最近一次读取完成时的本地时刻标签（快照提示用）。 */
  at: string | null;
}

export const EMPTY_TAIL: TailPagesState = {
  binding: null,
  runs: [],
  pages: 1,
  hasMore: false,
  at: null,
};

/** 只有与当前 authority（账号+网盘+代次）完全匹配的尾页才允许进入渲染。 */
export function visibleTailForAuthority(
  tail: TailPagesState,
  authority: string | null,
): TailPagesState {
  return authority !== null && tail.binding === authority ? tail : EMPTY_TAIL;
}

/** 还能不能继续往下读：第一页看共享快照，展开后看最后一页的 hasMore。 */
export function canLoadMoreActive(
  page: PostgresActivityPage | null,
  tail: TailPagesState,
): boolean {
  if (!page) return false;
  return tail.pages > 1 ? tail.hasMore : page.active.hasMore;
}

/**
 * 快照说第一页已覆盖全部活跃任务时，页外读到的行必然全部过期（完成或取消）。
 * 必须丢弃，而不是继续把旧状态当实时显示。
 */
export function tailIsStale(page: PostgresActivityPage, tail: TailPagesState): boolean {
  return tail.pages > 1 && !page.active.hasMore;
}

export type TailChangeAction = "none" | "refresh" | "clear";

/**
 * 取消/重试后怎么处理已展开的页外页：
 * - 没展开（只有共享第一页）→ 无需处理；
 * - 已稳定展开 → 重读已展开范围，页面原地更新；
 * - 正在读取 → 清空并作废在途响应（旧响应不可信，用户可重新展开）。
 */
export function tailActionAfterActivityChanged(
  tail: TailPagesState,
  busy: boolean,
): TailChangeAction {
  if (tail.pages <= 1) return "none";
  return busy ? "clear" : "refresh";
}

export interface TailRangeResult {
  runs: ActivityActiveRunSummary[];
  pages: number;
  hasMore: boolean;
}

/**
 * 读取 `firstPage..lastPage` 的页外摘要。页外页只用于显示，不再退回全量接口。
 * `isCurrent` 在每一页返回后检查：切盘/重复读取时旧响应必须丢弃。
 */
export async function loadTailRange(
  scope: ReturnType<typeof resolveLibraryProgressScope>,
  firstPage: number,
  lastPage: number,
  isCurrent: () => boolean = () => true,
  loadPage: typeof loadLibraryActivityPage = loadLibraryActivityPage,
): Promise<TailRangeResult | null> {
  const runs: ActivityActiveRunSummary[] = [];
  let pages = firstPage - 1;
  let hasMore = false;
  for (let target = firstPage; target <= lastPage; target += 1) {
    const result = await loadPage(scope, target);
    if (!isCurrent()) return null;
    runs.push(...result.active.items);
    pages = target;
    hasMore = result.active.hasMore;
    if (!hasMore) break;
  }
  return { runs, pages, hasMore };
}

/** 追加 = 保留已展开页；刷新 = 用服务端新结果整体替换旧快照。 */
export function mergeTailPages(
  mode: "append" | "refresh",
  current: TailPagesState,
  result: TailRangeResult,
  at: string | null,
  binding: string,
): TailPagesState {
  return {
    binding,
    runs: mode === "append" ? [...current.runs, ...result.runs] : result.runs,
    pages: result.pages,
    hasMore: result.hasMore,
    at,
  };
}

/** 页外快照提示：有页外行时必须明确它不是实时状态，并给重读入口。 */
export function TailSnapshotNotice({
  tail,
  busy,
  onRefresh,
}: {
  tail: TailPagesState;
  busy: boolean;
  onRefresh: () => void;
}) {
  if (tail.pages <= 1) return null;
  return (
    <div className="act-empty" role="note">
      <span className="act-sub">
        页外任务为{tail.at ? ` ${tail.at} ` : "最近一次"}读取的快照，任务完成或取消后请刷新列表。
      </span>
      <button type="button" className="act-retry" disabled={busy} onClick={onRefresh}>
        {busy ? "刷新中…" : "刷新列表"}
      </button>
    </div>
  );
}

export function ActivityFeed({
  storageId,
  accountKey,
}: {
  storageId?: string | undefined;
  accountKey?: string | null | undefined;
}) {
  // 已完成 is session-scoped by OBSERVATION: the runIds this browser saw active.
  // Robust to notification createdAt timing (a since-filter wrongly dropped runs
  // the user opened the page after — createdAt ≈ run-start, not finish).
  const observed = useRef<SeenActiveTracker>({ scopeKey: null, seen: new Set<string>() });
  // Re-render once when newly observed runIds appear, so 已完成 can show them
  // without waiting for the next snapshot.
  const [, bumpSeen] = useState(0);
  const scope = storageId ?? null;
  const account = accountKey ?? null;
  // One shared, page-wide progress subscription (SSE + unified low-frequency
  // fallback). The old code polled /api/activity every 2.6s from this component
  // AND from every card AND from the nav badge.
  const state = useLibraryProgress(scope, account);
  const refreshProgress = useLibraryProgressRefresh(scope, account);
  const scopeKey = activeScopeKey(account, scope, state.generation);
  const page = state.page;
  // Denied / pre-snapshot is not an empty queue: it revokes every tail row and
  // runId-bound button immediately, including the first render after the state
  // flips and before effects get a chance to clear local state.
  const authorized = page !== null && state.status !== "denied";
  const authority = authorized ? scopeKey : null;
  const view: ActivityView | null = authorized && page ? activityViewFromPage(page) : null;

  // Bounded pagination for 获取中: page 1 stays LIVE through the shared SSE; further
  // pages are read ON DEMAND with the same bounded DTO and request params (never the
  // old full /api/activity list) and appended until the server reports no more.
  const [tail, setTail] = useState<TailPagesState>(EMPTY_TAIL);
  const [tailBusyBinding, setTailBusyBinding] = useState<string | null>(null);
  const [tailErrorState, setTailErrorState] = useState<{ binding: string; message: string } | null>(null);
  const tailRequest = useRef(0);
  const authorityRef = useRef<string | null>(authority);
  authorityRef.current = authority;

  // Derive render-visible tail state synchronously. The clear effect below is for
  // cleanup; it is deliberately not the security boundary, because it runs after
  // the first post-scope/post-generation render.
  const liveTail = visibleTailForAuthority(tail, authority);
  const tailBusy = authority !== null && tailBusyBinding === authority;
  const tailError =
    authority !== null && tailErrorState?.binding === authority ? tailErrorState.message : null;
  const observedSeen = visibleObservedRuns(observed.current, authority);

  // Scope / generation / authorization transition: invalidate in-flight tails and
  // release all local state for the old authority. Rendering already gates by
  // `liveTail`; this effect removes the stale backing state.
  useEffect(() => {
    tailRequest.current += 1;
    setTail(EMPTY_TAIL);
    setTailBusyBinding(null);
    setTailErrorState(null);
  }, [authority]);

  const primaryRuns = authorized ? page?.active.items ?? [] : [];
  const primaryIds = new Set(primaryRuns.map((run) => run.runId));
  const activeRuns = [
    ...primaryRuns,
    ...liveTail.runs.filter((run) => !primaryIds.has(run.runId)),
  ];
  const activeSignature = activeRuns.map((run) => run.runId).join("|");

  useEffect(() => {
    if (authority === null) {
      if (observed.current.scopeKey !== null || observed.current.seen.size > 0) {
        observed.current.scopeKey = null;
        observed.current.seen.clear();
        bumpSeen((n) => n + 1);
      }
      return;
    }
    if (observeActiveRuns(observed.current, authority, activeRuns)) bumpSeen((n) => n + 1);
    // authority + activeSignature encode this render's generation/scope/runId set.
  }, [authority, activeSignature]);

  // 第一页已经覆盖全部活跃任务时，页外补读的行必然都已过期：直接丢弃，
  // 避免已完成的页外任务仍以「获取中」挂在列表里。
  useEffect(() => {
    if (!page || !authorized || !tailIsStale(page, liveTail)) return;
    tailRequest.current += 1;
    setTail(EMPTY_TAIL);
    setTailBusyBinding(null);
  }, [authorized, page, liveTail]);

  /** 读取页外页：`append` 追加下一页，`refresh` 重读已展开的全部页。 */
  const fetchTail = async (mode: "append" | "refresh"): Promise<void> => {
    if (!page || !authorized || tailBusy) return;
    const requestAuthority = authorityRef.current;
    if (requestAuthority === null) return;
    const first = mode === "append" ? liveTail.pages + 1 : 2;
    const last = mode === "append" ? liveTail.pages + 1 : liveTail.pages;
    if (first > last) return;
    const request = tailRequest.current + 1;
    tailRequest.current = request;
    setTailBusyBinding(requestAuthority);
    setTailErrorState(null);
    const resolved = resolveLibraryProgressScope({ storageId: scope, accountKey: account });
    try {
      const result = await loadTailRange(
        resolved,
        first,
        last,
        () => tailRequest.current === request && authorityRef.current === requestAuthority,
      );
      if (!result || authorityRef.current !== requestAuthority) return; // 换盘/换代次/denied 的旧响应
      const at = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      setTail((current) => {
        const base = current.binding === requestAuthority ? current : EMPTY_TAIL;
        const next = mergeTailPages(mode, base, result, at, requestAuthority);
        // 刷新后页外已没有任务：收起页外状态，不留下空的「旧快照」提示。
        return next.runs.length === 0 && !next.hasMore ? EMPTY_TAIL : next;
      });
    } catch (error) {
      if (tailRequest.current !== request || authorityRef.current !== requestAuthority) return;
      const denied = error instanceof LibraryProgressDeniedError;
      // 页外 403 本身就是失效信号：先撤掉旧 tail 行与 runId 操作，
      // 不等共享 SSE/轮询下一次把整页状态标成 denied。
      if (denied) setTail(EMPTY_TAIL);
      setTailErrorState({
        binding: requestAuthority,
        message:
          denied
            ? "登录状态或网盘归属已失效，无法读取页外任务。"
            : "读取页外任务失败，请稍后再试。",
      });
    } finally {
      if (tailRequest.current === request && authorityRef.current === requestAuthority) {
        setTailBusyBinding(null);
      }
    }
  };

  // 取消/重试改变服务端任务集合：共享第一页与已展开的页外页都要重读，
  // 否则页外那一行仍会显示成「排队中/获取中」。
  const handleActivityChanged = (): void => {
    if (authorityRef.current === null) return;
    refreshProgress();
    const action = tailActionAfterActivityChanged(liveTail, tailBusy);
    if (action === "refresh") {
      void fetchTail("refresh");
    } else if (action === "clear") {
      // 作废在途读取；旧结果回来时 request 序号已不匹配。
      tailRequest.current += 1;
      setTail(EMPTY_TAIL);
      setTailBusyBinding(null);
    }
  };

  const running = activeRuns.filter((run) => run.status === "running");
  const queued = activeRuns
    .filter((run) => run.status === "queued")
    .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  // Only show completions for runs THIS session watched go active → done.
  const completed = (view?.recentCompleted ?? []).filter((item) =>
    observedSeen.has(item.workflowRunId),
  );
  const remaining = page ? Math.max(0, page.active.total - activeRuns.length) : 0;
  const canLoadMore = authorized ? canLoadMoreActive(page, liveTail) : false;
  // Demo: acquisitions are client-only (no DB run) → surface this session's
  // acquired titles as completed items, and in-progress playbacks as live 获取中
  // rows, so the activity page reflects them like production.
  const demoAcq = useDemoAcquisitions();
  const isDemo = isDemoModeClient();
  const demoDone = isDemo ? demoCompletedItems(demoAcq) : [];
  const demoActive = demoInProgressActivityItems(useDemoInProgress());
  const allCompleted = [...demoDone, ...completed];

  return (
    <div className="activity">
      {state.status === "denied" ? (
        <p className="act-empty">登录状态或网盘归属已失效，请重新登录后查看获取进度。</p>
      ) : state.status === "polling" ? (
        <p className="act-empty">实时连接已断开，正在低频同步进度。</p>
      ) : null}
      <section className="act-section">
        <div className="act-section-head act-section-head-static">获取中</div>
        {running.length === 0 && demoActive.length === 0 ? (
          <p className="act-empty">{page === null ? "正在读取获取进度…" : "当前没有正在处理的任务。"}</p>
        ) : (
          <>
            {demoActive.map((item) => (
              <DemoRunningRow item={item} key={item.id} />
            ))}
            {running.map((run) => (
              <RunningRow run={run} storageId={storageId} key={run.runId} />
            ))}
          </>
        )}
        {liveTail.pages > 1 ? (
          <TailSnapshotNotice
            tail={liveTail}
            busy={tailBusy}
            onRefresh={() => void fetchTail("refresh")}
          />
        ) : null}
        {canLoadMore || tailError !== null ? (
          <div className="act-empty">
            {canLoadMore && remaining > 0 ? <span>还有 {remaining} 个进行中任务未显示。</span> : null}
            {canLoadMore ? (
              <button
                type="button"
                className="act-retry"
                title="页外任务为按需读取的摘要快照"
                disabled={tailBusy}
                onClick={() => void fetchTail("append")}
              >
                {tailBusy ? "加载中…" : "加载更多"}
              </button>
            ) : null}
            {tailError !== null ? <span className="act-sub">{tailError}</span> : null}
          </div>
        ) : null}
      </section>

      <CollapsibleSection title="排队中" count={queued.length} defaultOpen>
        {queued.length === 0 ? (
          <p className="act-empty">没有排队的任务。</p>
        ) : (
          queued.map((run) => (
            <QueuedRow run={run} key={run.runId} onChanged={handleActivityChanged} />
          ))
        )}
      </CollapsibleSection>

      <CollapsibleSection title="已完成" count={allCompleted.length} note="仅本次浏览" defaultOpen>
        {allCompleted.length === 0 ? (
          <p className="act-empty">本次浏览还没有完成的任务，历史可在通知查看。</p>
        ) : (
          allCompleted.map((item) => (
            <CompletedRow item={item} key={item.workflowRunId} onChanged={handleActivityChanged} />
          ))
        )}
      </CollapsibleSection>
    </div>
  );
}

function poster(posterPath: string | null, title: string, tone: string) {
  return posterPath ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="act-poster" src={`${POSTER}${posterPath}`} alt="" loading="lazy" />
  ) : (
    <span className={`act-poster act-poster-fallback tone-${tone}`}>{title.slice(0, 2)}</span>
  );
}

/** 「第 1/2 季」, or 「换源」 for a replace run (title-level). */
function seasonLabel(run: ActivityActiveRun): string {
  return activeRunLabel({ ...run, seasonNumbers: run.seasonNumbers ?? [] });
}

function RunningRow({ run, storageId }: { run: ActivityActiveRun; storageId?: string | undefined }) {
  const percent = Math.max(3, Math.min(100, run.progress?.percent ?? 3));
  const headline =
    run.progress?.needed && run.progress.needed > 0
      ? `已确认 ${run.progress.obtained ?? 0} / ${run.progress.needed} 集`
      : null;
  return (
    <Link className="act-row act-row-active" href={showHref(run.tmdbId, "library", storageId, run.type)}>
      {poster(run.posterPath, run.title, "info")}
      <div className="act-row-body">
        <div className="act-row-head">
          <strong>{run.title}</strong>
          {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
          {headline ? <span className="act-frac">{headline}</span> : null}
        </div>
        <div className="act-bar">
          <div className="act-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="act-ticker-row">
          <Loader2 size={14} className="act-spin" aria-hidden />
          <Ticker text={run.progress?.activity ?? "正在准备…"} />
        </div>
      </div>
    </Link>
  );
}

function Ticker({ text }: { text: string }) {
  // Two absolutely-stacked lines: the outgoing slides up & out, the incoming slides
  // up into place. On collapse we keep ONLY the incoming — its key is stable, so
  // React preserves the element (no remount) and it's already at rest (translateY
  // 0 = the is-in end state) → seamless, no "jump in from the top" flash.
  const idRef = useRef(0);
  const [lines, setLines] = useState<{ id: number; text: string }[]>([{ id: 0, text }]);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) {
      return;
    }
    prev.current = text;
    idRef.current += 1;
    const id = idRef.current;
    setLines((current) => {
      const outgoing = current[current.length - 1];
      return outgoing ? [outgoing, { id, text }] : [{ id, text }];
    });
    const timer = setTimeout(() => setLines([{ id, text }]), 380);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="act-ticker" aria-live="polite">
      {lines.map((line, index) => (
        <div
          key={line.id}
          className={`act-ticker-line${lines.length > 1 ? (index === 0 ? " is-out" : " is-in") : ""}`}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
}

type DemoActivityItem = ReturnType<typeof demoInProgressActivityItems>[number];

/** Demo-only 获取中 row: clock-driven progress, no DB run (not a link). Mirrors
 *  RunningRow's poster + progress bar + step layout. */
function DemoRunningRow({ item }: { item: DemoActivityItem }) {
  const percent = Math.max(3, Math.min(100, item.progress));
  return (
    <div className="act-row act-row-active">
      {poster(item.posterPath, item.title, "info")}
      <div className="act-row-body">
        <div className="act-row-head">
          <strong>{item.title}</strong>
        </div>
        <div className="act-bar">
          <div className="act-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <div className="act-ticker-row">
          <Loader2 size={14} className="act-spin" aria-hidden />
          <Ticker text={item.step} />
        </div>
      </div>
    </div>
  );
}

function QueuedRow({ run, onChanged }: { run: ActivityActiveRun; onChanged: () => void }) {
  return (
    <div className="act-row act-row-queued">
      {poster(run.posterPath, run.title, "muted")}
      <div className="act-row-body act-row-inline">
        <strong>{run.title}</strong>
        {seasonLabel(run) ? <span className="act-sub">{seasonLabel(run)}</span> : null}
        <span className="act-pill">
          <Clock3 size={12} aria-hidden />第 {run.queuePosition} 位{run.missingCount > 0 ? ` · 缺 ${run.missingCount} 集` : ""}
        </span>
        <CancelButton runId={run.runId} title={run.title} kind={run.kind} onChanged={onChanged} />
      </div>
    </div>
  );
}

function completedPillLabel(status: ActivityCompletedItem["status"]): string {
  switch (status) {
    case "no_coverage":
      return "暂无资源";
    case "partial":
      return "部分入库";
    case "failed":
      return "获取失败";
    case "retrying":
      return "重试中…";
    case "replaced":
      return "已换源";
    default:
      return "已入库";
  }
}

function CompletedRow({ item, onChanged }: { item: ActivityCompletedItem; onChanged: () => void }) {
  const ok =
    item.status === "complete" || item.status === "acquired" || item.status === "airing" || item.status === "replaced";
  const failed = item.status === "failed";
  return (
    <div className="act-row act-row-done">
      {poster(item.posterPath, item.title, ok ? "success" : "warn")}
      <div className="act-row-body act-row-inline">
        <strong>{item.title}</strong>
        {item.seasonLabel ? <span className="act-sub">{item.seasonLabel}</span> : null}
        <span className={`act-pill ${ok ? "tone-success" : "tone-warn"}`}>
          {ok ? <CheckCircle2 size={12} aria-hidden /> : <TriangleAlert size={12} aria-hidden />}
          {completedPillLabel(item.status)}
        </span>
        {item.sizeText ? <span className="act-sub">{item.sizeText}</span> : null}
        {failed ? <RetryButton runId={item.workflowRunId} title={item.title} onChanged={onChanged} /> : null}
      </div>
    </div>
  );
}

function RetryButton({ runId, title, onChanged }: { runId: string; title: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);

  const retry = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/retry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as {
        status?: string;
        reason?: RetryRefusalReason;
      };
      if (result.status !== "retried") {
        // Distinguish the two refusal causes. "可能已在处理" is wrong — and
        // misleading — for a patrol run: patrols are not queue-claimable, so they
        // can never be retried this way; the user should re-trigger a patrol.
        window.alert(
          result.reason === "kind_not_retriable"
            ? `「${title}」是巡检任务，不能单独重试。请在设置里触发一次巡检，或等待下一次自动巡检。`
            : `「${title}」无法重试（可能已在处理）。`,
        );
      }
      // Re-read the shared snapshot now instead of waiting for the next tick.
      onChanged();
    } catch {
      window.alert("重试失败，请稍后再试。");
    } finally {
      // Always release the spinner — a "not_retriable" (or any non-error) response
      // must not leave the button stuck busy until a full page refresh.
      setBusy(false);
    }
  };

  if (busy) {
    return (
      <span className="act-cancel act-cancel-busy">
        <Loader2 size={14} className="act-spin" aria-hidden />
      </span>
    );
  }
  return (
    <button type="button" className="act-retry" aria-label={`重试获取 ${title}`} onClick={retry}>
      <RotateCcw size={13} aria-hidden /> 重试
    </button>
  );
}

/** What the cancel control says. A queued acquisition takes its title out of the
 *  library with it; a replace run only drops this attempt — the library stays, and the
 *  swap waits for the next patrol (a patrol-queued replace run may carry only 待换
 *  episodes and no message, so the note speaks of the swap). */
export function cancelCopy(kind: RunKind): { action: string; confirm: string; note: string | null } {
  return kind === "replace_request"
    ? { action: "取消这次换源", confirm: "取消这次换源", note: "等下次巡检再换" }
    : { action: "取消获取", confirm: "取消并移出", note: null };
}

function CancelButton({
  runId,
  title,
  kind,
  onChanged,
}: {
  runId: string;
  title: string;
  kind: RunKind;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = cancelCopy(kind);

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/activity/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const result = (await res.json()) as { status?: string };
      if (result.status !== "cancelled") {
        window.alert(`「${title}」已开始处理，无法取消。`);
      }
      // Re-read the shared snapshot now (removed if cancelled, or shown running).
      onChanged();
    } catch {
      window.alert("取消失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  if (busy) {
    return <span className="act-cancel act-cancel-busy"><Loader2 size={14} className="act-spin" aria-hidden /></span>;
  }
  if (confirming) {
    return (
      <span className="act-confirm">
        {copy.note ? <span className="act-confirm-note">{copy.note}</span> : null}
        <span className="act-confirm-buttons">
          <button type="button" className="act-confirm-yes" onClick={cancel}>{copy.confirm}</button>
          <button type="button" className="act-confirm-no" onClick={() => setConfirming(false)}>留着</button>
        </span>
      </span>
    );
  }
  return (
    <button type="button" className="act-cancel" aria-label={`${copy.action} ${title}`} onClick={() => setConfirming(true)}>
      <X size={15} aria-hidden />
    </button>
  );
}

function CollapsibleSection({
  title,
  count,
  note,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  note?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen ?? true);
  return (
    <section className="act-section">
      <button type="button" className="act-section-head" onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
        {title} · {count}
        {note ? <span className="act-section-note">{note}</span> : null}
      </button>
      {open ? <div className="act-rows">{children}</div> : null}
    </section>
  );
}
