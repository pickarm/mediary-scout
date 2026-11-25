"use client";

import { useEffect, useState, useTransition } from "react";
import { LoaderCircle, UserPlus } from "lucide-react";
import {
  createManagedAccountAction,
  resetUserPasswordAction,
  setPublicRegistrationAction,
} from "../app/actions";
import { runAction } from "../lib/run-action";

interface ManagedAccount {
  id: string;
  username: string;
  isOwner: boolean;
  createdAt: string;
  driveCount: number;
}

/** 站主账号管理面板：公开注册策略切换、创建成员账号及成员密码重置（权限均在服务端二次核验）。 */
export function AccountAdminPanel({
  accounts,
  allowRegistration = false,
  registrationLockedByEnv = false,
}: {
  accounts: ManagedAccount[];
  allowRegistration?: boolean;
  registrationLockedByEnv?: boolean;
}) {
  const [accountList, setAccountList] = useState<ManagedAccount[]>(accounts);
  const [regAllowed, setRegAllowed] = useState(allowRegistration);
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [regPending, startRegTransition] = useTransition();

  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [createMsg, setCreateMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [createPending, startCreateTransition] = useTransition();

  useEffect(() => {
    setAccountList(accounts);
  }, [accounts]);

  useEffect(() => {
    setRegAllowed(allowRegistration);
  }, [allowRegistration]);

  const toggleRegistration = () => {
    setRegMsg(null);
    const next = !regAllowed;
    startRegTransition(async () => {
      const r = await runAction(
        () => setPublicRegistrationAction(next),
        (msg) => setRegMsg({ ok: false, text: msg }),
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.ok) {
        const resolved = res.allowed ?? next;
        setRegAllowed(resolved);
        setRegMsg({
          ok: true,
          text: resolved ? "已开放公开注册，新访客可在登录页自助创建账号。" : "已关闭公开注册，仅站主可新建账号。",
        });
      } else {
        setRegMsg({ ok: false, text: res.error ?? "切换失败。" });
      }
    });
  };

  const submitCreate = () => {
    setCreateMsg(null);
    startCreateTransition(async () => {
      const r = await runAction(
        () => createManagedAccountAction(newUsername, newPassword),
        (msg) => setCreateMsg({ ok: false, text: msg }),
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.ok && res.account) {
        const createdAccount = res.account;
        setAccountList((prev) =>
          prev.some((item) => item.id === createdAccount.id) ? prev : [...prev, createdAccount],
        );
        setCreateMsg({
          ok: true,
          text: `已创建账号「${createdAccount.username}」，请将用户名与初始密码发给对方登录。`,
        });
        setCreateOpen(false);
        setNewUsername("");
        setNewPassword("");
      } else {
        setCreateMsg({ ok: false, text: res.error ?? "创建失败。" });
      }
    });
  };

  return (
    <div className="account-admin">
      <div className="account-admin-row">
        <div className="account-admin-info" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="account-admin-name">公开注册</span>
            <span className={`hub-badge ${regAllowed ? "tone-green" : "tone-muted"}`}>
              {regAllowed ? "已开放" : "已关闭"}
            </span>
          </div>
          <span className="account-admin-meta">
            {registrationLockedByEnv
              ? "公开注册开关当前由环境变量 MEDIA_TRACK_ALLOW_REGISTRATION 锁定"
              : "默认关闭以防止陌生人自由注册；需要邀请家人朋友自助注册时可临时开启"}
          </span>
        </div>
        <div className="account-admin-action">
          <button
            type="button"
            className="secondary-button"
            style={{ cursor: registrationLockedByEnv ? "not-allowed" : "pointer" }}
            disabled={regPending || registrationLockedByEnv}
            onClick={toggleRegistration}
          >
            {regPending ? (
              <LoaderCircle size={14} className="spin" aria-hidden />
            ) : regAllowed ? (
              "关闭公开注册"
            ) : (
              "开放公开注册"
            )}
          </button>
        </div>
        {regMsg ? (
          <p
            className="panel-note"
            style={{ width: "100%", margin: "6px 0 0", color: regMsg.ok ? "var(--accent)" : "var(--negative, #f3727f)" }}
          >
            {regMsg.text}
          </p>
        ) : null}
      </div>

      <div className="account-admin-row">
        <div className="account-admin-info" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <span className="account-admin-name">新建成员账号</span>
          <span className="account-admin-meta">
            在关闭公开注册时由站主直接为成员开设账号，拥有各自独立的网盘与媒体库
          </span>
        </div>
        <div className="account-admin-action">
          {createOpen ? null : (
            <button
              type="button"
              className="secondary-button"
              style={{ cursor: "pointer" }}
              onClick={() => {
                setCreateOpen(true);
                setCreateMsg(null);
              }}
            >
              <UserPlus size={14} aria-hidden />
              新建账号
            </button>
          )}
        </div>
        {createOpen ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitCreate();
            }}
            style={{ width: "100%", display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}
          >
            <input
              type="text"
              className="setting-control"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="用户名（至少 2 位）"
              aria-label="新成员用户名"
              style={{ width: 170 }}
            />
            <input
              type="password"
              className="setting-control"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="初始密码（至少 6 位）"
              aria-label="新成员初始密码"
              autoComplete="new-password"
              style={{ width: 185 }}
            />
            <button type="submit" className="primary-button" disabled={createPending}>
              {createPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "创建"}
            </button>
            <button
              type="button"
              className="account-identity-item"
              style={{ width: "auto", padding: "7px 10px" }}
              onClick={() => {
                setCreateOpen(false);
                setNewUsername("");
                setNewPassword("");
                setCreateMsg(null);
              }}
            >
              取消
            </button>
          </form>
        ) : null}
        {createMsg ? (
          <p
            className="panel-note"
            style={{ width: "100%", margin: "6px 0 0", color: createMsg.ok ? "var(--accent)" : "var(--negative, #f3727f)" }}
          >
            {createMsg.text}
          </p>
        ) : null}
      </div>

      {accountList.map((account) => (
        <AccountAdminRow key={account.id} account={account} />
      ))}
    </div>
  );
}

