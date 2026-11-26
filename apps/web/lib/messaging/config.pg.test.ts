import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeWorkflowPostgresSchema, PostgresWorkflowRepository } from "../../../../packages/workflow/src/postgres";
import { readMessagingConnections, saveMessagingConnectionWithLock } from "./config";
const adminUrl = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
describe.skipIf(!adminUrl)("atomic messaging configuration", () => {
  const database = `v11_settings_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool; let pool: pg.Pool; let repository: PostgresWorkflowRepository;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl }); await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(adminUrl!); url.pathname = `/${database}`; pool = new pg.Pool({ connectionString: url.toString() });
    pool.on("error", () => {});
    await initializeWorkflowPostgresSchema(pool); repository = new PostgresWorkflowRepository(pool);
    for (const id of ["alice", "bob"]) await repository.createAccount({ id, username: id, passwordHash: "test-hash", groupId: null, isOwner: false, createdAt: "2026-11-17T00:00:00.000Z" });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`); await admin.end(); } });
  it("allows only one account to claim a bot during concurrent saves", async () => {
    const input = { platform: "telegram" as const, enabled: false, senderId: "123", defaultStorageId: null, credentials: { token: "shared-bot:test-token" } };
    const result = await Promise.allSettled([saveMessagingConnectionWithLock("alice", input, repository, pool), saveMessagingConnectionWithLock("bob", input, repository, pool)]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await Promise.all([readMessagingConnections("alice", repository), readMessagingConnections("bob", repository)]);
    expect(owners.flat().filter((c) => c.botId === "shared-bot")).toHaveLength(1);
  });
  it("retains both platform settings during concurrent saves to the same account", async () => {
    await Promise.all([
      saveMessagingConnectionWithLock("alice", { platform: "weixin", enabled: false, senderId: "wx-user", botId: "wx-bot", defaultStorageId: null, credentials: { token: "wx-token" } }, repository, pool),
      saveMessagingConnectionWithLock("alice", { platform: "feishu", enabled: false, senderId: "fs-user", defaultStorageId: null, credentials: { appId: "fs-app", appSecret: "fs-secret" } }, repository, pool),
    ]);
    expect((await readMessagingConnections("alice", repository)).map((c) => c.platform)).toEqual(expect.arrayContaining(["weixin", "feishu"]));
  });
  it("conditionally consumes the current QR in the same transaction as binding", async () => {
    const previous = await readMessagingConnections("alice", repository);
    await repository.setAccountSetting("alice", "messaging_weixin_login", "current-qr");
    const input = { platform: "weixin" as const, enabled: false, senderId: "wx-user", botId: "new-wx-bot", defaultStorageId: null, credentials: { token: "new-wx-token" } };
    await expect(saveMessagingConnectionWithLock("alice", input, repository, pool, { pendingWeixinQr: "old-qr" })).rejects.toThrow(/失效/);
    expect(await readMessagingConnections("alice", repository)).toEqual(previous);
    expect(await repository.getAccountSetting("alice", "messaging_weixin_login")).toBe("current-qr");
    await saveMessagingConnectionWithLock("alice", input, repository, pool, { pendingWeixinQr: "current-qr" });
    expect(await repository.getAccountSetting("alice", "messaging_weixin_login")).toBe("");
    expect((await readMessagingConnections("alice", repository)).find((c) => c.platform === "weixin")?.botId).toBe("new-wx-bot");
  });
});
