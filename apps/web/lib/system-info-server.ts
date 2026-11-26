import { isRegisteredStorageProvider } from "@media-track/workflow";
import { probeRedisConnection } from "@media-track/workflow/summary-cache";
import { readBuildCommit, readBuildVersion } from "./deployment-update-server";
import { isDemoMode } from "./demo-mode";
import { resolveTrackedImageRef, resolveUpdateDistribution } from "./fork-release";
import { getLibraryDatabasePool } from "./library-database";
import { isLibrarySummaryCacheReady } from "./library-summary-cache";
import {
  extractPostgresVersionLabel,
  parseSanitizedPostgresTarget,
  parseSanitizedRedisTarget,
  type SystemInfoSnapshot,
} from "./system-info-format";
import { getWorkflowRepository } from "./workflow-runtime";

const DB_PROBE_TIMEOUT_MS = 3_000;
const REDIS_PROBE_TIMEOUT_MS = 1_500;

function roundMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0;
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

function sanitizeDatabaseError(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const combined = `${code} ${message}`.toUpperCase();
  if (combined.includes("28P01") || combined.includes("28000") || combined.includes("PASSWORD")) {
    return "数据库认证失败，请检查账号或密码配置";
  }
  if (combined.includes("3D000")) {
    return "目标数据库不存在";
  }
  if (combined.includes("ECONNREFUSED")) {
    return "数据库连接被拒绝，请确认数据库服务已启动";
  }
  if (combined.includes("ETIMEDOUT") || combined.includes("TIMEOUT")) {
    return "数据库连接或探测超时";
  }
  return "数据库当前不可达，请检查连接配置与服务状态";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ETIMEDOUT")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function probeDatabase(canViewInfraDetails: boolean): Promise<SystemInfoSnapshot["database"]> {
  const sqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH?.trim();
  if (sqlitePath) {
    const startedAt = Date.now();
    try {
      await getWorkflowRepository().getSetting("__healthcheck__");
      return {
        engine: "sqlite",
        status: "connected",
        latencyMs: Math.max(0, Date.now() - startedAt),
        serverVersion: "SQLite (本地存储)",
        target: canViewInfraDetails ? (sqlitePath === ":memory:" ? ":memory:" : "本地文件") : null,
        databaseName: canViewInfraDetails ? (sqlitePath === ":memory:" ? "memory" : "sqlite") : null,
        sslMode: null,
        message: null,
      };
    } catch (error) {
      return {
        engine: "sqlite",
        status: "error",
        latencyMs: Math.max(0, Date.now() - startedAt),
        serverVersion: null,
        target: null,
        databaseName: null,
        sslMode: null,
        message: sanitizeDatabaseError(error),
      };
    }
  }

  const parsedTarget = parseSanitizedPostgresTarget(process.env.MEDIA_TRACK_POSTGRES_URL);
  const startedAt = Date.now();
  try {
    const pool = getLibraryDatabasePool();
    const res = await withTimeout(
      pool.query<{ server_version: string; database_name: string }>(
        "SELECT version() AS server_version, current_database() AS database_name",
      ),
      DB_PROBE_TIMEOUT_MS,
    );
    const row = res.rows[0];
    return {
      engine: "postgresql",
      status: "connected",
      latencyMs: Math.max(0, Date.now() - startedAt),
      serverVersion: extractPostgresVersionLabel(row?.server_version),
      target: canViewInfraDetails ? (parsedTarget?.target ?? null) : null,
      databaseName: canViewInfraDetails ? (row?.database_name ?? parsedTarget?.databaseName ?? null) : null,
      sslMode: canViewInfraDetails ? (parsedTarget?.sslMode ?? null) : null,
      message: null,
    };
  } catch (error) {
    return {
      engine: "postgresql",
      status: "error",
      latencyMs: Math.max(0, Date.now() - startedAt),
      serverVersion: null,
      target: canViewInfraDetails ? (parsedTarget?.target ?? null) : null,
      databaseName: canViewInfraDetails ? (parsedTarget?.databaseName ?? null) : null,
      sslMode: canViewInfraDetails ? (parsedTarget?.sslMode ?? null) : null,
      message: sanitizeDatabaseError(error),
    };
  }
}

