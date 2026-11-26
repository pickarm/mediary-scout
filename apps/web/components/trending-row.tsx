import Link from "next/link";
import { Film, RefreshCw, Search } from "lucide-react";
import { showHref } from "@media-track/workflow/scope";
import { tmdbImageUrl } from "../lib/tmdb-image";
import {
  getTrending,
  getTrendingLibraryBadges,
  trendingIdentityKey,
  TRENDING_KINDS,
  TRENDING_KIND_ORDER,
  type TrendingKind,
} from "../lib/trending";

/**
 * 搜索页空态「近期热门」发现区。点击卡片使用 showHref + t 参数直达详情页
 * （保留当前工作区 ?w），并叠加当前账号/工作区已入库/追更状态徽章。
 */
export async function TrendingRow({
  activeKind,
  basePath,
  storageId,
}: {
  activeKind: TrendingKind;
  basePath: string;
  storageId?: string | undefined;
}) {
  const cards = await getTrending(activeKind);
  if (cards.length === 0) {
    return (
      <div className="quiet-state">
        <Search size={24} aria-hidden />
        <strong>输入目标名称</strong>
        <span>搜索后才会请求元数据。</span>
      </div>
    );
  }
  const badges = await getTrendingLibraryBadges(cards, storageId);
  return (
    <section className="trending" aria-label="近期热门">
      <div className="trending-head">
        <div className="trending-tabs">
          <h2>近期热门</h2>
          {TRENDING_KIND_ORDER.map((kind) => (
            <Link
              key={kind}
              className={`filter-pill ${kind === activeKind ? "is-active" : ""}`}
              href={`${basePath}?trending=${kind}`}
            >
              {TRENDING_KINDS[kind].label}
            </Link>
          ))}
        </div>
        <span className="trending-note">
          <RefreshCw size={12} aria-hidden /> 每日更新 · 来自 TMDB
        </span>
      </div>
      <div className="trending-grid">
        {cards.map((card, index) => {
          const posterUrl = tmdbImageUrl(card.posterPath, "w342");
          const badge = badges.get(trendingIdentityKey(card.mediaType, card.tmdbId));
          const detailType = activeKind === "anime" ? "anime" : card.mediaType;
          return (
            <Link
              key={`${card.mediaType}_${card.tmdbId}`}
              className="trending-card"
              href={showHref(card.tmdbId, "search", storageId, detailType)}
            >
              <div className="trending-poster">
                {posterUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={posterUrl} alt="" loading="lazy" />
                ) : (
                  <Film size={24} aria-hidden />
                )}
                <span className="trending-rank">#{index + 1}</span>
                {badge ? (
                  <span className={`trending-badge hub-badge tone-${badge.tone}`}>
                    {badge.label}
                  </span>
                ) : null}
              </div>
              <span className="trending-title">{card.title}</span>
              <span className="trending-meta">
                {card.year ?? "—"} · {activeKind === "anime" ? "动漫" : card.mediaType === "movie" ? "电影" : "剧集"}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
