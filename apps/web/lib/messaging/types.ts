/** The three configured, account-owned private-message transports. */
export type MessagingPlatform = "weixin" | "feishu" | "telegram";

export interface MessagingConnection {
  id: string;
  accountId: string;
  platform: MessagingPlatform;
  botId: string;
  enabled: boolean;
  senderId: string;
  defaultStorageId: string | null;
  credentials: Record<string, string>;
}

export interface InboundMessage {
  connectionId: string;
  platform: MessagingPlatform;
  botId: string;
  messageId: string;
  conversationId: string;
  senderId: string;
  text: string;
  callbackData?: string;
  replyToken?: string;
}

export interface MessageReply {
  conversationId: string;
  text: string;
  replyToken?: string;
  choices?: readonly { label: string; value: string }[];
}

export interface MessagingSink {
  loadCursor(connectionId: string): Promise<string | null>;
  /** Commit the batch and cursor before acknowledging delivery. */
  accept(messages: readonly InboundMessage[], cursor?: string): Promise<void>;
}

export interface MessagingTransport {
  start(connection: MessagingConnection, sink: MessagingSink, signal: AbortSignal): Promise<void>;
  send(connection: MessagingConnection, reply: MessageReply): Promise<void>;
}
