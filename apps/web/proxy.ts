import { NextResponse, type NextRequest } from "next/server";
import { isAccountAuthEnabled, resolveSafeNextPath } from "./lib/auth-mode";
import { evaluateProxyAuth, isCookieSecure } from "./lib/proxy-auth";

/**
 * §7 P1 + 巡影 Fork 默认强制登录门禁（Next 16 "proxy" 约定，运行于 Node.js 运行时）。
 *
 * 门禁策略：
 *  - 演示模式（`MEDIA_TRACK_DEMO_MODE=1`）与本地桌面单用户（`MEDIA_TRACK_DESKTOP=1` 且未开多用户）：放行；
 *  - 默认强制账号密码登录（`isAccountAuthEnabled()` 为 true）：除认证端点与自守 API 外，
 *    处处权威核验 `mt_session` 签名、数据库会话有效期及对应账号已设密码状态；无效则清除旧 Cookie 并跳转 `/login`；
 *  - 单用户兼容模式（显式 `MEDIA_TRACK_MULTI_USER=0`）：若尚未设置任何访问密码（含从老镜像迁移后密码为空），
 *    无论局域网还是外网均强制跳转 `/login` 先设密码；已设密码后局域网直通、经 Cloudflare 头转发的远程请求需有效会话。
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

/** 经代理/隧道的远程请求判定。 */
function isRemoteRequest(request: NextRequest): boolean {
  return (
    request.headers.has("cf-ray") ||
    request.headers.has("cdn-loop") ||
    request.headers.has("cf-connecting-ip")
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  if (process.env.MEDIA_TRACK_DEMO_MODE === "1") {
    return NextResponse.next();
  }
  if (HANDLER_GUARDED_API_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix))) {
    return NextResponse.next();
  }
  if (process.env.MEDIA_TRACK_DESKTOP === "1" && process.env.MEDIA_TRACK_MULTI_USER !== "1") {
    return NextResponse.next();
  }

  const rawSessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const decision = await evaluateProxyAuth({
    rawSessionCookie,
    isRemote: isRemoteRequest(request),
    accountAuthEnabled: isAccountAuthEnabled(),
  });
  if (decision.allow) {
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
  const response = NextResponse.redirect(url);
  if (decision.clearCookie) {
    response.cookies.set(SESSION_COOKIE_NAME, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: isCookieSecure(request),
      path: "/",
      maxAge: 0,
    });
  }
  return response;
}

export const config = {
  // Gate pages; exclude the auth API, the login page, Next internals and assets.
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
