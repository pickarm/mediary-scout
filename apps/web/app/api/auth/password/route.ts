import { NextResponse, type NextRequest } from "next/server";
import { isDemoMode } from "../../../../lib/demo-mode";
import {
  SESSION_COOKIE_NAME,
  createSingleUserSessionCookie,
  isMultiUserEnabled,
  isCookieSecure,
  hasLoginPassword,
  setSingleUserPassword,
  requireAuthenticatedAccountId,
  isRemoteRequest,
  UnauthenticatedAccountError,
} from "../../../../lib/workflow-runtime";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, seconds

/**
 * 单用户模式设置或更新访问密码（`acct_default`）。
 * - 全网络环境一律强制登录：不再支持通过 `clear: true` 清空密码回退免密状态；
 * - 尚未设密码时仅允许局域网首次设置，设密完成后立即签发 `mt_session` Cookie；
 * - 已设密码后必须携带有效会话方可修改，否则严格返回 401。
 */
export async function POST(request: NextRequest) {
  if (isDemoMode()) {
    return NextResponse.json({ error: "演示站只读" }, { status: 403 });
  }
  if (isMultiUserEnabled()) {
    // 多用户有自己的改密路径（changeOwnPassword / resetUserPassword）
    return NextResponse.json({ error: "多用户模式请在账号设置中改密" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    clear?: unknown;
  };

  // 已设密码 → 后续变更必须已认证。状态读不出来（"unknown"）时同样要求认证。
  const passwordState = await hasLoginPassword();
  if (passwordState === false && isRemoteRequest(request.headers)) {
    return NextResponse.json(
      { error: "第一次设置访问密码只能在局域网里完成。请在家里的网络打开这台机器的局域网地址设置。" },
      { status: 403 },
    );
  }
  if (passwordState !== false) {
    try {
      await requireAuthenticatedAccountId();
    } catch (error) {
      if (error instanceof UnauthenticatedAccountError) {
        return NextResponse.json({ error: error.message }, { status: 401 });
      }
      throw error;
    }
  }

  if (body.clear === true) {
    return NextResponse.json(
      { error: "当前实例已启用全环境强制登录，不支持清空访问密码；如需更换请直接修改密码。" },
      { status: 400 },
    );
  }

  const password = typeof body.password === "string" ? body.password : "";
  const result = await setSingleUserPassword(password);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  const response = NextResponse.json({ ok: true, passwordSet: true });
  if (passwordState === false) {
    const signedCookie = await createSingleUserSessionCookie();
    response.cookies.set(SESSION_COOKIE_NAME, signedCookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: isCookieSecure(request),
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  }
  return response;
}

