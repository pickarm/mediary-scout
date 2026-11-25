import { describe, expect, it, vi } from "vitest";

import type {
  InboundMessage,
  MessagingConnection,
  MessagingSink,
} from "./types";
import {
  WeixinApiError,
  WeixinReloginRequiredError,
  beginWeixinLogin,
  createWeixinTransport,
  pollWeixinLogin,
} from "./weixin";

const connection: MessagingConnection = {
  id: "connection-weixin",
  accountId: "owner-account",
  platform: "weixin",
  botId: "18446744073709551614",
  enabled: true,
  senderId: "owner-user",
  defaultStorageId: null,
  credentials: {
    token: "bot-token",
    baseUrl: "https://weixin.example/api/",
    userId: "owner-user",
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function rawJsonResponse(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("weixin transport", () => {
  it("loads the persisted cursor, commits one owner-only private batch, then moves on", async () => {
    const controller = new AbortController();
    const accepted: InboundMessage[][] = [];
    const cursors: Array<string | undefined> = [];
    const sink: MessagingSink = {
      loadCursor: vi.fn(async () => "cursor-before"),
      accept: vi.fn(async (messages, cursor) => {
        accepted.push([...messages]);
        cursors.push(cursor);
        controller.abort();
      }),
    };
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.body).toBeTypeOf("string");
      expect(JSON.parse(init?.body as string)).toMatchObject({
        get_updates_buf: "cursor-before",
      });
      return jsonResponse({
        ret: 0,
        get_updates_buf: "cursor-after",
        msgs: [
          {
            message_id: "18446744073709551615",
            from_user_id: "owner-user",
            message_type: 1,
            context_token: "reply-context",
            item_list: [{ type: 1, text_item: { text: "开始" } }],
          },
          {
            message_id: "group-owner",
            from_user_id: "owner-user",
            group_id: "group-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "群聊" } }],
          },
          {
            message_id: "other-private",
            from_user_id: "other-user",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "他人" } }],
          },
          {
            message_id: "bot-message",
            from_user_id: "owner-user",
            message_type: 2,
            item_list: [{ type: 1, text_item: { text: "机器人" } }],
          },
          {
            from_user_id: "owner-user",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "无消息 ID" } }],
          },
        ],
      });
    });

    const transport = createWeixinTransport({ fetch: fetchImpl });
    await expect(transport.start(connection, sink, controller.signal)).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(accepted).toEqual([
      [
        {
          connectionId: "connection-weixin",
          platform: "weixin",
          botId: "18446744073709551614",
          messageId: "18446744073709551615",
          conversationId: "owner-user",
          senderId: "owner-user",
          text: "开始",
          replyToken: "reply-context",
        },
      ],
    ]);
    expect(cursors).toEqual(["cursor-after"]);
  });

  it("preserves an unquoted uint64 message_id before batching", async () => {
    const controller = new AbortController();
    const accepted: InboundMessage[][] = [];
    const sink: MessagingSink = {
      loadCursor: vi.fn(async () => null),
      accept: vi.fn(async (messages) => {
        accepted.push([...messages]);
        controller.abort();
      }),
    };
    const fetchImpl = vi.fn(async () =>
      rawJsonResponse(
        '{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"from_user_id":"owner-user","message_type":1,"context_token":"reply-context","item_list":[{"type":1,"text_item":{"text":"开始"}}]}]}',
      ),
    );

    await createWeixinTransport({ fetch: fetchImpl }).start(
      connection,
      sink,
      controller.signal,
    );

    expect(accepted).toEqual([
      [
        expect.objectContaining({
          messageId: "18446744073709551615",
          text: "开始",
        }),
      ],
    ]);
  });

  it("stops on getupdates -14 so the connection must be scanned again", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: -14, errmsg: "session expired" }));
    const sink: MessagingSink = {
      loadCursor: vi.fn(async () => null),
      accept: vi.fn(async () => undefined),
    };

    const transport = createWeixinTransport({ fetch: fetchImpl });
    await expect(
      transport.start(connection, sink, new AbortController().signal),
    ).rejects.toBeInstanceOf(WeixinReloginRequiredError);
    expect(sink.accept).not.toHaveBeenCalled();
  });

  it("does not commit when abort occurs while the response body is read", async () => {
    const controller = new AbortController();
    const sink: MessagingSink = {
      loadCursor: vi.fn(async () => null),
      accept: vi.fn(async () => undefined),
    };
    const fetchImpl = vi.fn(async () => {
      const response = jsonResponse({
        ret: 0,
        get_updates_buf: "after-abort",
        msgs: [
          {
            message_id: "owner-message",
            from_user_id: "owner-user",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "不应提交" } }],
          },
        ],
      });
      const originalText = response.text.bind(response);
      vi.spyOn(response, "text").mockImplementation(async () => {
        const body = await originalText();
        controller.abort();
        return body;
      });
      return response;
    });

    await expect(
      createWeixinTransport({ fetch: fetchImpl }).start(
        connection,
        sink,
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(sink.accept).not.toHaveBeenCalled();
  });

  it("ends an in-flight long poll when aborted", async () => {
    const controller = new AbortController();
    let markFetchStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchImpl = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener("abort", abort, { once: true });
          markFetchStarted?.();
        }),
    );
    const sink: MessagingSink = {
      loadCursor: vi.fn(async () => null),
      accept: vi.fn(async () => undefined),
    };

    const running = createWeixinTransport({ fetch: fetchImpl }).start(
      connection,
      sink,
      controller.signal,
    );
    await fetchStarted;
    controller.abort();

    await expect(running).resolves.toBeUndefined();
    expect(sink.accept).not.toHaveBeenCalled();
  });

  it("sends owner-only text with reply context and numbered choices", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bot-token");
      expect(JSON.parse(init?.body as string)).toMatchObject({
        msg: {
          to_user_id: "owner-user",
          context_token: "reply-context",
          message_type: 2,
          message_state: 2,
          item_list: [
            {
              type: 1,
              text_item: { text: "请选择\n1. 第一项\n2. 第二项" },
            },
          ],
        },
      });
      return jsonResponse({ ret: 0, errmsg: "" });
    });

    await createWeixinTransport({ fetch: fetchImpl }).send(connection, {
      conversationId: "owner-user",
      text: "请选择",
      replyToken: "reply-context",
      choices: [
        { label: "第一项", value: "one" },
        { label: "第二项", value: "two" },
      ],
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://weixin.example/api/ilink/bot/sendmessage",
    );
  });

  it("treats HTTP 200 with a non-zero send ret as failure and does not retry", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ret: 40001, errmsg: "rejected" }),
    );

    await expect(
      createWeixinTransport({ fetch: fetchImpl }).send(connection, {
        conversationId: "owner-user",
        text: "你好",
        replyToken: "reply-context",
      }),
    ).rejects.toBeInstanceOf(WeixinApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("checks send errcode even when ret is zero", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ret: 0, errcode: -14, errmsg: "session expired" }),
    );

    await expect(
      createWeixinTransport({ fetch: fetchImpl }).send(connection, {
        conversationId: "owner-user",
        text: "你好",
        replyToken: "reply-context",
      }),
    ).rejects.toBeInstanceOf(WeixinReloginRequiredError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not repeat numbered choices already rendered in the shared menu", async () => {
    const sharedMenu = "请选择\n1. 第一项\n2. 第二项\n\n回复序号，或点击按钮。";
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string) as {
        msg: { item_list: Array<{ text_item: { text: string } }> };
      };
      expect(request.msg.item_list[0]?.text_item.text).toBe(sharedMenu);
      return jsonResponse({ ret: 0 });
    });

    await createWeixinTransport({ fetch: fetchImpl }).send(connection, {
      conversationId: "owner-user",
      text: sharedMenu,
      replyToken: "reply-context",
      choices: [
        { label: "第一项", value: "one" },
        { label: "第二项", value: "two" },
      ],
    });
  });

  it("refuses to send outside the configured owner private chat", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ret: 0 }));

    await expect(
      createWeixinTransport({ fetch: fetchImpl }).send(connection, {
        conversationId: "another-user",
        text: "你好",
        replyToken: "reply-context",
      }),
    ).rejects.toThrow("仅允许回复 owner 私聊");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("weixin QR login", () => {
  it("starts the official QR login and maps PIN and redirect states", async () => {
    const qrcode = "qr-minimal-flow";
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("get_bot_qrcode")) {
        expect(JSON.parse(init?.body as string)).toEqual({ local_token_list: [] });
        return jsonResponse({
          qrcode,
          qrcode_img_content: "https://weixin.example/qr.png",
        });
      }
      if (url.includes("verify_code=2468")) {
        return jsonResponse({
          status: "confirmed",
          bot_token: "confirmed-token",
          ilink_bot_id: "18446744073709551613",
          baseurl: "https://redirect.example/api",
          ilink_user_id: "18446744073709551612",
        });
      }
      if (url.includes("redirect.example")) {
        return jsonResponse({
          status: "confirmed",
          bot_token: "redirect-token",
          ilink_bot_id: "bot-after-redirect",
          baseurl: "https://redirect.example/api",
          ilink_user_id: "owner-after-redirect",
        });
      }
      if (url.includes("first-poll")) {
        return jsonResponse({ status: "scaned_but_redirect", redirect_host: "redirect.example" });
      }
      return jsonResponse({ status: "need_verifycode" });
    });
    const deps = { fetch: fetchImpl };

    await expect(beginWeixinLogin(deps)).resolves.toEqual({
      qrcode: "qr-minimal-flow",
      qrcodeUrl: "https://weixin.example/qr.png",
    });
    await expect(pollWeixinLogin({ qrcode: "first-poll" }, deps)).resolves.toMatchObject({
      state: "scanned",
    });
    await expect(
      pollWeixinLogin({ qrcode: "first-poll" }, deps),
    ).resolves.toMatchObject({
      state: "confirmed",
      botId: "bot-after-redirect",
      userId: "owner-after-redirect",
      token: "redirect-token",
      baseUrl: "https://redirect.example/api",
    });
    await expect(
      pollWeixinLogin({ qrcode, pin: "2468" }, deps),
    ).resolves.toEqual({
      state: "confirmed",
      botId: "18446744073709551613",
      userId: "18446744073709551612",
      token: "confirmed-token",
      baseUrl: "https://redirect.example/api",
    });

    expect(calls[0]?.url).toBe(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
    );
    expect(calls[1]?.url).toContain(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=first-poll",
    );
    expect(calls[2]?.url).toContain(
      "https://redirect.example/ilink/bot/get_qrcode_status?qrcode=first-poll",
    );
    expect(calls[3]?.url).toContain("verify_code=2468");
  });

  it("preserves unquoted uint64 login IDs from the raw response", async () => {
    const fetchImpl = vi.fn(async () =>
      rawJsonResponse(
        '{"status":"confirmed","bot_token":"token","ilink_bot_id":18446744073709551613,"baseurl":"https://login.example/api","ilink_user_id":18446744073709551612}',
      ),
    );

    await expect(
      pollWeixinLogin({ qrcode: "raw-id-login" }, { fetch: fetchImpl }),
    ).resolves.toEqual({
      state: "confirmed",
      botId: "18446744073709551613",
      userId: "18446744073709551612",
      token: "token",
      baseUrl: "https://login.example/api",
    });
  });

  it("returns error when a confirmed login has an invalid base URL", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        status: "confirmed",
        bot_token: "token",
        ilink_bot_id: "bot-id",
        baseurl: "not a url",
        ilink_user_id: "owner-id",
      }),
    );

    await expect(
      pollWeixinLogin({ qrcode: "invalid-base-url" }, { fetch: fetchImpl }),
    ).resolves.toMatchObject({
      state: "error",
      message: expect.stringContaining("baseUrl"),
    });
  });

  it("maps verify-required, expired, and malformed responses explicitly", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "confirmed_but_need_verifycode" }))
      .mockResolvedValueOnce(jsonResponse({ status: "expired" }))
      .mockResolvedValueOnce(jsonResponse({ status: "unexpected" }));
    const deps = { fetch: fetchImpl };

    await expect(pollWeixinLogin({ qrcode: "pin-state" }, deps)).resolves.toMatchObject({
      state: "verify_required",
    });
    await expect(pollWeixinLogin({ qrcode: "expired-state" }, deps)).resolves.toMatchObject({
      state: "expired",
    });
    await expect(pollWeixinLogin({ qrcode: "bad-state" }, deps)).resolves.toMatchObject({
      state: "error",
    });
  });
});
