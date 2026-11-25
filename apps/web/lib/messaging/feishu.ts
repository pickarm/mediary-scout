import {
  Client,
  EventDispatcher,
  WSClient,
  type EventHandles,
  type InteractiveCard,
  type RawCardActionEvent,
} from "@larksuiteoapi/node-sdk";
import type {
  InboundMessage,
  MessageReply,
  MessagingConnection,
  MessagingSink,
  MessagingTransport,
} from "./types";

type FeishuMessageCreate = Client["im"]["message"]["create"];
type FeishuMessageReply = Client["im"]["message"]["reply"];
type FeishuReceiveEvent = Parameters<
  NonNullable<EventHandles["im.message.receive_v1"]>
>[0];
type FeishuCardActionEvent = RawCardActionEvent & { event_id?: string };

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuClient {
  im: {
    message: {
      create: FeishuMessageCreate;
      reply: FeishuMessageReply;
    };
  };
}

export interface FeishuWebSocket {
  start(params: { eventDispatcher: EventDispatcher }): Promise<void>;
  close(params?: { force?: boolean }): void;
}

export interface FeishuTransportDeps {
  clientFactory?: (credentials: FeishuCredentials) => FeishuClient;
  wsFactory?: (credentials: FeishuCredentials) => FeishuWebSocket;
}

interface FeishuCallbackHandles {
  "im.message.receive_v1": (event: FeishuReceiveEvent) => Promise<void>;
  "card.action.trigger": (event: FeishuCardActionEvent) => Promise<void>;
}

interface CachedClient {
  appId: string;
  appSecret: string;
  client: FeishuClient;
}

export class FeishuApiError extends Error {
  readonly api: string;
  readonly code: number;
  readonly businessMessage: string;

  constructor(api: string, code: number, businessMessage: string) {
    super(`${api} failed: code=${code} ${businessMessage}`.trim());
    this.name = "FeishuApiError";
    this.api = api;
    this.code = code;
    this.businessMessage = businessMessage;
  }
}

function createDefaultClient(credentials: FeishuCredentials): FeishuClient {
  return new Client(credentials);
}

function createDefaultSocket(credentials: FeishuCredentials): FeishuWebSocket {
  return new WSClient(credentials);
}

function resolveCredentials(connection: MessagingConnection): FeishuCredentials {
  if (connection.platform !== "feishu") {
    throw new Error(`Connection ${connection.id} is not a Feishu connection`);
  }

  const appId = connection.credentials.appId?.trim();
  const appSecret = connection.credentials.appSecret?.trim();
  if (!appId) {
    throw new Error(`Feishu connection ${connection.id} is missing appId`);
  }
  if (!appSecret) {
    throw new Error(`Feishu connection ${connection.id} is missing appSecret`);
  }
  return { appId, appSecret };
}

function findOwnerId(
  ids: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  },
  configuredSenderId: string,
): string | null {
  const ownerId = configuredSenderId.trim();
  return (
    [ids.open_id, ids.user_id, ids.union_id].find(
      (candidate): candidate is string =>
        candidate !== undefined && candidate === ownerId,
    ) ?? null
  );
}

function parseTextContent(content: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const text = Reflect.get(parsed, "text");
  return typeof text === "string" ? text : null;
}

function normalizeReceive(
  connection: MessagingConnection,
  event: FeishuReceiveEvent,
  appId: string,
): InboundMessage | null {
  if (
    event.message.chat_type !== "p2p" ||
    (event.sender.sender_type !== undefined &&
      event.sender.sender_type !== "user")
  ) {
    return null;
  }

  const senderId = event.sender.sender_id
    ? findOwnerId(event.sender.sender_id, connection.senderId)
    : null;
  if (!senderId || event.message.message_type !== "text") {
    return null;
  }

  const text = parseTextContent(event.message.content);
  if (text === null) {
    return null;
  }

  return {
    connectionId: connection.id,
    platform: "feishu",
    botId: appId,
    messageId: event.message.message_id,
    conversationId: event.message.chat_id,
    senderId,
    text,
    replyToken: event.message.message_id,
  };
}

function cardValue(value: unknown): { command: string; chatId: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const command = Reflect.get(value, "command");
  const chatId = Reflect.get(value, "chatId");
  return typeof command === "string" && typeof chatId === "string"
    ? { command, chatId }
    : null;
}

