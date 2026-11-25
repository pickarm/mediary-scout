import { Api, HttpError, type ApiClientOptions } from "grammy";
import type { Chat, Update, User } from "grammy/types";
import type {
  InboundMessage,
  MessagingConnection,
  MessagingSink,
  MessagingTransport,
} from "./types";

type TelegramApi = Pick<
  Api,
  "getUpdates" | "sendMessage" | "answerCallbackQuery"
>;
type GrammyAbortSignal = Parameters<TelegramApi["getUpdates"]>[1];

export interface TelegramTransportDeps {
  apiFactory?: (token: string) => TelegramApi;
}

const LONG_POLL_TIMEOUT_SECONDS = 30;

function grammySignal(signal: AbortSignal): GrammyAbortSignal {
  return signal as unknown as GrammyAbortSignal;
}

function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  if (error === signal.reason) {
    return true;
  }
  if (error instanceof HttpError) {
    return (
      error.error === signal.reason ||
      (error.error instanceof Error &&
        error.error.name === "AbortError")
    );
  }
  return error instanceof Error && error.name === "AbortError";
}

function parseCursor(cursor: string | null): number {
  if (cursor === null) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new Error(`Invalid Telegram cursor: ${cursor}`);
  }

  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) {
    throw new Error(`Invalid Telegram cursor: ${cursor}`);
  }
  return offset;
}

function isPrivateOwner(
  chat: Chat,
  sender: User,
  configuredSenderId: string,
): boolean {
  return (
    !sender.is_bot &&
    chat.type === "private" &&
    chat.id === sender.id &&
    String(sender.id) === configuredSenderId.trim()
  );
}

function normalizeUpdate(
  connection: MessagingConnection,
  update: Update,
): InboundMessage | null {
  if (update.message) {
    const message = update.message;
    if (
      !isPrivateOwner(
        message.chat,
        message.from,
        connection.senderId,
      )
    ) {
      return null;
    }

    return {
      connectionId: connection.id,
      platform: "telegram",
      botId: connection.botId,
      messageId: String(update.update_id),
      conversationId: String(message.chat.id),
      senderId: String(message.from.id),
      text: message.text ?? "",
    };
  }

  const callback = update.callback_query;
  if (!callback?.message) {
    return null;
  }
  if (
    !isPrivateOwner(
      callback.message.chat,
      callback.from,
      connection.senderId,
    )
  ) {
    return null;
  }

  return {
    connectionId: connection.id,
    platform: "telegram",
    botId: connection.botId,
    messageId: String(update.update_id),
    conversationId: String(callback.message.chat.id),
    senderId: String(callback.from.id),
    text: "",
    ...(callback.data === undefined ? {} : { callbackData: callback.data }),
    replyToken: callback.id,
  };
}

function createDefaultApi(token: string): TelegramApi {
  const fetchForGrammy = globalThis.fetch as unknown as NonNullable<
    ApiClientOptions["fetch"]
  >;
  return new Api(token, { fetch: fetchForGrammy });
}

export function createTelegramTransport(
  deps: TelegramTransportDeps = {},
): MessagingTransport {
  const apiByToken = new Map<string, TelegramApi>();
  const apiFactory = deps.apiFactory ?? createDefaultApi;

  function apiFor(connection: MessagingConnection): TelegramApi {
    const token = connection.credentials.token;
    if (!token) {
      throw new Error("Telegram bot token is required");
    }

    const existing = apiByToken.get(token);
    if (existing) {
      return existing;
    }

    const api = apiFactory(token);
    apiByToken.set(token, api);
    return api;
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

      const api = apiFor(connection);
      let offset = parseCursor(await sink.loadCursor(connection.id));

      while (!signal.aborted) {
        let updates: Update[];
        try {
          updates = await api.getUpdates(
            {
              offset,
              timeout: LONG_POLL_TIMEOUT_SECONDS,
              allowed_updates: ["message", "callback_query"],
            },
            grammySignal(signal),
          );
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          throw error;
        }

        if (signal.aborted || updates.length === 0) {
          continue;
        }

        const freshUpdates = [
          ...new Map(
            updates
              .filter((update) => update.update_id >= offset)
              .map((update) => [update.update_id, update] as const),
          ).values(),
        ].sort((left, right) => left.update_id - right.update_id);

        const nextOffset =
          Math.max(
            offset,
            ...updates.map((update) => update.update_id + 1),
          ) || offset;
        if (freshUpdates.length === 0) {
          continue;
        }

        const normalized = freshUpdates
          .map((update) => normalizeUpdate(connection, update))
          .filter((message): message is InboundMessage => message !== null);
        const callbacks = normalized.filter(
          (message) => message.replyToken !== undefined,
        );

        await sink.accept(normalized, String(nextOffset));
        offset = nextOffset;

        for (const callback of callbacks) {
          if (callback.replyToken) {
            try {
              await api.answerCallbackQuery(
                callback.replyToken,
                undefined,
                signal.aborted ? undefined : grammySignal(signal),
              );
            } catch (error) {
              if (isAbortFailure(error, signal)) {
                continue;
              }
              throw error;
            }
          }
        }
      }
    },

    async send(connection, reply): Promise<void> {
      const api = apiFor(connection);
      const choices = reply.choices ?? [];

      if (choices.length === 0) {
        await api.sendMessage(
          reply.conversationId,
          reply.text,
        );
        return;
      }

      await api.sendMessage(reply.conversationId, reply.text, {
        reply_markup: {
          inline_keyboard: choices.map((choice) => [
            {
              text: choice.label,
              callback_data: choice.value,
            },
          ]),
        },
      });
    },
  };
}
