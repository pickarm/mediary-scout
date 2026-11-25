import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetLoginThrottleForTest } from "./login-throttle";

const CRYPTO_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
  "MEDIA_TRACK_SQLITE_PATH",
  "MEDIA_TRACK_POSTGRES_URL",
  "MEDIA_TRACK_MULTI_USER",
  "MEDIA_TRACK_DEMO_MODE",
  "MEDIA_TRACK_DESKTOP",
  "MEDIA_TRACK_ADMIN_USERNAME",
  "MEDIA_TRACK_ADMIN_PASSWORD",
  "MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP",
  "MEDIA_TRACK_ALLOW_REGISTRATION",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

let activeRuntime: typeof import("./workflow-runtime") | null = null;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function boot(opts?: { headers?: Headers; sessionCookie?: string | undefined }) {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER;
  delete process.env.MEDIA_TRACK_DEMO_MODE;
  delete process.env.MEDIA_TRACK_DESKTOP;
  _resetLoginThrottleForTest();

  if (opts?.headers !== undefined || opts?.sessionCookie !== undefined) {
    const hdrs = opts.headers ?? new Headers();
    const cookieVal = opts.sessionCookie;
    vi.doMock("next/headers", () => ({
      headers: async () => hdrs,
      cookies: async () => ({
        get: (name: string) =>
          name === "mt_session" && cookieVal ? { name, value: cookieVal } : undefined,
      }),
    }));
  }

  vi.resetModules();
  activeRuntime = await import("./workflow-runtime");
  return activeRuntime;
}

afterEach(async () => {
  if (activeRuntime) {
    await activeRuntime.closeWorkflowRepositoryForTests();
    activeRuntime = null;
  }
  vi.doUnmock("next/headers");
  vi.resetModules();
  restoreEnv();
});