async function probeRedis(
  canViewInfraDetails: boolean,
  rehearsalMode: boolean,
): Promise<SystemInfoSnapshot["redis"]> {
  const namespace = process.env.MEDIA_TRACK_SUMMARY_CACHE_NAMESPACE?.trim() || "mediary-scout";
  const summaryCacheReady = isLibrarySummaryCacheReady();
  const rawRedisUrl = process.env.REDIS_URL?.trim();
  const parsedTarget = parseSanitizedRedisTarget(rawRedisUrl);

  if (rehearsalMode) {
    return {
      status: "rehearsal",
      latencyMs: null,
      serverVersion: null,
      target: canViewInfraDetails ? (parsedTarget?.target ?? null) : null,
      dbIndex: canViewInfraDetails ? (parsedTarget?.dbIndex ?? null) : null,
      tls: parsedTarget?.tls ?? false,
      summaryCacheReady,
      namespace: canViewInfraDetails ? namespace : "",
      message: "演练模式下已禁用外部 Redis 连接",
    };
  }

  if (!rawRedisUrl) {
    return {
      status: "unconfigured",
      latencyMs: null,
      serverVersion: null,
      target: null,
      dbIndex: null,
      tls: false,
      summaryCacheReady,
      namespace: canViewInfraDetails ? namespace : "",
      message: "未配置 REDIS_URL（当前由 PostgreSQL 直接响应摘要查询）",
    };
  }

  const probe = await probeRedisConnection(rawRedisUrl, { timeoutMs: REDIS_PROBE_TIMEOUT_MS });
  if (probe.ok) {
    return {
      status: "connected",
      latencyMs: probe.latencyMs,
      serverVersion: probe.version ? `Redis ${probe.version}` : "Redis",
      target: canViewInfraDetails ? (parsedTarget?.target ?? null) : null,
      dbIndex: canViewInfraDetails ? (parsedTarget?.dbIndex ?? null) : null,
      tls: parsedTarget?.tls ?? false,
      summaryCacheReady,
      namespace: canViewInfraDetails ? namespace : "",
      message: null,
    };
  }

  return {
    status: "error",
    latencyMs: probe.latencyMs,
    serverVersion: null,
    target: canViewInfraDetails ? (parsedTarget?.target ?? null) : null,
    dbIndex: canViewInfraDetails ? (parsedTarget?.dbIndex ?? null) : null,
    tls: parsedTarget?.tls ?? false,
    summaryCacheReady,
    namespace: canViewInfraDetails ? namespace : "",
    message: probe.error,
  };
}

interface LibraryCountsRow {
  landed_total: number | string;
  landed_movies: number | string;
  landed_tv: number | string;
  landed_anime: number | string;
  tracked_total: number | string;
  obtained_episodes: number | string;
}

