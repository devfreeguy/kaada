import type { Money } from "../money/index.js";
import type { AgentIntent, PaymentConstraints } from "./agent-intent.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { MissingField } from "./missing-fields.js";

export const INTENT_TYPES = [
  "SEND",
  "CONVERT",
  "QUOTE",
  "BALANCE",
  "TRANSACTION_STATUS",
  "HELP",
  "UNKNOWN",
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

export const INTENT_STATUSES = [
  "DRAFT",
  "AWAITING_DETAILS",
  "RESOLVED",
  "QUOTING",
  "AWAITING_CONFIRMATION",
  "EXECUTING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

/** Statuses in which an intent can still be completed or changed by the user. */
export const OPEN_INTENT_STATUSES = [
  "DRAFT",
  "AWAITING_DETAILS",
  "RESOLVED",
  "QUOTING",
  "AWAITING_CONFIRMATION",
] as const satisfies readonly IntentStatus[];

/** The resolved, canonical amount of an intent, with the side it fixes. */
export interface IntentAmountResolved {
  money: Money;
  mode: AmountMode;
}

/**
 * A stored intent. Resolved facts live in typed fields (canonical Money, asset and recipient ids);
 * whatever the language stage extracted, including still-unresolved human amounts, is kept in
 * `parsed`. The money's asset is implied by the mode: the source asset for EXACT_INPUT, the
 * destination asset for EXACT_OUTPUT.
 */
export interface Intent {
  id: string;
  userId: string;
  conversationId: string;
  type: IntentType;
  status: IntentStatus;
  amount?: IntentAmountResolved;
  sourceAssetId?: string;
  destinationAssetId?: string;
  /**
   * An explicit funding preference ("use USDT"). It is not the currency of `amount`: "send $20 using
   * USDT" is 20 USD with a USDT preference, and the amount stays in USD.
   */
  preferredSourceAssetId?: string;
  recipientId?: string;
  destinationCountry?: string;
  parsed?: AgentIntent;
  constraints?: PaymentConstraints;
  missingFields: MissingField[];
  /**
   * Starts at 1 and increases with every financial change (see hasFinancialChange). Anything derived
   * from an intent (clarification options now; quotes and routes later) records the revision it was
   * made from and is stale as soon as the intent has moved on.
   */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The asset an intent amount is denominated in: the source asset when the input is fixed
 * (EXACT_INPUT), the destination asset when the output is fixed (EXACT_OUTPUT). Undefined when that
 * asset has not been resolved yet.
 */
export function amountAssetIdFor(
  mode: AmountMode,
  assets: { sourceAssetId?: string | undefined; destinationAssetId?: string | undefined },
): string | undefined {
  return mode === "EXACT_INPUT" ? assets.sourceAssetId : assets.destinationAssetId;
}
