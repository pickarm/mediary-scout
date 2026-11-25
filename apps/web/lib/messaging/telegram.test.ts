import { describe, expect, it, vi } from "vitest";
import { Api, type ApiClientOptions } from "grammy";
import type { Chat, Message, Update, User } from "grammy/types";
import { createTelegramTransport } from "./telegram";
import type {
  InboundMessage,
  MessagingConnection,
  MessagingSink,
} from "./types";

type TelegramApi = Pick<
  Api,
  "getUpdates" | "sendMessage" | "answerCallbackQuery"
>;
type TelegramUpdateSignal = Parameters<TelegramApi["getUpdates"]>[1];
type GrammyFetch = NonNullable<ApiClientOptions["fetch"]>;
type GrammyFetchInput = Parameters<GrammyFetch>[0];
type GrammyFetchInit = Parameters<GrammyFetch>[1];
type GrammyFetchResponse = Awaited<ReturnType<GrammyFetch>>;
type NonChannelChat =
  | Chat.PrivateChat
  | Chat.GroupChat
  | Chat.SupergroupChat;

interface FakeTelegramApi {
  api: TelegramApi;
  getUpdates: ReturnType<typeof vi.fn<TelegramApi["getUpdates"]>>;
  sendMessage: ReturnType<typeof vi.fn<TelegramApi["sendMessage"]>>;
  answerCallbackQuery: ReturnType<
    typeof vi.fn<TelegramApi["answerCallbackQuery"]>
  >;
}

const OWNER_ID = 123;
const OWNER: User = {
  id: OWNER_ID,
  is_bot: false,
  first_name: "Owner",
};
const PRIVATE_CHAT: Chat.PrivateChat = {
  id: OWNER_ID,
  type: "private",
  first_name: "Owner",
};
const CONNECTION: MessagingConnection = {
  id: "telegram-connection",
  accountId: "account",
  platform: "telegram",
  botId: "bot",
  enabled: true,
  senderId: String(OWNER_ID),
  defaultStorageId: null,
  credentials: { token: "test-token" },
};

function makeFakeApi(): FakeTelegramApi {
  const getUpdates = vi.fn<TelegramApi["getUpdates"]>();
  const sendMessage = vi.fn<TelegramApi["sendMessage"]>();
  const answerCallbackQuery =
    vi.fn<TelegramApi["answerCallbackQuery"]>();

  return {
    api: { getUpdates, sendMessage, answerCallbackQuery },
    getUpdates,
    sendMessage,
    answerCallbackQuery,
  };
}

function makeSink(
  cursor: string | null,
  accepted: Array<{
    messages: readonly InboundMessage[];
    cursor?: string;
  }>,
  beforeAccept?: () => void,
): MessagingSink {
  return {
    loadCursor: vi.fn(async () => cursor),
    accept: vi.fn(async (messages, nextCursor) => {
      beforeAccept?.();
      accepted.push({ messages, cursor: nextCursor });
    }),
  };
}

function textMessage(
  text: string,
  from: User = OWNER,
  chat: NonChannelChat = PRIVATE_CHAT,
): Message.TextMessage & { chat: NonChannelChat; from: User } {
  return {
    message_id: 77,
    date: 1_700_000_000,
    chat,
    from,
    text,
  };
}

function messageUpdate(
  updateId: number,
  text: string,
  from: User = OWNER,
  chat: NonChannelChat = PRIVATE_CHAT,
): Update {
  return {
    update_id: updateId,
    message: textMessage(text, from, chat),
  };
}

function callbackUpdate(updateId: number, data: string): Update {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: OWNER,
      message: textMessage("Choose"),
      chat_instance: "chat-instance",
      data,
    },
  };
}

