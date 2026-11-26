import { describe, expect, it } from "vitest";
import {
  extractPostgresVersionLabel,
  formatUptime,
  parseSanitizedPostgresTarget,
  parseSanitizedRedisTarget,
} from "./system-info-format";

describe("formatUptime", () => {
  it("formats seconds, minutes, hours, and days cleanly and clamps non-positive values", () => {
    expect(formatUptime(-5)).toBe("0 秒");
    expect(formatUptime(Number.NaN)).toBe("0 秒");
    expect(formatUptime(0)).toBe("0 秒");
    expect(formatUptime(18)).toBe("18 秒");
    expect(formatUptime(5 * 60 + 4)).toBe("5 分 04 秒");
    expect(formatUptime(2 * 3_600 + 3 * 60 + 9)).toBe("2 小时 03 分 09 秒");
    expect(formatUptime(3 * 86_400 + 4 * 3_600 + 12 * 60 + 8)).toBe("3 天 4 小时 12 分 08 秒");
  });
});

describe("parseSanitizedPostgresTarget", () => {
  it("extracts host, port, database name, and sslmode while stripping credentials", () => {
    expect(
      parseSanitizedPostgresTarget(
        "postgresql://superadmin:top-secret-pw@PG.Internal.Local:5433/media_track?sslmode=require&password=leak",
      ),
    ).toEqual({
      target: "pg.internal.local:5433",
      databaseName: "media_track",
      sslMode: "require",
    });

    expect(parseSanitizedPostgresTarget("postgres://user:pass@127.0.0.1/appdb")).toEqual({
      target: "127.0.0.1:5432",
      databaseName: "appdb",
      sslMode: null,
    });
  });

  it("returns null for empty, invalid, or non-postgres URLs", () => {
    expect(parseSanitizedPostgresTarget(undefined)).toBeNull();
    expect(parseSanitizedPostgresTarget("")).toBeNull();
    expect(parseSanitizedPostgresTarget("http://localhost:5432/db")).toBeNull();
    expect(parseSanitizedPostgresTarget("not-a-url")).toBeNull();
  });
});

describe("parseSanitizedRedisTarget", () => {
  it("extracts host, port, dbIndex, and tls flag without exposing passwords", () => {
    expect(parseSanitizedRedisTarget("rediss://default:redis-secret@cache.example.com:6380/2")).toEqual({
      target: "cache.example.com:6380",
      dbIndex: "db2",
      tls: true,
    });

    expect(parseSanitizedRedisTarget("redis://:pw@127.0.0.1")).toEqual({
      target: "127.0.0.1:6379",
      dbIndex: "db0",
      tls: false,
    });
  });

  it("returns null for empty or invalid URLs", () => {
    expect(parseSanitizedRedisTarget(undefined)).toBeNull();
    expect(parseSanitizedRedisTarget("http://127.0.0.1:6379")).toBeNull();
  });
});

describe("extractPostgresVersionLabel", () => {
  it("normalizes full PostgreSQL version banner to concise major/minor label", () => {
    expect(
      extractPostgresVersionLabel(
        "PostgreSQL 16.4 on x86_64-pc-linux-musl, compiled by gcc (Alpine 13.2.1_git20240309) 13.2.1, 64-bit",
      ),
    ).toBe("PostgreSQL 16.4");
    expect(extractPostgresVersionLabel("")).toBeNull();
    expect(extractPostgresVersionLabel(null)).toBeNull();
  });
});
