import { Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { AcquiringPoller } from "../components/acquiring-poller";
import { AppSidebar } from "../components/app-sidebar";
import { DemoSessionLibrary } from "../components/demo-session-library";
import { LibraryPagedWall, type LibraryCategoryPreview } from "../components/library-paged-wall";
import { RememberQuery } from "../components/search-memory";
import { SearchForm } from "../components/search-form";
import { SearchResultsView, type SearchResultCardItem } from "../components/search-results-view";
import { TrendingRow } from "../components/trending-row";
import { GitHubNameplate } from "../components/github-nameplate";
import type { TrendingKind } from "../lib/trending";
import { getSearchView } from "../lib/search-page";
import { getLibraryMediaPage } from "../lib/library-media-runtime";
import {
  ensureDemoSeeded,
  getActiveWorkspaceScope,
  getRegisteredDriveCount,
  getWorkflowRepository,
  getCurrentAccountId,
} from "../lib/workflow-runtime";
import { isUserVisibleWorkflowKind } from "@media-track/workflow";
import type { TrackedSeasonState } from "@media-track/workflow";

/** Workspace base path: "/" is the account's primary drive, "/w/<id>" a
 *  specific drive. Library links must route within the current workspace —
 *  hardcoding "/" silently jumps to the primary drive from any other drive. */
function workspaceBasePath(storageId?: string): string {
  return storageId ? `/w/${storageId}` : "/";
}

export default function Page({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  return <HomeView searchParams={searchParams} />;
}

/**
 * Shared home surface for both the root route (storageId undefined → the
 * account's primary drive) and the /w/<storageId> workspace route (a specific
 * drive). The library + search awareness are scoped to that workspace.
 */
export function HomeView({
  searchParams,
  storageId,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  // searchParams is a dynamic input. Reading it inside a Suspense boundary lets
  // the static app shell prerender instead of the whole route blocking on it —
  // this is what silences the cacheComponents "blocking-route" warning. The await
  // resolves from the request URL (no I/O), so the fallback is effectively instant.
  return (
    <Suspense fallback={<HomeShell />}>
      <HomeSurface searchParams={searchParams} storageId={storageId} />
    </Suspense>
  );
}

function HomeShell() {
  return (
    <div className="app-shell">
      <AppSidebar active="search" />
      <main className="main product-main" aria-busy="true" />
    </div>
  );
}

async function HomeSurface({
  searchParams,
  storageId,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>> | undefined;
  storageId?: string | undefined;
}) {
  const params = (await searchParams) ?? {};
  const query = stringParam(params.q);
  const activeTab = stringParam(params.tab) === "library" ? "library" : "search";
  const mediaType = stringParam(params.type) || "all";
  const filter = stringParam(params.filter) || "all";
  const trendingParam = stringParam(params.trending);
  const activeTrending: TrendingKind =
    trendingParam === "tv" ? "tv" : trendingParam === "anime" ? "anime" : "movie";
  // Tree model: keep searches inside the ACTIVE workspace so an acquisition lands
  // on the drive you're viewing — not silently on the primary drive. Root route
  // (no storageId) posts to "/" as before.
  const basePath = workspaceBasePath(storageId);
  const driveCount = await getRegisteredDriveCount();

  return (
    <div className="app-shell">
      <AppSidebar active={activeTab} searchQuery={query} basePath={basePath} activeStorageId={storageId} />

      <main className="main product-main">
        {activeTab === "search" ? (
          <section className="search-surface">
            <RememberQuery query={query} basePath={basePath} />
            <div className="search-hero">
              <div>
                <h1>搜索</h1>
                <p>找到目标后发起获取，后台会处理资源判断、转存和验证。</p>
              </div>
              <SearchForm basePath={basePath} defaultQuery={query} />
            </div>
            {driveCount >= 2 ? (
              <p className="panel-note" style={{ marginTop: -4, marginBottom: 4 }}>
                搜索与获取按网盘隔离 —— 想为某块盘获取资源，请切到该盘后在它的搜索页操作。
              </p>
            ) : null}
            <Suspense key={`search-${query}`} fallback={<SearchResultsSkeleton />}>
              <SearchResults
                query={query}
                storageId={storageId}
                activeTrending={activeTrending}
                basePath={basePath}
              />
            </Suspense>
          </section>
        ) : (
          <>
            <DemoSessionLibrary />
            <Suspense fallback={<LibrarySurfaceSkeleton />}>
              <LibrarySurface mediaType={mediaType} filter={filter} storageId={storageId} />
            </Suspense>
          </>
        )}
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function SearchResults({
  query,
  storageId,
  activeTrending,
  basePath,
}: {
  query: string;
  storageId?: string | undefined;
  activeTrending: TrendingKind;
  basePath: string;
}) {
  const searchView = await getSearchView(query, storageId);
  const repository = getWorkflowRepository();
  await ensureDemoSeeded(repository);
  const scope = await getActiveWorkspaceScope(storageId);

  // 搜索页仅复用活跃任务列表判断轮询与获取中状态，避免为无封面的运行记录额外触发 TMDB 请求。
  const activeRuns = (await repository.listActiveWorkflowRuns(scope)).filter(
    (snapshot) =>
      snapshot.workflowRun.kind !== "replace_request" &&
      isUserVisibleWorkflowKind(snapshot.workflowRun.kind),
  );
  const inProgressKeys = new Set(
    activeRuns.map(
      (snapshot) => `${snapshot.title.type === "movie" ? "movie" : "tv"}:${snapshot.title.tmdbId}`,
    ),
  );

  if (searchView.state === "empty") {
    return (
      <>
        {activeRuns.length > 0 ? <AcquiringPoller storageId={storageId} /> : null}
        <TrendingRow activeKind={activeTrending} basePath={basePath} storageId={storageId} />
      </>
    );
  }

  if (searchView.state === "provider_error") {
    return (
      <>
        {activeRuns.length > 0 ? <AcquiringPoller storageId={storageId} /> : null}
        <section className="search-results" aria-label="搜索结果">
          <div className="quiet-state compact" role="alert">
            <TriangleAlert size={22} aria-hidden />
            <strong>搜索暂时不可用：连不上元数据服务（TMDB）</strong>
            <span>
              当前部署环境连不上 TMDB，内置代理也不通。国内网络未配置代理时常见——
              给部署主机（或容器）配置可访问外网的代理后重试。
            </span>
            {/* Deliberately a full-reload <a>, not <Link>: retry must re-run the
                server render (re-probe TMDB). A client-side navigation to the
                SAME URL can be served from the router cache as a no-op. */}
            <a className="primary-button" href={`${basePath}?q=${encodeURIComponent(searchView.query)}`}>
              重试
            </a>
            {searchView.providerError ? (
              <span className="panel-note">{searchView.providerError}</span>
            ) : null}
          </div>
        </section>
      </>
    );
  }

  // 仅当搜索结果包含剧集时才查询剧集追踪状态；已预取分季且单盘隔离时走主键定向查询，避免全表扫描。
  const trackedByTmdbId = new Map<number, TrackedSeasonState[]>();
  const tvCandidates = searchView.candidates.filter((candidate) => candidate.mediaType === "tv");
  if (tvCandidates.length > 0) {
    const canTargetedLookup =
      scope.connectedStorageId !== null &&
      tvCandidates.every((candidate) => candidate.seasonNumbers.length > 0) &&
      tvCandidates.reduce((sum, candidate) => sum + candidate.seasonNumbers.length, 0) <= 24;
    const states = canTargetedLookup
      ? (
          await Promise.all(
            tvCandidates.flatMap((candidate) =>
              candidate.seasonNumbers.map((seasonNumber) =>
                repository.getTrackedSeasonState(`tmdb_tv_${candidate.tmdbId}_s${seasonNumber}`, scope),
              ),
            ),
          )
        ).filter((state): state is TrackedSeasonState => state !== null)
      : await repository.listTrackedSeasonStates(scope);

    for (const state of states) {
      if (state.title.type === "movie") {
        continue;
      }
      const list = trackedByTmdbId.get(state.title.tmdbId) ?? [];
      list.push(state);
      trackedByTmdbId.set(state.title.tmdbId, list);
    }
  }

  const items: SearchResultCardItem[] = searchView.candidates.map((candidate) => {
    const trackedStates = candidate.mediaType === "tv" ? (trackedByTmdbId.get(candidate.tmdbId) ?? []) : [];
    return {
      candidate,
      acquiring: inProgressKeys.has(`${candidate.mediaType}:${candidate.tmdbId}`),
      trackedLabel:
        candidate.mediaType === "tv"
          ? trackedSummaryLabel(trackedStates, candidate.seasonNumbers.length)
          : null,
      trackedSeasonNumbers: [
        ...new Set(trackedStates.map((state) => state.season.seasonNumber)),
      ],
    };
  });

  return (
    <>
      {activeRuns.length > 0 ? <AcquiringPoller storageId={storageId} /> : null}
      <SearchResultsView
        key={searchView.query}
        query={searchView.query}
        interpretedQuery={searchView.interpretedQuery}
        cacheStatus={searchView.cacheStatus}
        items={items}
        storageId={storageId}
      />
    </>
  );
}

/**
 * Concrete library awareness for a result card: not just "tracked", but
 * WHICH seasons are obtained / airing / missing.
 * When a season is tracked across multiple drives, its states are merged by
 * `seasonNumber` so the obtained episode set is unioned and each season number
 * appears at most once in the summary label.
 */
function trackedSummaryLabel(states: TrackedSeasonState[], totalSeasonCount: number): string | null {
  if (states.length === 0) {
    return null;
  }
  const bySeason = new Map<number, TrackedSeasonState[]>();
  for (const state of states) {
    const list = bySeason.get(state.season.seasonNumber) ?? [];
    list.push(state);
    bySeason.set(state.season.seasonNumber, list);
  }
  const complete: number[] = [];
  const active: number[] = [];
  let missingCount = 0;
  for (const [seasonNumber, group] of [...bySeason.entries()].sort((a, b) => a[0] - b[0])) {
    const primary = group.reduce((best, cur) =>
      cur.season.latestAiredEpisode > best.season.latestAiredEpisode ? cur : best,
    );
    const obtainedCodes = new Set<string>();
    for (const s of group) {
      for (const ep of s.episodes) {
        if (ep.obtained) obtainedCodes.add(ep.episodeCode);
      }
    }
    const totalEpisodes = primary.season.totalEpisodes;
    const latestAired = primary.season.latestAiredEpisode;
    const airedCount = Math.min(latestAired, totalEpisodes);
    const allCompleted =
      group.every((s) => s.season.status === "completed") ||
      (totalEpisodes > 0 && latestAired >= totalEpisodes && obtainedCodes.size >= airedCount);
    if (allCompleted && obtainedCodes.size >= totalEpisodes) {
      complete.push(seasonNumber);
    } else if (!allCompleted && group.some((s) => s.season.status === "active")) {
      active.push(seasonNumber);
    } else {
      missingCount += 1;
    }
  }
  if (totalSeasonCount > 0 && complete.length === totalSeasonCount) {
    return `全 ${totalSeasonCount} 季已获取`;
  }
  const parts: string[] = [];
  if (complete.length > 0) {
    parts.push(`第 ${complete.join("、")} 季已获取`);
  }
  if (active.length > 0) {
    parts.push(`第 ${active.join("、")} 季追更中`);
  }
  if (missingCount > 0) {
    parts.push(`${missingCount} 季有缺集`);
  }
  return parts.join(" · ") || "已追踪";
}

async function LibrarySurface({ mediaType, filter, storageId }: { mediaType: string; filter: string; storageId?: string | undefined }) {
  const category = mediaType === "movie" || mediaType === "tv" || mediaType === "anime" ? mediaType : null;
  const normalizedFilter = filter === "complete" || filter === "tracking" || filter === "partial" ? filter : "all";
  const accountId = await getCurrentAccountId();
  if (storageId !== undefined) {
    const owned = await getWorkflowRepository().listConnectedStorages(accountId);
    if (!owned.some((storage) => storage.id === storageId && storage.accountId === accountId)) {
      return <section className="library-surface"><div className="quiet-state"><strong>找不到该账号的网盘连接。</strong></div></section>;
    }
  }
  const connectedStorageId = storageId ?? null;
  const load = (type: "movie" | "tv" | "anime", pageSize: number) => getLibraryMediaPage({
    accountId,
    connectedStorageId,
    type,
    pageSize,
    page: 1,
    sort: "title",
    direction: "asc",
    ...(category === type && normalizedFilter !== "all" ? { state: normalizedFilter } : {}),
  });
  const types = category ? [category] as const : ["movie", "tv", "anime"] as const;
  const pages = await Promise.all(types.map((type) => load(type, category ? 48 : 12)));
  const previews: LibraryCategoryPreview[] = types.map((type, index) => ({ type, page: pages[index]! }));
  // Observe the shared scope even when an active title falls outside this preview.
  const acquiring = pages.some((page) => page.items.some((entry) => entry.acquiring));
  return <section className="library-surface">
    <AcquiringPoller storageId={storageId} initiallyAcquiring={acquiring} />
    <LibraryPagedWall previews={previews} storageId={storageId} mediaType={category} filter={normalizedFilter} />
  </section>;
}

function SearchResultsSkeleton() {
  return (
    <div className="candidate-grid" style={{ marginTop: 24 }}>
      <div className="skeleton-card" />
      <div className="skeleton-card" />
    </div>
  );
}

function LibrarySurfaceSkeleton() {
  return (
    <section className="library-surface">
      <div className="skeleton skeleton-heading" />
      <div className="poster-wall">
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
        <div className="skeleton skeleton-poster" />
      </div>
    </section>
  );
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}
