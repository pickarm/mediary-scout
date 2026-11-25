/*
 * Protocol behavior adapted from Tencent/openclaw-weixin at
 * 0ad1ae91347a938f52f1e4e2abd6dcda51e05f9e.
 *
 * Copyright (C) 2026 Tencent.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type {
  InboundMessage,
  MessageReply,
  MessagingConnection,
  MessagingSink,
  MessagingTransport,
} from "./types";

const LOGIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_RETRY_MS = 2_000;
const BASE_INFO = {
  channel_version: "3.0.1/xunying",
  bot_agent: "Xunying",
} as const;
const LOSSLESS_ID_FIELDS = new Set([
  "message_id",
  "msg_id",
  "svr_id",
  "ilink_bot_id",
  "ilink_user_id",
]);
const redirectBases = new Map<string, string>();

type FetchLike = typeof fetch;
type SleepLike = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface WeixinTransportDependencies {
  fetch?: FetchLike;
  sleep?: SleepLike;
}

export type WeixinLoginState =
  | "wait"
  | "scanned"
  | "confirmed"
  | "expired"
  | "verify_required"
  | "error";

export interface WeixinLoginResult {
  state: WeixinLoginState;
  botId?: string;
  userId?: string;
  token?: string;
  baseUrl?: string;
  message?: string;
}

export interface WeixinLoginPollInput {
  qrcode: string;
  pin?: string;
}

export class WeixinReloginRequiredError extends Error {
  readonly code = -14;

  constructor(message = "微信会话已失效，请重新扫码登录。") {
    super(message);
    this.name = "WeixinReloginRequiredError";
  }
}

export class WeixinApiError extends Error {
  readonly api: string;
  readonly ret: number | undefined;
  readonly errcode: number | undefined;
  readonly errmsg: string;

  constructor(
    api: string,
    ret: number | undefined,
    errcode: number | undefined,
    errmsg: string,
  ) {
    super(`${api} 失败：ret=${ret ?? "无"} errcode=${errcode ?? "无"} ${errmsg}`.trim());
    this.name = "WeixinApiError";
    this.api = api;
    this.ret = ret;
    this.errcode = errcode;
    this.errmsg = errmsg;
  }
}

class WeixinHttpError extends Error {
  readonly status: number;

  constructor(api: string, status: number, body: string) {
    super(`${api} 返回 HTTP ${status}：${body.slice(0, 500)}`);
    this.name = "WeixinHttpError";
    this.status = status;
  }
}

class WeixinProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeixinProtocolError";
  }
}

interface ResolvedWeixinConnection {
  token: string;
  baseUrl: string;
  userId: string;
  botId: string;
}

interface CursorBatch {
  messages: InboundMessage[];
  cursor: string | undefined;
}

export function createWeixinTransport(
  dependencies: WeixinTransportDependencies = {},
): MessagingTransport {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? delay;

  return {
    async start(connection, sink, signal) {
      const resolved = resolveConnection(connection);
      if (signal.aborted) return;

      let cursor = await sink.loadCursor(connection.id);
      if (signal.aborted) return;

      while (!signal.aborted) {
        let response: Record<string, unknown>;
        try {
          response = await requestJson(
            fetchImpl,
            `${resolved.baseUrl}/ilink/bot/getupdates`,
            {
              method: "POST",
              headers: authenticatedHeaders(resolved.token),
              body: JSON.stringify({
                get_updates_buf: cursor ?? "",
                base_info: BASE_INFO,
              }),
              signal,
            },
            "getupdates",
          );
        } catch (error) {
          if (signal.aborted) return;
          if (error instanceof WeixinProtocolError) throw error;
          await sleep(DEFAULT_LONG_POLL_RETRY_MS, signal);
          continue;
        }

        if (signal.aborted) return;
        assertSuccessfulResponse("getupdates", response, {
          retRequired: false,
          checkErrcode: true,
        });
        const batch = normalizeBatch(response, connection, resolved, cursor);
        if (signal.aborted) return;
        await sink.accept(batch.messages, batch.cursor);
        cursor = batch.cursor ?? cursor;
      }
    },

    async send(connection, reply) {
      const resolved = resolveConnection(connection);
      assertOwnerReply(reply, resolved.userId);
      if (!reply.replyToken) {
        throw new WeixinProtocolError("微信回复缺少 replyToken（context_token）。");
      }

      const text = formatReplyText(reply);
      if (!text) {
        throw new WeixinProtocolError("微信回复文本不能为空。");
      }

      const response = await requestJson(
        fetchImpl,
        `${resolved.baseUrl}/ilink/bot/sendmessage`,
        {
          method: "POST",
          headers: authenticatedHeaders(resolved.token),
          body: JSON.stringify({
            msg: {
              from_user_id: "",
              to_user_id: resolved.userId,
              client_id: createClientId(),
              message_type: 2,
              message_state: 2,
              context_token: reply.replyToken,
              item_list: [
                {
                  type: 1,
                  text_item: { text },
                },
              ],
            },
            base_info: BASE_INFO,
          }),
        },
        "sendmessage",
      );

      // HTTP 200 is only transport success. A Weixin send is successful only
      // when the business response explicitly says ret=0.
      assertSuccessfulResponse("sendmessage", response, {
        retRequired: true,
        checkErrcode: true,
      });
    },
  };
}

export async function beginWeixinLogin(
  dependencies: WeixinTransportDependencies = {},
): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const response = await requestJson(
    fetchImpl,
    `${LOGIN_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": encodedUin(),
      },
      body: JSON.stringify({ local_token_list: [] }),
    },
    "get_bot_qrcode",
  );
  const qrcode = requiredString(response, "qrcode", "get_bot_qrcode");
  const qrcodeUrl = requiredString(response, "qrcode_img_content", "get_bot_qrcode");
  return { qrcode, qrcodeUrl };
}

export async function pollWeixinLogin(
  input: WeixinLoginPollInput,
  dependencies: WeixinTransportDependencies = {},
): Promise<WeixinLoginResult> {
  if (!input.qrcode) {
    return { state: "error", message: "二维码值不能为空。" };
  }

  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const baseUrl = redirectBases.get(input.qrcode) ?? LOGIN_BASE_URL;
  const query = new URLSearchParams({ qrcode: input.qrcode });
  if (input.pin) query.set("verify_code", input.pin);

  let response: Record<string, unknown>;
  try {
    response = await requestJson(
      fetchImpl,
      `${baseUrl}/ilink/bot/get_qrcode_status?${query.toString()}`,
      {
        method: "GET",
        headers: {
          "iLink-App-Id": "bot",
          "iLink-App-ClientVersion": "50331648",
        },
      },
      "get_qrcode_status",
    );
  } catch (error) {
    return { state: "error", message: errorMessage(error) };
  }

  const status = optionalString(response, "status");
  if (!status) {
    return { state: "error", message: "二维码状态响应缺少 status。" };
  }

  if (status.includes("need_verifycode")) {
    return { state: "verify_required", message: "请在手机微信中输入配对数字。" };
  }

  switch (status) {
    case "wait":
      return { state: "wait" };
    case "scaned":
      return { state: "scanned" };
    case "confirmed": {
      const botId = optionalString(response, "ilink_bot_id");
      const userId = optionalString(response, "ilink_user_id");
      const token = optionalString(response, "bot_token");
      const confirmedBaseUrl = optionalString(response, "baseurl");
      if (!botId || !userId || !token || !confirmedBaseUrl) {
        redirectBases.delete(input.qrcode);
        return {
          state: "error",
          message: "登录已确认，但服务端未返回完整的凭证。",
        };
      }
      let baseUrl: string;
      try {
        baseUrl = normalizeBaseUrl(confirmedBaseUrl);
      } catch (error) {
        redirectBases.delete(input.qrcode);
        return { state: "error", message: errorMessage(error) };
      }
      redirectBases.delete(input.qrcode);
      return {
        state: "confirmed",
        botId,
        userId,
        token,
        baseUrl,
      };
    }
    case "expired":
      redirectBases.delete(input.qrcode);
      return { state: "expired", message: "二维码已过期，请重新获取。" };
    case "verify_code_blocked":
      redirectBases.delete(input.qrcode);
      return { state: "expired", message: "配对数字错误次数过多，请重新扫码。" };
    case "scaned_but_redirect": {
      const redirectHost = optionalString(response, "redirect_host");
      if (!redirectHost) {
        return { state: "error", message: "扫码重定向响应缺少 redirect_host。" };
      }
      try {
        redirectBases.set(input.qrcode, normalizeRedirectHost(redirectHost));
      } catch (error) {
        return { state: "error", message: errorMessage(error) };
      }
      return { state: "scanned" };
    }
    case "binded_redirect":
      redirectBases.delete(input.qrcode);
      return {
        state: "error",
        message: "该机器人已绑定，请从现有连接恢复凭证或重新开始连接。",
      };
    default:
      return { state: "error", message: `未知的二维码状态：${status}` };
  }
}

function resolveConnection(connection: MessagingConnection): ResolvedWeixinConnection {
  if (connection.platform !== "weixin") {
    throw new WeixinProtocolError(`连接 ${connection.id} 不是微信连接。`);
  }

  const token = requiredCredential(connection, "token");
  const userId = requiredCredential(connection, "userId");
  const baseUrl = normalizeBaseUrl(requiredCredential(connection, "baseUrl"));
  if (!connection.botId) {
    throw new WeixinProtocolError(`连接 ${connection.id} 缺少 botId。`);
  }
  return { token, userId, baseUrl, botId: connection.botId };
}

function requiredCredential(connection: MessagingConnection, key: string): string {
  const value = connection.credentials[key];
  if (!value) {
    throw new WeixinProtocolError(`微信连接 ${connection.id} 缺少凭证 ${key}。`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeixinProtocolError("微信 baseUrl 不是有效 URL。");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WeixinProtocolError("微信 baseUrl 必须使用 HTTP(S)。");
  }
  return value.replace(/\/+$/, "");
}

function normalizeRedirectHost(redirectHost: string): string {
  const candidate = new URL(`https://${redirectHost}`);
  if (
    candidate.username ||
    candidate.password ||
    candidate.pathname !== "/" ||
    candidate.search ||
    candidate.hash
  ) {
    throw new WeixinProtocolError("微信扫码重定向地址不合法。");
  }
  return candidate.origin;
}

function authenticatedHeaders(token: string): HeadersInit {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": encodedUin(),
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "50331648",
  };
}

function assertOwnerReply(reply: MessageReply, ownerUserId: string): void {
  if (reply.conversationId !== ownerUserId) {
    throw new WeixinProtocolError("微信仅允许回复 owner 私聊。");
  }
}

function formatReplyText(reply: MessageReply): string {
  const lines: string[] = [];
  if (reply.text) lines.push(reply.text);
  for (const [index, choice] of (reply.choices ?? []).entries()) {
    if (!textHasNumberedChoice(reply.text, index, choice.label)) {
      lines.push(`${index + 1}. ${choice.label}`);
    }
  }
  return lines.join("\n");
}

function textHasNumberedChoice(text: string, index: number, label: string): boolean {
  const marker = `${index + 1}. ${label}`;
  return text.split(/\r?\n/u).some((line) => {
    const trimmed = line.trimStart();
    return trimmed === marker || trimmed.startsWith(`${marker} · `);
  });
}

function normalizeBatch(
  response: Record<string, unknown>,
  connection: MessagingConnection,
  resolved: ResolvedWeixinConnection,
  previousCursor: string | null,
): CursorBatch {
  const rawMessages = response.msgs;
  const messages = Array.isArray(rawMessages)
    ? rawMessages.flatMap((raw): InboundMessage[] => {
        const message = normalizeInbound(raw, connection, resolved);
        return message ? [message] : [];
      })
    : [];
  const nextCursor = optionalString(response, "get_updates_buf");
  return {
    messages,
    cursor: nextCursor || previousCursor || undefined,
  };
}

function normalizeInbound(
  value: unknown,
  connection: MessagingConnection,
  resolved: ResolvedWeixinConnection,
): InboundMessage | undefined {
  const message = asRecord(value);
  if (!message) return undefined;

  const messageId = optionalString(message, "message_id");
  const senderId = optionalString(message, "from_user_id");
  const groupId = optionalString(message, "group_id");
  if (
    !messageId ||
    !senderId ||
    senderId !== resolved.userId ||
    Boolean(groupId) ||
    message.message_type !== 1
  ) {
    return undefined;
  }

  const text = textFromItems(message.item_list);
  if (!text) return undefined;

  const replyToken = optionalString(message, "context_token");
  return {
    connectionId: connection.id,
    platform: "weixin",
    botId: resolved.botId,
    messageId,
    conversationId: resolved.userId,
    senderId,
    text,
    ...(replyToken ? { replyToken } : {}),
  };
}

function textFromItems(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((raw): string[] => {
      const item = asRecord(raw);
      if (!item || item.type !== 1) return [];
      const textItem = asRecord(item.text_item);
      const text = textItem ? optionalString(textItem, "text") : undefined;
      return text ? [text] : [];
    })
    .join("\n");
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  api: string,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new WeixinHttpError(api, response.status, body);
  }

  let parsed: unknown;
  try {
    parsed = parseWeixinJson(body);
  } catch {
    throw new WeixinProtocolError(`${api} 返回的响应不是 JSON。`);
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new WeixinProtocolError(`${api} 返回的响应不是 JSON 对象。`);
  }
  return record;
}

function parseWeixinJson(rawText: string): unknown {
  let output = "";
  let index = 0;
  while (index < rawText.length) {
    if (rawText[index] !== '"') {
      output += rawText[index++];
      continue;
    }

    const stringStart = index;
    index++;
    let escaped = false;
    while (index < rawText.length) {
      const char = rawText[index++];
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        break;
      }
    }
    const stringToken = rawText.slice(stringStart, index);
    output += stringToken;

    let cursor = index;
    while (/\s/u.test(rawText[cursor] ?? "")) cursor++;
    if (rawText[cursor] !== ":") continue;

    let key: unknown;
    try {
      key = JSON.parse(stringToken);
    } catch {
      continue;
    }
    if (typeof key !== "string" || !LOSSLESS_ID_FIELDS.has(key)) continue;

    output += rawText.slice(index, cursor + 1);
    cursor++;
    while (/\s/u.test(rawText[cursor] ?? "")) {
      output += rawText[cursor++];
    }
    const numberStart = cursor;
    if (rawText[cursor] === "-") cursor++;
    while (/\d/u.test(rawText[cursor] ?? "")) cursor++;
    if (cursor > numberStart && !(cursor === numberStart + 1 && rawText[numberStart] === "-")) {
      output += `"${rawText.slice(numberStart, cursor)}"`;
      index = cursor;
    } else {
      index = numberStart;
    }
  }
  return JSON.parse(output) as unknown;
}

function assertSuccessfulResponse(
  api: string,
  response: Record<string, unknown>,
  checks: { retRequired: boolean; checkErrcode: boolean },
): void {
  const ret = optionalNumber(response, "ret", api);
  const errcode = checks.checkErrcode
    ? optionalNumber(response, "errcode", api)
    : undefined;
  if (checks.retRequired && ret === undefined) {
    throw new WeixinProtocolError(`${api} 的 HTTP 200 响应缺少业务 ret。`);
  }
  if (ret === undefined && errcode === undefined) {
    throw new WeixinProtocolError(`${api} 的 HTTP 200 响应缺少业务返回码。`);
  }
  if (ret !== undefined && ret !== 0) {
    if (ret === -14 || errcode === -14) {
      throw new WeixinReloginRequiredError();
    }
    throw new WeixinApiError(api, ret, errcode, optionalString(response, "errmsg") ?? "");
  }
  if (errcode !== undefined && errcode !== 0) {
    if (errcode === -14) throw new WeixinReloginRequiredError();
    throw new WeixinApiError(api, ret, errcode, optionalString(response, "errmsg") ?? "");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  api: string,
): string {
  const value = optionalString(record, key);
  if (!value) throw new WeixinProtocolError(`${api} 响应缺少 ${key}。`);
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
  api: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WeixinProtocolError(`${api} 响应字段 ${key} 不是有效数字。`);
  }
  return value;
}

function createClientId(): string {
  return globalThis.crypto.randomUUID();
}

function encodedUin(): string {
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  const value =
    ((bytes[0] ?? 0) * 0x1000000 +
      (bytes[1] ?? 0) * 0x10000 +
      (bytes[2] ?? 0) * 0x100 +
      (bytes[3] ?? 0)) >>>
    0;
  return btoa(String(value));
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
