import { connection } from "next/server";
import { redirect } from "next/navigation";
import { isDemoMode } from "../lib/demo-mode";
import {
  getCurrentAccountId,
  getCurrentAccountSummary,
  hasLoginPassword,
  isMultiUserEnabled,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block and page-level auth fallback:
 * - Demo mode or local desktop single-user: renders nothing;
 * - Single-user opt-out mode (MEDIA_TRACK_MULTI_USER=0): redirects to /login when password is unset
 *   or session is unauthenticated, otherwise shows identity menu (change password + logout);
 * - Default forced-auth mode: redirects to /login when session is invalid/missing or account lacks summary.
 */
export async function AccountIdentityLoader() {
  await connection();
  if (isDemoMode()) return null;
  if (!isMultiUserEnabled()) {
    if (process.env.MEDIA_TRACK_DESKTOP === "1") return null;
    if ((await hasLoginPassword()) !== true) {
      redirect("/login");
    }
    const accountId = await getCurrentAccountId();
    if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
      redirect("/login");
    }
    const summary = await getCurrentAccountSummary();
    const displayName = summary?.username && summary.username !== "default" ? summary.username : "站主";
    return <AccountIdentity username={displayName} isOwner={true} showAccountManagement={false} />;
  }
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    redirect("/login");
  }
  const summary = await getCurrentAccountSummary();
  if (!summary) {
    redirect("/login");
  }
  return <AccountIdentity username={summary.username} isOwner={summary.isOwner} />;
}
