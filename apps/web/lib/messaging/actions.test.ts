import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagingConfigRepository } from "./config";
const auth = vi.hoisted(() => ({ account: "alice" as string | null, counter: 0, poll: vi.fn() }));
const values = new Map<string, string>();
const repository: MessagingConfigRepository = {
  getAccountSetting: async (a, k) => values.get(`${a}:${k}`) ?? null,
  setAccountSetting: async (a, k, v) => { values.set(`${a}:${k}`, v); },
  listAccounts: async () => [{ id: "alice" }, { id: "bob" }], listConnectedStorages: async () => [],
};
vi.mock("../workflow-runtime", () => ({ getWorkflowRepository: () => repository, requireAuthenticatedAccountId: async () => { if (!auth.account) throw new Error("未登录"); return auth.account; } }));
vi.mock("../library-runtime", () => ({ getLibraryPool: () => ({}) }));
vi.mock("../demo-mode", () => ({ assertNotDemo: () => undefined }));
vi.mock("./config", async (original) => {
  const config = await original<typeof import("./config")>();
  return { ...config, saveMessagingConnectionWithLock: async (account: string, input: Parameters<typeof config.saveMessagingConnection>[1], repo: MessagingConfigRepository, _pool: unknown, options?: { pendingWeixinQr: string }) => {
    if (options && await repo.getAccountSetting(account, "messaging_weixin_login") !== options.pendingWeixinQr) throw new Error("二维码已失效");
    const saved = await config.saveMessagingConnection(account, input, repo);
    if (options) await repo.setAccountSetting(account, "messaging_weixin_login", "");
    return saved;
  } };
});
vi.mock("qrcode", () => ({ default: { toDataURL: async () => "data:image/png;base64,test" } }));
vi.mock("./weixin", () => ({ beginWeixinLogin: async () => ({ qrcode: `qr-${++auth.counter}`, qrcodeUrl: "https://weixin.example/qr" }), pollWeixinLogin: auth.poll }));
import { beginWeixinLoginAction, pollWeixinLoginAction, saveMessagingConnectionAction } from "./actions";
import { readMessagingConnections, saveMessagingConnection } from "./config";
beforeEach(() => { values.clear(); vi.clearAllMocks(); auth.account = "alice"; auth.counter = 0; });
describe("messaging authenticated server actions", () => {
  it("rejects unauthenticated configuration and QR login before writing or contacting a platform", async () => {
    auth.account = null;
    expect((await beginWeixinLoginAction()).success).toBe(false);
    expect((await saveMessagingConnectionAction({ platform: "telegram", enabled: false, senderId: "", defaultStorageId: null, credentials: {} })).success).toBe(false);
    expect(values.size).toBe(0);
  });
  it("isolates QR pending state by account and supersedes the previous QR", async () => {
    const first = await beginWeixinLoginAction();
    auth.account = "bob";
    expect((await pollWeixinLoginAction({ qrcode: first.qrcode! })).success).toBe(false);
    expect(auth.poll).not.toHaveBeenCalled();
    auth.account = "alice";
    const second = await beginWeixinLoginAction();
    expect(second.qrcode).not.toBe(first.qrcode);
    expect((await pollWeixinLoginAction({ qrcode: first.qrcode! })).success).toBe(false);
    expect(auth.poll).not.toHaveBeenCalled();
  });
  it("binds credentials on the server, keeps a new bot off and returns only a masked view", async () => {
    const login = await beginWeixinLoginAction();
    auth.poll.mockResolvedValue({ state: "confirmed", token: "weixin-test-secret", botId: "wx-bot", userId: "wx-user", baseUrl: "https://weixin.example" });
    const result = await pollWeixinLoginAction({ qrcode: login.qrcode! });
    expect(result).toMatchObject({ success: true, state: "confirmed", connection: { enabled: false, credentialSet: { token: true } } });
    expect(JSON.stringify(result)).not.toContain("weixin-test-secret");
    expect((await readMessagingConnections("alice", repository))[0]?.credentials.token).toBe("weixin-test-secret");
    expect(values.get("alice:messaging_weixin_login")).toBe("");
  });
  it("does not overwrite another account's bot on QR confirmation", async () => {
    await saveMessagingConnection("bob", { platform: "weixin", enabled: false, senderId: "bob", botId: "wx-bot", defaultStorageId: null, credentials: { token: "bobs-token" } }, repository);
    const login = await beginWeixinLoginAction();
    auth.poll.mockResolvedValue({ state: "confirmed", token: "alices-token", botId: "wx-bot", userId: "alice", baseUrl: "https://weixin.example" });
    expect(await pollWeixinLoginAction({ qrcode: login.qrcode! })).toMatchObject({ success: false, message: expect.stringContaining("其他账号") });
    expect(await readMessagingConnections("alice", repository)).toEqual([]);
    expect(values.get("alice:messaging_weixin_login")).toBe(login.qrcode);
  });
  it("rejects an old confirmation when a new QR was generated during the platform poll", async () => {
    const first = await beginWeixinLoginAction();
    let finish!: (value: unknown) => void;
    auth.poll.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const oldPoll = pollWeixinLoginAction({ qrcode: first.qrcode! });
    await vi.waitFor(() => expect(auth.poll).toHaveBeenCalled());
    const current = await beginWeixinLoginAction();
    finish({ state: "confirmed", token: "old-secret", botId: "old-bot", userId: "wx-user", baseUrl: "https://weixin.example" });
    expect(await oldPoll).toMatchObject({ success: false, message: expect.stringContaining("失效") });
    expect(values.get("alice:messaging_weixin_login")).toBe(current.qrcode);
    expect(await readMessagingConnections("alice", repository)).toEqual([]);
  });
});
