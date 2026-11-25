import { NextResponse, type NextRequest } from "next/server";
import { isAccountAuthEnabled, resolveSafeNextPath } from "./lib/auth-mode";

/**
 * §7 P1 + 巡影 Fork 默认强制登录门禁（Next 16 "proxy" 约定）。
 *
 * 两种门禁形态：
 *  - 默认强制账号密码登录（`isAccountAuthEnabled()` 为 true，含公网裸端口、普通反代与局域网）：
 *    除认证端点与自守 API 外处处需要 session。
 *  - 兼容单用户逃生阀（显式 `MEDIA_TRACK_MULTI_USER=0` 或桌面版默认）：
 *    凡经 Cloudflare 隧道的远程请求需 session；局域网直通。
 *  - 演示模式（`MEDIA_TRACK_DEMO_MODE=1`）：只读免登录放行。
 *
 * This does cheap PRESENCE gating for the redirect UX (runs on the Edge runtime,
 * no DB access). The authoritative check — signature + session row + expiry — is
 * server-side in getCurrentAccountId(), which returns a no-data sentinel for an
 * invalid/expired cookie, so reads fail closed even if a stale cookie slips past.
 */
const SESSION_COOKIE_NAME = "mt_session";
// /api/update/busy and /api/update/hold are called by the updater. It has no session
// cookie; those routes check the updater token themselves. Redirecting them to /login
// would break the busy wait and the hold before a swap.
const HANDLER_GUARDED_API_PREFIXES = [
  "/api/health",
  "/api/workflows/",
  "/api/agent/",
  "/api/update/busy",
  "/api/update/hold",
];

/** 经隧道的远程请求判定。与 workflow-runtime.isRemoteRequest() 保持一致：
 *  用 cf-ray/cdn-loop 而非仅 cf-connecting-ip（后者可被 zone 规则删除 → fail-open）。 */
function isRemoteRequest(request: NextRequest): boolean {
  return (
    request.headers.has("cf-ray") ||
    request.headers.has("cdn-loop") ||
    request.headers.has("cf-connecting-ip")
  );
}

export function proxy(request: NextRequest): NextResponse {
  if (process.env.MEDIA_TRACK_DEMO_MODE === "1") {
    return NextResponse.next();
  }
  const accountAuth = isAccountAuthEnabled();
  const gated = accountAuth || isRemoteRequest(request);
  if (!gated) {
    return NextResponse.next();
  }
  if (HANDLER_GUARDED_API_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  if (hasSession) {
    return NextResponse.next();
  }
  const { pathname, search } = request.nextUrl;
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/" && !pathname.startsWith("/api/")) {
    const nextPath = resolveSafeNextPath(`${pathname}${search ?? ""}`);
    if (nextPath !== "/") {
      url.searchParams.set("next", nextPath);
    }
  }
  return NextResponse.redirect(url);
}

export const config = {
  // Gate pages; exclude the auth API, the login page, Next internals and assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
