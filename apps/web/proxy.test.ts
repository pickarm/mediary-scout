import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { proxy } from "./proxy";
import type { NextRequest } from "next/server";

const prevMultiUser = process.env.MEDIA_TRACK_MULTI_USER;
const prevDemoMode = process.env.MEDIA_TRACK_DEMO_MODE;
const prevDesktop = process.env.MEDIA_TRACK_DESKTOP;

beforeEach(() => {
  delete process.env.MEDIA_TRACK_MULTI_USER;
  delete process.env.MEDIA_TRACK_DEMO_MODE;
  delete process.env.MEDIA_TRACK_DESKTOP;
});

afterAll(() => {
  if (prevMultiUser !== undefined) process.env.MEDIA_TRACK_MULTI_USER = prevMultiUser;
  else delete process.env.MEDIA_TRACK_MULTI_USER;
  if (prevDemoMode !== undefined) process.env.MEDIA_TRACK_DEMO_MODE = prevDemoMode;
  else delete process.env.MEDIA_TRACK_DEMO_MODE;
  if (prevDesktop !== undefined) process.env.MEDIA_TRACK_DESKTOP = prevDesktop;
  else delete process.env.MEDIA_TRACK_DESKTOP;
});

const makeRequest = (opts: {
  path?: string;
  search?: string;
  cf?: boolean;
  staleAuthCookie?: boolean;
  session?: boolean;
}): NextRequest => {
  const headers = new Headers();
  if (opts.cf) headers.set("cf-ray", "8f3abc-LAX");
  const cookies = new Map<string, { name: string; value: string }>();
  if (opts.staleAuthCookie)
    cookies.set("mt_auth_required", { name: "mt_auth_required", value: "1" });
  if (opts.session) cookies.set("mt_session", { name: "mt_session", value: "sess.sig" });
  const url = new URL(`http://localhost:3000${opts.path ?? "/"}${opts.search ?? ""}`);
  return {
    headers,
    cookies: { get: (name: string) => cookies.get(name) },
    nextUrl: {
      pathname: url.pathname,
      search: url.search,
      clone: () => new URL(url.toString()),
    },
  } as unknown as NextRequest;
};

const redirectsToLogin = (req: NextRequest): boolean => {
  const res = proxy(req);
  return res.status >= 300 && res.status < 400 && (res.headers.get("location") ?? "").includes("/login");
};

describe("proxy gate — default forced login mode", () => {
  it("redirects unauthenticated requests even without Cloudflare headers (bare IP / reverse proxy / LAN)", () => {
    const res = proxy(makeRequest({ path: "/settings", search: "?tab=account" }));
    expect(res.status).toBe(307);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const target = new URL(location!);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBe("/settings?tab=account");
  });

  it("does not attach /api/* paths into ?next= query on redirect", () => {
    const res = proxy(makeRequest({ path: "/api/update/status" }));
    expect(res.status).toBe(307);
    const target = new URL(res.headers.get("location")!);
    expect(target.pathname).toBe("/login");
    expect(target.searchParams.get("next")).toBeNull();
  });

  it("allows requests carrying mt_session cookie and handler-guarded API prefixes", () => {
    expect(redirectsToLogin(makeRequest({ path: "/settings", session: true }))).toBe(false);
    for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step", "/api/update/busy", "/api/update/hold"]) {
      expect(redirectsToLogin(makeRequest({ path }))).toBe(false);
    }
  });

  it("allows MEDIA_TRACK_DEMO_MODE=1 without session", () => {
    process.env.MEDIA_TRACK_DEMO_MODE = "1";
    expect(redirectsToLogin(makeRequest({ cf: true, path: "/" }))).toBe(false);
  });
});

describe("proxy gate — single-user opt-out mode (MEDIA_TRACK_MULTI_USER=0)", () => {
  beforeAll(() => {
    process.env.MEDIA_TRACK_MULTI_USER = "0";
  });

  beforeEach(() => {
    process.env.MEDIA_TRACK_MULTI_USER = "0";
  });

  it("局域网（无 CF 头）→ 直通，零摩擦（任何 cookie 状态下都一样）", () => {
    expect(redirectsToLogin(makeRequest({}))).toBe(false);
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(false);
  });

  it("未设密码 + 远程 → 仍要重定向到 /login（那里给的是设置密码表单）", () => {
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
  });

  it("远程 + 无 session → 重定向到登录（残留 cookie 不得放行）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true }))).toBe(true);
  });

  it("远程 + 有 session → 直通（残留 cookie 不影响）", () => {
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true, cf: true, session: true }))).toBe(false);
    expect(redirectsToLogin(makeRequest({ cf: true, session: true }))).toBe(false);
  });

  it("三个 CF 头任一存在都算远程", () => {
    for (const header of ["cf-ray", "cdn-loop", "cf-connecting-ip"]) {
      const req = makeRequest({});
      req.headers.set(header, "x");
      expect(redirectsToLogin(req)).toBe(true);
    }
  });

  it("handler 自守的 API 前缀不被重定向（否则会把 JSON 端点变成 HTML 跳转）", () => {
    for (const path of ["/api/health", "/api/workflows/run", "/api/agent/step"]) {
      expect(redirectsToLogin(makeRequest({ cf: true, path }))).toBe(false);
    }
  });
});

describe("proxy gate — explicit multi-user mode (MEDIA_TRACK_MULTI_USER=1)", () => {
  it("多用户：无 session 一律重定向，与来源和任何残留 cookie 无关", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    expect(redirectsToLogin(makeRequest({}))).toBe(true);
    expect(redirectsToLogin(makeRequest({ cf: true }))).toBe(true);
    expect(redirectsToLogin(makeRequest({ staleAuthCookie: true }))).toBe(true);
    expect(redirectsToLogin(makeRequest({ session: true }))).toBe(false);
  });

  it("多用户、无 session：/api/update/busy 与 /api/update/hold 放行，/api/update/status 仍重定向", () => {
    process.env.MEDIA_TRACK_MULTI_USER = "1";
    expect(redirectsToLogin(makeRequest({ path: "/api/update/busy" }))).toBe(false);
    expect(redirectsToLogin(makeRequest({ path: "/api/update/hold" }))).toBe(false);
    expect(redirectsToLogin(makeRequest({ path: "/api/update/status" }))).toBe(true);
  });
});
