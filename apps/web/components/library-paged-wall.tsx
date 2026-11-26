"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  CalendarClock,
  CheckCircle2,
  Clock3,
  LayoutGrid,
  List,
  LoaderCircle,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LibraryQueryItem, LibraryQueryMediaType, LibraryQueryPage, LibraryQuerySort, LibraryQueryState } from "@media-track/workflow/library-query";
import { showHref } from "@media-track/workflow/scope";
import { tmdbImageUrl } from "../lib/tmdb-image";
import { useLibraryProgress } from "./library-progress-provider";
import { LibraryAcquiringRow, libraryMediaIdentityKey } from "./library-acquiring-row";
import styles from "./library-paged-wall.module.css";

export type LibraryCategoryPreview = { type: LibraryQueryMediaType; page: LibraryQueryPage };
export type LibraryStorageOption = {
  id: string;
  label: string;
  provider?: string;
  status?: "active" | "frozen";
};

type Filter = "all" | "complete" | "tracking" | "partial";
type SortOption = Extract<LibraryQuerySort, "title" | "updatedAt" | "year" | "obtainedEpisodes">;
type SortDirection = "asc" | "desc";
type ViewMode = "grid" | "list";

const PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 250;
const LABELS: Record<LibraryQueryMediaType, string> = { movie: "电影", tv: "电视剧", anime: "动漫" };
const SORT_LABELS: Record<SortOption, string> = {
  title: "片名",
  updatedAt: "最近更新",
  year: "年份",
  obtainedEpisodes: "已获取集数",
};

function basePath(storageId?: string): string { return storageId ? `/w/${storageId}` : "/"; }
function categoryHref(storageId: string | undefined, type: LibraryQueryMediaType, filter: Filter): string {
  return `${basePath(storageId)}?tab=library&type=${type}&filter=${filter}`;
}
function stateForFilter(filter: Filter): LibraryQueryState | undefined { return filter === "all" ? undefined : filter; }
function resultKey(
  storageId: string | undefined,
  category: LibraryQueryMediaType | null,
  filter: Filter,
  page: number,
  search: string,
  sort: SortOption,
  direction: SortDirection,
): string {
  return JSON.stringify([storageId ?? null, category, filter, page, search, sort, direction]);
}

function isStorageOptionArray(value: unknown): value is LibraryStorageOption[] {
  return Array.isArray(value) && value.every(
    (entry) => Boolean(entry && typeof entry === "object" && "id" in entry && typeof entry.id === "string" && "label" in entry && typeof entry.label === "string"),
  );
}

