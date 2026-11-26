"use client";

import Link from "next/link";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { showHref } from "@media-track/workflow/scope";
import type { SearchCandidateCard } from "@media-track/workflow/search-view";
import { tmdbImageUrl } from "../lib/tmdb-image";
import { AcquireProgressBadge } from "./acquire-progress-badge";
import { RequestTrackButton } from "./request-track-button";
import { SeasonRequestMenu } from "./season-request-menu";

export type SearchMediaFilter = "all" | "movie" | "tv";

export interface SearchResultCardItem {
  candidate: SearchCandidateCard;
  acquiring: boolean;
  trackedLabel: string | null;
  trackedSeasonNumbers: number[];
}

/** 按类型筛选搜索结果（纯函数，便于客户端即时切换与单测）。 */
export function filterSearchResultItems(
  items: readonly SearchResultCardItem[],
  filter: SearchMediaFilter,
): SearchResultCardItem[] {
  if (filter === "all") {
    return [...items];
  }
  return items.filter((item) => item.candidate.mediaType === filter);
}

/**
 * 搜索结果客户端视图：展示命中总数、支持「全部 / 电影 / 剧集」即时过滤胶囊，
 * 并为未预取分季详情的剧集卡片提供直达详情页按钮。
 */
export function SearchResultsView({
  query,
  interpretedQuery,
  cacheStatus,
  items,
  storageId,
}: {
  query: string;
  interpretedQuery?: string | undefined;
  cacheStatus: "none" | "hit" | "miss";
  items: SearchResultCardItem[];
  storageId?: string | undefined;
}) {
  const [filter, setFilter] = useState<SearchMediaFilter>("all");
  const movieCount = items.filter((item) => item.candidate.mediaType === "movie").length;
  const tvCount = items.filter((item) => item.candidate.mediaType === "tv").length;
  const visibleItems = filterSearchResultItems(items, filter);

  return (
    <section className="search-results" aria-label="搜索结果">
      <div className="section-heading search-results-heading">
        <div>
          <h2>结果</h2>
          <p>
            共找到 {items.length} 条结果
            {cacheStatus === "hit" ? " · 来自缓存" : ""}
          </p>
          {interpretedQuery ? (
            <p className="panel-note">
              「{query}」像是描述而不是片名 —— 已按「{interpretedQuery}」搜索。
            </p>
          ) : null}
        </div>
        {items.length > 0 ? (
          <div className="search-filter-pills" role="group" aria-label="按类型筛选">
            <button
              type="button"
              className={`filter-pill ${filter === "all" ? "is-active" : ""}`}
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              全部 ({items.length})
            </button>
            <button
              type="button"
              className={`filter-pill ${filter === "movie" ? "is-active" : ""}`}
              aria-pressed={filter === "movie"}
              onClick={() => setFilter("movie")}
            >
              电影 ({movieCount})
            </button>
            <button
              type="button"
              className={`filter-pill ${filter === "tv" ? "is-active" : ""}`}
              aria-pressed={filter === "tv"}
              onClick={() => setFilter("tv")}
            >
              剧集 ({tvCount})
            </button>
          </div>
        ) : null}
      </div>
      {items.length === 0 ? (
        <div className="quiet-state compact">
          <TriangleAlert size={22} aria-hidden />
          <strong>没有匹配结果</strong>
          <span>{query}</span>
          <span className="panel-note">
            可以试试剧情描述（如「男主带着小绿瓶修仙的国漫」），或去掉「第几季／篇章名」只搜作品名。
          </span>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="quiet-state compact">
          <strong>当前筛选下没有{filter === "movie" ? "电影" : "剧集"}结果</strong>
          <button type="button" className="secondary-button" onClick={() => setFilter("all")}>
            查看全部 ({items.length})
          </button>
        </div>
      ) : (
        <div className="candidate-grid">
          {visibleItems.map((item) => (
            <CandidateCard
              key={`${item.candidate.mediaType}_${item.candidate.tmdbId}`}
              candidate={item.candidate}
              acquiring={item.acquiring}
              trackedLabel={item.trackedLabel}
              trackedSeasonNumbers={item.trackedSeasonNumbers}
              storageId={storageId}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CandidateCard({
  candidate,
  acquiring,
  trackedLabel,
  trackedSeasonNumbers,
  storageId,
}: {
  candidate: SearchCandidateCard;
  acquiring: boolean;
  trackedLabel: string | null;
  trackedSeasonNumbers: number[];
  storageId?: string | undefined;
}) {
  const isTv = candidate.mediaType === "tv";
  const trackedSet = new Set(trackedSeasonNumbers);
  const untrackedSeasons = candidate.seasonNumbers.filter(
    (seasonNumber) => !trackedSet.has(seasonNumber),
  );
  const detailHref = showHref(candidate.tmdbId, "search", storageId, candidate.mediaType);
  const posterUrl = tmdbImageUrl(candidate.posterPath, "w342");
  const showDetailButton =
    !acquiring &&
    isTv &&
    (candidate.seasonNumbers.length === 0 || (trackedLabel !== null && untrackedSeasons.length === 0));

  return (
    <article className="candidate-card">
      <Link className="candidate-poster" href={detailHref} aria-hidden tabIndex={-1}>
        {posterUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={posterUrl} alt="" loading="lazy" />
        ) : (
          <span>{candidate.title.slice(0, 4)}</span>
        )}
      </Link>
      <div className="candidate-body">
        <div className="candidate-title-row">
          <div>
            <h3>
              <Link href={detailHref}>{candidate.title}</Link>
            </h3>
            <p>
              {candidate.year} · {isTv ? "剧集" : "电影"}
            </p>
          </div>
          <div className="candidate-actions">
            {acquiring ? (
              <AcquireProgressBadge
                tmdbId={candidate.tmdbId}
                seasonNumber={null}
                storageId={storageId}
                mediaType={candidate.mediaType}
                title="后台正在获取——点查看进度（活动）"
              />
            ) : null}
            {!acquiring && isTv && untrackedSeasons.length > 0 ? (
              <SeasonRequestMenu
                tmdbId={candidate.tmdbId}
                mediaType={candidate.mediaType}
                seasonNumbers={untrackedSeasons}
                totalSeasonCount={candidate.seasonNumbers.length}
                allLabel={
                  trackedLabel !== null ? `获取剩余 ${untrackedSeasons.length} 季` : "获取所有季"
                }
                storageId={storageId}
                demoEntry={{
                  tmdbId: candidate.tmdbId,
                  title: candidate.title,
                  year: candidate.year,
                  type: candidate.mediaType,
                  posterPath: candidate.posterPath,
                }}
              />
            ) : null}
            {showDetailButton ? (
              <Link className="primary-button" href={detailHref}>
                查看详情
              </Link>
            ) : null}
            {!acquiring && !isTv && trackedLabel === null ? (
              <RequestTrackButton
                candidateId={candidate.id}
                tmdbId={candidate.tmdbId}
                mediaType={candidate.mediaType}
                actionState={candidate.action.state}
                disabled={candidate.action.disabled}
                label={candidate.action.label}
                storageId={storageId}
                demoEntry={{
                  tmdbId: candidate.tmdbId,
                  title: candidate.title,
                  year: candidate.year,
                  type: candidate.mediaType,
                  posterPath: candidate.posterPath,
                }}
              />
            ) : null}
          </div>
        </div>
        {candidate.overview ? (
          <p className="candidate-overview">{candidate.overview}</p>
        ) : null}
        <div className="candidate-meta">
          {isTv && candidate.seasonNumbers.length > 0 ? (
            <span>共 {candidate.seasonNumbers.length} 季</span>
          ) : null}
          {!acquiring && trackedLabel !== null ? (
            <span className="hub-badge tone-green">{trackedLabel}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}
