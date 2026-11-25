import { connection } from "next/server";
import { redirect } from "next/navigation";
import { isDemoMode } from "../lib/demo-mode";
import {
  getCurrentAccountId,
  getCurrentAccountSummary,
  isMultiUserEnabled,
  UNAUTHENTICATED_ACCOUNT_ID,
} from "../lib/workflow-runtime";
import { AccountIdentity } from "./account-identity";

/**
 * Async server loader for the sidebar identity block. Renders nothing in single-user
 * or demo mode, redirects to /login when an expired/revoked session slips past Edge
 * cookie-presence checks, and otherwise renders the signed-in account dropdown.
 *
 * `connection()` FIRST so cacheComponents evaluates this per-request, not at build time.
 */
export async function AccountIdentityLoader() {
  await connection();
  if (!isMultiUserEnabled() || isDemoMode()) return null;
  const accountId = await getCurrentAccountId();
  if (accountId === UNAUTHENTICATED_ACCOUNT_ID) {
    redirect("/login");
  }
  const summary = await getCurrentAccountSummary();
  if (!summary) return null;
  return <AccountIdentity username={summary.username} isOwner={summary.isOwner} />;
}
