"use client";

import Image from "next/image";
import { Check, KeyRound, LoaderCircle, LogOut, QrCode, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  beginWeixinLoginAction,
  pollWeixinLoginAction,
  saveMessagingConnectionAction,
  unlinkMessagingConnectionAction,
} from "../lib/messaging/actions";
import type { MessagingConnectionInput, MessagingConnectionView } from "../lib/messaging/config";
import type { MessagingPlatform } from "../lib/messaging/types";
import { runAction } from "../lib/run-action";

const PLATFORM_COPY: Readonly<Record<MessagingPlatform, {
  title: string;
  description: string;
  configuredLabel: string;
}>> = {
  weixin: {
    title: "微信机器人",
    description: "扫码登录微信机器人，后续可通过私聊查询、选择和收取资源。",
    configuredLabel: "已配置微信登录",
  },
  feishu: {
    title: "飞书机器人",
    description: "使用飞书应用凭证接收本人的私聊消息和操作。",
    configuredLabel: "已配置 App Secret",
  },
  telegram: {
    title: "Telegram 机器人",
    description: "使用 Bot Token 接收本人的 Telegram 私聊消息和操作。",
    configuredLabel: "已配置 Bot Token",
  },
};

const PLATFORM_ORDER: readonly MessagingPlatform[] = ["weixin", "feishu", "telegram"];
const POLL_INTERVAL_MS = 2_000;

type Notice = { kind: "success" | "error"; message: string };
type WeixinLoginPhase =
  | "idle"
  | "starting"
  | "waiting"
  | "scanned"
  | "verify_required"
  | "confirmed"
  | "expired"
  | "error";

export function MessagingSettingsForm({
  initial,
  storages,
}: {
  initial: MessagingConnectionView[];
  storages: readonly { id: string; label: string }[];
}) {
  return (
    <div>
      {PLATFORM_ORDER.map((platform) => (
        <MessagingPlatformPanel
          key={platform}
          platform={platform}
          initial={initial.find((connection) => connection.platform === platform) ?? null}
          storages={storages}
        />
      ))}
    </div>
  );
}

