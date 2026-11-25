"use client";

import { useEffect, useState, useTransition } from "react";
import { Aperture, Eye, EyeOff, HelpCircle, LoaderCircle, Lock, ShieldCheck } from "lucide-react";
import { resolveSafeNextPath } from "../../lib/auth-mode";
import { remoteFirstSetupNotice } from "../../lib/remote-access-copy";

interface AuthBootstrapResponse {
  needsClaim: boolean;
  hasExistingLibrary: boolean;
  singleUser?: boolean;
  passwordSet?: boolean;
  remote?: boolean;
  allowRegistration?: boolean;
  webBootstrapDisabled?: boolean;
  authenticated?: boolean;
}

/**
 * 巡影登录 / 首次初始化页面。
 * - 默认强制账号密码登录；未认领时展示「首次初始化站主」流程并接管已有媒体库
 * - 默认关闭公开注册，仅当站主或环境变量开启后才允许在登录页创建普通账号
 * - 当显式配置 MEDIA_TRACK_MULTI_USER=0 时兼容旧单用户访问密码模式
 */
export default function LoginPage() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [nextPath, setNextPath] = useState("/");
  const [isPending, startTransition] = useTransition();
  const [bootstrap, setBootstrap] = useState<AuthBootstrapResponse | null>(null);
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);

  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const targetNext = resolveSafeNextPath(search.get("next"));
    setNextPath(targetNext);

    let cancelled = false;
    fetch("/api/auth/bootstrap")
      .then((res) => res.json() as Promise<AuthBootstrapResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data?.authenticated) {
          window.location.replace(targetNext);
          return;
        }
        setBootstrap(data);
        setBootstrapLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBootstrap(null);
        setBootstrapLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const singleUser = bootstrap?.singleUser === true;
  const claiming = !singleUser && bootstrap?.needsClaim === true;
  const allowRegistration = !singleUser && bootstrap?.allowRegistration === true;
  const webBootstrapDisabled = !singleUser && bootstrap?.webBootstrapDisabled === true;
  const settingPassword = singleUser && bootstrap?.passwordSet === false;
  const effectiveMode: "login" | "register" = singleUser
    ? "login"
    : claiming
      ? "register"
      : allowRegistration
        ? mode
        : "login";
  const needsConfirmPassword = !singleUser && effectiveMode === "register";

  /** 单用户兼容模式：首次设置访问密码并顺手换取 session。 */
  const submitNewPassword = () => {
    setError(null);
    startTransition(async () => {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "设置失败，请重试。");
        return;
      }
      await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "", password }),
      }).catch(() => undefined);
      window.location.href = nextPath;
    });
  };

  const submit = () => {
    setError(null);
    if (needsConfirmPassword && password !== confirmPassword) {
      setError("两次输入的密码不一致。");
      return;
    }
    startTransition(async () => {
      const res = await fetch(`/api/auth/${effectiveMode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        window.location.href = nextPath;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "操作失败，请重试。");
    });
  };

  const title = singleUser
    ? bootstrap?.passwordSet
      ? "输入访问密码"
      : "设置访问密码"
    : claiming
      ? bootstrap?.hasExistingLibrary
        ? "接管这台实例"
        : "创建站主账号"
      : effectiveMode === "login"
        ? "登录巡影"
        : "创建账号";

  const note = singleUser
    ? bootstrap?.passwordSet
      ? "这台实例已设置访问密码。局域网内无需登录，从外网访问需要输入密码。"
      : "给这台实例设一个访问密码。局域网内依旧免登录；以后从外网打开时，要输入这个密码才能进来。"
    : claiming
      ? bootstrap?.hasExistingLibrary
        ? "这台实例已有媒体库。设置站主用户名与密码来接管它——你的库与网盘将原样保留；完成后将自动锁定初始化入口，默认不开放公开注册。"
        : "你是首位使用者。创建站主账号后将自动锁定初始化入口，默认不开放公开注册。"
      : effectiveMode === "login"
        ? "登录以访问你的媒体库与网盘配置"
        : "创建一个本地账号开始使用";

  const buttonText = settingPassword
    ? "设置密码并进入"
    : singleUser
      ? "进入"
      : claiming
        ? "创建站主并进入"
        : effectiveMode === "login"
          ? "登录"
          : "创建并登录";

  const renderBrand = () => (
    <div className="brand auth-brand">
      <span className="brand-mark">
        <Aperture size={18} aria-hidden />
      </span>
      <span className="brand-copy">
        <strong>巡影 · Mediary Scout</strong>
        <span>多网盘媒体 agent</span>
      </span>
    </div>
  );

  if (!bootstrapLoaded || bootstrap?.authenticated) {
    return (
      <main className="auth-shell">
        <div className="auth-container">
          {renderBrand()}
          <section className="panel auth-card" aria-busy="true">
            <div className="auth-loading">
              <LoaderCircle size={20} className="spin" aria-label="加载中" />
              <span className="panel-note" style={{ margin: 0 }}>
                正在检查实例状态…
              </span>
            </div>
          </section>
        </div>
      </main>
    );
  }

  const lanOnly = singleUser ? remoteFirstSetupNotice(bootstrap) : null;
  if (lanOnly) {
    return (
      <main className="auth-shell">
        <div className="auth-container">
          {renderBrand()}
          <section className="panel auth-card">
            <div className="auth-header" style={{ marginBottom: 0 }}>
              <span className="auth-badge">
                <Lock size={12} aria-hidden />
                首次安全初始化
              </span>
              <h1 className="auth-title">{lanOnly.title}</h1>
              <p className="auth-subtitle">{lanOnly.note}</p>
            </div>
          </section>
        </div>
      </main>
    );
  }

  if (claiming && webBootstrapDisabled) {
    return (
      <main className="auth-shell">
        <div className="auth-container">
          {renderBrand()}
          <section className="panel auth-card">
            <div className="auth-header" style={{ marginBottom: 0 }}>
              <span className="auth-badge">
                <Lock size={12} aria-hidden />
                等待环境变量初始化
              </span>
              <h1 className="auth-title">已禁用网页端首次初始化</h1>
              <p className="auth-subtitle">
                当前实例尚未配置站主账号，且已开启禁止网页匿名初始化保护。请在部署环境中设置初始账号后再登录。
              </p>
            </div>
            <div className="auth-code-note">
              请在 <code>.env</code> 中配置 <code>MEDIA_TRACK_ADMIN_USERNAME</code> 与{" "}
              <code>MEDIA_TRACK_ADMIN_PASSWORD</code>（密码至少 6 位）并重启服务，完成后刷新本页登录。
            </div>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <div className="auth-container">
        {renderBrand()}
        <section className="panel auth-card">
          <div className="auth-header">
            {claiming ? (
              <span className="auth-badge">
                <ShieldCheck size={12} aria-hidden />
                首次初始化
              </span>
            ) : null}
            <h1 className="auth-title">{title}</h1>
            <p className="auth-subtitle">{note}</p>
          </div>

          <form
            className="auth-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (settingPassword) {
                submitNewPassword();
              } else {
                submit();
              }
            }}
          >
            {singleUser ? null : (
              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-username">
                  用户名
                </label>
                <input
                  id="auth-username"
                  className="setting-control"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="请输入用户名（至少 2 位）"
                  aria-label="用户名"
                  autoComplete="username"
                  required
                />
              </div>
            )}

            <div className="auth-field">
              <label className="auth-label" htmlFor="auth-password">
                {settingPassword ? "访问密码" : "密码"}
              </label>
              <div className="auth-password-wrap">
                <input
                  id="auth-password"
                  type={showPassword ? "text" : "password"}
                  className="setting-control"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={
                    settingPassword || effectiveMode === "register"
                      ? "设置密码（至少 6 位）"
                      : "请输入密码"
                  }
                  aria-label={settingPassword ? "设置访问密码" : "密码"}
                  autoComplete={
                    settingPassword || effectiveMode === "register" ? "new-password" : "current-password"
                  }
                  required
                />
                <button
                  type="button"
                  className="auth-eye-btn"
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((prev) => !prev)}
                >
                  {showPassword ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                </button>
              </div>
            </div>

            {needsConfirmPassword ? (
              <div className="auth-field">
                <label className="auth-label" htmlFor="auth-confirm-password">
                  确认密码
                </label>
                <div className="auth-password-wrap">
                  <input
                    id="auth-confirm-password"
                    type={showConfirmPassword ? "text" : "password"}
                    className="setting-control"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                    placeholder="请再次输入密码"
                    aria-label="确认密码"
                    autoComplete="new-password"
                    required
                  />
                  <button
                    type="button"
                    className="auth-eye-btn"
                    aria-label={showConfirmPassword ? "隐藏确认密码" : "显示确认密码"}
                    aria-pressed={showConfirmPassword}
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                  >
                    {showConfirmPassword ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
                  </button>
                </div>
              </div>
            ) : null}

            {error ? (
              <p className="auth-alert" role="alert">
                {error}
              </p>
            ) : null}

            <button type="submit" className="primary-button auth-submit" disabled={isPending}>
              {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : buttonText}
            </button>
          </form>

          {!claiming && !singleUser && allowRegistration && effectiveMode === "register" ? (
            <div style={{ marginTop: 14, textAlign: "center" }}>
              <span
                role="note"
                tabIndex={0}
                onMouseEnter={() => setWhyOpen(true)}
                onMouseLeave={() => setWhyOpen(false)}
                onFocus={() => setWhyOpen(true)}
                onBlur={() => setWhyOpen(false)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  cursor: "help",
                }}
              >
                <HelpCircle size={13} aria-hidden />
                为什么我需要创建账号？
              </span>
              {whyOpen ? (
                <p className="auth-code-note" style={{ marginTop: 8 }}>
                  这个站点支持<strong>多人共用</strong>。注册账号后，你可以绑定<strong>自己的</strong>网盘，拥有一份只属于你的媒体库——你的获取记录、收藏都与其他用户互不可见。和家人或朋友合用同一个站点时，各自注册、各连各的网盘即可。
                </p>
              ) : null}
            </div>
          ) : null}

          {!claiming && !singleUser ? (
            <div className="auth-divider-footer">
              {allowRegistration ? (
                <p className="panel-note" style={{ margin: 0 }}>
                  {effectiveMode === "login" ? "还没有账号？" : "已有账号？"}{" "}
                  <button
                    type="button"
                    className="auth-link-btn"
                    onClick={() => {
                      setMode(effectiveMode === "login" ? "register" : "login");
                      setError(null);
                      setConfirmPassword("");
                      setWhyOpen(false);
                    }}
                  >
                    {effectiveMode === "login" ? "创建账号" : "去登录"}
                  </button>
                </p>
              ) : (
                <p className="panel-note" style={{ margin: 0 }}>
                  当前未开放公开注册，如需账号请联系站主
                </p>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
