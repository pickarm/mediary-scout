"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, CheckCircle2, Clock3, LoaderCircle, Search, TriangleAlert, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { LibraryQueryItem, LibraryQueryPage, LibraryQueryState, LibraryQueryMediaType } from "@media-track/workflow/library-query";
import { showHref } from "@media-track/workflow/scope";
import { useLibraryProgress } from "./library-progress-provider";
import { LibraryAcquiringRow, libraryMediaIdentityKey } from "./library-acquiring-row";
import styles from "./library-paged-wall.module.css";

export type LibraryCategoryPreview = { type: LibraryQueryMediaType; page: LibraryQueryPage };
type Filter = "all" | "complete" | "tracking" | "partial";
const PAGE_SIZE = 48;
const SEARCH_DEBOUNCE_MS = 250;
const LABELS: Record<LibraryQueryMediaType, string> = { movie: "电影", tv: "电视剧", anime: "动漫" };

function basePath(storageId?: string): string { return storageId ? `/w/${storageId}` : "/"; }
function categoryHref(storageId: string | undefined, type: LibraryQueryMediaType, filter: Filter): string {
  return `${basePath(storageId)}?tab=library&type=${type}&filter=${filter}`;
}
function stateForFilter(filter: Filter): LibraryQueryState | undefined { return filter === "all" ? undefined : filter; }
function resultKey(storageId: string | undefined, category: LibraryQueryMediaType | null, filter: Filter, page: number, search: string): string {
  return JSON.stringify([storageId ?? null, category, filter, page, search]);
}