describe("forced account authentication & bootstrap policy", () => {
  it(
    "enables account auth by default and fails closed when unauthenticated",
    async () => {
      const rt = await boot({ headers: new Headers() });
      expect(rt.isMultiUserEnabled()).toBe(true);
      expect(await rt.getCurrentAccountId()).toBe(rt.UNAUTHENTICATED_ACCOUNT_ID);
      await expect(rt.requireAuthenticatedAccountId()).rejects.toBeInstanceOf(
        rt.UnauthenticatedAccountError,
      );
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "adopts acct_default on initial claim and rejects public self-registration afterward by default",
    async () => {
      const rt = await boot();
      const first = await rt.registerAccount("owner", "secret-123");
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.accountId).toBe("acct_default");
        const acct = await rt.getWorkflowRepository().getAccountById("acct_default");
        expect(acct?.isOwner).toBe(true);
        expect(acct?.username).toBe("owner");
      }

      const second = await rt.registerAccount("stranger", "secret-456");
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toContain("未开放公开注册");
      }
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "serializes concurrent first-claim attempts so only one claimant succeeds and owner is never overwritten",
    async () => {
      const rt = await boot();
      const [r1, r2] = await Promise.all([
        rt.registerAccount("alice", "pass-1111"),
        rt.registerAccount("bob", "pass-2222"),
      ]);
      const successes = [r1, r2].filter((r) => r.ok);
      const failures = [r1, r2].filter((r) => !r.ok);
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const owner = await rt.getWorkflowRepository().getAccountById("acct_default");
      expect(owner?.username).toBe("alice");
      expect((await rt.loginAccount("alice", "pass-1111")).ok).toBe(true);
      expect((await rt.loginAccount("bob", "pass-2222")).ok).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "provisions owner from env once and never overwrites an already-changed password",
    async () => {
      process.env.MEDIA_TRACK_ADMIN_USERNAME = "envowner";
      process.env.MEDIA_TRACK_ADMIN_PASSWORD = "init-password";
      const rt = await boot();

      await rt.ensureEnvBootstrapOwner();
      const login1 = await rt.loginAccount("envowner", "init-password");
      expect(login1.ok).toBe(true);

      const changed = await rt.changeOwnPassword("acct_default", "init-password", "rotated-password");
      expect(changed).toEqual({ ok: true });

      process.env.MEDIA_TRACK_ADMIN_PASSWORD = "reset-attempt";
      await rt.ensureEnvBootstrapOwner();

      expect((await rt.loginAccount("envowner", "init-password")).ok).toBe(false);
      expect((await rt.loginAccount("envowner", "reset-attempt")).ok).toBe(false);
      expect((await rt.loginAccount("envowner", "rotated-password")).ok).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "blocks web initial claim when MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1",
    async () => {
      process.env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP = "1";
      const rt = await boot();

      const res = await rt.registerAccount("owner", "secret-123");
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toContain("已禁用网页端首次初始化");
      }
      expect((await rt.getBootstrapState()).needsClaim).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "allows owner to toggle registration and add accounts, while rejecting non-owners and env locks",
    async () => {
      const rt = await boot();
      await rt.registerAccount("owner", "secret-123");

      const created = await rt.createManagedAccount("acct_default", "member1", "member-pass");
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.account.isOwner).toBe(false);
      expect(created.account.username).toBe("member1");

      const dup = await rt.createManagedAccount("acct_default", "member1", "other-pass");
      expect(dup).toEqual({ ok: false, error: "用户名已存在。" });

      // Non-owner cannot manage registration or accounts.
      expect(await rt.setPublicRegistrationEnabled(created.account.id, true)).toEqual({
        ok: false,
        error: "无权限。",
      });
      expect(await rt.createManagedAccount(created.account.id, "member2", "member-pass")).toEqual({
        ok: false,
        error: "无权限。",
      });

      // Owner toggles public registration on, letting stranger register; then toggles off.
      expect(await rt.setPublicRegistrationEnabled("acct_default", true)).toEqual({ ok: true, allowed: true });
      const stranger = await rt.registerAccount("member2", "member-pass");
      expect(stranger.ok).toBe(true);

      expect(await rt.setPublicRegistrationEnabled("acct_default", false)).toEqual({ ok: true, allowed: false });
      const blocked = await rt.registerAccount("member3", "member-pass");
      expect(blocked.ok).toBe(false);

      // Env lock blocks DB toggle.
      process.env.MEDIA_TRACK_ALLOW_REGISTRATION = "0";
      const locked = await rt.setPublicRegistrationEnabled("acct_default", true);
      expect(locked.ok).toBe(false);
      if (!locked.ok) {
        expect(locked.error).toContain("环境变量");
      }
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "authenticates session cookie in getCurrentAccountId and revokes on logoutSession",
    async () => {
      const cookieBox: { value: string | undefined } = { value: undefined };
      vi.doMock("next/headers", () => ({
        headers: async () => new Headers(),
        cookies: async () => ({
          get: (name: string) =>
            name === "mt_session" && cookieBox.value ? { name, value: cookieBox.value } : undefined,
        }),
      }));

      process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
      delete process.env.MEDIA_TRACK_POSTGRES_URL;
      delete process.env.MEDIA_TRACK_MULTI_USER;
      delete process.env.MEDIA_TRACK_DEMO_MODE;
      _resetLoginThrottleForTest();
      vi.resetModules();
      activeRuntime = await import("./workflow-runtime");

      const claim = await activeRuntime.registerAccount("owner", "secret-123");
      expect(claim.ok).toBe(true);
      const created = await activeRuntime.createManagedAccount("acct_default", "member", "member-pass");
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const login = await activeRuntime.loginAccount("member", "member-pass");
      expect(login.ok).toBe(true);
      if (!login.ok) return;

      cookieBox.value = login.signedCookie;
      expect(await activeRuntime.getCurrentAccountId()).toBe(created.account.id);
      expect(await activeRuntime.requireAuthenticatedAccountId()).toBe(created.account.id);

      await activeRuntime.logoutSession(cookieBox.value);
      expect(await activeRuntime.getCurrentAccountId()).toBe(activeRuntime.UNAUTHENTICATED_ACCOUNT_ID);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it("keeps MEDIA_TRACK_DEMO_MODE=1 unauthenticated on default account", async () => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
    delete process.env.MEDIA_TRACK_POSTGRES_URL;
    delete process.env.MEDIA_TRACK_MULTI_USER;
    vi.doMock("next/headers", () => ({
      headers: async () => new Headers({ "cf-ray": "demo" }),
      cookies: async () => ({ get: () => undefined }),
    }));
    vi.resetModules();
    activeRuntime = await import("./workflow-runtime");

    expect(activeRuntime.isMultiUserEnabled()).toBe(false);
    expect(await activeRuntime.getCurrentAccountId()).toBe("acct_default");
  });
});
