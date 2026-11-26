/** 系统信息纯数据模型与前端安全格式化/脱敏工具（禁止引入 Node / pg / redis 模块）。 */

export interface SystemInfoSnapshot {
  collectedAt: string;
  process: {
    startedAt: string;
    uptimeSeconds: number;
    nodeVersion: string;
    platform: string;
    arch: string;
    memoryRssMb: number;
    memoryHeapUsedMb: number;
    pid: number;
  };
  version: {
    buildVersion: string | null;
    buildCommit: string | null;
    distribution: "fork-image" | "local-source";
    imageRef: string | null;
    demoMode: boolean;
    rehearsalMode: boolean;
  };
  database: {
    engine: "postgresql" | "sqlite";
    status: "connected" | "error";
    latencyMs: number | null;
    serverVersion: string | null;
    target: string | null;
    databaseName: string | null;
    sslMode: string | null;
    message: string | null;
  };
  redis: {
    status: "connected" | "unconfigured" | "rehearsal" | "error";
    latencyMs: number | null;
    serverVersion: string | null;
    target: string | null;
    dbIndex: string | null;
    tls: boolean;
    summaryCacheReady: boolean;
    namespace: string;
    message: string | null;
  };
  library: {
    landedTotal: number;
    landedMovies: number;
    landedTv: number;
    landedAnime: number;
    trackedTotal: number;
    obtainedEpisodes: number;
    activeDrives: number;
    totalDrives: number;
  };
  canViewInfraDetails: boolean;
}

/** 格式化持续运行时间（秒 → 中文可读时长）。 */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0 秒";
  }
  const whole = Math.floor(totalSeconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const seconds = whole % 60;
  const pad2 = (value: number) => String(value).padStart(2, "0");

  if (days > 0) {
    return `${days} 天 ${hours} 小时 ${pad2(minutes)} 分 ${pad2(seconds)} 秒`;
  }
  if (hours > 0) {
    return `${hours} 小时 ${pad2(minutes)} 分 ${pad2(seconds)} 秒`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${pad2(seconds)} 秒`;
  }
  return `${seconds} 秒`;
}

function formatHostPort(hostname: string, port: string): string {
  const cleanHost = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `${cleanHost}:${port}`;
}

/** 脱敏解析 PostgreSQL 连接串：仅提取主机、端口、库名与 sslmode，严格丢弃用户名、密码与其他参数。 */
export function parseSanitizedPostgresTarget(rawUrl: string | undefined): {
  target: string;
  databaseName: string | null;
  sslMode: string | null;
} | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return null;
    }
    if (!parsed.hostname) return null;
    const port = parsed.port || "5432";
    const dbRaw = parsed.pathname.replace(/^\//, "");
    let databaseName: string | null = null;
    if (dbRaw) {
      try {
        databaseName = decodeURIComponent(dbRaw);
      } catch {
        databaseName = dbRaw;
      }
    }
    const sslModeRaw = parsed.searchParams.get("sslmode")?.trim() ?? "";
    return {
      target: formatHostPort(parsed.hostname.toLowerCase(), port),
      databaseName: databaseName || null,
      sslMode: sslModeRaw || null,
    };
  } catch {
    return null;
  }
}

/** 脱敏解析 Redis 连接串：仅提取主机、端口、库序号与 TLS 标记，严格丢弃用户名与密码。 */
export function parseSanitizedRedisTarget(rawUrl: string | undefined): {
  target: string;
  dbIndex: string;
  tls: boolean;
} | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
      return null;
    }
    if (!parsed.hostname) return null;
    const port = parsed.port || "6379";
    const pathSegment = parsed.pathname.replace(/^\//, "").split("/")[0]?.trim() ?? "";
    const dbNumber = /^\d+$/.test(pathSegment) ? pathSegment : "0";
    return {
      target: formatHostPort(parsed.hostname.toLowerCase(), port),
      dbIndex: `db${dbNumber}`,
      tls: parsed.protocol === "rediss:",
    };
  } catch {
    return null;
  }
}

/** 提取简洁的 PostgreSQL 服务版本号（例如 "PostgreSQL 16.4"）。 */
export function extractPostgresVersionLabel(rawVersion: string | null | undefined): string | null {
  const trimmed = rawVersion?.trim();
  if (!trimmed) return null;
  const match = /PostgreSQL\s+([^\s,]+)/i.exec(trimmed);
  if (match?.[1]) {
    return `PostgreSQL ${match[1]}`;
  }
  return trimmed.slice(0, 64);
}
