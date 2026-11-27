"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, EyeOff, RefreshCw, RotateCcw } from "lucide-react";
import {
  ignoreOrganizedDrifts,
  loadOrganizedDrifts,
  reorganizeDriftedFiles,
  unignoreOrganizedDrifts,
  type OrganizedDriftItem,
  type OrganizedIndexPage,
} from "./library-organization-client";
import styles from "./library-organized-drift-panel.module.css";

const PAGE_SIZE = 10;

export function LibraryOrganizedDriftPanel({
  storageId,
  refreshTrigger = 0,
  frozen = false,
  onReorganized,
}: {
  storageId: string | null;
  refreshTrigger?: number;
  frozen?: boolean;
  onReorganized?: () => void;
}) {
  const [tab, setTab] = useState<"drifted" | "ignored">("drifted");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<OrganizedIndexPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  const fetchList = useCallback(async (targetStorageId: string, nextTab: "drifted" | "ignored", nextPage: number) => {
    const scopeGen = generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const res = await loadOrganizedDrifts(
        targetStorageId,
        { status: nextTab, page: nextPage, pageSize: PAGE_SIZE },
        controller.signal,
      );
      if (generationRef.current !== scopeGen || controller.signal.aborted) return;
      setData(res);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (generationRef.current !== scopeGen) return;
      setError(cause instanceof Error ? cause.message : "加载整理索引变更列表失败。");
    } finally {
      if (generationRef.current === scopeGen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    setPage(1);
    setTab("drifted");
    setNotice(null);
    setError(null);
    if (!storageId) {
      setData(null);
      return;
    }
    void fetchList(storageId, "drifted", 1);
    return () => {
      controllerRef.current?.abort();
    };
  }, [storageId, refreshTrigger, fetchList]);

  useEffect(() => {
    if (!storageId) return;
    void fetchList(storageId, tab, page);
  }, [storageId, tab, page, fetchList]);

  const handleIgnore = async (fileId: string) => {
    if (!storageId || busyId || batchBusy) return;
    setBusyId(fileId);
    setNotice(null);
    setError(null);
    try {
      await ignoreOrganizedDrifts(storageId, [fileId]);
      setNotice("已忽略当前文件名改动；若将来再次改名或切换命名模板，系统将重新提示。");
      await fetchList(storageId, tab, page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "忽略变更失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleUnignore = async (fileId: string) => {
    if (!storageId || busyId || batchBusy) return;
    setBusyId(fileId);
    setNotice(null);
    setError(null);
    try {
      await unignoreOrganizedDrifts(storageId, [fileId]);
      setNotice("已恢复变更提醒。");
      await fetchList(storageId, tab, page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复提醒失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleReorganizeOne = async (fileId: string) => {
    if (!storageId || frozen || busyId || batchBusy) return;
    setBusyId(fileId);
    setNotice(null);
    setError(null);
    try {
      const res = await reorganizeDriftedFiles(storageId, { fileIds: [fileId] });
      setNotice(
        res.queuedFiles > 0
          ? "已提交按当前模板重新整理，可在下方整理记录实时查看进度。"
          : "文件已符合当前模板，无需写入。",
      );
      onReorganized?.();
      await fetchList(storageId, tab, page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "提交重新整理失败。");
    } finally {
      setBusyId(null);
    }
  };

  const handleReorganizeAll = async () => {
    if (!storageId || frozen || busyId || batchBusy) return;
    setBatchBusy(true);
    setNotice(null);
    setError(null);
    try {
      const res = await reorganizeDriftedFiles(storageId, { allDrifted: true });
      setNotice(
        res.queuedFiles > 0
          ? `已批量提交 ${res.queuedFiles} 个变更文件按模板重新整理。`
          : "当前没有需要重新整理的待处理项。",
      );
      onReorganized?.();
      await fetchList(storageId, tab, page);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "批量重新整理失败。");
    } finally {
      setBatchBusy(false);
    }
  };

  if (!storageId || !data) return null;
  if (data.counts.drifted === 0 && data.counts.ignored === 0) {
    return null;
  }

  return (
    <section
      className={`panel ${styles.panel} ${data.counts.drifted === 0 ? styles.panelQuiet : ""}`}
      aria-label="文件名变更提醒"
      data-testid="drift-panel"
    >
      <div className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <AlertTriangle size={17} className={styles.warnIcon} />
            <h2>文件名变更提醒</h2>
            {data.counts.drifted > 0 && (
              <span className={styles.driftCountBadge}>待确认 {data.counts.drifted}</span>
            )}
            <span className={styles.indexBadge}>已索引 {data.counts.totalIndexed} 项</span>
          </div>
          <p className={styles.sub}>
            扫库比对持久化索引时发现以下已整理文件与当前模板不一致，未擅自覆盖；可选择按模板强制整理或忽略本次改动。
          </p>
        </div>
        <div className={styles.controls}>
          {data.counts.drifted > 0 && tab === "drifted" && !frozen && (
            <button
              type="button"
              className="primary-button"
              data-testid="btn-reorganize-all"
              onClick={() => void handleReorganizeAll()}
              disabled={batchBusy || Boolean(busyId)}
            >
              <RefreshCw size={13} />
              {batchBusy ? "提交中…" : "全部按模板重新整理"}
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void fetchList(storageId, tab, page)}
            disabled={loading}
          >
            <RefreshCw size={13} />刷新
          </button>
        </div>
      </div>

      <div className={styles.tabs} role="tablist" aria-label="变更状态切换">
        <button
          type="button"
          role="tab"
          data-testid="drift-tab-drifted"
          aria-selected={tab === "drifted"}
          className={`${styles.tabBtn} ${tab === "drifted" ? styles.tabBtnActive : ""}`}
          onClick={() => { setTab("drifted"); setPage(1); }}
        >
          待处理（{data.counts.drifted}）
        </button>
        <button
          type="button"
          role="tab"
          data-testid="drift-tab-ignored"
          aria-selected={tab === "ignored"}
          className={`${styles.tabBtn} ${tab === "ignored" ? styles.tabBtnActive : ""}`}
          onClick={() => { setTab("ignored"); setPage(1); }}
        >
          已忽略（{data.counts.ignored}）
        </button>
      </div>

      {notice && (
        <div className={styles.notice} role="status">
          <Check size={14} />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
        </div>
      )}

      {data.items.length === 0 ? (
        <div className={styles.empty}>
          {tab === "drifted" ? "当前没有待处理的文件名篡改或模板偏移。" : "当前没有已忽略的变更记录。"}
        </div>
      ) : (
        <div className={styles.list}>
          {data.items.map((item) => (
            <DriftRow
              key={item.fileId}
              item={item}
              tab={tab}
              frozen={frozen}
              busy={busyId === item.fileId || batchBusy}
              onIgnore={() => void handleIgnore(item.fileId)}
              onUnignore={() => void handleUnignore(item.fileId)}
              onReorganize={() => void handleReorganizeOne(item.fileId)}
            />
          ))}
        </div>
      )}

      {data.totalPages > 1 && (
        <div className={styles.pager}>
          <span>第 {data.page} / {data.totalPages} 页</span>
          <button
            type="button"
            className="secondary-button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            <ChevronLeft size={13} />上一页
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={page >= data.totalPages || loading}
            onClick={() => setPage((current) => Math.min(data.totalPages, current + 1))}
          >
            下一页<ChevronRight size={13} />
          </button>
        </div>
      )}
    </section>
  );
}

function DriftRow({
  item,
  tab,
  frozen,
  busy,
  onIgnore,
  onUnignore,
  onReorganize,
}: {
  item: OrganizedDriftItem;
  tab: "drifted" | "ignored";
  frozen: boolean;
  busy: boolean;
  onIgnore: () => void;
  onUnignore: () => void;
  onReorganize: () => void;
}) {
  const titleText = item.identity.mediaType === "movie"
    ? `${item.identity.title}${item.identity.year ? ` (${item.identity.year})` : ""}`
    : `${item.identity.title}${item.identity.year ? ` (${item.identity.year})` : ""}${item.identity.episodeCode ? ` · ${item.identity.episodeCode}` : ""}`;

  return (
    <article className={styles.row} data-testid={`drift-row-${item.fileId}`}>
      <div className={styles.rowTop}>
        <div className={styles.rowTitle}>
          <strong>{titleText}</strong>
          <span className={styles.reasonTag}>{item.driftReason ?? "命名或位置不一致"}</span>
        </div>
        <div className={styles.rowActions}>
          {tab === "drifted" ? (
            <>
              {!frozen && (
                <button
                  type="button"
                  className="primary-button"
                  data-testid={`btn-reorganize-${item.fileId}`}
                  disabled={busy}
                  onClick={onReorganize}
                >
                  <RefreshCw size={12} />按模板重新整理
                </button>
              )}
              <button
                type="button"
                className="secondary-button"
                data-testid={`btn-ignore-${item.fileId}`}
                disabled={busy}
                onClick={onIgnore}
              >
                <EyeOff size={12} />忽略
              </button>
            </>
          ) : (
            <button
              type="button"
              className="secondary-button"
              data-testid={`btn-unignore-${item.fileId}`}
              disabled={busy}
              onClick={onUnignore}
            >
              <RotateCcw size={12} />恢复提醒
            </button>
          )}
        </div>
      </div>
      <div className={styles.diffBox}>
        <div className={styles.currentName}>
          网盘当前：{item.observedRelativePath ?? item.observedName ?? "—"}
        </div>
        <div className={styles.expectedName}>
          模板预期：{item.expectedRelativePath ?? item.organizedRelativePath}
        </div>
      </div>
    </article>
  );
}