function MessagingPlatformPanel({
  platform,
  initial,
  storages,
}: {
  platform: MessagingPlatform;
  initial: MessagingConnectionView | null;
  storages: readonly { id: string; label: string }[];
}) {
  const copy = PLATFORM_COPY[platform];
  const [connection, setConnection] = useState<MessagingConnectionView | null>(initial);
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [senderId, setSenderId] = useState(initial?.senderId ?? "");
  const [defaultStorageId, setDefaultStorageId] = useState(initial?.defaultStorageId ?? "");
  const [appId, setAppId] = useState(platform === "feishu" ? initial?.botId ?? "" : "");
  const [token, setToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<"save" | "unlink" | null>(null);
  const [weixinPhase, setWeixinPhase] = useState<WeixinLoginPhase>("idle");
  const [qrcode, setQrcode] = useState<string | null>(null);
  const [qrcodeUrl, setQrcodeUrl] = useState<string | null>(null);
  const [pin, setPin] = useState("");
  const pollGeneration = useRef(0);
  const pinRef = useRef("");

  useEffect(() => {
    setConnection(initial);
    setEnabled(initial?.enabled ?? false);
    setSenderId(initial?.senderId ?? "");
    setDefaultStorageId(initial?.defaultStorageId ?? "");
    setAppId(platform === "feishu" ? initial?.botId ?? "" : "");
    setToken("");
    setAppSecret("");
  }, [initial, platform]);

  useEffect(() => {
    pinRef.current = pin;
  }, [pin]);

  useEffect(() => () => {
    pollGeneration.current += 1;
  }, []);

  const stopWeixinPolling = (phase: WeixinLoginPhase = "idle") => {
    pollGeneration.current += 1;
    setQrcode(null);
    setQrcodeUrl(null);
    setPin("");
    setWeixinPhase(phase);
  };

  const applyConnection = (next: MessagingConnectionView) => {
    setConnection(next);
    setEnabled(next.enabled);
    setSenderId(next.senderId);
    setDefaultStorageId(next.defaultStorageId ?? "");
    setAppId(platform === "feishu" ? next.botId : "");
  };

  const handleEnabledChange = (next: boolean) => {
    setEnabled(next);
    if (!next && platform === "weixin" && weixinPhase !== "idle" && weixinPhase !== "confirmed") {
      stopWeixinPolling();
      setNotice({ kind: "success", message: "已停止等待微信扫码。" });
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy("save");
    setNotice(null);
    const credentials: Record<string, string> = {};
    if (platform === "telegram" && token.trim()) credentials.token = token.trim();
    if (platform === "feishu") {
      if (appId.trim()) credentials.appId = appId.trim();
      if (appSecret.trim()) credentials.appSecret = appSecret.trim();
    }
    const input: MessagingConnectionInput = {
      platform,
      enabled,
      senderId,
      defaultStorageId: defaultStorageId || null,
      credentials,
    };
    const outcome = await runAction(
      () => saveMessagingConnectionAction(input),
      () => setNotice({ kind: "error", message: "保存失败，请刷新页面后重试。" }),
    );
    if (!outcome.ok) {
      setBusy(null);
      return;
    }
    if (!outcome.value.success) {
      setNotice({ kind: "error", message: outcome.value.message ?? "保存失败，请检查填写内容。" });
      setBusy(null);
      return;
    }
    if (outcome.value.connection) applyConnection(outcome.value.connection);
    setToken("");
    setAppSecret("");
    setNotice({ kind: "success", message: outcome.value.message ?? `${copy.title}设置已保存。` });
    setBusy(null);
  };

  const unlink = async () => {
    if (busy) return;
    setBusy("unlink");
    setNotice(null);
    if (platform === "weixin") stopWeixinPolling();
    const outcome = await runAction(
      () => unlinkMessagingConnectionAction(platform),
      () => setNotice({ kind: "error", message: "解绑失败，请刷新页面后重试。" }),
    );
    if (!outcome.ok) {
      setBusy(null);
      return;
    }
    if (!outcome.value.success) {
      setNotice({ kind: "error", message: outcome.value.message ?? "解绑失败，请稍后重试。" });
      setBusy(null);
      return;
    }
    setConnection(null);
    setEnabled(false);
    setSenderId("");
    setDefaultStorageId("");
    setAppId("");
    setToken("");
    setAppSecret("");
    setPin("");
    setNotice({ kind: "success", message: outcome.value.message ?? `${copy.title}已解绑。` });
    setBusy(null);
  };

  const handlePoll = async (generation: number, currentQrcode: string): Promise<void> => {
    while (pollGeneration.current === generation) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
      if (pollGeneration.current !== generation) return;
      const currentPin = pinRef.current.trim();
      const outcome = await runAction(
        () => pollWeixinLoginAction({
          qrcode: currentQrcode,
          ...(currentPin ? { pin: currentPin } : {}),
        }),
        () => setNotice({ kind: "error", message: "查询扫码状态失败，请重新扫码。" }),
      );
      if (pollGeneration.current !== generation) return;
      if (!outcome.ok) {
        setWeixinPhase("error");
        return;
      }
      const result = outcome.value;
      if (result.state === "confirmed") {
        if (result.connection) applyConnection(result.connection);
        setQrcode(null);
        setQrcodeUrl(null);
        setPin("");
        setWeixinPhase("confirmed");
        setNotice({ kind: "success", message: result.message ?? "微信机器人已扫码登录。" });
        return;
      }
      if (result.state === "verify_required") {
        setWeixinPhase("verify_required");
        setNotice({ kind: "error", message: result.message ?? "需要输入 PIN 继续验证。" });
        return;
      }
      if (result.state === "expired") {
        setQrcode(null);
        setQrcodeUrl(null);
        setWeixinPhase("expired");
        setNotice({ kind: "error", message: result.message ?? "二维码已过期，请重新扫码。" });
        return;
      }
      if (result.state === "error" || !result.success) {
        setWeixinPhase("error");
        setNotice({ kind: "error", message: result.message ?? "微信扫码登录失败，请重试。" });
        return;
      }
      if (result.state === "scanned") {
        setWeixinPhase("scanned");
        setNotice({ kind: "success", message: result.message ?? "已扫码，请在微信中确认。" });
      } else {
        setWeixinPhase("waiting");
      }
    }
  };

  const beginWeixinLogin = async () => {
    stopWeixinPolling("starting");
    setNotice(null);
    const generation = pollGeneration.current;
    const outcome = await runAction(
      () => beginWeixinLoginAction(),
      () => setNotice({ kind: "error", message: "获取二维码失败，请稍后重试。" }),
    );
    if (pollGeneration.current !== generation) return;
    if (!outcome.ok) {
      setWeixinPhase("error");
      return;
    }
    if (!outcome.value.success || !outcome.value.qrcode || !outcome.value.qrcodeUrl) {
      setWeixinPhase("error");
      setNotice({ kind: "error", message: outcome.value.message ?? "未获取到可用的登录二维码。" });
      return;
    }
    setQrcode(outcome.value.qrcode);
    setQrcodeUrl(outcome.value.qrcodeUrl);
    setWeixinPhase("waiting");
    void handlePoll(generation, outcome.value.qrcode);
  };

  const continueWithPin = () => {
    if (!qrcode) return;
    const generation = ++pollGeneration.current;
    setWeixinPhase("waiting");
    setNotice(null);
    void handlePoll(generation, qrcode);
  };

  const hasConnection = Boolean(connection && (
    connection.enabled
    || connection.botId
    || connection.senderId
    || connection.defaultStorageId
    || Object.values(connection.credentialSet).some(Boolean)
  ));
  const saveLabel = busy === "save" ? "保存中…" : "保存设置";
  const credentialConfigured = platform === "weixin"
    ? Boolean(connection?.credentialSet.token)
    : platform === "feishu"
      ? Boolean(connection?.credentialSet.appId && connection.credentialSet.appSecret)
      : Boolean(connection?.credentialSet.token);

  return (
    <section className="panel messaging-platform-panel" style={{ maxWidth: 720, marginTop: 24 }} data-platform={platform}>
      <div className="panel-header">
        <div>
          <h2 className="panel-title">{copy.title}</h2>
          <p className="panel-note">{copy.description}</p>
        </div>
        {credentialConfigured ? (
          <span className="panel-note" role="status">{copy.configuredLabel}</span>
        ) : null}
      </div>

      <div className="push-form">
        <label className="push-field">
          <span className="push-label">启用此机器人</span>
          <span>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => handleEnabledChange(event.target.checked)}
              disabled={busy !== null}
            />
            {" "}{enabled ? "已开启" : "默认关闭"}
          </span>
        </label>

        {platform === "telegram" ? (
          <label className="push-field">
            <span className="push-label">Bot Token</span>
            <input
              className="setting-control"
              type="password"
              aria-label="Telegram Bot Token"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder={connection?.credentialSet.token ? "已配置，留空保留现有 Bot Token" : "123456789:AA…"}
              disabled={busy !== null}
            />
          </label>
        ) : null}

        {platform === "feishu" ? (
          <>
            <label className="push-field">
              <span className="push-label">App ID</span>
              <input
                className="setting-control"
                type="text"
                aria-label="飞书 App ID"
                autoComplete="off"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="cli_…"
                disabled={busy !== null}
              />
            </label>
            <label className="push-field">
              <span className="push-label">App Secret</span>
              <input
                className="setting-control"
                type="password"
                aria-label="飞书 App Secret"
                autoComplete="new-password"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder={connection?.credentialSet.appSecret ? "已配置，留空保留现有 App Secret" : "填写飞书应用密钥"}
                disabled={busy !== null}
              />
            </label>
          </>
        ) : null}

        {platform === "weixin" ? (
          <>
            <div className="qr-connect">
              <div className="qr-connect-controls">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void beginWeixinLogin()}
                  disabled={busy !== null || weixinPhase === "starting"}
                >
                  {weixinPhase === "starting"
                    ? <LoaderCircle size={14} className="spin" aria-hidden />
                    : qrcodeUrl
                      ? <RefreshCw size={14} aria-hidden />
                      : <QrCode size={14} aria-hidden />}
                  {weixinPhase === "starting" ? "获取中…" : qrcodeUrl ? "重新扫码" : "扫码登录"}
                </button>
                {weixinPhase === "verify_required" ? (
                  <button className="secondary-button" type="button" onClick={continueWithPin} disabled={!pin.trim()}>
                    <KeyRound size={14} aria-hidden />
                    使用 PIN 继续
                  </button>
                ) : null}
              </div>
              <p className="qr-hint">二维码只用于当前微信账号登录；登录成功后服务端只向页面返回脱敏连接状态。</p>
              {qrcodeUrl ? (
                <div className="qr-frame">
                  <Image
                    src={qrcodeUrl}
                    alt="微信机器人登录二维码"
                    width={180}
                    height={180}
                    unoptimized
                  />
                  <span className={`qr-status ${weixinPhase === "scanned" ? "scanned" : ""}`}>
                    {weixinPhase === "scanned"
                      ? "已扫码，请在微信中确认"
                      : weixinPhase === "verify_required"
                        ? "请输入 PIN 继续验证"
                        : "使用微信扫码登录"}
                  </span>
                </div>
              ) : null}
            </div>
            <label className="push-field">
              <span className="push-label">PIN</span>
              <input
                className="setting-control"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                aria-label="PIN"
                value={pin}
                onChange={(event) => setPin(event.target.value)}
                placeholder="微信要求验证时填写 PIN"
                disabled={busy !== null}
              />
            </label>
            {connection?.botId ? <p className="panel-note">机器人 ID：{connection.botId}</p> : null}
          </>
        ) : null}

        <label className="push-field">
          <span className="push-label">本人平台 ID</span>
          <input
            className="setting-control"
            type="text"
            aria-label="本人平台 ID"
            autoComplete="off"
            value={senderId}
            onChange={(event) => setSenderId(event.target.value)}
            placeholder="只接受此平台 ID 发来的私聊消息"
            disabled={busy !== null}
          />
        </label>

        <label className="push-field">
          <span className="push-label">默认网盘</span>
          <select
            className="setting-control"
            aria-label="默认网盘"
            value={defaultStorageId}
            onChange={(event) => setDefaultStorageId(event.target.value)}
            disabled={busy !== null}
          >
            <option value="">不设置默认网盘</option>
            {storages.map((storage) => (
              <option key={storage.id} value={storage.id}>{storage.label}</option>
            ))}
          </select>
        </label>

        <div className="service-actions">
          <button className="primary-button" type="button" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save"
              ? <LoaderCircle size={14} className="spin" aria-hidden />
              : <Check size={14} aria-hidden />}
            {saveLabel}
          </button>
          {hasConnection ? (
            <button className="secondary-button" type="button" onClick={() => void unlink()} disabled={busy !== null}>
              {busy === "unlink"
                ? <LoaderCircle size={14} className="spin" aria-hidden />
                : <LogOut size={14} aria-hidden />}
              {busy === "unlink" ? "解绑中…" : "解绑机器人"}
            </button>
          ) : null}
          {notice ? (
            <p
              className="panel-note"
              role={notice.kind === "error" ? "alert" : "status"}
              style={{ color: notice.kind === "error" ? "var(--negative)" : "var(--accent)" }}
            >
              {notice.message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
