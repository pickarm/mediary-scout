"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Clock3,
  Cpu,
  Database,
  Film,
  HardDrive,
  RefreshCw,
  Tag,
} from "lucide-react";
import { formatUptime, type SystemInfoSnapshot } from "../lib/system-info-format";
import styles from "./system-info-panel.module.css";

function formatLocalTimestamp(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date(ts));
  } catch {
    return iso;
  }
}

function dbStatusMeta(status: SystemInfoSnapshot["database"]["status"]): { label: string; tone: string } {
  return status === "connected"
    ? { label: "已连接", tone: "tone-green" }
    : { label: "连接异常", tone: "tone-red" };
}

function redisStatusMeta(status: SystemInfoSnapshot["redis"]["status"]): { label: string; tone: string } {
  switch (status) {
    case "connected":
      return { label: "已连接", tone: "tone-green" };
    case "unconfigured":
      return { label: "未配置", tone: "tone-muted" };
    case "rehearsal":
      return { label: "演练禁用", tone: "tone-amber" };
    case "error":
      return { label: "连接异常", tone: "tone-red" };
  }
}

export function SystemInfoPanel({
  initial,
  libraryHref,
  settingsUpdateHref,
}: {
  initial: SystemInfoSnapshot;
  libraryHref: string;
  settingsUpdateHref: string;
}) {
  const [snapshot, setSnapshot] = useState<SystemInfoSnapshot>(initial);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => {
    setSnapshot(initial);
    setElapsedSec(0);
  }, [initial]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [snapshot.collectedAt]);

  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await fetch("/api/system/info", { cache: "no-store" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `刷新失败（HTTP ${response.status}）`);
      }
      const next = (await response.json()) as SystemInfoSnapshot;
      setSnapshot(next);
      setElapsedSec(0);
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "系统状态刷新失败，请稍后重试。");
    } finally {
      setRefreshing(false);
    }
  };

  const dbBadge = dbStatusMeta(snapshot.database.status);
  const redisBadge = redisStatusMeta(snapshot.redis.status);
  const liveUptimeText = formatUptime(snapshot.process.uptimeSeconds + elapsedSec);
  const shortCommit = snapshot.version.buildCommit ? snapshot.version.buildCommit.slice(0, 12) : null;
  const versionLabel = snapshot.version.buildVersion ?? "dev";

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.collectedMeta}>
          上次采集：{formatLocalTimestamp(snapshot.collectedAt)}
        </span>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            void refresh();
          }}
          disabled={refreshing}
        >
          <RefreshCw size={14} className={refreshing ? "spin" : undefined} aria-hidden />
          {refreshing ? "刷新中…" : "刷新状态"}
        </button>
      </div>

      {refreshError ? (
        <p className={styles.errorNote} role="alert">
          {refreshError}
        </p>
      ) : null}

      <section className={styles.overviewGrid} aria-label="系统概览">
        <article className={styles.statCard}>
          <div className={styles.statHead}>
            <span>已入库影片</span>
            <Film size={15} aria-hidden />
          </div>
          <div className={styles.statValue}>{snapshot.library.landedTotal} 部</div>
          <div className={styles.statSub}>
            电影 {snapshot.library.landedMovies} · 剧集 {snapshot.library.landedTv} · 动漫{" "}
            {snapshot.library.landedAnime}
          </div>
        </article>

        <article className={styles.statCard}>
          <div className={styles.statHead}>
            <span>持续运行时间</span>
            <Clock3 size={15} aria-hidden />
          </div>
          <div className={styles.statValue} data-testid="system-uptime">
            {liveUptimeText}
          </div>
          <div className={styles.statSub}>
            启动于 {formatLocalTimestamp(snapshot.process.startedAt)}
          </div>
        </article>

        <article className={styles.statCard}>
          <div className={styles.statHead}>
            <span>系统版本</span>
            <Tag size={15} aria-hidden />
          </div>
          <div className={styles.statValue}>{versionLabel}</div>
          <div className={styles.statSub}>
            {shortCommit ? `提交 ${shortCommit}` : "未写入构建提交"} ·{" "}
            {snapshot.version.distribution === "fork-image" ? "预构建容器镜像" : "本地源码运行"}
          </div>
        </article>

        <article className={styles.statCard}>
          <div className={styles.statHead}>
            <span>服务连接</span>
            <Activity size={15} aria-hidden />
          </div>
          <div className={styles.badgeRow}>
            <span className={`hub-badge ${dbBadge.tone}`}>
              {snapshot.database.engine === "sqlite" ? "SQLite" : "数据库"}：{dbBadge.label}
            </span>
            <span className={`hub-badge ${redisBadge.tone}`}>
              Redis：{redisBadge.label}
            </span>
          </div>
          <div className={styles.statSub}>
            {snapshot.database.latencyMs !== null ? `数据库 ${snapshot.database.latencyMs} ms` : "数据库延迟未知"}
            {snapshot.redis.latencyMs !== null ? ` · Redis ${snapshot.redis.latencyMs} ms` : ""}
          </div>
        </article>
      </section>

      <section className={styles.detailGrid} aria-label="系统详情">
        <article className={`panel ${styles.detailPanel}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Database size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                数据库（{snapshot.database.engine === "sqlite" ? "SQLite" : "PostgreSQL"}）
              </h2>
              <p className="panel-note">任务队列、媒体库索引与账号会话唯一持久化存储</p>
            </div>
            <span className={`hub-badge ${dbBadge.tone}`}>{dbBadge.label}</span>
          </div>

          <dl className={styles.kvList}>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>服务版本</dt>
              <dd className={styles.kvValue}>{snapshot.database.serverVersion ?? "不可用"}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>探测延迟</dt>
              <dd className={styles.kvValue}>
                {snapshot.database.latencyMs !== null ? `${snapshot.database.latencyMs} ms` : "—"}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>连接地址</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.canViewInfraDetails ? (snapshot.database.target ?? "—") : "仅站主可见"}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>数据库名</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.canViewInfraDetails ? (snapshot.database.databaseName ?? "—") : "仅站主可见"}
              </dd>
            </div>
            {snapshot.database.sslMode ? (
              <div className={styles.kvRow}>
                <dt className={styles.kvLabel}>SSL 模式</dt>
                <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                  {snapshot.canViewInfraDetails ? snapshot.database.sslMode : "仅站主可见"}
                </dd>
              </div>
            ) : null}
          </dl>

          {snapshot.database.message ? (
            <p className={styles.errorNote}>{snapshot.database.message}</p>
          ) : null}
        </article>

        <article className={`panel ${styles.detailPanel}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Activity size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                Redis 缓存
              </h2>
              <p className="panel-note">可选媒体库与活动摘要缓存；不可用时自动安全降级至数据库</p>
            </div>
            <span className={`hub-badge ${redisBadge.tone}`}>{redisBadge.label}</span>
          </div>

          <dl className={styles.kvList}>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>服务版本</dt>
              <dd className={styles.kvValue}>{snapshot.redis.serverVersion ?? "—"}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>探测延迟</dt>
              <dd className={styles.kvValue}>
                {snapshot.redis.latencyMs !== null ? `${snapshot.redis.latencyMs} ms` : "—"}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>连接地址</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.canViewInfraDetails
                  ? snapshot.redis.target
                    ? `${snapshot.redis.target} (${snapshot.redis.dbIndex ?? "db0"}${snapshot.redis.tls ? ", TLS" : ""})`
                    : "—"
                  : "仅站主可见"}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>摘要缓存器</dt>
              <dd className={styles.kvValue}>
                {snapshot.redis.summaryCacheReady ? "已就绪" : "按需休眠或直查数据库"}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>缓存命名空间</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.canViewInfraDetails ? (snapshot.redis.namespace || "mediary-scout") : "仅站主可见"}
              </dd>
            </div>
          </dl>

          {snapshot.redis.message ? (
            <p className={snapshot.redis.status === "error" ? styles.errorNote : styles.statusNote}>
              {snapshot.redis.message}
            </p>
          ) : null}
        </article>

        <article className={`panel ${styles.detailPanel}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <HardDrive size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                媒体库统计
              </h2>
              <p className="panel-note">统计当前账号下已实际入库影片、追踪项目与绑定网盘</p>
            </div>
          </div>

          <dl className={styles.kvList}>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>已入库影片总数</dt>
              <dd className={styles.kvValue}>{snapshot.library.landedTotal} 部</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>分类明细</dt>
              <dd className={styles.kvValue}>
                电影 {snapshot.library.landedMovies} · 剧集 {snapshot.library.landedTv} · 动漫{" "}
                {snapshot.library.landedAnime}
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>追踪作品总数</dt>
              <dd className={styles.kvValue}>{snapshot.library.trackedTotal} 部</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>已入库集数 / 影片条数</dt>
              <dd className={styles.kvValue}>{snapshot.library.obtainedEpisodes}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>网盘连接（活动 / 总数）</dt>
              <dd className={styles.kvValue}>
                {snapshot.library.activeDrives} / {snapshot.library.totalDrives}
              </dd>
            </div>
          </dl>

          <div className={styles.panelFooter}>
            <span className={styles.statusNote}>仅统计当前账号可见的媒体库记录</span>
            <Link className="secondary-button" href={libraryHref}>
              查看媒体库
            </Link>
          </div>
        </article>

        <article className={`panel ${styles.detailPanel}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Cpu size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                系统与运行环境
              </h2>
              <p className="panel-note">构建指纹、容器镜像及 Node.js 运行时状态</p>
            </div>
          </div>

          <dl className={styles.kvList}>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>构建版本</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>{versionLabel}</dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>构建提交</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.version.buildCommit ?? "未知"}
              </dd>
            </div>
            {snapshot.version.imageRef ? (
              <div className={styles.kvRow}>
                <dt className={styles.kvLabel}>追踪镜像</dt>
                <dd className={`${styles.kvValue} ${styles.kvMono}`}>{snapshot.version.imageRef}</dd>
              </div>
            ) : null}
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>Node.js 运行时</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.process.nodeVersion} ({snapshot.process.platform}/{snapshot.process.arch})
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>进程内存（RSS / Heap）</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>
                {snapshot.process.memoryRssMb} MB / {snapshot.process.memoryHeapUsedMb} MB
              </dd>
            </div>
            <div className={styles.kvRow}>
              <dt className={styles.kvLabel}>进程 PID</dt>
              <dd className={`${styles.kvValue} ${styles.kvMono}`}>{snapshot.process.pid}</dd>
            </div>
          </dl>

          <div className={styles.panelFooter}>
            <span className={styles.statusNote}>
              {snapshot.version.rehearsalMode
                ? "当前处于演练保护模式"
                : snapshot.version.demoMode
                  ? "当前处于只读演示模式"
                  : "支持前往设置页检测最新容器镜像"}
            </span>
            <Link className="secondary-button" href={settingsUpdateHref}>
              检查镜像更新
            </Link>
          </div>
        </article>
      </section>
    </div>
  );
}
