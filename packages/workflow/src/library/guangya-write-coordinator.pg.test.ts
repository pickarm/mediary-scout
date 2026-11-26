import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GuangYaWriteCoordinator } from "./guangya-write-coordinator.js";

const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const pgDescribe = adminUrl ? describe : describe.skip;
const dbName = `media_track_write_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let firstPool: Pool;
let secondPool: Pool;
let firstCoordinator: GuangYaWriteCoordinator;
let secondCoordinator: GuangYaWriteCoordinator;
const lockAppName = "media-track-f07b-test-lock";

pgDescribe("GuangYa write coordinator PostgreSQL integration", () => {
  beforeAll(async () => {
    if (!adminUrl) return;
    const parsed = new URL(adminUrl);
    const port = parsed.port ? Number(parsed.port) : 5432;
    const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (!localHost || !Number.isSafeInteger(port) || port < 1 || port > 65_535 || parsed.pathname !== "/postgres") {
      throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL must target the isolated local test server");
    }
    admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${dbName}`;
    firstPool = new Pool({ connectionString: databaseUrl.toString(), max: 2, application_name: lockAppName });
    firstPool.on("error", () => {});
    secondPool = new Pool({ connectionString: databaseUrl.toString(), max: 2 });
    secondPool.on("error", () => {});
    firstCoordinator = new GuangYaWriteCoordinator(firstPool);
    secondCoordinator = new GuangYaWriteCoordinator(secondPool);
  }, 30_000);

  afterAll(async () => {
    if (firstPool) await firstPool.end();
    if (secondPool) await secondPool.end();
    if (admin) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [dbName]);
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    }
  }, 30_000);

  it("serializes separate coordinators, lets another account progress, and fences after backend termination", async () => {
    const held = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = firstCoordinator.run(["guangya:shared"], async () => {
      order.push("first-start");
      held.resolve();
      await release.promise;
      order.push("first-end");
    });
    await held.promise;
    const second = secondCoordinator.run(["guangya:shared"], async () => { order.push("second"); });
    await secondCoordinator.run(["guangya:other"], async () => { order.push("other"); });
    expect(order).toEqual(["first-start", "other"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "other", "first-end", "second"]);

    await firstCoordinator.run(["guangya:lost"], async () => {
      const result = await admin.query<{ pid: number }>(
        "SELECT a.pid FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid WHERE a.application_name = $1 AND a.datname = $2 AND l.locktype = 'advisory' AND l.granted LIMIT 1",
        [lockAppName, dbName],
      );
      const pid = result.rows[0]?.pid;
      expect(pid).toBeTypeOf("number");
      await admin.query("SELECT pg_terminate_backend($1)", [pid]);
      await expect(firstCoordinator.assertHeld("guangya:lost")).rejects.toThrow("GUANGYA_WRITE_LOCK_LOST");
    });
    await secondCoordinator.run(["guangya:lost"], async () => {
      await expect(secondCoordinator.assertHeld("guangya:lost")).resolves.toBeUndefined();
    });
  }, 30_000);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