async function collectLibraryStats(accountId: string): Promise<SystemInfoSnapshot["library"]> {
  const repo = getWorkflowRepository();
  const storages = (await repo.listConnectedStorages(accountId)).filter((s) =>
    isRegisteredStorageProvider(s.provider),
  );
  const totalDrives = storages.length;
  const activeDrives = storages.filter((s) => s.status === "active").length;

  const sqlitePath = process.env.MEDIA_TRACK_SQLITE_PATH?.trim();
  if (!sqlitePath && process.env.MEDIA_TRACK_POSTGRES_URL?.trim()) {
    try {
      const pool = getLibraryDatabasePool();
      const result = await withTimeout(
        pool.query<LibraryCountsRow>(
          `
          WITH scoped_seasons AS (
            SELECT ts.id AS season_id,
                   ts.connected_storage_id,
                   m.payload->>'type' AS media_type,
                   (m.payload->>'tmdbId')::integer AS tmdb_id,
                   (ts.payload->>'seasonNumber')::integer AS season_number
              FROM tracked_seasons ts
              JOIN media_titles m ON m.id = ts.media_title_id
             WHERE ts.account_id = $1
               AND NOT ts.id LIKE 'staging-janitor%'
          ),
          obtained_pairs AS (
            SELECT s.media_type, s.tmdb_id, s.season_number, e.episode_code
              FROM scoped_seasons s
              JOIN episode_states e
                ON e.tracked_season_id = s.season_id
               AND e.connected_storage_id = s.connected_storage_id
             WHERE e.payload->>'obtained' = 'true'
            UNION
            SELECT s.media_type, s.tmdb_id, s.season_number, c.episode_code
              FROM scoped_seasons s
              JOIN episode_copies c ON c.tracked_season_id = s.season_id
              JOIN connected_storages cs
                ON cs.id = c.storage_id AND cs.account_id = $1
             WHERE NOT EXISTS (
               SELECT 1 FROM episode_states e
                WHERE e.tracked_season_id = c.tracked_season_id
                  AND e.connected_storage_id = c.storage_id
             )
          ),
          distinct_titles AS (
            SELECT DISTINCT media_type, tmdb_id
              FROM scoped_seasons
          ),
          per_title AS (
            SELECT dt.media_type,
                   dt.tmdb_id,
                   COUNT(op.episode_code)::integer AS obtained_count
              FROM distinct_titles dt
              LEFT JOIN obtained_pairs op
                ON op.media_type = dt.media_type
               AND op.tmdb_id = dt.tmdb_id
             GROUP BY dt.media_type, dt.tmdb_id
          )
          SELECT COUNT(*) FILTER (WHERE obtained_count > 0)::integer AS landed_total,
                 COUNT(*) FILTER (WHERE obtained_count > 0 AND media_type = 'movie')::integer AS landed_movies,
                 COUNT(*) FILTER (WHERE obtained_count > 0 AND media_type = 'tv')::integer AS landed_tv,
                 COUNT(*) FILTER (WHERE obtained_count > 0 AND media_type = 'anime')::integer AS landed_anime,
                 COUNT(*)::integer AS tracked_total,
                 COALESCE(SUM(obtained_count), 0)::integer AS obtained_episodes
            FROM per_title
          `,
          [accountId],
        ),
        DB_PROBE_TIMEOUT_MS,
      );
      const row = result.rows[0];
      return {
        landedTotal: Number(row?.landed_total ?? 0),
        landedMovies: Number(row?.landed_movies ?? 0),
        landedTv: Number(row?.landed_tv ?? 0),
        landedAnime: Number(row?.landed_anime ?? 0),
        trackedTotal: Number(row?.tracked_total ?? 0),
        obtainedEpisodes: Number(row?.obtained_episodes ?? 0),
        activeDrives,
        totalDrives,
      };
    } catch {
      // PG 查询异常时回退到 repo 列表统计，保证页面仍能打开。
    }
  }

  const states = (await repo.listTrackedSeasonStates(accountId)).filter(
    (s) => !s.season.id.startsWith("staging-janitor"),
  );
  const byTitle = new Map<string, { type: string; obtainedKeys: Set<string> }>();
  for (const state of states) {
    const key = `${state.title.type}:${state.title.tmdbId}`;
    let entry = byTitle.get(key);
    if (!entry) {
      entry = { type: state.title.type, obtainedKeys: new Set<string>() };
      byTitle.set(key, entry);
    }
    for (const ep of state.episodes) {
      if (ep.obtained) {
        entry.obtainedKeys.add(`${state.season.seasonNumber}:${ep.episodeCode}`);
      }
    }
  }
  let landedTotal = 0;
  let landedMovies = 0;
  let landedTv = 0;
  let landedAnime = 0;
  let obtainedEpisodes = 0;
  for (const entry of byTitle.values()) {
    const count = entry.obtainedKeys.size;
    obtainedEpisodes += count;
    if (count > 0) {
      landedTotal += 1;
      if (entry.type === "movie") landedMovies += 1;
      else if (entry.type === "tv") landedTv += 1;
      else if (entry.type === "anime") landedAnime += 1;
    }
  }
  return {
    landedTotal,
    landedMovies,
    landedTv,
    landedAnime,
    trackedTotal: byTitle.size,
    obtainedEpisodes,
    activeDrives,
    totalDrives,
  };
}

/** 采集当前实例运行时、版本、数据库、Redis 与当前账号媒体库入库统计。 */
export async function collectSystemInfo(opts: {
  accountId: string;
  canViewInfraDetails: boolean;
}): Promise<SystemInfoSnapshot> {
  const nowMs = Date.now();
  const uptimeSeconds = Math.max(0, Math.floor(process.uptime()));
  const startedAt = new Date(nowMs - uptimeSeconds * 1000).toISOString();
  const mem = process.memoryUsage();
  const rehearsalMode = process.env.MEDIA_TRACK_REHEARSAL === "1";
  const demoMode = isDemoMode();
  const distribution = resolveUpdateDistribution(process.env);
  const trackedImage = resolveTrackedImageRef(process.env);

  const [buildVersion, buildCommit, database, redis, library] = await Promise.all([
    readBuildVersion(),
    readBuildCommit(),
    probeDatabase(opts.canViewInfraDetails),
    probeRedis(opts.canViewInfraDetails, rehearsalMode),
    collectLibraryStats(opts.accountId).catch(() => ({
      landedTotal: 0,
      landedMovies: 0,
      landedTv: 0,
      landedAnime: 0,
      trackedTotal: 0,
      obtainedEpisodes: 0,
      activeDrives: 0,
      totalDrives: 0,
    })),
  ]);

  return {
    collectedAt: new Date(nowMs).toISOString(),
    process: {
      startedAt,
      uptimeSeconds,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memoryRssMb: roundMb(mem.rss),
      memoryHeapUsedMb: roundMb(mem.heapUsed),
      pid: process.pid,
    },
    version: {
      buildVersion,
      buildCommit,
      distribution,
      imageRef: distribution === "fork-image" && trackedImage.ok ? trackedImage.fullRef : null,
      demoMode,
      rehearsalMode,
    },
    database,
    redis,
    library,
    canViewInfraDetails: opts.canViewInfraDetails,
  };
}
