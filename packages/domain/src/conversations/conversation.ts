import type { JsonObject, JsonValue } from "../json.js";

export const CHANNEL_TYPES = ["TELEGRAM", "WHATSAPP", "WEB", "DISCORD", "X"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const CONVERSATION_STATUSES = ["ACTIVE", "COMPLETED", "ARCHIVED"] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_ROLES = ["USER", "ASSISTANT", "SYSTEM", "TOOL"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/**
 * What Kaada is waiting to be told, when that is NOT a missing detail of an open payment (those live on the intent itself:
 * `missingFields`). Stored on the conversation, so it survives restarts and several instances, and it is never inferred from
 * the wording of an earlier message.
 *
 * - RATE_PAIR: Kaada asked "which rate should I check?". The next message is first read as a pair of assets.
 *
 * `intentId` / `intentRevision` record the payment that was open when the question was asked. If that payment has changed since
 * (cancelled, replaced, revised), the question belongs to a situation that no longer exists and the focus is ignored.
 */
export interface ConversationFocus {
  kind: "RATE_PAIR";
  /** ISO time the question was asked. A focus does not wait for ever. */
  setAt: string;
  intentId?: string;
  intentRevision?: number;
}

/** How long an unanswered question keeps the conversation's focus. */
export const FOCUS_TTL_MS = 30 * 60 * 1000;

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
