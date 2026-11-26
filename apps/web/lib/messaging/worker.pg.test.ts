import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresMessagingStore } from "./store";
import type { MessagingConnection } from "./types";
import { listRecoverableMessagingJobIds } from "./worker";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

const connection: MessagingConnection = {
  id: "connection-recovery",
  accountId: "account-recovery",
  platform: "weixin",
  botId: "bot-recovery",
  enabled: true,
  senderId: "owner-recovery",
  defaultStorageId: null,
  credentials: {},
};

integration("messaging worker recovery", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let databaseName = "";
  let databaseCreated = false;

  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `messaging_worker_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrl = new URL(adminConnectionString);
    databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });
    pool.on("error", () => {});
    await pool.query(
      "CREATE TABLE account_settings (account_id text NOT NULL, key text NOT NULL, value text NOT NULL, PRIMARY KEY(account_id,key))",
    );
  }, 30_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      try {
        if (databaseCreated) await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      } finally {
        await adminPool.end();
      }
    }
  }, 30_000);

  it("returns every eligible durable job without a latest-100 cutoff", async () => {
    const store = new PostgresMessagingStore(pool);
    await store.ensureSchema();
    for (let index = 0; index < 105; index += 1) {
      await store.accept(connection, [
        {
          connectionId: connection.id,
          platform: connection.platform,
          botId: connection.botId,
          messageId: `queued-${index}`,
          conversationId: "private-chat",
          senderId: connection.senderId,
          text: "恢复",
        },
      ]);
    }
    await pool.query(
      `UPDATE messaging_jobs
       SET phase='queued',
           result='{"kind":"acquisition_request"}'::jsonb
       WHERE platform_message_id LIKE 'queued-%'`,
    );

    const [selection] = await store.accept(connection, [
      {
        connectionId: connection.id,
        platform: connection.platform,
        botId: connection.botId,
        messageId: "direct-selection",
        conversationId: "private-chat",
        senderId: connection.senderId,
        text: "https://115.com/s/select",
      },
    ]);
    await pool.query(
      `UPDATE messaging_jobs
       SET input_kind='direct_link', phase='pending_selection'
       WHERE id=$1`,
      [selection!.id],
    );

    const [submitted] = await store.accept(connection, [
      {
        connectionId: connection.id,
        platform: connection.platform,
        botId: connection.botId,
        messageId: "direct-submitted",
        conversationId: "private-chat",
        senderId: connection.senderId,
        text: "https://115.com/s/submitted",
      },
    ]);
    await pool.query(
      `UPDATE messaging_jobs
       SET input_kind='direct_link', phase='submitted', workflow_run_id='direct-run'
       WHERE id=$1`,
      [submitted!.id],
    );

    const [unsent] = await store.accept(connection, [
      {
        connectionId: connection.id,
        platform: connection.platform,
        botId: connection.botId,
        messageId: "unsent-result",
        conversationId: "private-chat",
        senderId: connection.senderId,
        text: "帮助",
      },
    ]);
    await pool.query(
      `UPDATE messaging_jobs
       SET phase='completed', send_status='pending', result='{"text":"待发送"}'::jsonb
       WHERE id=$1`,
      [unsent!.id],
    );

    const [linkedNative] = await store.accept(connection, [
      {
        connectionId: connection.id,
        platform: connection.platform,
        botId: connection.botId,
        messageId: "linked-native",
        conversationId: "private-chat",
        senderId: connection.senderId,
        text: "电影",
      },
    ]);
    await pool.query(
      `UPDATE messaging_jobs
       SET phase='queued', workflow_run_id='native-run', send_status='sent'
       WHERE id=$1`,
      [linkedNative!.id],
    );

    const recovered = await listRecoverableMessagingJobIds(pool);

    expect(recovered).toHaveLength(108);
    expect(recovered.some((row) => row.id === selection!.id)).toBe(false);
    expect(recovered.some((row) => row.id === submitted!.id)).toBe(true);
    expect(recovered.some((row) => row.id === unsent!.id)).toBe(true);
    expect(recovered.some((row) => row.id === linkedNative!.id)).toBe(true);
  }, 60_000);
});
