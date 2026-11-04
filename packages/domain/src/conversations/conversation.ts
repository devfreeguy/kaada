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
 * - RATE_PAIR:   Kaada asked "which rate should I check?". The next message is first read as a pair of assets.
 * - RATE_QUOTED: Kaada has just answered a rate for `from`/`to`. A message that is only an amount ("20,000") is read as that
 *                amount of `from`, converted to `to`: the follow-up a person obviously means. It carries no recipient and no
 *                wallet, so it can never become a payment by itself.
 *
 * `intentId` / `intentRevision` record the payment that was open at the time. If that payment has changed since (cancelled,
 * replaced, revised), the focus belongs to a situation that no longer exists and is ignored.
 *
 * A focus is scoped to one conversation row, which belongs to one user and one channel chat, so it can never be read across
 * users or chats. It expires after FOCUS_TTL_MS.
 */
export interface ConversationFocusBase {
  /** ISO time the focus was set. A focus does not wait for ever. */
  setAt: string;
  intentId?: string;
  intentRevision?: number;
}

export interface RatePairFocus extends ConversationFocusBase {
  kind: "RATE_PAIR";
}

export interface RateQuotedFocus extends ConversationFocusBase {
  kind: "RATE_QUOTED";
  /** The labels that were priced, exactly as resolved; re-resolved from scratch on the follow-up. */
  from: string;
  to: string;
}

export type ConversationFocus = RatePairFocus | RateQuotedFocus;

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
