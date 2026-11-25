import { isWebBootstrapDisabled } from "../../../../lib/auth-mode";
import { isDemoMode } from "../../../../lib/demo-mode";
import { NextResponse, type NextRequest } from "next/server";
import {
  SESSION_COOKIE_NAME,
  ensureEnvBootstrapOwner,
  getBootstrapState,
  isCookieSecure,
  isMultiUserEnabled,
  isPublicRegistrationEnabled,
  registerAccount,
} from "../../../../lib/workflow-runtime";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

/** Register a local account (or perform initial owner claim when unclaimed) → set session cookie. */
export async function POST(request: NextRequest) {
  if (isDemoMode()) return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  if (!isMultiUserEnabled()) {
    return NextResponse.json({ error: "multi-user disabled" }, { status: 404 });
  }
  await ensureEnvBootstrapOwner();
  const bootstrap = await getBootstrapState();
  if (bootstrap.needsClaim) {
    if (isWebBootstrapDisabled()) {
      return NextResponse.json(
        {
          error:
            "已禁用网页端首次初始化，请通过环境变量 MEDIA_TRACK_ADMIN_USERNAME 与 MEDIA_TRACK_ADMIN_PASSWORD 配置站主账号。",
        },
        { status: 403 },
      );
    }
  } else if (!(await isPublicRegistrationEnabled())) {
    return NextResponse.json(
      { error: "当前站点未开放公开注册，请联系站主开启注册或创建账号。" },
      { status: 403 },
    );
  }
  const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
  const username = typeof body.username === "string" ? body.username : "";
  const password = typeof body.password === "string" ? body.password : "";
  const result = await registerAccount(username, password);
  if (!result.ok) {
    const status =
      result.error.includes("未开放公开注册") || result.error.includes("已禁用网页端首次初始化")
        ? 403
        : 400;
    return NextResponse.json({ error: result.error }, { status });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, result.signedCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: isCookieSecure(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
