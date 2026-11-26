import { DEFAULT_ACCOUNT_ID } from "@media-track/workflow";
import {
  ensureEnvBootstrapOwner,
  hasLoginPassword,
  isCookieSecure,
  resolveSessionAccountId,
} from "./workflow-runtime";

export { isCookieSecure };

export interface ProxyAuthDecision {
  allow: boolean;
  clearCookie: boolean;
}

/**
 * 权威代理门禁决策（运行于 Next.js 16 Node.js proxy 运行时）：
 * - 默认强制登录模式（accountAuthEnabled=true）：必须持有有效且对应「已设密码账号」的 mt_session；
 *   缺失或失效/过期/指向空密码账号时一律拦截并按需清除失效 Cookie，绝不放行页面壳渲染。
 * - 单用户兼容模式（MEDIA_TRACK_MULTI_USER=0）：先强制校验 acct_default 已设置访问密码；
 *   若未设密码或读取失败（fail-closed），无论局域网还是外网均拦截并强制跳转 /login 设置密码。
 */
export async function evaluateProxyAuth(opts: {
  rawSessionCookie: string | undefined;
  isRemote: boolean;
  accountAuthEnabled: boolean;
}): Promise<ProxyAuthDecision> {
  const hasCookie = Boolean(opts.rawSessionCookie);

  if (opts.accountAuthEnabled) {
    if (!opts.rawSessionCookie) {
      return { allow: false, clearCookie: false };
    }
    try {
      await ensureEnvBootstrapOwner();
      const accountId = await resolveSessionAccountId(opts.rawSessionCookie);
      if (accountId) {
        return { allow: true, clearCookie: false };
      }
      return { allow: false, clearCookie: true };
    } catch {
      return { allow: false, clearCookie: true };
    }
  }

  let passwordState: boolean | "unknown" = "unknown";
  try {
    passwordState = await hasLoginPassword();
  } catch {
    passwordState = "unknown";
  }

  if (passwordState !== true) {
    return { allow: false, clearCookie: hasCookie };
  }

  if (!opts.isRemote) {
    return { allow: true, clearCookie: false };
  }

  if (!opts.rawSessionCookie) {
    return { allow: false, clearCookie: false };
  }

  try {
    const accountId = await resolveSessionAccountId(opts.rawSessionCookie);
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return { allow: true, clearCookie: false };
    }
    return { allow: false, clearCookie: true };
  } catch {
    return { allow: false, clearCookie: true };
  }
}
