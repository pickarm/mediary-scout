import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { InboundMessage, MessagingConnection } from "./types";
import { PostgresMessagingStore } from "./store";

const adminConnectionString = process.env.MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL;
const integration = describe.skipIf(!adminConnectionString);

let adminPool: pg.Pool;
let pool: pg.Pool;
let databaseName = "";
let databaseCreated = false;

const connection: MessagingConnection = {
  id: "connection-a",
  accountId: "account-a",
  platform: "weixin",
  botId: "bot-a",
  enabled: true,
  senderId: "owner-a",
  defaultStorageId: "storage-a",
  credentials: {},
};

function inbound(input: {
  id: string;
  connectionId?: string;
  senderId?: string;
  text?: string;
  callbackData?: string;
  replyToken?: string;
}): InboundMessage {
  return {
    connectionId: input.connectionId ?? connection.id,
    platform: connection.platform,
    botId: connection.botId,
    messageId: input.id,
    conversationId: "private-chat",
    senderId: input.senderId ?? connection.senderId,
    text: input.text ?? input.id,
    ...(input.callbackData === undefined ? {} : { callbackData: input.callbackData }),
    ...(input.replyToken === undefined ? {} : { replyToken: input.replyToken }),
  };
}

integration("PostgresMessagingStore", () => {
  beforeAll(async () => {
    if (!adminConnectionString) throw new Error("MEDIA_TRACK_TEST_POSTGRES_ADMIN_URL is required");
    adminPool = new pg.Pool({ connectionString: adminConnectionString });
    databaseName = `messaging_${randomUUID().replaceAll("-", "")}`;
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

  beforeEach(async () => {
    await pool.query("DROP TABLE IF EXISTS messaging_jobs");
    await pool.query("TRUNCATE account_settings");
  });

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

  it("filters non-self messages, deduplicates by connection/message id, and commits cursor with the batch", async () => {
    const store = new PostgresMessagingStore(pool);
    await store.ensureSchema();

    const accepted = await store.accept(
      connection,
      [
        inbound({ id: "0001", text: "我想看电影", replyToken: "ctx-1" }),
        inbound({ id: "self", senderId: "bot-a" }),
        inbound({ id: "foreign-connection", connectionId: "connection-b" }),
      ],
      "cursor-1",
    );

    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      accountId: "account-a",
      connectionId: "connection-a",
      platformMessageId: "0001",
      senderId: "owner-a",
      text: "我想看电影",
      replyToken: "ctx-1",
      phase: "received",
    });
    expect(accepted[0]?.id).toEqual(expect.any(String));
    await expect(store.loadCursor("connection-a")).resolves.toBe("cursor-1");
    await expect(
      store.loadLatestReplyToken("account-a", "connection-a", "private-chat"),
    ).resolves.toBe("ctx-1");
    await expect(store.get("account-a", accepted[0]!.id)).resolves.toMatchObject({
      platformMessageId: "0001",
    });

    const duplicate = await store.accept(connection, [inbound({ id: "0001" })], "cursor-2");
    expect(duplicate).toEqual([]);
    await expect(store.loadCursor("connection-a")).resolves.toBe("cursor-2");

    await store.accept(
      connection,
      [inbound({ id: "0002", text: "查询", replyToken: "ctx-2" })],
      "cursor-3",
    );
    await store.accept(connection, [inbound({ id: "0003", text: "帮助" })], "cursor-4");
    await expect(
      store.loadLatestReplyToken("account-a", "connection-a", "private-chat"),
    ).resolves.toBe("ctx-2");

    const telegramConnection: MessagingConnection = {
      ...connection,
      id: "connection-telegram",
      accountId: "account-telegram",
      platform: "telegram",
      botId: "bot-telegram",
      senderId: "owner-telegram",
    };
    const [telegram] = await store.accept(telegramConnection, [
      {
        ...inbound({ id: "telegram", replyToken: "must-not-persist" }),
        connectionId: telegramConnection.id,
        platform: telegramConnection.platform,
        botId: telegramConnection.botId,
        senderId: telegramConnection.senderId,
      },
    ]);
    expect(telegram?.replyToken).toBeNull();

    await pool.query("DROP TRIGGER IF EXISTS reject_messaging_cursor ON account_settings");
    await pool.query(
      "CREATE OR REPLACE FUNCTION reject_messaging_cursor_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.value = 'rollback' THEN RAISE EXCEPTION 'cursor rejected'; END IF; RETURN NEW; END $$",
    );
    await pool.query(
      "CREATE TRIGGER reject_messaging_cursor BEFORE INSERT OR UPDATE ON account_settings FOR EACH ROW EXECUTE FUNCTION reject_messaging_cursor_fn()",
    );
    await expect(
      store.accept(connection, [inbound({ id: "rollback" })], "rollback"),
    ).rejects.toThrow("cursor rejected");
    const rolledBack = await pool.query(
      "SELECT 1 FROM messaging_jobs WHERE platform_message_id = 'rollback'",
    );
    expect(rolledBack.rowCount).toBe(0);
  }, 30_000);

  it("claims atomically and uses CAS so a pending choice enqueues only once", async () => {
    const store = new PostgresMessagingStore(pool);
    await store.ensureSchema();
    const [accepted] = await store.accept(connection, [inbound({ id: "choice-source" })]);
    expect(accepted).toBeDefined();

    const [first, second] = await Promise.all([store.claimNext(), store.claimNext()]);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(first).toMatchObject({ id: accepted!.id, phase: "running" });

    await store.replacePendingCandidates(
      "account-a",
      accepted!.id,
      [
        { kind: "title", value: "tmdb_movie_1", label: "选项一" },
        { kind: "season", value: "tmdb_tv_2:1", label: "选项二" },
      ],
      "2026-11-17T08:01:00.000Z",
    );
    const results = await Promise.all([
      store.confirmPending("account-a", accepted!.id, 0, "2026-11-17T08:02:00.000Z"),
      store.confirmPending("account-a", accepted!.id, 0, "2026-11-17T08:02:00.000Z"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    await expect(store.get("account-a", accepted!.id)).resolves.toMatchObject({
      phase: "queued",
      selectedCandidateIndex: 0,
      candidates: [
        { kind: "title", value: "tmdb_movie_1" },
        { kind: "season", value: "tmdb_tv_2:1" },
      ],
    });
  }, 30_000);

  it("expires only another pending job in the same private chat and scopes reads by account", async () => {
    const store = new PostgresMessagingStore(pool);
    await store.ensureSchema();
    const [first] = await store.accept(connection, [inbound({ id: "first" })]);
    expect(first).toBeDefined();
    await store.claimNext();
    await store.replacePendingCandidates(
      "account-a",
      first!.id,
      [{ kind: "title", value: "one", label: "一" }],
      "2026-11-17T08:03:00.000Z",
    );

    await store.accept(
      {
        ...connection,
        id: "connection-b",
        accountId: "account-b",
        botId: "bot-b",
        senderId: "owner-b",
      },
      [
        {
          ...inbound({ id: "second" }),
          connectionId: "connection-b",
          botId: "bot-b",
          senderId: "owner-b",
        },
      ],
    );
    const secondClaim = await store.claimNext();
    expect(secondClaim).not.toBeNull();
    await store.replacePendingCandidates(
      "account-b",
      secondClaim!.id,
      [{ kind: "title", value: "two", label: "二" }],
      "2026-11-17T08:04:00.000Z",
    );

    const [firstAfter, secondAfter] = await Promise.all([
      store.get("account-a", first!.id),
      store.get("account-b", secondClaim!.id),
    ]);
    expect(firstAfter?.phase).toBe("pending_selection");
    expect(secondAfter?.phase).toBe("pending_selection");
    await expect(store.get("account-b", first!.id)).resolves.toBeNull();
    await expect(store.listRecent("account-a")).resolves.toHaveLength(1);
    await expect(store.listRecent("account-b")).resolves.toHaveLength(1);

    await store.requestStop("account-b", secondClaim!.id);
    await expect(store.requestStop("account-a", secondClaim!.id)).resolves.toBe(false);
  }, 30_000);
});
