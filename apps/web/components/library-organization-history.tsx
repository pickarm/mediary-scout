"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { extractMediaTechTags } from "@media-track/workflow/naming";
import {
  loadOrganizationHistory,
  type OrganizationHistoryItem,
  type OrganizationHistoryPage,
  type OrganizationHistoryStatusFilter,
} from "./library-organization-client";
import styles from "./library-organization-history.module.css";

const ACTIVE_POLL_MS = 3_000;
const IDLE_POLL_MS = 12_000;

const STATUS_TABS: readonly { id: OrganizationHistoryStatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "verified", label: "已整理" },
  { id: "failed", label: "失败" },
];

export function LibraryOrganizationHistory({
  storageId,
  refreshTrigger = 0,
}: {
  storageId: string | null;
  refreshTrigger?: number;
}) {
  const [status, setStatus] = useState<OrganizationHistoryStatusFilter>("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [liveRefresh, setLiveRefresh] = useState(true);
  const [data, setData] = useState<OrganizationHistoryPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const lastTriggerRef = useRef(refreshTrigger);

  const fetchHistory = useCallback(async (
    targetStorageId: string,
    nextPage: number,
    nextPageSize: number,
    nextStatus: OrganizationHistoryStatusFilter,
    background: boolean,
  ) => {
    const scopeGen = generation.current;
    if (!background) {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      setLoading(true);
    }
    const signal = controllerRef.current?.signal;
    try {
      const result = await loadOrganizationHistory(
        targetStorageId,
        { page: nextPage, pageSize: nextPageSize, status: nextStatus },
        signal,
      );
      if (generation.current !== scopeGen || signal?.aborted) return;
      setData(result);
      setError(null);
      if (result.totalPages > 0 && nextPage > result.totalPages) {
        setPage(result.totalPages);
      }
    } catch (cause) {
      if (signal?.aborted || generation.current !== scopeGen) return;
      setError(cause instanceof Error ? cause.message : "读取整理记录失败。");
    } finally {
      if (generation.current === scopeGen && !background) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = new AbortController();
    setPage(1);
    setData(null);
    setError(null);
    if (storageId) {
      void fetchHistory(storageId, 1, pageSize, status, false);
    }
    return () => {
      controllerRef.current?.abort();
    };
  }, [storageId, pageSize, status, fetchHistory]);

  useEffect(() => {
    if (!storageId) return;
    if (refreshTrigger !== lastTriggerRef.current) {
      lastTriggerRef.current = refreshTrigger;
      setPage(1);
      void fetchHistory(storageId, 1, pageSize, status, false);
      return;
    }
    void fetchHistory(storageId, page, pageSize, status, false);
  }, [storageId, page, pageSize, status, refreshTrigger, fetchHistory]);

  const hasActiveWork = data?.activeSummary.hasActiveWork ?? false;

  useEffect(() => {
    if (!storageId || !liveRefresh) return;
    const intervalMs = hasActiveWork ? ACTIVE_POLL_MS : IDLE_POLL_MS;
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      void fetchHistory(storageId, page, pageSize, status, true);
    };
    const timer = window.setInterval(poll, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [storageId, liveRefresh, hasActiveWork, page, pageSize, status, fetchHistory]);

  const totalPages = data?.totalPages ?? 1;
  const pageNumbers = useMemo(() => visiblePageNumbers(page, totalPages), [page, totalPages]);

  const countFor = (id: OrganizationHistoryStatusFilter): number => {
    if (!data) return 0;
    if (id === "all") return data.counts.all;
    if (id === "active") return data.counts.running + data.counts.planned;
    return data.counts[id];
  };

  if (!storageId) return null;

  const latestScan = data?.activeSummary.latestScanTask ?? null;
  const scanRunning = Boolean(latestScan && ["queued", "running", "cancelling"].includes(latestScan.status));

  return (
    <section className={`panel ${styles.panel}`} aria-label="整理记录">
      <div className={styles.header}>
        <div>
          <div className={styles.headerTitle}>
            <h2>整理记录</h2>
            <span className={`${styles.liveBadge} ${liveRefresh ? "" : styles.liveBadgeIdle}`}>
              <i className={styles.liveDot} />
              {liveRefresh
                ? (hasActiveWork ? "实时刷新中（每 3 秒）" : "自动刷新中（空闲每 12 秒）")
                : "自动刷新已暂停"}
            </span>
          </div>
          <p>按最近更新倒序展示当前网盘的重命名与归档明细，支持翻页与实时跟踪执行进度。</p>
        </div>
        <div className={styles.headerControls}>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setLiveRefresh((current) => !current)}
          >
            {liveRefresh ? <><Pause size={13} />暂停刷新</> : <><Play size={13} />开启实时刷新</>}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void fetchHistory(storageId, page, pageSize, status, false)}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? styles.spin : ""} />刷新
          </button>
        </div>
      </div>

      {hasActiveWork && (
        <div className={styles.activeBanner} role="status">
          <div className={styles.activeStats}>
            {scanRunning && latestScan && (
              <span>
                正在扫描目录：<strong>{latestScan.directoriesDone}</strong> / {latestScan.directoriesDiscovered} · 已发现文件 <strong>{latestScan.filesDiscovered}</strong>
              </span>
            )}
            {data && (data.activeSummary.activePlanCount > 0 || data.counts.running > 0) && (
              <span>
                正在并发整理：处理中 <strong>{data.counts.running}</strong> · 排队中 <strong>{data.counts.planned}</strong>
              </span>
            )}
          </div>
          <span>系统自动完成扫描 → 复用数据库身份 → 并发重命名归档</span>
        </div>
      )}

      <div className={styles.filtersBar}>
        <div className={styles.filterPills} role="group" aria-label="记录状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`${styles.filterPill} ${status === tab.id ? styles.filterPillActive : ""}`}
              onClick={() => {
                setStatus(tab.id);
                setPage(1);
              }}
            >
              <span>{tab.label}</span>
              <span>{countFor(tab.id)}</span>
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className={styles.errorAlert} role="alert">
          <CircleAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading && !data ? (
        <div className={styles.empty}>
          <LoaderCircle size={18} className={styles.spin} /> 正在读取整理记录…
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className={styles.empty}>
          {status === "all"
            ? "当前网盘还没有整理记录。勾选上方目录并点击「开始单次整理」或新增入库后，记录会实时显示在这里。"
            : "当前筛选条件下没有整理记录。"}
        </div>
      ) : (
        <div className={styles.list}>
          {data.items.map((item) => (
            <HistoryRow key={`${item.taskId}:${item.operationKey}:${item.operationId}`} item={item} />
          ))}
        </div>
      )}

      <div className={styles.pagination}>
        <div className={styles.pageInfo}>
          <span>共 {data?.total ?? 0} 条 · 第 {page} / {totalPages} 页</span>
          <label>
            每页{" "}
            <select
              aria-label="每页记录数"
              className={styles.pageSizeSelect}
              value={pageSize}
              onChange={(event) => {
                setPageSize(Number(event.target.value));
                setPage(1);
              }}
            >
              <option value={20}>20 条</option>
              <option value={50}>50 条</option>
            </select>
          </label>
        </div>

        <div className={styles.pageControls} aria-label="整理记录分页">
          <button
            type="button"
            className="secondary-button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={page <= 1 || loading}
          >
            <ChevronLeft size={14} />上一页
          </button>
          {pageNumbers.map((entry, index) => (
            entry === "ellipsis"
              ? <span key={`ellipsis-${index}`} className={styles.ellipsis}>…</span>
              : (
                <button
                  key={entry}
                  type="button"
                  className={`${styles.pageNumber} ${entry === page ? styles.pageNumberActive : ""}`}
                  onClick={() => setPage(entry)}
                  disabled={loading}
                  aria-current={entry === page ? "page" : undefined}
                >
                  {entry}
                </button>
              )
          ))}
          <button
            type="button"
            className="secondary-button"
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            disabled={page >= totalPages || loading}
          >
            下一页<ChevronRight size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}

