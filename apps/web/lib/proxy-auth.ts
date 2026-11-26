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
 * - 单用户兼容模式（MEDIA_TRACK_MULTI_USER=0）：全网络环境一律强制登录（已彻底移除局域网免登）；
 *   必须先确认 acct_default 已设置访问密码，且请求携带有效 acct_default 的 mt_session 才放行；
 *   未设密码、读取失败（fail-closed）或会话无效时一律拦截跳转 /login 并按需清除失效 Cookie。
 */
export async function evaluateProxyAuth(opts: {
  rawSessionCookie: string | undefined;
  accountAuthEnabled: boolean;
  isRemote?: boolean;
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
