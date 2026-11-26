import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { _resetLoginThrottleForTest } from "./lib/login-throttle";

const CRYPTO_TIMEOUT_MS = 30_000;

const ENV_KEYS = [
  "MEDIA_TRACK_SQLITE_PATH",
  "MEDIA_TRACK_POSTGRES_URL",
  "MEDIA_TRACK_MULTI_USER",
  "MEDIA_TRACK_DEMO_MODE",
  "MEDIA_TRACK_DESKTOP",
] as const;

const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));

let activeRuntime: typeof import("./lib/workflow-runtime") | null = null;
let activeProxy: typeof import("./proxy").proxy | null = null;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const prev = savedEnv.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

async function boot(envOverrides?: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  process.env.MEDIA_TRACK_SQLITE_PATH = ":memory:";
  delete process.env.MEDIA_TRACK_POSTGRES_URL;
  delete process.env.MEDIA_TRACK_MULTI_USER;
  delete process.env.MEDIA_TRACK_DEMO_MODE;
  delete process.env.MEDIA_TRACK_DESKTOP;
  if (envOverrides) {
    for (const [key, val] of Object.entries(envOverrides)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
  _resetLoginThrottleForTest();
  vi.resetModules();
  activeRuntime = await import("./lib/workflow-runtime");
  activeProxy = (await import("./proxy")).proxy;
  return { rt: activeRuntime, proxy: activeProxy };
}

beforeEach(() => {
  restoreEnv();
});

afterEach(async () => {
  if (activeRuntime) {
    await activeRuntime.closeWorkflowRepositoryForTests();
    activeRuntime = null;
  }
  activeProxy = null;
  vi.resetModules();
  restoreEnv();
});

const makeRequest = (opts: {
  path?: string;
  search?: string;
  cf?: boolean;
  staleAuthCookie?: boolean;
  sessionValue?: string;
}): NextRequest => {
  const headers = new Headers();
  if (opts.cf) headers.set("cf-ray", "8f3abc-LAX");
  const cookies = new Map<string, { name: string; value: string }>();
  if (opts.staleAuthCookie) {
    cookies.set("mt_auth_required", { name: "mt_auth_required", value: "1" });
  }
  if (opts.sessionValue !== undefined) {
    cookies.set("mt_session", { name: "mt_session", value: opts.sessionValue });
  }
  const url = new URL(`http://localhost:3000${opts.path ?? "/"}${opts.search ?? ""}`);
  return {
    headers,
    cookies: { get: (name: string) => cookies.get(name) },
    nextUrl: {
      protocol: url.protocol,
      pathname: url.pathname,
      search: url.search,
      clone: () => new URL(url.toString()),
    },
  } as unknown as NextRequest;
};

const isRedirectToLogin = (res: Response): boolean =>
  res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");

describe("proxy gate — default forced login & authoritative session verification", () => {
  it(
    "redirects unauthenticated requests even without Cloudflare headers and rejects stale/forged cookies",
    async () => {
      const { proxy } = await boot();

      const res = await proxy(makeRequest({ path: "/settings", search: "?tab=account" }));
      expect(res.status).toBe(307);
      const target = new URL(res.headers.get("location")!);
      expect(target.pathname).toBe("/login");
      expect(target.searchParams.get("next")).toBe("/settings?tab=account");
      expect(res.headers.get("set-cookie")).toBeNull();

      // 老镜像/旧容器遗留的无效 mt_session Cookie：必须拦截跳转并清掉失效 Cookie
      for (const path of ["/", "/settings", "/library-demo", "/api/activity"]) {
        const staleRes = await proxy(makeRequest({ path, sessionValue: "stale.oldsess" }));
        expect(isRedirectToLogin(staleRes)).toBe(true);
        const setCookie = staleRes.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("mt_session=;");
        expect(setCookie).toContain("Max-Age=0");
      }
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "rejects even an unexpired DB session when the account password_hash is empty (migrated unclaimed instance)",
    async () => {
      const { rt, proxy } = await boot();
      const { signSession } = await import("@media-track/workflow");
      const repo = rt.getWorkflowRepository();
      // 模拟老库/异常状态：acct_default 尚未设置密码，但 sessions 表里已有未过期记录
      const acct = await repo.getAccountById("acct_default");
      expect(acct?.passwordHash).toBe("");
      await repo.createSession({
        id: "sess_unclaimed",
        accountId: "acct_default",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      const signed = signSession("sess_unclaimed", await rt.getSessionSecret());

      const res = await proxy(makeRequest({ path: "/", sessionValue: signed }));
      expect(isRedirectToLogin(res)).toBe(true);
      expect(res.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "does not attach /api/* paths into ?next= query on redirect",
    async () => {
      const { proxy } = await boot();
      const res = await proxy(makeRequest({ path: "/api/update/status" }));
      expect(res.status).toBe(307);
      const target = new URL(res.headers.get("location")!);
      expect(target.pathname).toBe("/login");
      expect(target.searchParams.get("next")).toBeNull();
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "allows valid signed DB session for claimed owner and revokes immediately after password change or logout",
    async () => {
      const { rt, proxy } = await boot();
      const claim = await rt.registerAccount("owner", "secret-123");
      expect(claim.ok).toBe(true);
      if (!claim.ok) return;

      expect(isRedirectToLogin(await proxy(makeRequest({ path: "/settings", sessionValue: claim.signedCookie })))).toBe(false);
      expect(isRedirectToLogin(await proxy(makeRequest({ path: "/library-demo", sessionValue: claim.signedCookie })))).toBe(false);

      // 改密会吊销旧会话：携带旧 Cookie 必须立即 307 跳转 /login 并清除 Cookie
      const changed = await rt.changeOwnPassword("acct_default", "secret-123", "new-secret-456");
      expect(changed).toEqual({ ok: true });
      const afterChange = await proxy(makeRequest({ path: "/", sessionValue: claim.signedCookie }));
      expect(isRedirectToLogin(afterChange)).toBe(true);
      expect(afterChange.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "allows handler-guarded API prefixes, demo mode, and local desktop mode without session",
    async () => {
      const { proxy } = await boot();
      for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step", "/api/update/busy", "/api/update/hold"]) {
        expect(isRedirectToLogin(await proxy(makeRequest({ path })))).toBe(false);
      }

      process.env.MEDIA_TRACK_DEMO_MODE = "1";
      expect(isRedirectToLogin(await proxy(makeRequest({ cf: true, path: "/" })))).toBe(false);
      delete process.env.MEDIA_TRACK_DEMO_MODE;

      process.env.MEDIA_TRACK_DESKTOP = "1";
      expect(isRedirectToLogin(await proxy(makeRequest({ path: "/" })))).toBe(false);
    },
    CRYPTO_TIMEOUT_MS,
  );
});

describe("proxy gate — single-user opt-out mode (MEDIA_TRACK_MULTI_USER=0)", () => {
  it(
    "forces redirect to /login on LAN and remote when no password is set yet (migrated or fresh)",
    async () => {
      const { rt, proxy } = await boot({ MEDIA_TRACK_MULTI_USER: "0" });
      expect(await rt.hasLoginPassword()).toBe(false);

      // 未设密码前：局域网无 CF 头与外网一样都必须先去 /login 设置密码
      expect(isRedirectToLogin(await proxy(makeRequest({ path: "/" })))).toBe(true);
      expect(isRedirectToLogin(await proxy(makeRequest({ cf: true, path: "/" })))).toBe(true);

      const staleRes = await proxy(makeRequest({ path: "/settings", sessionValue: "stale.cookie" }));
      expect(isRedirectToLogin(staleRes)).toBe(true);
      expect(staleRes.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "in MEDIA_TRACK_MULTI_USER=0, enforces acct_default session across BOTH LAN and remote (no LAN bypass)",
    async () => {
      const { rt, proxy } = await boot({ MEDIA_TRACK_MULTI_USER: "0" });
      await rt.setSingleUserPassword("secret-123");

      // 已设密码：无 session 时局域网与外网同样被拦截跳转 /login（彻底取消免登）
      expect(isRedirectToLogin(await proxy(makeRequest({})))).toBe(true);
      expect(isRedirectToLogin(await proxy(makeRequest({ staleAuthCookie: true })))).toBe(true);
      expect(isRedirectToLogin(await proxy(makeRequest({ cf: true })))).toBe(true);

      // 伪造 session 在局域网和远程都一律拦截并清 Cookie
      for (const cf of [false, true]) {
        const forged = await proxy(makeRequest({ cf, sessionValue: "forged.sig" }));
        expect(isRedirectToLogin(forged)).toBe(true);
        expect(forged.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
      }

      // 携带真实 acct_default 会话：局域网和远程均放行
      const login = await rt.loginAccount("", "secret-123");
      expect(login.ok).toBe(true);
      if (!login.ok) return;
      expect(isRedirectToLogin(await proxy(makeRequest({ sessionValue: login.signedCookie })))).toBe(false);
      expect(isRedirectToLogin(await proxy(makeRequest({ cf: true, sessionValue: login.signedCookie })))).toBe(false);

      // 退出登录后旧 session 在局域网和远程均立即失效并被拦截
      await rt.logoutSession(login.signedCookie);
      const afterLogout = await proxy(makeRequest({ path: "/", sessionValue: login.signedCookie }));
      expect(isRedirectToLogin(afterLogout)).toBe(true);
      expect(afterLogout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");

      // 清密后恢复未设密态：局域网携带旧会话亦被拦截
      await rt.clearSingleUserPassword();
      expect(isRedirectToLogin(await proxy(makeRequest({ path: "/", sessionValue: login.signedCookie })))).toBe(true);
    },
    CRYPTO_TIMEOUT_MS,
  );

  it(
    "handler-guarded API prefixes pass in MEDIA_TRACK_MULTI_USER=0",
    async () => {
      const { proxy } = await boot({ MEDIA_TRACK_MULTI_USER: "0" });
      for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step"]) {
        expect(isRedirectToLogin(await proxy(makeRequest({ cf: true, path })))).toBe(false);
      }
    },
    CRYPTO_TIMEOUT_MS,
  );
});
