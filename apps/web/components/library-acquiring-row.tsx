"use client";

import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import type { ActivityActiveRunSummary, PostgresActivityPage } from "@media-track/workflow/activity-query";
import type { LibraryProgressMediaType } from "../lib/library-progress-client";

export interface LibraryAcquiringTitle {
  type: LibraryProgressMediaType;
  tmdbId: number;
  title: string;
  year: number | null;
  posterPath: string | null;
}

export function libraryMediaIdentityKey(mediaType: LibraryProgressMediaType, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

/**
 * The activity page contains one row per run; the library wall contains one
 * poster per media identity. Keep movie and TV ids distinct, and keep the first
 * (running-first) run for a title.
 */
export function dedupeLibraryAcquiringTitles(
  runs: readonly ActivityActiveRunSummary[],
  mediaType: LibraryProgressMediaType | null,
): LibraryAcquiringTitle[] {
  const seen = new Set<string>();
  const titles: LibraryAcquiringTitle[] = [];
  for (const run of runs) {
    if (mediaType !== null && run.type !== mediaType) continue;
    const key = libraryMediaIdentityKey(run.type, run.tmdbId);
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push({
      type: run.type,
      tmdbId: run.tmdbId,
      title: run.title,
      year: run.year,
      posterPath: run.posterPath,
    });
  }
  return titles;
}

function activityHref(storageId: string | undefined): string {
  return storageId ? `/activity?w=${encodeURIComponent(storageId)}` : "/activity";
}

export function LibraryAcquiringRow({
  page,
  storageId,
  mediaType,
  search = "",
  serverMatchedKeys,
}: {
  page: PostgresActivityPage | null;
  storageId?: string | undefined;
  mediaType: LibraryProgressMediaType | null;
  search?: string;
  serverMatchedKeys?: ReadonlySet<string> | undefined;
}) {
  if (!page) return null;
  const needle = search.trim().toLowerCase();
  const titles = dedupeLibraryAcquiringTitles(page.active.items, mediaType)
    .filter((title) => needle === ""
      || title.title.toLowerCase().includes(needle)
      || serverMatchedKeys?.has(libraryMediaIdentityKey(title.type, title.tmdbId)) === true);
  if (titles.length === 0) {
    // The bounded first page can contain only other media types. Keep a
    // category-neutral activity entry without inventing a category count.
    const otherTypeOnPage = mediaType !== null && page.active.items.some((run) => run.type !== mediaType);
    if (needle !== "" || !otherTypeOnPage || page.totals.active === 0) return null;
    return <div className="category-section" aria-label="获取中活动">
      <div className="category-header is-static">
        <h2>获取中活动</h2>
        <Link
          className="secondary-button"
          href={activityHref(storageId)}
          aria-label={`查看全部获取中活动（共 ${page.totals.active} 项）`}
        >
          查看全部
        </Link>
      </div>
      <p className="panel-note">当前有界列表未包含本分类作品，可查看全部活动。</p>
    </div>;
  }
  const more = page.active.hasMore || page.totals.active > titles.length || mediaType !== null;
  return <div className="category-section" aria-label="获取中">
    <div className="category-header is-static">
      <h2>获取中 {titles.length}</h2>
      {more ? <Link
        className="secondary-button"
        href={activityHref(storageId)}
        aria-label={`查看全部获取中活动（共 ${page.totals.active} 项）`}
      >
        查看全部
      </Link> : null}
    </div>
    <div className="poster-row">
      {titles.map((title) => <LibraryAcquiringCard key={libraryMediaIdentityKey(title.type, title.tmdbId)} title={title} />)}
    </div>
  </div>;
}

function LibraryAcquiringCard({ title }: { title: LibraryAcquiringTitle }) {
  return <div className="wall-card is-loading" aria-disabled="true" title="获取中，完成后可进入">
    <span className="wall-poster">
      {title.posterPath ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://image.tmdb.org/t/p/w342${title.posterPath}`} alt="" loading="lazy" />
      ) : <span className="poster-fallback">{title.title.slice(0, 4)}</span>}
      <span className="wall-loading-overlay">
        <LoaderCircle size={20} className="spin" aria-hidden />
        <span>获取中</span>
      </span>
    </span>
    <span className="wall-copy">
      <strong>{title.title}</strong>
      <span>{title.year ?? "年份未知"} · 正在获取</span>
    </span>
  </div>;
}