/** Original media wall layout backed by bounded SQL pages. */
export function LibraryPagedWall({ previews, storageId, mediaType, filter, storages }: {
  previews: readonly LibraryCategoryPreview[];
  storageId?: string | undefined;
  mediaType: LibraryQueryMediaType | null;
  filter: Filter;
  storages?: readonly LibraryStorageOption[] | undefined;
}) {
  const category = mediaType;
  const baseStorage = storageId ?? "";
  const [storageOverride, setStorageOverride] = useState<{ base: string; value: string } | null>(null);
  const activeStorageFilter = storageOverride && storageOverride.base === baseStorage ? storageOverride.value : baseStorage;
  const effectiveStorageId = activeStorageFilter || undefined;

  const [sort, setSort] = useState<SortOption>("title");
  const [direction, setDirection] = useState<SortDirection>("asc");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [loadedStorages, setLoadedStorages] = useState<readonly LibraryStorageOption[] | null>(null);
  const loadedStoragesRef = useRef(storages !== undefined);
  const loadingStoragesRef = useRef(false);
  if (storages !== undefined) loadedStoragesRef.current = true;

  const initial = useMemo(() => category ? previews.find((item) => item.type === category)?.page : undefined, [previews, category]);
  const initialKey = initial ? resultKey(baseStorage || undefined, category, filter, 1, "", "title", "asc") : null;
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const scopeKey = resultKey(effectiveStorageId, category, filter, 1, settledQuery, sort, direction);
  // Page belongs to the scope that requested it. Deriving it keeps a filter,
  // category, search or storage switch from firing one last stale page query.
  const [pagination, setPagination] = useState<{ token: string; page: number }>(() => ({ token: scopeKey, page: 1 }));
  const page = pagination.token === scopeKey ? pagination.page : 1;
  const [loadedResult, setLoadedResult] = useState<{ key: string; page: LibraryQueryPage } | null>(
    initial && initialKey ? { key: initialKey, page: initial } : null,
  );
  const [knownPage, setKnownPage] = useState<{ token: string; total: number; pageSize: number } | null>(
    initial && initialKey ? { token: resultKey(baseStorage || undefined, category, filter, 1, "", "title", "asc"), total: initial.total, pageSize: initial.pageSize } : null,
  );
  const [loading, setLoading] = useState(false);
  // Errors are bound to the query they answered; a late failure never covers
  // the wall the user has since switched to.
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const progressPage = useLibraryProgress(effectiveStorageId).page;
  const activeKeys = useMemo(() => new Set((progressPage?.active.items ?? [])
    .map((run) => libraryMediaIdentityKey(run.type, run.tmdbId))), [progressPage]);
  const normalItems = (items: readonly LibraryQueryItem[]) => items.filter((item) =>
    !activeKeys.has(libraryMediaIdentityKey(item.type, item.tmdbId)));

  const isDefaultOverview = !category
    && settledQuery === ""
    && sort === "title"
    && direction === "asc"
    && activeStorageFilter === baseStorage;

  useEffect(() => {
    const timer = window.setTimeout(() => setSettledQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setPagination((current) => current.token === scopeKey ? current : { token: scopeKey, page: 1 });
  }, [scopeKey]);
  // router.refresh() (the bounded acquisition poller) can deliver a newer
  // server page while the client stays mounted; adopt it only while the wall
  // shows that page, never overwriting an unrelated search result.
  useEffect(() => {
    if (!initial || !initialKey || settledQuery !== "" || page !== 1 || sort !== "title" || direction !== "asc" || activeStorageFilter !== baseStorage) {
      return;
    }
    setLoadedResult((current) => current && current.key === initialKey && current.page === initial ? current : { key: initialKey, page: initial });
    setKnownPage((current) => current && current.token === scopeKey && current.total === initial.total && current.pageSize === initial.pageSize
      ? current
      : { token: scopeKey, total: initial.total, pageSize: initial.pageSize });
  }, [activeStorageFilter, baseStorage, direction, initial, initialKey, page, scopeKey, settledQuery, sort]);

  useEffect(() => {
    if (isDefaultOverview) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const key = resultKey(effectiveStorageId, category, filter, page, settledQuery, sort, direction);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort, direction });
    if (effectiveStorageId) params.set("storageId", effectiveStorageId);
    if (category) params.set("type", category);
    const state = stateForFilter(filter);
    if (state) params.set("state", state);
    if (settledQuery) params.set("search", settledQuery);
    if (!storages && !loadedStoragesRef.current) params.set("includeStorages", "1");
    setLoading(true);
    setError(null);
    void fetch(`/api/library/media?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "媒体库暂时无法加载。");
        return body as LibraryQueryPage & { storages?: unknown };
      })
      .then((value) => {
        if (!active) return;
        if (isStorageOptionArray(value.storages)) {
          loadedStoragesRef.current = true;
          setLoadedStorages(value.storages);
        }
        setLoadedResult({ key, page: value });
        setKnownPage({ token: scopeKey, total: value.total, pageSize: value.pageSize });
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError({ key, message: reason instanceof Error ? reason.message : "媒体库暂时无法加载。" });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [category, direction, effectiveStorageId, filter, isDefaultOverview, page, retry, scopeKey, settledQuery, sort, storages]);

  const ensureStoragesLoaded = () => {
    if (storages || loadedStoragesRef.current || loadingStoragesRef.current) return;
    loadingStoragesRef.current = true;
    void fetch("/api/library/media?page=1&pageSize=1&includeStorages=1", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "storages" in body && isStorageOptionArray(body.storages)) {
          loadedStoragesRef.current = true;
          setLoadedStorages(body.storages);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        loadingStoragesRef.current = false;
      });
  };

  const storageChoices = useMemo(() => {
    const source = storages ?? loadedStorages ?? [];
    const list: LibraryStorageOption[] = [{ id: "", label: "全部网盘" }];
    const seen = new Set<string>([""]);
    for (const option of source) {
      if (!seen.has(option.id)) {
        seen.add(option.id);
        list.push(option);
      }
    }
    if (baseStorage && !seen.has(baseStorage)) {
      list.push({ id: baseStorage, label: "当前网盘" });
    }
    return list;
  }, [baseStorage, loadedStorages, storages]);

  const currentKey = resultKey(effectiveStorageId, category, filter, page, settledQuery, sort, direction);
  const pendingSearch = query.trim() !== settledQuery;
  const result = pendingSearch ? null
    : loadedResult?.key === currentKey ? loadedResult.page
      : page === 1 && initial && initialKey === currentKey ? initial
        : null;
  // While a new query is debouncing the input no longer describes the failed
  // result, so its error must not sit above the wall the user is moving to.
  const currentError = !pendingSearch && error?.key === currentKey ? error.message : null;
  // A failed refresh must not hide a usable server preview for the same scope.
  const visibleError = result ? null : currentError;
  const busy = pendingSearch || loading;
  const pageInfo = result ?? (knownPage && knownPage.token === scopeKey ? knownPage : null);
  const clearQuery = () => {
    setQuery("");
    setSettledQuery("");
    setError(null);
    inputRef.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Escape") clearQuery();
    if (event.key !== "Enter") return;
    const trimmed = query.trim();
    if (!trimmed || trimmed !== settledQuery || pendingSearch || loading || currentError || !result) return;
    if (result.total !== 1 || result.items.length !== 1) return;
    const item = result.items[0];
    if (item && !item.acquiring && !activeKeys.has(libraryMediaIdentityKey(item.type, item.tmdbId))) {
      router.push(showHref(item.tmdbId, "library", effectiveStorageId, item.type));
    }
  };

  const handleSortChange = (nextSort: SortOption) => {
    setSort(nextSort);
    setDirection(nextSort === "title" ? "asc" : "desc");
  };

  const isSearch = query.trim() !== "";
  const visibleItems = normalItems(result?.items ?? []);
  const serverMatchedActiveKeys = new Set((result?.items ?? [])
    .map((item) => libraryMediaIdentityKey(item.type, item.tmdbId))
    .filter((key) => activeKeys.has(key)));
  const title = category ? LABELS[category] : "我的媒体库";
  const showPagedResults = !isDefaultOverview || isSearch || Boolean(category);

  const summary = useMemo(() => {
    if (!showPagedResults) {
      const total = previews.reduce((sum, entry) => sum + entry.page.total, 0);
      const counts = previews
        .filter((entry) => entry.page.total > 0)
        .map((entry) => `${LABELS[entry.type]} ${entry.page.total}`);
      return { total, chips: counts };
    }
    if (!result) return null;
    const stats = { complete: 0, tracking: 0, partial: 0, reserved: 0 };
    for (const item of result.items) {
      stats[item.state] += 1;
    }
    const chips: string[] = [];
    if (stats.complete > 0) chips.push(`已入库 ${stats.complete}`);
    if (stats.tracking > 0) chips.push(`追更中 ${stats.tracking}`);
    if (stats.partial > 0) chips.push(`有缺集 ${stats.partial}`);
    if (stats.reserved > 0) chips.push(`预定 ${stats.reserved}`);
    return { total: result.total, chips };
  }, [previews, result, showPagedResults]);

  return <>
    <div className="section-heading library-heading library-find-heading">
      <div>{category ? <h1><Link href={`${basePath(storageId)}?tab=library`} style={{ marginRight: 12, opacity: 0.6 }}>‹</Link>{title}</h1> : <h1>{title}</h1>}
        {category && result ? <p>{result.total} 部{(category === "tv" || category === "anime") && filter !== "complete" ? " · 含追更与缺集作品" : ""}</p> : null}
      </div>
      <div className="search-box search-box-compact"><Search size={16} aria-hidden />
        <input ref={inputRef} value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} aria-label="在库中查找" placeholder="在库中查找…" />
        {query.trim() ? <button type="button" className="search-box-compact-clear" aria-label="清空查找" onClick={clearQuery}><X size={14} aria-hidden /></button> : null}
      </div>
    </div>

    <div className={styles.toolbar}>
      {category ? <div className={styles.toolbarFilters}>
        {(["all", "complete", "tracking", "partial"] as const).map((value) => (
          <Link key={value} className={`filter-pill ${filter === value ? "is-active" : ""}`} href={categoryHref(storageId, category, value)}>
            {value === "all" ? "全部" : value === "complete" ? "已完结" : value === "tracking" ? "追更中" : "有缺集"}
          </Link>
        ))}
      </div> : null}

      <div className={styles.toolbarControls}>
        <select
          className={styles.selectControl}
          aria-label="按网盘筛选"
          value={activeStorageFilter}
          onFocus={ensureStoragesLoaded}
          onMouseDown={ensureStoragesLoaded}
          onChange={(event) => setStorageOverride({ base: baseStorage, value: event.target.value })}
        >
          {storageChoices.map((option) => (
            <option key={option.id || "__all__"} value={option.id}>{option.label}</option>
          ))}
        </select>

        <select
          className={styles.selectControl}
          aria-label="排序方式"
          value={sort}
          onChange={(event) => handleSortChange(event.target.value as SortOption)}
        >
          {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
            <option key={option} value={option}>{SORT_LABELS[option]}</option>
          ))}
        </select>

        <button
          type="button"
          className={styles.iconButton}
          aria-label={direction === "asc" ? "当前升序，点击切换为降序" : "当前降序，点击切换为升序"}
          onClick={() => setDirection((prev) => (prev === "asc" ? "desc" : "asc"))}
        >
          {direction === "asc" ? <ArrowUpNarrowWide size={14} aria-hidden /> : <ArrowDownWideNarrow size={14} aria-hidden />}
          <span>{direction === "asc" ? "升序" : "降序"}</span>
        </button>

        <div className={styles.viewToggle} role="group" aria-label="视图切换">
          <button
            type="button"
            className={`${styles.viewButton} ${viewMode === "grid" ? styles.viewButtonActive : ""}`}
            aria-pressed={viewMode === "grid"}
            onClick={() => setViewMode("grid")}
          >
            <LayoutGrid size={13} aria-hidden />
            <span>海报墙</span>
          </button>
          <button
            type="button"
            className={`${styles.viewButton} ${viewMode === "list" ? styles.viewButtonActive : ""}`}
            aria-pressed={viewMode === "list"}
            onClick={() => setViewMode("list")}
          >
            <List size={13} aria-hidden />
            <span>紧凑列表</span>
          </button>
        </div>
      </div>
    </div>

    {summary && summary.total > 0 ? <div className={styles.summaryBar} aria-label="媒体库统计概览">
      <span className={styles.summaryTotal}>共 {summary.total} 部</span>
      {summary.chips.length > 0 ? <span className={styles.summaryChips}>
        {summary.chips.map((chip) => <span className={styles.summaryChip} key={chip}>{chip}</span>)}
      </span> : null}
    </div> : null}

    <LibraryAcquiringRow
      page={progressPage}
      storageId={effectiveStorageId}
      mediaType={category}
      search={query.trim()}
      serverMatchedKeys={serverMatchedActiveKeys}
    />
    {isSearch ? <p className="panel-note" aria-live="polite" aria-atomic="true">{result ? `匹配 ${result.total} 部${busy ? " · 查找中" : ""}` : "正在查找…"}</p> : null}
    {visibleError ? <div className="quiet-state compact"><TriangleAlert size={22} aria-hidden /><strong>{visibleError}</strong><button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试</button></div> : null}
    {!visibleError && busy && !result ? <div className="poster-wall" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div className="skeleton skeleton-poster" key={index} />)}</div> : null}
    {!visibleError && isSearch && result?.total === 0 && !busy ? <div className="quiet-state compact"><TriangleAlert size={22} aria-hidden /><strong>没找到『{query}』</strong><button type="button" className="secondary-button" onClick={clearQuery}>清空</button></div> : null}
    {!visibleError && !showPagedResults ? <>
      {previews.map(({ type, page: preview }) => preview.total > 0 ? <div className="category-section" key={type}>
        <Link className="category-header" href={categoryHref(storageId, type, "all")}><h2>{LABELS[type]} {preview.total}</h2><span className="category-arrow">›</span></Link>
        {viewMode === "grid"
          ? <div className="poster-row">{normalItems(preview.items).map((item) => <PosterCard key={mediaKey(item)} item={item} storageId={effectiveStorageId} />)}</div>
          : <div className={styles.compactList}>{normalItems(preview.items).map((item) => <CompactListRow key={mediaKey(item)} item={item} storageId={effectiveStorageId} />)}</div>}
      </div> : null)}
      {previews.every(({ page: preview }) => preview.total === 0) ? <div className="quiet-state"><strong>媒体库还是空的</strong><span>去搜索页发起第一次获取吧。</span></div> : null}
    </> : null}
    {!visibleError && showPagedResults ? <>
      {result && visibleItems.length > 0 ? (
        viewMode === "grid"
          ? <div className="poster-wall">{visibleItems.map((item) => <PosterCard key={mediaKey(item)} item={item} storageId={effectiveStorageId} />)}</div>
          : <div className={styles.compactList}>{visibleItems.map((item) => <CompactListRow key={mediaKey(item)} item={item} storageId={effectiveStorageId} />)}</div>
      ) : null}
      {result && result.total === 0 && !isSearch && !busy ? <div className="quiet-state compact"><strong>这个分类还没有作品</strong></div> : null}
      {pageInfo && pageInfo.total > pageInfo.pageSize ? <nav className={styles.pagination} aria-label="媒体库分页">
        <button type="button" className="secondary-button" disabled={page <= 1 || busy} onClick={() => setPagination({ token: scopeKey, page: Math.max(1, page - 1) })}>上一页</button>
        <span>第 {page} / {Math.ceil(pageInfo.total / pageInfo.pageSize)} 页 · 共 {pageInfo.total} 部</span>
        <button type="button" className="secondary-button" disabled={page * pageInfo.pageSize >= pageInfo.total || busy} onClick={() => setPagination({ token: scopeKey, page: page + 1 })}>下一页</button>
      </nav> : null}
    </> : null}
  </>;
}

function mediaKey(item: LibraryQueryItem): string { return libraryMediaIdentityKey(item.type, item.tmdbId); }

function badgeInfo(item: LibraryQueryItem) {
  return item.state === "reserved"
    ? [{ tone: "blue" as const, icon: CalendarClock, label: "预定（未上映）", shortLabel: "预定" }]
    : item.state === "complete"
      ? [{ tone: "green" as const, icon: CheckCircle2, label: "已全部入库", shortLabel: "已入库" }]
      : item.state === "tracking"
        ? [{ tone: "indigo" as const, icon: Clock3, label: "追更中", shortLabel: "追更中" }]
        : [
            { tone: "amber" as const, icon: TriangleAlert, label: "有缺集", shortLabel: "有缺集" },
            ...(item.airing ? [{ tone: "indigo" as const, icon: Clock3, label: "追更中", shortLabel: "追更中" }] : []),
          ];
}

function itemSubtitle(item: LibraryQueryItem): string {
  if (item.type === "movie") {
    return item.state === "reserved" ? `预定 · ${formatReleaseDate(item.releaseDate)}上映` : String(item.year);
  }
  return `${item.year} · ${item.seasonCount} 季 · ${item.obtainedEpisodes}/${item.totalAiredEpisodes}/${item.totalEpisodes} 集`;
}

function PosterCard({ item, storageId }: { item: LibraryQueryItem; storageId?: string | undefined }) {
  const posterSrc = tmdbImageUrl(item.posterPath, "w342");
  if (item.acquiring) return <div className="wall-card is-loading" aria-disabled title="获取中，完成后可进入">
    <span className="wall-poster">{posterSrc ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={posterSrc} alt="" loading="lazy" />
    ) : <span className="poster-fallback">{item.title.slice(0, 4)}</span>}<span className="wall-loading-overlay"><LoaderCircle size={20} className="spin" aria-hidden /><span>获取中</span></span></span>
    <span className="wall-copy"><strong>{item.title}</strong><span>{item.year} · 正在获取</span></span>
  </div>;
  const badge = badgeInfo(item);
  return <Link className="wall-card" href={showHref(item.tmdbId, "library", storageId, item.type)}>
    <span className="wall-poster">{posterSrc ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={posterSrc} alt="" loading="lazy" />
    ) : <span className="poster-fallback">{item.title.slice(0, 4)}</span>}
      <span className="wall-states">{badge.map(({ tone, icon: Icon, label }) => <span className={`wall-state tone-${tone}`} title={label} key={label}><Icon size={13} aria-hidden /></span>)}</span>
    </span>
    <span className="wall-copy"><strong>{item.title}</strong><span>{itemSubtitle(item)}</span></span>
  </Link>;
}

const COMPACT_TONE_CLASS = {
  green: styles.toneGreen,
  indigo: styles.toneIndigo,
  amber: styles.toneAmber,
  blue: styles.toneBlue,
} as const;

function CompactListRow({ item, storageId }: { item: LibraryQueryItem; storageId?: string | undefined }) {
  const thumbSrc = tmdbImageUrl(item.posterPath, "w92");
  const updatedLabel = formatUpdatedAt(item.updatedAt);

  if (item.acquiring) {
    return (
      <div className={`${styles.compactRow} ${styles.compactRowLoading}`} aria-disabled="true" title="获取中，完成后可进入">
        <span className={styles.compactPoster}>
          {thumbSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumbSrc} alt="" loading="lazy" />
          ) : <span className={styles.compactPosterFallback}>{item.title.slice(0, 2)}</span>}
        </span>
        <span className={styles.compactMain}>
          <span className={styles.compactTitle}>{item.title}</span>
          <span className={styles.compactMeta}>
            <span>{LABELS[item.type]}</span>
            <span>{item.year} · 正在获取</span>
          </span>
        </span>
        <span className={styles.compactRight}>
          <span className={`${styles.compactBadge} ${styles.toneIndigo}`}>
            <LoaderCircle size={12} className="spin" aria-hidden />
            获取中
          </span>
        </span>
      </div>
    );
  }

  const badges = badgeInfo(item);
  return (
    <Link className={styles.compactRow} href={showHref(item.tmdbId, "library", storageId, item.type)}>
      <span className={styles.compactPoster}>
        {thumbSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumbSrc} alt="" loading="lazy" />
        ) : <span className={styles.compactPosterFallback}>{item.title.slice(0, 2)}</span>}
      </span>
      <span className={styles.compactMain}>
        <span className={styles.compactTitle}>{item.title}</span>
        <span className={styles.compactMeta}>
          <span>{LABELS[item.type]}</span>
          <span>{itemSubtitle(item)}</span>
        </span>
      </span>
      <span className={styles.compactRight}>
        {updatedLabel ? <span className={styles.compactUpdated}>更新 {updatedLabel}</span> : null}
        {badges.map(({ tone, icon: Icon, shortLabel }) => (
          <span key={shortLabel} className={`${styles.compactBadge} ${COMPACT_TONE_CLASS[tone]}`}>
            <Icon size={12} aria-hidden />
            {shortLabel}
          </span>
        ))}
      </span>
    </Link>
  );
}

function formatReleaseDate(value: string | null): string {
  const match = value && /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value ?? "";
}

function formatUpdatedAt(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}
