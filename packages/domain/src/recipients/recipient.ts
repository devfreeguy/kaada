import type { JsonObject } from "../json.js";

export const RECIPIENT_TYPES = [
  "KAADA_USER",
  "USERNAME",
  "TELEGRAM_USER",
  "PHONE_NUMBER",
  "WALLET_ADDRESS",
  "SAVED_BENEFICIARY",
  "EXTERNAL_PAYMENT_ADDRESS",
] as const;
export type RecipientType = (typeof RECIPIENT_TYPES)[number];

/**
 * How the sender referred to the recipient, before any lookup. `value` is exactly what was said or
 * parsed (a Kaada username, "@maria", "+2348012345678", "0xabc...", a beneficiary nickname, ...).
 * Resolving a reference into a ResolvedRecipient is a separate step.
 */
export type RecipientReference = {
  [T in RecipientType]: { type: T; value: string };
}[RecipientType];

/** A stored recipient: a saved beneficiary or a remembered counterparty. */
export interface Recipient {
  id: string;
  /** The user who saved it; absent for system-created recipients. */
  ownerUserId?: string;
  /** The Kaada account this recipient maps to, when there is one. */
  linkedUserId?: string;
  type: RecipientType;
  displayName?: string;
  /** Type-specific lookup key: username, Telegram id, phone number, payment address, ... */
  identifier?: string;
  walletAddress?: string;
  destinationCountry?: string;
  preferredAssetId?: string;
  isSaved: boolean;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** The outcome of resolving a RecipientReference: enough to route a payment to them. */
export interface ResolvedRecipient {
  reference: RecipientReference;
  /** Present when the recipient is (or was saved as) a stored Recipient. */
  recipientId?: string;
  linkedUserId?: string;
  displayName?: string;
  walletAddress?: string;
  destinationCountry?: string;
  preferredAssetId?: string;
}
