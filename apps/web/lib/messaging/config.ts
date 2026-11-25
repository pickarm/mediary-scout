import { randomUUID } from "node:crypto";
import type { MessagingConnection, MessagingPlatform } from "./types";

export const MESSAGING_CONFIG_KEY = "messaging_connections";
export const MESSAGING_PLATFORMS: readonly MessagingPlatform[] = ["weixin", "feishu", "telegram"];

export interface MessagingConfigRepository {
  getAccountSetting(accountId: string, key: string): Promise<string | null>;
  setAccountSetting(accountId: string, key: string, value: string): Promise<void>;
  listAccounts(): Promise<readonly { id: string }[]>;
  listConnectedStorages(accountId: string): Promise<readonly { id: string; status: string }[]>;
}

export interface MessagingConnectionInput {
  platform: MessagingPlatform;
  enabled: boolean;
  senderId: string;
  defaultStorageId: string | null;
  credentials: Record<string, string>;
  botId?: string;
  unlink?: boolean;
}

export type MessagingConnectionView = Omit<MessagingConnection, "credentials"> & { credentialSet: Record<string, boolean> };

export async function readMessagingConnections(accountId: string, repository: MessagingConfigRepository): Promise<MessagingConnection[]> {
  const raw = await repository.getAccountSetting(accountId, MESSAGING_CONFIG_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((value): value is MessagingConnection => {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return row.accountId === accountId && typeof row.id === "string" && typeof row.botId === "string"
      && MESSAGING_PLATFORMS.includes(row.platform as MessagingPlatform)
      && typeof row.senderId === "string" && typeof row.enabled === "boolean"
      && (row.defaultStorageId === null || typeof row.defaultStorageId === "string")
      && row.credentials !== null && typeof row.credentials === "object" && !Array.isArray(row.credentials)
      && Object.values(row.credentials).every((v) => typeof v === "string");
  });
}

export async function saveMessagingConnection(accountId: string, input: MessagingConnectionInput, repository: MessagingConfigRepository): Promise<MessagingConnection> {
  if (!accountId || accountId === "acct_unauthenticated") throw new Error("请先登录");
  if (!MESSAGING_PLATFORMS.includes(input.platform)) throw new Error("不支持的消息平台");
  const connections = await readMessagingConnections(accountId, repository);
  const previous = connections.find((c) => c.platform === input.platform);
  if (input.unlink) {
    await repository.setAccountSetting(accountId, MESSAGING_CONFIG_KEY, JSON.stringify(connections.filter((c) => c.platform !== input.platform)));
    return { id: previous?.id ?? randomUUID(), accountId, platform: input.platform, botId: "", enabled: false, senderId: "", defaultStorageId: null, credentials: {} };
  }
  const credentials = { ...previous?.credentials };
  for (const [key, value] of Object.entries(input.credentials)) {
    if (typeof value !== "string") throw new Error("凭证格式无效");
    if (value.includes("***")) throw new Error("请填写原始凭证，不能保存脱敏占位符");
    if (value.trim()) credentials[key] = value.trim();
  }
  const botId = input.platform === "telegram" ? credentials.token?.split(":")[0] ?? ""
    : input.platform === "feishu" ? credentials.appId ?? "" : input.botId?.trim() || previous?.botId || "";
  const senderId = input.senderId.trim();
  if (input.enabled) {
    const required = input.platform === "feishu" ? ["appId", "appSecret"] : ["token"];
    if (!botId || required.some((k) => !credentials[k])) throw new Error("请先填写连接凭证或扫码登录");
    if (!senderId) throw new Error("请填写本人平台标识");
  }
  if (input.defaultStorageId) {
    const storages = await repository.listConnectedStorages(accountId);
    if (!storages.some((s) => s.id === input.defaultStorageId && s.status === "active")) throw new Error("默认网盘不存在、已冻结或不属于当前账号");
  }
  if (botId) {
    const accountIds = new Set(["acct_default", ...(await repository.listAccounts()).map((a) => a.id)]);
    for (const other of accountIds) {
      if (other === accountId) continue;
      if ((await readMessagingConnections(other, repository)).some((c) => c.platform === input.platform && c.botId === botId)) throw new Error("该机器人已配置到其他账号，请使用独立机器人");
    }
  }
  const connection: MessagingConnection = {
    id: previous?.botId === botId ? previous.id : randomUUID(), accountId, platform: input.platform,
    botId, enabled: input.enabled, senderId, defaultStorageId: input.defaultStorageId, credentials,
  };
  await repository.setAccountSetting(accountId, MESSAGING_CONFIG_KEY, JSON.stringify([...connections.filter((c) => c.platform !== input.platform), connection]));
  return connection;
}

export function messagingConnectionViews(connections: readonly MessagingConnection[]): MessagingConnectionView[] {
  return connections.map(({ credentials, ...connection }) => ({ ...connection, credentialSet: Object.fromEntries(Object.entries(credentials).map(([k, v]) => [k, Boolean(v)])) }));
}

/** Serialize the small shared JSON setting and bot ownership check in PostgreSQL. */
export async function saveMessagingConnectionWithLock(
  accountId: string, input: MessagingConnectionInput, repository: MessagingConfigRepository,
  pool: import("pg").Pool,
  options?: { pendingWeixinQr: string },
): Promise<MessagingConnection> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [4_011_989_151]);
    if (options) {
      const pending = await client.query<{ value: string }>(
        "SELECT value FROM account_settings WHERE account_id=$1 AND key='messaging_weixin_login' FOR UPDATE", [accountId],
      );
      if (pending.rows[0]?.value !== options.pendingWeixinQr) throw new Error("二维码已失效，请重新扫码");
    }
    const saved = await saveMessagingConnection(accountId, input, {
      listAccounts: () => repository.listAccounts(),
      listConnectedStorages: (account) => repository.listConnectedStorages(account),
      getAccountSetting: async (account, key) => {
        const result = await client.query<{ value: string }>("SELECT value FROM account_settings WHERE account_id=$1 AND key=$2", [account, key]);
        return result.rows[0]?.value ?? null;
      },
      setAccountSetting: async (account, key, value) => {
        await client.query("INSERT INTO account_settings(account_id,key,value) VALUES($1,$2,$3) ON CONFLICT(account_id,key) DO UPDATE SET value=EXCLUDED.value", [account, key, value]);
      },
    });
    if (options) await client.query("UPDATE account_settings SET value='' WHERE account_id=$1 AND key='messaging_weixin_login'", [accountId]);
    await client.query("COMMIT");
    return saved;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
