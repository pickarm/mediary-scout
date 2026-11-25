import { describe, expect, it } from "vitest";
import { readMessagingConnections, saveMessagingConnection, messagingConnectionViews, type MessagingConfigRepository } from "./config";

function fixture() {
  const settings = new Map<string, string>();
  const repo: MessagingConfigRepository = {
    getAccountSetting: async (a, k) => settings.get(`${a}:${k}`) ?? null,
    setAccountSetting: async (a, k, v) => { settings.set(`${a}:${k}`, v); },
    listAccounts: async () => [{ id: "alice" }, { id: "bob" }],
    listConnectedStorages: async (a) => a === "alice" ? [{ id: "drive-a", status: "active" }] : [],
  };
  return { repo, settings };
}

describe("messaging connection settings", () => {
  it("keeps credentials on the server and preserves them on a blank edit", async () => {
    const { repo } = fixture();
    const input = { platform: "telegram" as const, enabled: true, senderId: "123", defaultStorageId: "drive-a", credentials: { token: "456:test-secret" } };
    const saved = await saveMessagingConnection("alice", input, repo);
    await saveMessagingConnection("alice", { ...input, senderId: "124", credentials: { token: "" } }, repo);
    const [connection] = await readMessagingConnections("alice", repo);
    expect(connection).toMatchObject({ id: saved.id, senderId: "124", botId: "456", credentials: { token: "456:test-secret" } });
    expect(JSON.stringify(messagingConnectionViews([connection!]))).not.toContain("test-secret");
    expect(await readMessagingConnections("bob", repo)).toEqual([]);
  });

  it("rejects another account's default drive and duplicate bots", async () => {
    const { repo } = fixture();
    const input = { platform: "telegram" as const, enabled: true, senderId: "123", defaultStorageId: null, credentials: { token: "456:test-secret" } };
    await saveMessagingConnection("alice", input, repo);
    await expect(saveMessagingConnection("bob", input, repo)).rejects.toThrow(/其他账号/);
    await expect(saveMessagingConnection("alice", { ...input, defaultStorageId: "other-drive" }, repo)).rejects.toThrow(/网盘/);
  });

  it("stores explicit disable and clears a connection on unlink", async () => {
    const { repo } = fixture();
    const input = { platform: "telegram" as const, enabled: true, senderId: "123", defaultStorageId: null, credentials: { token: "456:test-secret" } };
    await saveMessagingConnection("alice", input, repo);
    await saveMessagingConnection("alice", { ...input, enabled: false, credentials: {} }, repo);
    expect((await readMessagingConnections("alice", repo))[0]?.enabled).toBe(false);
    await saveMessagingConnection("alice", { ...input, enabled: false, unlink: true, credentials: {} }, repo);
    expect(await readMessagingConnections("alice", repo)).toEqual([]);
  });
});
