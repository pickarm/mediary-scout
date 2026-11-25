import {
  EventDispatcher,
  type Client,
  type EventHandles,
  type RawCardActionEvent,
} from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createFeishuTransport,
  type FeishuClient,
} from "./feishu";
import type {
  InboundMessage,
  MessagingConnection,
  MessagingSink,
} from "./types";

type FeishuMessageCreate = Client["im"]["message"]["create"];
type FeishuMessageReply = Client["im"]["message"]["reply"];
type FeishuReceiveEvent = Parameters<
  NonNullable<EventHandles["im.message.receive_v1"]>
>[0];
type FeishuHandler<T> = (event: T) => Promise<unknown> | unknown;

interface FakeFeishuClient {
  api: FeishuClient;
  create: ReturnType<typeof vi.fn<FeishuMessageCreate>>;
  reply: ReturnType<typeof vi.fn<FeishuMessageReply>>;
}

type FeishuSocketStart = (params: {
  eventDispatcher: EventDispatcher;
}) => Promise<void>;
type FeishuSocketClose = (params?: { force?: boolean }) => void;

interface FakeFeishuSocket {
  api: {
    start: FeishuSocketStart;
    close: FeishuSocketClose;
  };
  start: ReturnType<typeof vi.fn<FeishuSocketStart>>;
  close: ReturnType<typeof vi.fn<FeishuSocketClose>>;
}

const CONNECTION: MessagingConnection = {
  id: "feishu-connection",
  accountId: "account",
  platform: "feishu",
  botId: "cli_0123456789abcdef",
  enabled: true,
  senderId: "ou_owner",
  defaultStorageId: null,
  credentials: {
    appId: "cli_0123456789abcdef",
    appSecret: "test-app-secret",
  },
};

function makeFakeClient(): FakeFeishuClient {
  const create = vi.fn<FeishuMessageCreate>(async () => ({ code: 0 }));
  const reply = vi.fn<FeishuMessageReply>(async () => ({ code: 0 }));
  return {
    api: { im: { message: { create, reply } } },
    create,
    reply,
  };
}

function makeFakeSocket(): FakeFeishuSocket {
  const start = vi.fn<FeishuSocketStart>(async () => undefined);
  const close = vi.fn<FeishuSocketClose>();
  return {
    api: { start, close },
    start,
    close,
  };
}

function makeSink(
  accepted: InboundMessage[],
  accept?: (
    messages: readonly InboundMessage[],
    cursor?: string,
  ) => Promise<void>,
): MessagingSink {
  return {
    loadCursor: vi.fn(async () => null),
    accept: vi.fn(async (messages, cursor) => {
      if (accept) {
        await accept(messages, cursor);
        return;
      }
      accepted.push(...messages);
    }),
  };
}

function registeredHandler<T>(
  dispatcher: EventDispatcher,
  eventName: string,
): FeishuHandler<T> {
  const handler = dispatcher.handles.get(eventName);
  if (!handler) {
    throw new Error(`Missing handler for ${eventName}`);
  }
  return handler as unknown as FeishuHandler<T>;
}

function receiveEvent(options: {
  eventId?: string;
  messageId?: string;
  openId?: string;
  chatType?: "p2p" | "group";
  text?: string;
} = {}): FeishuReceiveEvent {
  return {
    event_id: options.eventId ?? "event-unstable",
    sender: {
      sender_id: { open_id: options.openId ?? "ou_owner" },
      sender_type: "user",
    },
    message: {
      message_id: options.messageId ?? "om_owner_message",
      create_time: "1700000000000",
      chat_id: "oc_owner_private",
      chat_type: options.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: options.text ?? "查询任务" }),
    },
  };
}

interface CardActionOptions {
  eventId?: string;
  openId?: string;
  chatId?: string;
  messageId?: string;
  command?: string;
  valueChatId?: string;
}

function cardAction(options: CardActionOptions = {}): RawCardActionEvent {
  return {
    context: {
      open_message_id: options.messageId ?? "om_card_message",
      open_chat_id: options.chatId ?? "oc_owner_private",
    },
    operator: { open_id: options.openId ?? "ou_owner" },
    action: {
      tag: "button",
      value: {
        command: options.command ?? "msg:task-1:0",
        chatId: options.valueChatId ?? "oc_owner_private",
      },
    },
  };
}

function cardActionEvent(
  options: CardActionOptions = {},
): RawCardActionEvent & { event_id: string } {
  return {
    ...cardAction(options),
    event_id: options.eventId ?? "evt_card_click",
  };
}

