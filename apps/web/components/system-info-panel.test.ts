import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SystemInfoSnapshot } from "../lib/system-info-format";
import { SystemInfoPanel } from "./system-info-panel";

function makeSnapshot(over?: Partial<SystemInfoSnapshot>): SystemInfoSnapshot {
  return {
    collectedAt: "2026-11-26T14:00:00.000Z",
    process: {
      startedAt: "2026-11-26T10:00:00.000Z",
      uptimeSeconds: 4 * 3_600 + 15 * 60 + 9,
      nodeVersion: "v22.13.0",
      platform: "linux",
      arch: "x64",
      memoryRssMb: 180.5,
      memoryHeapUsedMb: 92.3,
      pid: 42,
    },
    version: {
      buildVersion: "v2026.11.26",
      buildCommit: "f7fefad8b5f2f686dc5dc16cd9981973e60e6c92",
      distribution: "fork-image",
      imageRef: "ghcr.io/pickarm/mediary-scout:latest",
      demoMode: false,
      rehearsalMode: false,
    },
    auth: {
      mode: "account-auth",
      passwordConfigured: true,
    },
    database: {
      engine: "postgresql",
      status: "connected",
      latencyMs: 4,
      serverVersion: "PostgreSQL 16.4",
      target: "postgres.internal:5432",
      databaseName: "media_track",
      sslMode: "disable",
      message: null,
    },
    redis: {
      status: "connected",
      latencyMs: 2,
      serverVersion: "Redis 7.4.0",
      target: "redis.internal:6379",
      dbIndex: "db0",
      tls: false,
      summaryCacheReady: true,
      namespace: "mediary-scout",
      message: null,
    },
    library: {
      landedTotal: 25,
      landedMovies: 15,
      landedTv: 6,
      landedAnime: 4,
      trackedTotal: 28,
      obtainedEpisodes: 180,
      activeDrives: 2,
      totalDrives: 3,
    },
    canViewInfraDetails: true,
    ...over,
  };
}

describe("SystemInfoPanel", () => {
  it("renders database, redis, version, uptime, and library counts for owner", () => {
    const html = renderToStaticMarkup(
      createElement(SystemInfoPanel, {
        initial: makeSnapshot(),
        libraryHref: "/?tab=library",
        settingsUpdateHref: "/settings?tab=update",
      }),
    );

    expect(html).toContain("25 部");
    expect(html).toContain("电影 15 · 剧集 6 · 动漫 4");
    expect(html).toContain("4 小时 15 分 09 秒");
    expect(html).toContain("v2026.11.26");
    expect(html).toContain("f7fefad8b5f2");
    expect(html).toContain("PostgreSQL 16.4");
    expect(html).toContain("postgres.internal:5432");
    expect(html).toContain("Redis 7.4.0");
    expect(html).toContain("redis.internal:6379 (db0)");
    expect(html).toContain("2 / 3");
    expect(html).toContain("ghcr.io/pickarm/mediary-scout:latest");
    expect(html).toContain("强制账号密码登录（已设密码）");
  });

  it("masks infrastructure endpoints when canViewInfraDetails is false", () => {
    const html = renderToStaticMarkup(
      createElement(SystemInfoPanel, {
        initial: makeSnapshot({
          canViewInfraDetails: false,
          database: {
            engine: "postgresql",
            status: "connected",
            latencyMs: 5,
            serverVersion: "PostgreSQL 16.4",
            target: null,
            databaseName: null,
            sslMode: null,
            message: null,
          },
          redis: {
            status: "unconfigured",
            latencyMs: null,
            serverVersion: null,
            target: null,
            dbIndex: null,
            tls: false,
            summaryCacheReady: false,
            namespace: "",
            message: "未配置 REDIS_URL（当前由 PostgreSQL 直接响应摘要查询）",
          },
        }),
        libraryHref: "/?tab=library",
        settingsUpdateHref: "/settings?tab=update",
      }),
    );

    expect(html).toContain("仅站主可见");
    expect(html).toContain("未配置");
    expect(html).not.toContain("postgres.internal");
  });
});
