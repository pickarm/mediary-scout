"use server";

import QRCode from "qrcode";
import { getLibraryPool } from "../library-runtime";
import { getWorkflowRepository, requireAuthenticatedAccountId } from "../workflow-runtime";
import { assertNotDemo } from "../demo-mode";
import { messagingConnectionViews, readMessagingConnections, saveMessagingConnectionWithLock, type MessagingConnectionInput, type MessagingConnectionView } from "./config";
import type { MessagingPlatform } from "./types";
import { beginWeixinLogin, pollWeixinLogin, type WeixinLoginState } from "./weixin";

type ConnectionActionResult = { success: boolean; message?: string; connection?: MessagingConnectionView };
const LOGIN_KEY = "messaging_weixin_login";

export async function saveMessagingConnectionAction(input: MessagingConnectionInput): Promise<ConnectionActionResult> {
  try {
    assertNotDemo();
    const accountId = await requireAuthenticatedAccountId();
    const saved = await saveMessagingConnectionWithLock(accountId, input, getWorkflowRepository(), getLibraryPool());
    return { success: true, connection: messagingConnectionViews([saved])[0]! };
  } catch (error) { return { success: false, message: error instanceof Error ? error.message : "保存失败" }; }
}

export async function unlinkMessagingConnectionAction(platform: MessagingPlatform): Promise<ConnectionActionResult> {
  return saveMessagingConnectionAction({ platform, enabled: false, senderId: "", defaultStorageId: null, credentials: {}, unlink: true });
}

export async function beginWeixinLoginAction(): Promise<{ success: boolean; qrcode?: string; qrcodeUrl?: string; message?: string }> {
  try {
    assertNotDemo();
    const accountId = await requireAuthenticatedAccountId();
    const login = await beginWeixinLogin();
    await getWorkflowRepository().setAccountSetting(accountId, LOGIN_KEY, login.qrcode);
    return { success: true, qrcode: login.qrcode, qrcodeUrl: await QRCode.toDataURL(login.qrcodeUrl) };
  } catch (error) { return { success: false, message: error instanceof Error ? error.message : "获取二维码失败" }; }
}

export async function pollWeixinLoginAction(input: { qrcode: string; pin?: string }): Promise<{ success: boolean; state?: WeixinLoginState; connection?: MessagingConnectionView; message?: string }> {
  try {
    assertNotDemo();
    const accountId = await requireAuthenticatedAccountId();
    const repository = getWorkflowRepository();
    if ((await repository.getAccountSetting(accountId, LOGIN_KEY)) !== input.qrcode) return { success: false, message: "二维码已失效，请重新扫码" };
    const result = await pollWeixinLogin(input);
    if (result.state === "confirmed" && result.token && result.userId && result.botId && result.baseUrl) {
      const previous = (await readMessagingConnections(accountId, repository)).find((c) => c.platform === "weixin");
      const saved = await saveMessagingConnectionWithLock(accountId, {
        platform: "weixin", enabled: previous?.enabled ?? false, senderId: result.userId, botId: result.botId,
        defaultStorageId: previous?.defaultStorageId ?? null,
        credentials: { token: result.token, baseUrl: result.baseUrl, userId: result.userId },
      }, repository, getLibraryPool(), { pendingWeixinQr: input.qrcode });
      return { success: true, state: result.state, connection: messagingConnectionViews([saved])[0]! };
    }
    return { success: result.state !== "error", state: result.state, ...(result.message ? { message: result.message } : {}) };
  } catch (error) { return { success: false, message: error instanceof Error ? error.message : "扫码状态查询失败" }; }
}
