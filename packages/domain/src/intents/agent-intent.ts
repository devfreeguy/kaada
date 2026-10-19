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

/**
 * What the speaker said about an amount: the number, usually its currency, and which side of the
 * trade it fixes when that was clear. The currency is optional because people say "send 20 to Daniel"
 * without one; it must then be asked for, never guessed.
 */
export interface IntentAmount {
  value: string;
  currencyOrAsset?: string | undefined;
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

/**
 * What a conversational (non-transactional) message is about. Carried by a HELP intent's `topic`, so these never become
 * stored operations and need no new intent type: they are side requests that leave any operation in progress untouched.
 * - GREETING / SMALL_TALK / FAREWELL: social turns ("hey", "what's up", "thanks, that's all").
 * - CAPABILITIES: "what can you do?"
 * - FUNDING: "how do I fund my account?", "add money", "deposit", "where is my wallet address?", "my friend will send me
 *   money": the answer is the wallet's funding details (its address and what it accepts).
 * - SUPPORTED_ASSETS: "what coins do you support?", "can I receive CELO?", "do you support USDT?": the answer is the real list
 *   of what the wallet holds, from the registry.
 * - FINANCE_QUESTION: a money question Kaada can talk about but has no data for.
 * - OUT_OF_SCOPE: not about money at all (sports, weather, ...).
 * - RATE_GENERAL: a rate question that does not say which pair.
 */
export const CHAT_TOPICS = [
  "GREETING",
  "SMALL_TALK",
  "FAREWELL",
  "CAPABILITIES",
  "FUNDING",
  "SUPPORTED_ASSETS",
  "FINANCE_QUESTION",
  "OUT_OF_SCOPE",
  "RATE_GENERAL",
] as const;
export type ChatTopic = (typeof CHAT_TOPICS)[number];

export function isChatTopic(value: string | undefined): value is ChatTopic {
  return value !== undefined && (CHAT_TOPICS as readonly string[]).includes(value);
}