function normalizeCardAction(
  connection: MessagingConnection,
  event: FeishuCardActionEvent,
  appId: string,
): InboundMessage | null {
  const senderId = event.operator
    ? findOwnerId(event.operator, connection.senderId)
    : null;
  const eventId = event.event_id?.trim();
  const cardMessageId =
    event.context?.open_message_id ?? event.open_message_id;
  const conversationId = event.context?.open_chat_id ?? event.open_chat_id;
  const value = cardValue(event.action?.value);
  if (
    !senderId ||
    !eventId ||
    !cardMessageId ||
    !conversationId ||
    !value ||
    value.chatId !== conversationId
  ) {
    return null;
  }

  return {
    connectionId: connection.id,
    platform: "feishu",
    botId: appId,
    messageId: eventId,
    conversationId,
    senderId,
    text: "",
    callbackData: value.command,
    replyToken: cardMessageId,
  };
}

function interactiveCard(reply: MessageReply): InteractiveCard {
  const choices = reply.choices ?? [];
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: reply.text },
      },
      {
        tag: "action",
        actions: choices.map((choice, index) => ({
          tag: "button",
          text: { tag: "plain_text", content: choice.label },
          type: index === 0 ? "primary" : "default",
          value: {
            command: choice.value,
            chatId: reply.conversationId,
          },
        })),
      },
    ],
  };
}

function messagePayload(reply: MessageReply): {
  content: string;
  msg_type: "text" | "interactive";
} {
  if ((reply.choices ?? []).length === 0) {
    return {
      msg_type: "text",
      content: JSON.stringify({ text: reply.text }),
    };
  }
  return {
    msg_type: "interactive",
    content: JSON.stringify(interactiveCard(reply)),
  };
}

function assertSuccessfulResponse(
  api: string,
  response: { code?: number | undefined; msg?: string | undefined },
): void {
  if (response.code !== undefined && response.code !== 0) {
    throw new FeishuApiError(api, response.code, response.msg ?? "");
  }
}

export function createFeishuTransport(
  deps: FeishuTransportDeps = {},
): MessagingTransport {
  const clientFactory = deps.clientFactory ?? createDefaultClient;
  const wsFactory = deps.wsFactory ?? createDefaultSocket;
  const clients = new Map<string, CachedClient>();

  function clientFor(
    connection: MessagingConnection,
    credentials: FeishuCredentials,
  ): FeishuClient {
    const cached = clients.get(connection.id);
    if (
      cached?.appId === credentials.appId &&
      cached.appSecret === credentials.appSecret
    ) {
      return cached.client;
    }
    const client = clientFactory(credentials);
    clients.set(connection.id, { ...credentials, client });
    return client;
  }

  return {
    async start(
      connection: MessagingConnection,
      sink: MessagingSink,
      signal: AbortSignal,
    ): Promise<void> {
      if (signal.aborted) {
        return;
      }

      const credentials = resolveCredentials(connection);
      clientFor(connection, credentials);
      const dispatcher = new EventDispatcher({}).register<FeishuCallbackHandles>({
        "im.message.receive_v1": async (event) => {
          const message = normalizeReceive(
            connection,
            event,
            credentials.appId,
          );
          if (message) {
            await sink.accept([message]);
          }
        },
        "card.action.trigger": async (event) => {
          const message = normalizeCardAction(
            connection,
            event,
            credentials.appId,
          );
          if (message) {
            await sink.accept([message]);
          }
        },
      });
      const socket = wsFactory(credentials);
      let closed = false;
      let resolveAborted: (() => void) | undefined;
      const aborted = new Promise<void>((resolve) => {
        resolveAborted = resolve;
      });
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        socket.close({ force: true });
        resolveAborted?.();
      };

      signal.addEventListener("abort", close, { once: true });
      try {
        await Promise.race([
          socket.start({ eventDispatcher: dispatcher }),
          aborted,
        ]);
        if (signal.aborted) {
          return;
        }
        await aborted;
      } catch (error) {
        close();
        throw error;
      } finally {
        signal.removeEventListener("abort", close);
      }
    },

    async send(
      connection: MessagingConnection,
      reply: MessageReply,
    ): Promise<void> {
      const credentials = resolveCredentials(connection);
      const client = clientFor(connection, credentials);
      const data = messagePayload(reply);

      if (reply.replyToken) {
        const response = await client.im.message.reply({
          path: { message_id: reply.replyToken },
          data,
        });
        assertSuccessfulResponse("message.reply", response);
        return;
      }

      const response = await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: reply.conversationId,
          ...data,
        },
      });
      assertSuccessfulResponse("message.create", response);
    },
  };
}