/** Original media wall layout backed by bounded SQL pages. */
export function LibraryPagedWall({ previews, storageId, mediaType, filter }: {
  previews: readonly LibraryCategoryPreview[];
  storageId?: string | undefined;
  mediaType: LibraryQueryMediaType | null;
  filter: Filter;
}) {
  const category = mediaType;
  const initial = useMemo(() => category ? previews.find((item) => item.type === category)?.page : undefined, [previews, category]);
  const initialKey = initial ? resultKey(storageId, category, filter, 1, "") : null;
  const [query, setQuery] = useState("");
  const [settledQuery, setSettledQuery] = useState("");
  const scopeKey = resultKey(storageId, category, filter, 1, settledQuery);
  // Page belongs to the scope that requested it. Deriving it keeps a filter,
  // category, search or storage switch from firing one last stale page query.
  const [pagination, setPagination] = useState<{ token: string; page: number }>(() => ({ token: scopeKey, page: 1 }));
  const page = pagination.token === scopeKey ? pagination.page : 1;
  const [loadedResult, setLoadedResult] = useState<{ key: string; page: LibraryQueryPage } | null>(
    initial && initialKey ? { key: initialKey, page: initial } : null,
  );
  const [knownPage, setKnownPage] = useState<{ token: string; total: number; pageSize: number } | null>(
    initial && initialKey ? { token: resultKey(storageId, category, filter, 1, ""), total: initial.total, pageSize: initial.pageSize } : null,
  );
  const [loading, setLoading] = useState(false);
  // Errors are bound to the query they answered; a late failure never covers
  // the wall the user has since switched to.
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const router = useRouter();
  const progressPage = useLibraryProgress(storageId).page;
  const activeKeys = useMemo(() => new Set((progressPage?.active.items ?? [])
    .map((run) => libraryMediaIdentityKey(run.type, run.tmdbId))), [progressPage]);
  const normalItems = (items: readonly LibraryQueryItem[]) => items.filter((item) =>
    !activeKeys.has(libraryMediaIdentityKey(item.type, item.tmdbId)));

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
    if (!initial || !initialKey || settledQuery !== "" || page !== 1) return;
    setLoadedResult((current) => current && current.key === initialKey && current.page === initial ? current : { key: initialKey, page: initial });
    setKnownPage((current) => current && current.token === scopeKey && current.total === initial.total && current.pageSize === initial.pageSize
      ? current
      : { token: scopeKey, total: initial.total, pageSize: initial.pageSize });
  }, [initial, initialKey, page, scopeKey, settledQuery]);

  useEffect(() => {
    if (!category && settledQuery === "") {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const key = resultKey(storageId, category, filter, page, settledQuery);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: "title", direction: "asc" });
    if (storageId) params.set("storageId", storageId);
    if (category) params.set("type", category);
    const state = stateForFilter(filter);
    if (state) params.set("state", state);
    if (settledQuery) params.set("search", settledQuery);
    setLoading(true);
    setError(null);
    void fetch(`/api/library/media?${params.toString()}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "媒体库暂时无法加载。");
        return body as LibraryQueryPage;
      })
      .then((value) => {
        if (!active) return;
        setLoadedResult({ key, page: value });
        setKnownPage({ token: scopeKey, total: value.total, pageSize: value.pageSize });
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setError({ key, message: reason instanceof Error ? reason.message : "媒体库暂时无法加载。" });
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [category, filter, page, retry, scopeKey, settledQuery, storageId]);

  const currentKey = resultKey(storageId, category, filter, page, settledQuery);
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
      router.push(showHref(item.tmdbId, "library", storageId, item.type));
    }
  };

  const isSearch = query.trim() !== "";
  const visibleItems = normalItems(result?.items ?? []);
  const serverMatchedActiveKeys = new Set((result?.items ?? [])
    .map((item) => libraryMediaIdentityKey(item.type, item.tmdbId))
    .filter((key) => activeKeys.has(key)));
  const title = category ? LABELS[category] : "我的媒体库";

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
    {category ? <div style={{ marginBottom: 16, display: "flex", gap: 8 }}>
      {(["all", "complete", "tracking", "partial"] as const).map((value) => <Link key={value} className={`filter-pill ${filter === value ? "is-active" : ""}`} href={categoryHref(storageId, category, value)}>{value === "all" ? "全部" : value === "complete" ? "已完结" : value === "tracking" ? "追更中" : "有缺集"}</Link>)}
    </div> : null}
    <LibraryAcquiringRow
      page={progressPage}
      storageId={storageId}
      mediaType={category}
      search={query.trim()}
      serverMatchedKeys={serverMatchedActiveKeys}
    />
    {isSearch ? <p className="panel-note" aria-live="polite" aria-atomic="true">{result ? `匹配 ${result.total} 部${busy ? " · 查找中" : ""}` : "正在查找…"}</p> : null}
    {visibleError ? <div className="quiet-state compact"><TriangleAlert size={22} aria-hidden /><strong>{visibleError}</strong><button type="button" className="secondary-button" onClick={() => setRetry((value) => value + 1)}>重试</button></div> : null}
    {!visibleError && busy && !result ? <div className="poster-wall" aria-busy="true">{Array.from({ length: 8 }, (_, index) => <div className="skeleton skeleton-poster" key={index} />)}</div> : null}
    {!visibleError && isSearch && result?.total === 0 && !busy ? <div className="quiet-state compact"><TriangleAlert size={22} aria-hidden /><strong>没找到『{query}』</strong><button type="button" className="secondary-button" onClick={clearQuery}>清空</button></div> : null}
    {!visibleError && !isSearch && !category ? <>
      {previews.map(({ type, page: preview }) => preview.total > 0 ? <div className="category-section" key={type}>
        <Link className="category-header" href={categoryHref(storageId, type, "all")}><h2>{LABELS[type]} {preview.total}</h2><span className="category-arrow">›</span></Link>
        <div className="poster-row">{normalItems(preview.items).map((item) => <PosterCard key={mediaKey(item)} item={item} storageId={storageId} />)}</div>
      </div> : null)}
      {previews.every(({ page: preview }) => preview.total === 0) ? <div className="quiet-state"><strong>媒体库还是空的</strong><span>去搜索页发起第一次获取吧。</span></div> : null}
    </> : null}
    {!visibleError && (category || isSearch) ? <>
      {result && visibleItems.length > 0 ? <div className="poster-wall">{visibleItems.map((item) => <PosterCard key={mediaKey(item)} item={item} storageId={storageId} />)}</div> : null}
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

function PosterCard({ item, storageId }: { item: LibraryQueryItem; storageId?: string | undefined }) {
  if (item.acquiring) return <div className="wall-card is-loading" aria-disabled title="获取中，完成后可进入">
    <span className="wall-poster">{item.posterPath ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`https://image.tmdb.org/t/p/w342${item.posterPath}`} alt="" loading="lazy" />
    ) : <span className="poster-fallback">{item.title.slice(0, 4)}</span>}<span className="wall-loading-overlay"><LoaderCircle size={20} className="spin" aria-hidden /><span>获取中</span></span></span>
    <span className="wall-copy"><strong>{item.title}</strong><span>{item.year} · 正在获取</span></span>
  </div>;
  const badge = item.state === "reserved" ? [{ tone: "blue", icon: CalendarClock, label: "预定（未上映）" }] : item.state === "complete" ? [{ tone: "green", icon: CheckCircle2, label: "已全部入库" }] : item.state === "tracking" ? [{ tone: "indigo", icon: Clock3, label: "追更中" }] : [{ tone: "amber", icon: TriangleAlert, label: "有缺集" }, ...(item.airing ? [{ tone: "indigo", icon: Clock3, label: "追更中" }] : [])];
  return <Link className="wall-card" href={showHref(item.tmdbId, "library", storageId, item.type)}>
    <span className="wall-poster">{item.posterPath ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`https://image.tmdb.org/t/p/w342${item.posterPath}`} alt="" loading="lazy" />
    ) : <span className="poster-fallback">{item.title.slice(0, 4)}</span>}
      <span className="wall-states">{badge.map(({ tone, icon: Icon, label }) => <span className={`wall-state tone-${tone}`} title={label} key={label}><Icon size={13} aria-hidden /></span>)}</span>
    </span>
    <span className="wall-copy"><strong>{item.title}</strong><span>{item.type === "movie" ? item.state === "reserved" ? `预定 · ${formatReleaseDate(item.releaseDate)}上映` : item.year : `${item.year} · ${item.seasonCount} 季 · ${item.obtainedEpisodes}/${item.totalAiredEpisodes}/${item.totalEpisodes} 集`}</span></span>
  </Link>;
}

function formatReleaseDate(value: string | null): string {
  const match = value && /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${Number(match[2])}月${Number(match[3])}日` : value ?? "";
}
