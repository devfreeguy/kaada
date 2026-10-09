import type { JsonObject, JsonValue } from "../json.js";

export const CHANNEL_TYPES = ["TELEGRAM", "WHATSAPP", "WEB", "DISCORD", "X"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CONVERSATION_STATUSES = ["ACTIVE", "COMPLETED", "ARCHIVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_ROLES = ["USER", "ASSISTANT", "SYSTEM", "TOOL"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface Conversation {
  id: string;
  userId: string;
  channel: ChannelType;
  status: ConversationStatus;
  /** The channel's own chat id, used to route webhooks to the right conversation. */
  externalConversationId?: string;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  /** The channel's own message id; used to drop duplicate webhook deliveries. */
  externalMessageId?: string;
  structuredData?: JsonValue;
  metadata?: JsonObject;
  createdAt: Date;
}
