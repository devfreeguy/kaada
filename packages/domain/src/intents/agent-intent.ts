import type { HumanAmount } from "../money/index.js";
import type { QuoteConstraints } from "../quotes/quote.js";
import type { RecipientReference } from "../recipients/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";

/*
 * What the language stage (an LLM today) extracts from a message. Everything is optional because
 * people leave things out: "Send $20." is a valid SEND intent with no recipient, and nothing here
 * may be invented to fill the gap. Amounts are HumanAmount, not Money: assets are still labels.
 *
 * Optional properties accept explicit `undefined` so that Zod-parsed output is assignable.
 */

/** A human amount plus which side of the trade it fixes, when the speaker made that clear. */
export interface IntentAmount extends HumanAmount {
  mode?: AmountMode | undefined;
}

/** Where the money should end up. Any combination may be given. */
export interface Destination {
  /** ISO 3166-1 alpha-2, e.g. "BR". */
  country?: string | undefined;
  /** Fiat currency label, e.g. "BRL". */
  currency?: string | undefined;
  /** Asset label, e.g. "USDT". */
  asset?: string | undefined;
}

export interface PaymentConstraints extends QuoteConstraints {
  /** Highest total fee the user will accept. */
  maxFee?: HumanAmount | undefined;
}

export interface SendIntent {
  type: "SEND";
  recipient?: RecipientReference | undefined;
  amount?: IntentAmount | undefined;
  /** Asset label to pay with, e.g. "USDT". */
  sourceAsset?: string | undefined;
  destination?: Destination | undefined;
  constraints?: PaymentConstraints | undefined;
}

export interface ConvertIntent {
  type: "CONVERT";
  amount?: IntentAmount | undefined;
  fromAsset?: string | undefined;
  toAsset?: string | undefined;
  constraints?: PaymentConstraints | undefined;
}

/** A non-executing price question: "How much would 50 USDT give me in Brazil?" */
export interface QuoteIntent {
  type: "QUOTE";
  amount?: IntentAmount | undefined;
  fromAsset?: string | undefined;
  toAsset?: string | undefined;
  destination?: Destination | undefined;
  constraints?: PaymentConstraints | undefined;
}

export interface BalanceIntent {
  type: "BALANCE";
  asset?: string | undefined;
}

export interface TransactionStatusIntent {
  type: "TRANSACTION_STATUS";
  /** A transaction hash or Kaada id; absent means "my latest". */
  reference?: string | undefined;
}

export interface HelpIntent {
  type: "HELP";
  topic?: string | undefined;
}

export interface UnknownIntent {
  type: "UNKNOWN";
  reason?: string | undefined;
}

export type AgentIntent =
  | SendIntent
  | ConvertIntent
  | QuoteIntent
  | BalanceIntent
  | TransactionStatusIntent
  | HelpIntent
  | UnknownIntent;