function fetchUrl(input: GrammyFetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function grammyJsonResponse(result: unknown): GrammyFetchResponse {
  return new Response(
    JSON.stringify({ ok: true, result }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  ) as unknown as GrammyFetchResponse;
}

describe("Telegram messaging transport", () => {
  it("loads the durable cursor and advances only to the confirmed next offset", async () => {
    const fake = makeFakeApi();
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const calls: Array<{
      offset: number | undefined;
      signal: TelegramUpdateSignal;
    }> = [];
    const controller = new AbortController();

    fake.getUpdates.mockImplementation(async (params, signal) => {
      calls.push({ offset: params?.offset, signal });
      if (calls.length === 1) {
        return [messageUpdate(40, "hello")];
      }
      controller.abort();
      return [];
    });

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });
    await transport.start(
      CONNECTION,
      makeSink("40", accepted),
      controller.signal,
    );

    expect(calls.map((call) => call.offset)).toEqual([40, 41]);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(
      true,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.cursor).toBe("41");
    expect(accepted[0]?.messages[0]).toMatchObject({
      connectionId: CONNECTION.id,
      platform: "telegram",
      botId: CONNECTION.botId,
      messageId: "40",
      conversationId: String(OWNER_ID),
      senderId: String(OWNER_ID),
      text: "hello",
    });
  });

  it("ignores stale, group, and other-user updates while advancing past the batch", async () => {
    const fake = makeFakeApi();
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const controller = new AbortController();
    const groupChat: Chat.GroupChat = {
      id: -100,
      type: "group",
      title: "Group",
    };
    const otherUser: User = {
      id: 999,
      is_bot: false,
      first_name: "Other",
    };

    fake.getUpdates.mockImplementation(async () => {
      if (accepted.length === 0) {
        return [
          messageUpdate(49, "stale"),
          messageUpdate(50, "already committed"),
          messageUpdate(51, "owner"),
          messageUpdate(52, "group", OWNER, groupChat),
          messageUpdate(53, "other", otherUser),
        ];
      }
      controller.abort();
      return [];
    });

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });
    await transport.start(
      CONNECTION,
      makeSink("51", accepted),
      controller.signal,
    );

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.cursor).toBe("54");
    expect(accepted[0]?.messages).toHaveLength(1);
    expect(accepted[0]?.messages[0]).toMatchObject({
      messageId: "51",
      text: "owner",
    });
  });

  it("normalizes callbacks and acknowledges them only after the batch commits", async () => {
    const fake = makeFakeApi();
    const events: string[] = [];
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const controller = new AbortController();
    let getUpdatesCalls = 0;

    fake.getUpdates.mockImplementation(async () => {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return [callbackUpdate(7, "choose:keep")];
      }
      controller.abort();
      return [];
    });
    fake.answerCallbackQuery.mockImplementation(async () => {
      events.push("ack");
      return true;
    });

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });
    await transport.start(
      CONNECTION,
      makeSink(null, accepted, () => events.push("accept")),
      controller.signal,
    );

    expect(events).toEqual(["accept", "ack"]);
    expect(accepted[0]?.cursor).toBe("8");
    expect(accepted[0]?.messages[0]).toMatchObject({
      messageId: "7",
      callbackData: "choose:keep",
    });
    expect(fake.answerCallbackQuery).toHaveBeenCalledWith(
      "callback-7",
      undefined,
      controller.signal,
    );
  });

  it("acknowledges a committed callback when abort lands during the commit", async () => {
    const fake = makeFakeApi();
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const controller = new AbortController();
    fake.getUpdates.mockResolvedValue([callbackUpdate(7, "choose:keep")]);
    fake.answerCallbackQuery.mockImplementation(
      async (_callbackId, _other, signal) => {
        if (signal?.aborted) {
          throw new Error("ack request received an aborted signal");
        }
        return true;
      },
    );

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });
    await transport.start(
      CONNECTION,
      makeSink(null, accepted, () => controller.abort()),
      controller.signal,
    );

    expect(accepted[0]?.cursor).toBe("8");
    expect(fake.answerCallbackQuery).toHaveBeenCalledWith(
      "callback-7",
      undefined,
      undefined,
    );
  });

  it("settles gracefully when the real grammY Api aborts an in-flight ACK", async () => {
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const controller = new AbortController();
    const requestUrls: string[] = [];
    const fetchImpl = vi.fn<GrammyFetch>(
      async (input: GrammyFetchInput, init: GrammyFetchInit) => {
        const url = fetchUrl(input);
        requestUrls.push(url);

        if (url.endsWith("/getUpdates")) {
          return grammyJsonResponse([
            callbackUpdate(7, "choose:keep"),
          ]);
        }
        if (url.endsWith("/answerCallbackQuery")) {
          const requestSignal = init?.signal as unknown as
            | AbortSignal
            | undefined;
          controller.abort();
          if (requestSignal?.aborted) {
            throw new DOMException(
              "The operation was aborted.",
              "AbortError",
            );
          }
          throw new Error("ACK fetch did not observe abort");
        }

        throw new Error("Unexpected Telegram request: " + url);
      },
    );
    const transport = createTelegramTransport({
      apiFactory: () =>
        new Api("test-token", { fetch: fetchImpl }),
    });

    await expect(
      transport.start(
        CONNECTION,
        makeSink(null, accepted),
        controller.signal,
      ),
    ).resolves.toBeUndefined();

    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.cursor).toBe("8");
    expect(accepted[0]?.messages[0]?.messageId).toBe("7");
    expect(
      requestUrls.map((url) => url.slice(url.lastIndexOf("/") + 1)),
    ).toEqual(["getUpdates", "answerCallbackQuery"]);
    expect(controller.signal.aborted).toBe(true);
  });

  it("propagates a real ACK failure after committing the callback", async () => {
    const fake = makeFakeApi();
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const ackError = new Error("Telegram rejected the ACK");
    fake.getUpdates.mockResolvedValue([
      callbackUpdate(7, "choose:keep"),
    ]);
    fake.answerCallbackQuery.mockRejectedValue(ackError);
    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });

    await expect(
      transport.start(
        CONNECTION,
        makeSink(null, accepted),
        new AbortController().signal,
      ),
    ).rejects.toBe(ackError);

    expect(accepted[0]?.cursor).toBe("8");
    expect(fake.answerCallbackQuery).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a callback when the sink rejects the batch", async () => {
    const fake = makeFakeApi();
    const commitError = new Error("database unavailable");
    const sink: MessagingSink = {
      loadCursor: async () => null,
      accept: async () => {
        throw commitError;
      },
    };
    fake.getUpdates.mockResolvedValue([callbackUpdate(7, "choose:keep")]);

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });

    await expect(
      transport.start(CONNECTION, sink, new AbortController().signal),
    ).rejects.toBe(commitError);
    expect(fake.answerCallbackQuery).not.toHaveBeenCalled();
    expect(fake.getUpdates).toHaveBeenCalledTimes(1);
  });

  it("propagates polling errors without accepting a batch", async () => {
    const fake = makeFakeApi();
    const pollingError = new Error("telegram unavailable");
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const sink = makeSink(null, accepted);
    fake.getUpdates.mockRejectedValue(pollingError);

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });

    await expect(
      transport.start(CONNECTION, sink, new AbortController().signal),
    ).rejects.toBe(pollingError);
    expect(accepted).toEqual([]);
  });

  it("aborts an in-flight request and exits without accepting the response", async () => {
    const fake = makeFakeApi();
    const accepted: Array<{
      messages: readonly InboundMessage[];
      cursor?: string;
    }> = [];
    const sink = makeSink(null, accepted);
    const controller = new AbortController();
    let requestedSignal: TelegramUpdateSignal;

    fake.getUpdates.mockImplementation((_params, signal) => {
      requestedSignal = signal;
      return new Promise<Update[]>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new Error("request aborted")),
          { once: true },
        );
      });
    });

    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });
    const started = transport.start(CONNECTION, sink, controller.signal);

    await vi.waitFor(() => expect(requestedSignal).toBe(controller.signal));
    controller.abort();

    await expect(started).resolves.toBeUndefined();
    expect(accepted).toEqual([]);
  });

  it("sends literal text with callback choices and never retries an unknown result", async () => {
    const fake = makeFakeApi();
    const factory = vi.fn(() => fake.api);
    fake.sendMessage.mockResolvedValue(textMessage("Reply"));
    const transport = createTelegramTransport({ apiFactory: factory });
    const reply = {
      conversationId: String(OWNER_ID),
      text: "*literal*",
      choices: [
        { label: "Keep", value: "choose:keep" },
        { label: "Drop", value: "choose:drop" },
      ],
    } as const;

    await transport.send(CONNECTION, reply);

    expect(factory).toHaveBeenCalledWith("test-token");
    expect(fake.sendMessage).toHaveBeenCalledWith(
      String(OWNER_ID),
      "*literal*",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Keep", callback_data: "choose:keep" }],
            [{ text: "Drop", callback_data: "choose:drop" }],
          ],
        },
      },
    );
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("propagates send failures without retrying", async () => {
    const fake = makeFakeApi();
    const sendError = new Error("unknown send result");
    fake.sendMessage.mockRejectedValue(sendError);
    const transport = createTelegramTransport({
      apiFactory: () => fake.api,
    });

    await expect(
      transport.send(CONNECTION, {
        conversationId: String(OWNER_ID),
        text: "Reply",
      }),
    ).rejects.toBe(sendError);
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
  });
});
