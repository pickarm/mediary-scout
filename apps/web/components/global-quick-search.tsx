"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Search, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { LibraryQueryItem, LibraryQueryMediaType, LibraryQueryPage, LibraryQueryState } from "@media-track/workflow/library-query";
import { showHref } from "@media-track/workflow/scope";
import { tmdbImageUrl } from "../lib/tmdb-image";
import styles from "./global-quick-search.module.css";

const SEARCH_DEBOUNCE_MS = 200;
const TYPE_LABELS: Record<LibraryQueryMediaType, string> = {
  movie: "电影",
  tv: "电视剧",
  anime: "动漫",
};
const STATE_LABELS: Record<LibraryQueryState, { text: string; tone: string }> = {
  complete: { text: "已入库", tone: styles.badgeGreen ?? "" },
  tracking: { text: "追更中", tone: styles.badgeIndigo ?? "" },
  partial: { text: "有缺集", tone: styles.badgeAmber ?? "" },
  reserved: { text: "预定", tone: styles.badgeBlue ?? "" },
};

export function tmdbOnlineSearchHref(basePath: string, query: string): string {
  const normalizedBase = !basePath || basePath === "/" ? "/" : basePath.replace(/\/+$/u, "");
  return `${normalizedBase}?q=${encodeURIComponent(query)}`;
}

/**
 * 全局快速搜索弹窗与侧栏触发器：
 * - 支持 `Ctrl+K` / `Cmd+K` 全局唤起（输入法组合态下不拦截）；
 * - 实时防抖查询 `/api/library/media?search=<q>&pageSize=8`；
 * - 支持方向键上下选择、回车进入库内详情或跳转到首页在线搜 TMDB。
 */