function AccountAdminRow({ account }: { account: ManagedAccount }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  const submit = () => {
    setMsg(null);
    startTransition(async () => {
      const r = await runAction(
        () => resetUserPasswordAction(account.id, pw),
        (msg) => setMsg({ ok: false, text: msg }),
      );
      if (!r.ok) return;
      const res = r.value;
      if (res.ok) {
        setMsg({ ok: true, text: `已重置「${account.username}」的密码，请把新密码交给 TA。` });
        setOpen(false);
        setPw("");
      } else {
        setMsg({ ok: false, text: res.error ?? "重置失败。" });
      }
    });
  };

  const created = account.createdAt.slice(0, 10);

  return (
    <div className="account-admin-row">
      <div className="account-admin-info">
        <span className="account-admin-name">{account.username}</span>
        {account.isOwner ? <span className="account-identity-owner">站主</span> : null}
        <span className="account-admin-meta">
          {created} · {account.driveCount} 个网盘
        </span>
      </div>
      <div className="account-admin-action">
        {open ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="password"
              className="setting-control"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="新密码（至少 6 位）"
              aria-label={`${account.username} 的新密码`}
              autoComplete="new-password"
              style={{ width: 180 }}
            />
            <button type="button" className="primary-button" onClick={submit} disabled={isPending}>
              {isPending ? <LoaderCircle size={14} className="spin" aria-hidden /> : "确认"}
            </button>
            <button
              type="button"
              className="account-identity-item"
              style={{ width: "auto", padding: "7px 10px" }}
              onClick={() => {
                setOpen(false);
                setPw("");
              }}
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="account-identity-item"
            style={{ width: "auto", padding: "7px 12px" }}
            onClick={() => {
              setOpen(true);
              setMsg(null);
            }}
          >
            重置密码
          </button>
        )}
      </div>
      {msg ? (
        <p
          className="panel-note"
          style={{ width: "100%", margin: "6px 0 0", color: msg.ok ? "var(--accent)" : "var(--negative, #f3727f)" }}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
