import { connection, NextResponse, type NextRequest } from "next/server";
import { isWebBootstrapDisabled } from "../../../../lib/auth-mode";
import {
  SESSION_COOKIE_NAME,
  ensureEnvBootstrapOwner,
  getBootstrapState,
  getPublicRegistrationState,
  hasLoginPassword,
  isCookieSecure,
  isMultiUserEnabled,
  isRemoteRequest,
  resolveSessionAccountId,
} from "../../../../lib/workflow-runtime";

/** Tells the /login page whether the instance is unclaimed (→ show the context-aware
 *  claim screen), whether public registration is allowed, whether web bootstrap is
 *  disabled, and whether the caller already holds a valid session.
 *
 *  `connection()` FIRST: reads runtime env + DB at request time rather than prerender. */
export async function GET(request: NextRequest) {
  await connection();
  const remote = isRemoteRequest(request.headers);
  const rawSessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  let sessionAccountId: string | null = null;
  if (rawSessionCookie) {
    try {
      sessionAccountId = await resolveSessionAccountId(rawSessionCookie);
    } catch {
      sessionAccountId = null;
    }
  }
  const authenticated = Boolean(sessionAccountId);
  const shouldClearInvalidCookie = Boolean(rawSessionCookie) && !authenticated;

  const finalize = (payload: Record<string, unknown>) => {
    const response = NextResponse.json(payload);
    if (shouldClearInvalidCookie) {
      response.cookies.set(SESSION_COOKIE_NAME, "", {
        httpOnly: true,
        sameSite: "lax",
        secure: isCookieSecure(request),
        path: "/",
        maxAge: 0,
      });
    }
    return response;
  };

  if (!isMultiUserEnabled()) {
    return finalize({
      needsClaim: false,
      hasExistingLibrary: false,
      singleUser: true,
      // "unknown"（DB 读不出来）按**已设密码**上报：服务端远程读路径此时是
      // fail-closed 的，宁可显示登录框，也不要误导为无需登录。
      passwordSet: (await hasLoginPassword()) !== false,
      remote,
      allowRegistration: false,
      webBootstrapDisabled: false,
      authenticated,
    });
  }

  await ensureEnvBootstrapOwner();
  const [bootstrap, regState] = await Promise.all([
    getBootstrapState(),
    getPublicRegistrationState(),
  ]);
  return finalize({
    ...bootstrap,
    singleUser: false,
    remote,
    allowRegistration: regState.allowed,
    webBootstrapDisabled: isWebBootstrapDisabled(),
    authenticated,
  });
}
