import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { Recipient } from "../recipients/index.js";
import type { Intent } from "./intent.js";

/**
 * What a route planner is handed once an intent is ready. It describes what the user wants, in
 * their own terms, and nothing a provider decided: no rate, no source amount, no fees, no route, no
 * provider, no wrapped token. Everything here was stated by the user or resolved from stored data.
 */
export interface RoutingRequest {
  intentId: string;
  /** The intent revision this request was built from. Plans made for another revision are stale. */
  intentRevision: number;
  userId: string;
  operation: "SEND" | "CONVERT" | "QUOTE";
  /** A QUOTE only answers a price question; it never becomes a payment. */
  purpose: "PAYMENT" | "QUOTE";
  /** The fixed side, in the asset it was expressed in (a fiat currency or a token). */
  amount: Money;
  amountMode: AmountMode;
  /** What the sending side is denominated in, when known (for EXACT_INPUT, the amount asset). */
  sourceAssetId?: string;
  /** What the receiving side is denominated in, when known. */
  destinationAssetId?: string;
  /** "Use USDT": the explicit funding preference. */
  preferredSourceAssetId?: string;
  recipient?: {
    recipientId: string;
    linkedUserId?: string;
    displayName?: string;
    walletAddress?: string;
  };
  destinationCountry?: string;
}

/** The few recipient fields a routing request carries. A stored Recipient satisfies it. */
export type RecipientView = Pick<Recipient, "id"> &
  Partial<Pick<Recipient, "linkedUserId" | "displayName" | "walletAddress">>;

/**
 * Builds the routing handoff from a stored intent, or undefined when the intent has no operation
 * that routes or no canonical amount yet. Pure: it reads only the intent and its recipient record.
 */
export function buildRoutingRequest(
  intent: Intent,
  recipient?: RecipientView,
): RoutingRequest | undefined {
  if (
    (intent.type !== "SEND" && intent.type !== "CONVERT" && intent.type !== "QUOTE") ||
    !intent.amount
  ) {
    return undefined;
  }
  return {
    intentId: intent.id,
    intentRevision: intent.revision,
    userId: intent.userId,
    operation: intent.type,
    purpose: intent.type === "QUOTE" ? "QUOTE" : "PAYMENT",
    amount: intent.amount.money,
    amountMode: intent.amount.mode,
    ...(intent.sourceAssetId && { sourceAssetId: intent.sourceAssetId }),
    ...(intent.destinationAssetId && { destinationAssetId: intent.destinationAssetId }),
    ...(intent.preferredSourceAssetId && {
      preferredSourceAssetId: intent.preferredSourceAssetId,
    }),
    ...(recipient && {
      recipient: {
        recipientId: recipient.id,
        ...(recipient.linkedUserId && { linkedUserId: recipient.linkedUserId }),
        ...(recipient.displayName && { displayName: recipient.displayName }),
        ...(recipient.walletAddress && { walletAddress: recipient.walletAddress }),
      },
    }),
    ...(intent.destinationCountry && { destinationCountry: intent.destinationCountry }),
  };
}