function HistoryRow({ item }: { item: OrganizationHistoryItem }) {
  const tech = extractMediaTechTags(item.originalName);
  const badges = [tech.resolution, tech.videoSource, tech.dynamicRange, tech.videoCodec, tech.audioCodec, tech.fps, tech.releaseGroup].filter(Boolean);
  const isSubtitle = item.pairedFileId !== item.fileId;
  const identityLabel = item.identity
    ? `${item.identity.title}${item.identity.year ? ` (${item.identity.year})` : ""}${item.identity.episodeCode ? ` · ${item.identity.episodeCode}` : ""}`
    : item.targetName;

  return (
    <article className={styles.row}>
      <div className={styles.rowTop}>
        <div className={styles.rowTitleGroup}>
          <span className={`${styles.statusBadge} ${styles[`status_${item.status}`] ?? ""}`}>
            {statusLabel(item.status)}
          </span>
          <strong>{identityLabel}</strong>
          {isSubtitle && <span className={styles.subtitleTag}>随行字幕</span>}
        </div>
        <span className={styles.rowTime}>{formatDateTime(item.updatedAt)}</span>
      </div>

      {badges.length > 0 && (
        <div className={styles.techRow}>
          {badges.map((badge) => (
            <span key={badge} className={styles.techChip}>{badge}</span>
          ))}
        </div>
      )}

      <div className={styles.pathBox}>
        <span className={styles.pathOld}>原文件：{item.originalName}</span>
        <span className={styles.pathNew}>目标路径：{item.targetRelativePath}</span>
      </div>

      {item.error && <div className={styles.errorBox}>失败原因：{item.error}</div>}
    </article>
  );
}

function statusLabel(status: OrganizationHistoryItem["status"]): string {
  const labels: Record<OrganizationHistoryItem["status"], string> = {
    planned: "排队中",
    running: "处理中",
    verified: "已整理",
    failed: "失败",
  };
  return labels[status];
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(date);
}

function visiblePageNumbers(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  const sorted = [...pages].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const value = sorted[index]!;
    if (index > 0 && value - sorted[index - 1]! > 1) {
      result.push("ellipsis");
    }
    result.push(value);
  }
  return result;
}
