/*
 * Chat-channel persistence contracts. Channel-neutral: nothing here names Telegram. A channel adapter (Telegram, later WhatsApp)
 * only ever deals in these shapes; what a button MEANS, whether an event was already handled and which message shows a payment's
 * progress are application facts, kept server-side.
 */
import type { ChannelType } from "../conversations/conversation.js";

export const CHANNEL_ACTION_KINDS = [
  "SELECT_OPTION",
  "CANCEL",
  "VIEW_STATUS",
  "RETRY",
  "SUGGESTION",
  "CONTINUE_PAYMENT",
  "SET_COUNTRY",
  "CONVERT_CURRENCY",
  "KEEP_CURRENCY",
] as const;
export type ChannelActionKind = (typeof CHANNEL_ACTION_KINDS)[number];

/** What a pressed button means. The provider sees only `id`. */
export interface ChannelAction {
  id: string;
  /** What the provider sees: 16 random bytes, base64url (22 characters). Fits Telegram's 64-byte callback_data with room to spare. */
  handle: string;
  userId: string;
  channel: ChannelType;
  /** The provider account the button was shown to. No one else may use it. */
  externalUserId: string;
  conversationId: string;
  kind: ChannelActionKind;
  /** Small and non-sensitive (an option id, a session reference): never a PIN, token, claim token or amount. */
  payload: Record<string, string>;
  reusable: boolean;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

export type NewChannelAction = Omit<ChannelAction, "usedAt" | "createdAt">;

export type ChannelActionRejection =
  "UNKNOWN" | "EXPIRED" | "USED" | "WRONG_USER" | "WRONG_CHANNEL";

export interface ChannelActionRepository {
  create(action: NewChannelAction, now: Date): Promise<ChannelAction>;
  findByHandle(handle: string): Promise<ChannelAction | null>;
  /**
   * Claims a button press. Succeeds only for the account the button was shown to, on its channel, before it expires and (unless
   * reusable) once: of any number of concurrent presses exactly one gets the action. Everything else is a rejection that
   * changes nothing and reveals nothing beyond the reason code to the caller.
   */
  consume(input: {
    handle: string;
    channel: ChannelType;
    externalUserId: string;
    now: Date;
  }): Promise<{ ok: true; action: ChannelAction } | { ok: false; reason: ChannelActionRejection }>;
  deleteExpiredBefore(before: Date, limit: number): Promise<number>;
}

export type InboundClaim = "NEW" | "DUPLICATE" | "IN_PROGRESS" | "RECLAIMED";

export interface ChannelInboundEventRepository {
  /**
   * Records that this delivery is being handled. NEW: first time. DUPLICATE: already PROCESSED, so acknowledge and do nothing.
   * IN_PROGRESS: another worker has it and is not stale yet. RECLAIMED: a stale RECEIVED (its worker died), so handle it now.
   */
  claim(input: {
    id: string;
    channel: ChannelType;
    externalEventId: string;
    now: Date;
    staleMs: number;
  }): Promise<InboundClaim>;
  markProcessed(channel: ChannelType, externalEventId: string, now: Date): Promise<void>;
  /** Forgets a claim whose handling failed, so the provider's retry is processed instead of treated as in progress. */
  release(channel: ChannelType, externalEventId: string): Promise<void>;
  deleteOlderThan(before: Date, limit: number): Promise<number>;
}

export interface ChannelPaymentStatus {
  id: string;
  userId: string;
  channel: ChannelType;
  externalConversationId: string;
  authorizationSessionId: string;
  /** The message that showed the payment summary (its button is replaced when the session ends). */
  externalSummaryMessageId?: string;
  /** The message edited as the payment progresses. */
  externalStatusMessageId?: string;
  /** What the person was last told (a PaymentState name, or a session-level state). */
  lastState: string;
  terminal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type NewChannelPaymentStatus = Omit<ChannelPaymentStatus, "createdAt" | "updatedAt">;

export interface ChannelPaymentStatusRepository {
  /** One record per authorization session; a repeat returns the existing one. */
  create(status: NewChannelPaymentStatus): Promise<ChannelPaymentStatus>;
  findBySession(authorizationSessionId: string): Promise<ChannelPaymentStatus | null>;
  /** Records that are not terminal, oldest first. */
  listActive(limit: number): Promise<ChannelPaymentStatus[]>;
  /**
   * Moves `lastState` only if it still equals `from` (compare-and-set), so of two instances that notice the same change exactly
   * one announces it. Returns the updated record, or null when someone else moved first.
   */
  transition(input: {
    id: string;
    from: string;
    to: string;
    terminal?: boolean;
    externalStatusMessageId?: string;
  }): Promise<ChannelPaymentStatus | null>;
  /** Remembers which message shows the progress (set once, after it was first sent). */
  attachStatusMessage(id: string, externalStatusMessageId: string): Promise<void>;
  /** Puts `lastState` back after a failed announcement (only if it is still `to`), so the next pass announces it again. */
  revert(input: { id: string; from: string; to: string }): Promise<void>;
}