export function GlobalQuickSearch({
  storageId,
  basePath = "/",
}: {
  storageId?: string | undefined;
  basePath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const [items, setItems] = useState<LibraryQueryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();

  const closeModal = () => {
    setOpen(false);
    setError(null);
  };

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        closeModal();
      }
    };
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setSettledQuery("");
      setItems([]);
      setLoading(false);
      setError(null);
      setActiveIndex(0);
      return;
    }
    const timer = window.setTimeout(() => setSettledQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query]);

  useEffect(() => {
    if (!open || !settledQuery) return;
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ search: settledQuery, pageSize: "8" });
    if (storageId) params.set("storageId", storageId);
    void fetch(`/api/library/media?${params.toString()}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) {
          throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "媒体库搜索失败");
        }
        return body as LibraryQueryPage;
      })
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setActiveIndex(0);
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError(reason instanceof Error ? reason.message : "媒体库搜索失败");
        setItems([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [open, settledQuery, storageId]);

  const trimmed = query.trim();
  const hasTmdbFallback = trimmed.length > 0;
  const selectableCount = items.length + (hasTmdbFallback ? 1 : 0);

  const navigateToItem = (item: LibraryQueryItem) => {
    if (item.acquiring) return;
    closeModal();
    router.push(showHref(item.tmdbId, "library", storageId, item.type));
  };

  const navigateToTmdb = () => {
    if (!trimmed) return;
    closeModal();
    router.push(tmdbOnlineSearchHref(basePath, trimmed));
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key === "ArrowDown") {
      if (selectableCount === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % selectableCount);
      return;
    }
    if (event.key === "ArrowUp") {
      if (selectableCount === 0) return;
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + selectableCount) % selectableCount);
      return;
    }
    if (event.key === "Enter") {
      if (!trimmed) return;
      event.preventDefault();
      if (activeIndex < items.length) {
        const selected = items[activeIndex];
        if (selected && !selected.acquiring) {
          navigateToItem(selected);
        }
        return;
      }
      navigateToTmdb();
    }
  };

  const onBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      closeModal();
    }
  };

  const dialog = open ? (
    <div className={styles.backdrop} role="presentation" onClick={onBackdropClick}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="快速搜索媒体库"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <Search size={17} aria-hidden />
          <input
            ref={inputRef}
            className={styles.input}
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索我的媒体库，或输入片名在线搜 TMDB…"
            aria-label="全局快速搜索"
          />
          <button type="button" className={styles.closeBtn} aria-label="关闭快速搜索" onClick={closeModal}>
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className={styles.body}>
          {!trimmed ? (
            <div className={styles.statusNote}>输入片名快速直达库内作品，或跳转在线搜索 TMDB。</div>
          ) : null}
          {trimmed && loading ? (
            <div className={styles.statusNote} aria-live="polite">正在搜索媒体库…</div>
          ) : null}
          {trimmed && !loading && error ? (
            <div className={styles.statusNote}>{error}</div>
          ) : null}
          {trimmed && !loading && !error && items.length > 0 ? (
            <>
              <div className={styles.sectionLabel}>我的媒体库</div>
              {items.map((item, index) => {
                const thumbSrc = tmdbImageUrl(item.posterPath, "w92");
                const isActive = index === activeIndex;
                const badge = item.acquiring
                  ? { text: "获取中", tone: styles.badgeIndigo ?? "" }
                  : STATE_LABELS[item.state];
                return (
                  <button
                    key={`${item.type}:${item.tmdbId}`}
                    type="button"
                    className={`${styles.resultItem} ${isActive ? styles.resultItemActive : ""}`}
                    aria-selected={isActive}
                    disabled={item.acquiring}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => navigateToItem(item)}
                  >
                    <span className={styles.thumb}>
                      {thumbSrc ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={thumbSrc} alt="" />
                      ) : <span className={styles.thumbFallback}>{item.title.slice(0, 2)}</span>}
                    </span>
                    <span className={styles.itemBody}>
                      <span className={styles.itemTitle}>{item.title}</span>
                      <span className={styles.itemMeta}>
                        <span>{item.year}</span>
                        <span>{TYPE_LABELS[item.type]}</span>
                        {item.type !== "movie" ? (
                          <span>{item.seasonCount} 季 · {item.obtainedEpisodes}/{item.totalAiredEpisodes} 集</span>
                        ) : null}
                      </span>
                    </span>
                    <span className={`${styles.badge} ${badge.tone}`}>{badge.text}</span>
                  </button>
                );
              })}
            </>
          ) : null}
          {trimmed && !loading && !error && settledQuery === trimmed && items.length === 0 ? (
            <div className={styles.statusNote}>媒体库中未找到『{trimmed}』</div>
          ) : null}
          {hasTmdbFallback ? (
            <button
              type="button"
              className={`${styles.tmdbAction} ${activeIndex === items.length ? styles.tmdbActionActive : ""}`}
              onMouseEnter={() => setActiveIndex(items.length)}
              onClick={navigateToTmdb}
            >
              <span className={styles.tmdbActionLeft}>
                <Search size={15} aria-hidden />
                <span>在线搜 TMDB：{trimmed}</span>
              </span>
              <ArrowRight size={15} aria-hidden />
            </button>
          ) : null}
        </div>

        <div className={styles.footerHint}>
          <span>↑↓ 选择 · Enter 打开 · Esc 关闭</span>
          <span>Ctrl+K / ⌘K</span>
        </div>
      </div>
    </div>
  ) : null;

  const canPortal = typeof document !== "undefined" && Boolean(document.body);

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        aria-label="打开快速搜索"
        aria-keyshortcuts="Control+K Meta+K"
        onClick={() => setOpen(true)}
      >
        <span className={styles.triggerLabel}>
          <Search size={15} aria-hidden />
          <span className={styles.triggerText}>快速搜索</span>
        </span>
        <kbd className={styles.kbd}>Ctrl+K</kbd>
      </button>
      {dialog ? (canPortal ? createPortal(dialog, document.body) : dialog) : null}
    </>
  );
}