describe("Feishu messaging transport", () => {
  it("normalizes stable owner private text events and ignores group or other-user messages", async () => {
    const fakeClient = makeFakeClient();
    const fakeSocket = makeFakeSocket();
    const accepted: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => fakeSocket.api,
    });

    const started = transport.start(
      CONNECTION,
      makeSink(accepted),
      controller.signal,
    );
    await vi.waitFor(() => expect(fakeSocket.start).toHaveBeenCalledOnce());
    const dispatcher = fakeSocket.start.mock.calls[0]?.[0].eventDispatcher;
    if (!dispatcher) {
      throw new Error("Feishu WS start did not receive an EventDispatcher");
    }
    const handler = registeredHandler<FeishuReceiveEvent>(
      dispatcher,
      "im.message.receive_v1",
    );

    await handler(receiveEvent());
    await handler(receiveEvent({ chatType: "group" }));
    await handler(receiveEvent({ openId: "ou_other" }));

    expect(accepted).toEqual([
      {
        connectionId: CONNECTION.id,
        platform: "feishu",
        botId: "cli_0123456789abcdef",
        messageId: "om_owner_message",
        conversationId: "oc_owner_private",
        senderId: "ou_owner",
        text: "查询任务",
        replyToken: "om_owner_message",
      },
    ]);

    controller.abort();
    await started;
  });

  it("waits for sink.accept before acknowledging the SDK handler", async () => {
    const fakeClient = makeFakeClient();
    const fakeSocket = makeFakeSocket();
    const controller = new AbortController();
    let releaseAccept: (() => void) | undefined;
    const acceptGate = new Promise<void>((resolve) => {
      releaseAccept = resolve;
    });
    const sink = makeSink([], async () => {
      await acceptGate;
    });
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => fakeSocket.api,
    });

    const started = transport.start(CONNECTION, sink, controller.signal);
    await vi.waitFor(() => expect(fakeSocket.start).toHaveBeenCalledOnce());
    const dispatcher = fakeSocket.start.mock.calls[0]?.[0].eventDispatcher;
    if (!dispatcher) {
      throw new Error("Feishu WS start did not receive an EventDispatcher");
    }
    const handler = registeredHandler<FeishuReceiveEvent>(
      dispatcher,
      "im.message.receive_v1",
    );

    let handling = false;
    const handled = Promise.resolve(handler(receiveEvent())).then(() => {
      handling = true;
    });
    await vi.waitFor(() => expect(sink.accept).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(handling).toBe(false);

    releaseAccept?.();
    await handled;
    expect(handling).toBe(true);

    controller.abort();
    await started;
  });

  it("normalizes card actions only for the owner and the card's private conversation", async () => {
    const fakeClient = makeFakeClient();
    const fakeSocket = makeFakeSocket();
    const accepted: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => fakeSocket.api,
    });

    const started = transport.start(
      CONNECTION,
      makeSink(accepted),
      controller.signal,
    );
    await vi.waitFor(() => expect(fakeSocket.start).toHaveBeenCalledOnce());
    const dispatcher = fakeSocket.start.mock.calls[0]?.[0].eventDispatcher;
    if (!dispatcher) {
      throw new Error("Feishu WS start did not receive an EventDispatcher");
    }
    const handler = registeredHandler<RawCardActionEvent>(
      dispatcher,
      "card.action.trigger",
    );

    await handler(cardActionEvent());
    await handler(cardActionEvent({ openId: "ou_other" }));
    await handler(cardActionEvent({ chatId: "oc_other_chat" }));

    expect(accepted).toEqual([
      {
        connectionId: CONNECTION.id,
        platform: "feishu",
        botId: "cli_0123456789abcdef",
        messageId: "evt_card_click",
        conversationId: "oc_owner_private",
        senderId: "ou_owner",
        text: "",
        callbackData: "msg:task-1:0",
        replyToken: "om_card_message",
      },
    ]);

    controller.abort();
    await started;
  });

  it("keeps distinct card button clicks under their native event UUIDs", async () => {
    const fakeClient = makeFakeClient();
    const fakeSocket = makeFakeSocket();
    const accepted: InboundMessage[] = [];
    const controller = new AbortController();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => fakeSocket.api,
    });

    const started = transport.start(
      CONNECTION,
      makeSink(accepted),
      controller.signal,
    );
    await vi.waitFor(() => expect(fakeSocket.start).toHaveBeenCalledOnce());
    const dispatcher = fakeSocket.start.mock.calls[0]?.[0].eventDispatcher;
    if (!dispatcher) {
      throw new Error("Feishu WS start did not receive an EventDispatcher");
    }

    const invokeCardAction = async (
      eventId: string,
      command: string,
    ): Promise<void> => {
      await dispatcher.invoke(
        {
          schema: "2.0",
          header: {
            event_id: eventId,
            event_type: "card.action.trigger",
            token: "verification-token",
            create_time: "1700000000000",
            tenant_key: "tenant",
            app_id: "cli_0123456789abcdef",
          },
          event: cardAction({
            messageId: "om_same_card",
            command,
          }),
        },
        { needCheck: false },
      );
    };

    await invokeCardAction("evt_click_0", "msg:job:0");
    await invokeCardAction("evt_click_1", "msg:job:1");
    await invokeCardAction("evt_click_0", "msg:job:0");

    expect(
      accepted.map(({ messageId, callbackData, replyToken }) => ({
        messageId,
        callbackData,
        replyToken,
      })),
    ).toEqual([
      {
        messageId: "evt_click_0",
        callbackData: "msg:job:0",
        replyToken: "om_same_card",
      },
      {
        messageId: "evt_click_1",
        callbackData: "msg:job:1",
        replyToken: "om_same_card",
      },
      {
        messageId: "evt_click_0",
        callbackData: "msg:job:0",
        replyToken: "om_same_card",
      },
    ]);

    controller.abort();
    await started;
  });

  it("replies with literal text through the official message reply API", async () => {
    const fakeClient = makeFakeClient();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => makeFakeSocket().api,
    });

    await transport.send(CONNECTION, {
      conversationId: "oc_owner_private",
      text: "*literal*",
      replyToken: "om_inbound",
    });

    expect(fakeClient.create).not.toHaveBeenCalled();
    expect(fakeClient.reply).toHaveBeenCalledOnce();
    expect(fakeClient.reply).toHaveBeenCalledWith({
      path: { message_id: "om_inbound" },
      data: {
        content: JSON.stringify({ text: "*literal*" }),
        msg_type: "text",
      },
    });
  });

  it("sends interactive choices with pass-through command values", async () => {
    const fakeClient = makeFakeClient();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => makeFakeSocket().api,
    });

    await transport.send(CONNECTION, {
      conversationId: "oc_owner_private",
      text: "请选择",
      choices: [
        { label: "第一个", value: "msg:task-1:0" },
        { label: "第二个", value: "msg:task-1:1" },
      ],
    });

    expect(fakeClient.reply).not.toHaveBeenCalled();
    expect(fakeClient.create).toHaveBeenCalledOnce();
    const payload = fakeClient.create.mock.calls[0]?.[0];
    if (!payload) {
      throw new Error("Feishu card send payload was missing");
    }
    expect(payload.params).toEqual({ receive_id_type: "chat_id" });
    expect(payload.data).toMatchObject({
      receive_id: "oc_owner_private",
      msg_type: "interactive",
    });
    expect(JSON.parse(payload.data.content)).toEqual({
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "div",
          text: { tag: "lark_md", content: "请选择" },
        },
        {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: "第一个" },
              type: "primary",
              value: {
                command: "msg:task-1:0",
                chatId: "oc_owner_private",
              },
            },
            {
              tag: "button",
              text: { tag: "plain_text", content: "第二个" },
              type: "default",
              value: {
                command: "msg:task-1:1",
                chatId: "oc_owner_private",
              },
            },
          ],
        },
      ],
    });
  });

  it("fails on a non-zero Feishu business code without retrying", async () => {
    const fakeClient = makeFakeClient();
    fakeClient.reply.mockResolvedValue({
      code: 999,
      msg: "no permission",
    });
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => makeFakeSocket().api,
    });

    await expect(
      transport.send(CONNECTION, {
        conversationId: "oc_owner_private",
        text: "回复",
        replyToken: "om_inbound",
      }),
    ).rejects.toThrow(/999.*no permission/);
    expect(fakeClient.reply).toHaveBeenCalledOnce();
  });

  it("closes the SDK connection when the supplied signal aborts", async () => {
    const fakeClient = makeFakeClient();
    const fakeSocket = makeFakeSocket();
    const controller = new AbortController();
    const transport = createFeishuTransport({
      clientFactory: () => fakeClient.api,
      wsFactory: () => fakeSocket.api,
    });

    const started = transport.start(
      CONNECTION,
      makeSink([]),
      controller.signal,
    );
    await vi.waitFor(() => expect(fakeSocket.start).toHaveBeenCalledOnce());
    controller.abort();

    await expect(started).resolves.toBeUndefined();
    expect(fakeSocket.close).toHaveBeenCalledOnce();
    expect(fakeSocket.close).toHaveBeenCalledWith({ force: true });
  });
});
