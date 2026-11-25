export const ALLOW_PUBLIC_REGISTRATION_SETTING_KEY = "auth_allow_registration";

export const MIN_USERNAME_LENGTH = 2;
export const MAX_USERNAME_LENGTH = 64;
export const MIN_PASSWORD_LENGTH = 6;

const USERNAME_CONTROL_CHAR_RE = /[\u0000-\u001f]/u;
const PATH_CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

export type EnvBootstrapOwnerResult =
  | { status: "none" }
  | { status: "valid"; username: string; password: string }
  | { status: "invalid"; reason: string };

/**
 * 判断实例是否启用强制账号密码登录（包含前端登录门禁、会话强制检验与按账号数据隔离）。
 * - 演示模式始终关闭（免登只读）
 * - 桌面端仅在显式配置 MEDIA_TRACK_MULTI_USER=1 时开启
 * - 其余自部署/Web 场景默认开启，仅当显式设 MEDIA_TRACK_MULTI_USER=0 时回退兼容单用户模式
 */
export function isAccountAuthEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MEDIA_TRACK_DEMO_MODE === "1") {
    return false;
  }
  if (env.MEDIA_TRACK_DESKTOP === "1") {
    return env.MEDIA_TRACK_MULTI_USER === "1";
  }
  if (env.MEDIA_TRACK_MULTI_USER === "0") {
    return false;
  }
  return true;
}

/** 是否禁止在网页 /login 首次匿名初始化站主账号（强制改用环境变量配置）。 */
export function isWebBootstrapDisabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP === "1";
}

/**
 * 校验并提取用户名（仅裁剪首尾空白）。
 * 返回校验通过的用户名或中文错误原因。
 */
export function validateUsernameInput(raw: string): { ok: true; username: string } | { ok: false; error: string } {
  if (USERNAME_CONTROL_CHAR_RE.test(raw)) {
    return { ok: false, error: "用户名长度不能超过 64 位且不能包含控制字符。" };
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_USERNAME_LENGTH) {
    return { ok: false, error: "用户名至少 2 位。" };
  }
  if (trimmed.length > MAX_USERNAME_LENGTH) {
    return { ok: false, error: "用户名长度不能超过 64 位且不能包含控制字符。" };
  }
  return { ok: true, username: trimmed };
}

/** 解析环境变量中的首次预置站主凭证；密码不作 trim 以保留用户原字符。 */
export function resolveEnvBootstrapOwner(
  env: Record<string, string | undefined> = process.env,
): EnvBootstrapOwnerResult {
  const rawUsername = env.MEDIA_TRACK_ADMIN_USERNAME ?? "";
  const trimmedUsername = rawUsername.trim();
  const password = env.MEDIA_TRACK_ADMIN_PASSWORD ?? "";

  if (!trimmedUsername && password.length === 0) {
    return { status: "none" };
  }
  if (!trimmedUsername || password.length === 0) {
    return { status: "invalid", reason: "MEDIA_TRACK_ADMIN_USERNAME 与 MEDIA_TRACK_ADMIN_PASSWORD 必须同时配置" };
  }
  if (
    USERNAME_CONTROL_CHAR_RE.test(rawUsername) ||
    trimmedUsername.length < MIN_USERNAME_LENGTH ||
    trimmedUsername.length > MAX_USERNAME_LENGTH
  ) {
    return { status: "invalid", reason: "MEDIA_TRACK_ADMIN_USERNAME 需为 2-64 个有效字符且不含控制字符" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { status: "invalid", reason: "MEDIA_TRACK_ADMIN_PASSWORD 长度不能少于 6 位" };
  }
  return { status: "valid", username: trimmedUsername, password };
}

/** 解析当前公开注册策略（环境变量优先级高于数据库设置，默认关闭）。 */
export function resolvePublicRegistrationState(opts: {
  envValue?: string | undefined;
  dbValue: string | null;
}): { allowed: boolean; lockedByEnv: boolean } {
  const normalizedEnv = opts.envValue?.trim();
  if (normalizedEnv === "1") {
    return { allowed: true, lockedByEnv: true };
  }
  if (normalizedEnv === "0") {
    return { allowed: false, lockedByEnv: true };
  }
  return { allowed: opts.dbValue === "1", lockedByEnv: false };
}

/** 校验并归一化登录成功后的站内回跳路径，防止开放重定向与跳回认证/API 端点。 */
export function resolveSafeNextPath(raw: string | null | undefined): string {
  if (!raw) {
    return "/";
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("\\")) {
    return "/";
  }
  if (PATH_CONTROL_CHAR_RE.test(trimmed)) {
    return "/";
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed, "http://localhost");
  } catch {
    return "/";
  }
  if (parsed.origin !== "http://localhost") {
    return "/";
  }
  if (
    parsed.pathname === "/login" ||
    parsed.pathname.startsWith("/login/") ||
    parsed.pathname === "/api" ||
    parsed.pathname.startsWith("/api/")
  ) {
    return "/";
  }
  return trimmed;
}
