import type { InboundChannelMessage } from "./types.js";

/**
 * What Kaada is doing for an inbound interaction decides what the person sees while waiting. Decided BEFORE anything is shown, so
 * a greeting never gets a loading bubble and a button that answers instantly never gets a typing indicator.
 *
 *   INSTANT_DETERMINISTIC             answered from stored state, no model, no provider: reply at once, show nothing
 *   FAST_CONVERSATIONAL               a casual message, answered by a short model reply: typing only
 *   MODEL_GENERATED                   a message that needs interpretation and wording: typing only
 *   PROVIDER_LOOKUP                   a rate or a balance: typing, and a contextual status only if it is slow
 *   ROUTING_OR_FINANCIAL_COMPUTATION  preparing or pricing a payment: typing, and payment wording if it is slow
 *   PAYMENT_EXECUTION                 a payment being submitted: the persistent, edited status message (payment-status.ts)
 *   BACKGROUND_STATUS                 a notification Kaada sends on its own: nothing waits, so nothing is shown
 *
 * Classification here only chooses WORDS and whether to show anything. It never decides what happened: the answer itself always
 * comes from the Agent Core's typed response. When unsure, a message is conversational (typing only), never a loader.
 */
export const RESPONSE_CLASSES = [
  "INSTANT_DETERMINISTIC",
  "FAST_CONVERSATIONAL",
  "MODEL_GENERATED",
  "PROVIDER_LOOKUP",
  "ROUTING_OR_FINANCIAL_COMPUTATION",
  "PAYMENT_EXECUTION",
  "BACKGROUND_STATUS",
] as const;
export type ResponseClass = (typeof RESPONSE_CLASSES)[number];

/** The real work a slow reply is waiting for. Each has its own wording; there is no generic one. */
export type ProgressTask = "RATE" | "BALANCE" | "RECIPIENT" | "PAYMENT" | "ROUTE";

export interface LatencyPlan {
  class: ResponseClass;
  /** Show the channel's typing activity from the start. */
  typing: boolean;
  /** The work to describe if the reply turns out slow. Absent: never show a status for this interaction. */
  progress?: ProgressTask;
}

/** How soon activity is shown (milliseconds). Configurable; these are the defaults. */
export interface LatencyTimings {
  /** Typing is shown after this long (0: at once, for anything that is not instant). */
  typingAfterMs: number;
  /** A contextual status is shown only if the reply still has not arrived after this long. */
  statusAfterMs: number;
  /** Typing is renewed this often (providers clear it after a few seconds). */
  typingEveryMs: number;
}

export const DEFAULT_LATENCY: LatencyTimings = {
  typingAfterMs: 0,
  statusAfterMs: 1_500,
  typingEveryMs: 4_000,
};

const INSTANT: LatencyPlan = { class: "INSTANT_DETERMINISTIC", typing: false };
const CONVERSATIONAL: LatencyPlan = { class: "FAST_CONVERSATIONAL", typing: true };
const lookup = (progress: ProgressTask): LatencyPlan => ({
  class: "PROVIDER_LOOKUP",
  typing: true,
  progress,
});
const computing = (progress: ProgressTask): LatencyPlan => ({
  class: "ROUTING_OR_FINANCIAL_COMPUTATION",
  typing: true,
  progress,
});

/** Currency and token names that make "X to Y" a rate question. Only used to pick wording. */
const CURRENCY =
  "(?:usd|usdt|usdc|ngn|cngn|brl|wbrl|ars|wars|idr|idrx|eur|gbp|kes|ghs|zar|mxn|cop|pen|clp|celo|dollars?|naira|pesos?|reais|real)";
const RATE_WORDS = /\b(?:rates?|price|prices|exchange|worth|convert|conversion)\b/i;
const RATE_PAIR = new RegExp(`\\b${CURRENCY}\\s*(?:to|/|->|vs\\.?)\\s*${CURRENCY}\\b`, "i");
const BALANCE_WORDS =
  /\b(?:balance|balances|how much (?:do i have|have i got)|what do i (?:have|hold))\b/i;
const SEND_WORDS = /\b(?:send|pay|transfer|remit|wire)\b/i;
const FIND_WORDS =
  /\b(?:find|look\s?up|search(?: for)?)\b[^.?!]*\b(?:recipient|contact|him|her|them|beneficiary)\b/i;

/** The plan for a typed message. */
export function classifyText(text: string): LatencyPlan {
  const value = text.trim();
  if (value.length === 0) return INSTANT;
  if (FIND_WORDS.test(value)) return lookup("RECIPIENT");
  if (SEND_WORDS.test(value)) return computing("PAYMENT");
  if (BALANCE_WORDS.test(value)) return lookup("BALANCE");
  if (RATE_WORDS.test(value) || RATE_PAIR.test(value)) return lookup("RATE");
  return CONVERSATIONAL;
}

/** The plan for an interaction, from what is known before anything has been read or decided. */
export function classifyInbound(content: InboundChannelMessage["content"]): LatencyPlan {
  switch (content.kind) {
    case "TEXT":
      return classifyText(content.text);
    case "COMMAND":
      // /balance reads the wallet; every other command is answered from stored state.
      return content.command === "BALANCE" ? lookup("BALANCE") : INSTANT;
    case "ACTION":
      // A button is usually answered from stored state; the kinds that start real work refine this once they are known.
      return INSTANT;
  }
}

/** What a pressed button turns out to be doing, once it is resolved. */
export function classifyAction(
  kind: "SELECT_OPTION" | "CANCEL" | "SUGGESTION" | "CONTINUE_PAYMENT" | "VIEW_STATUS" | "RETRY",
  suggestion?: string,
): LatencyPlan {
  switch (kind) {
    case "SELECT_OPTION":
      return computing("ROUTE");
    case "CONTINUE_PAYMENT":
      return computing("ROUTE");
    case "SUGGESTION":
      if (suggestion === "CHECK_BALANCE") return lookup("BALANCE");
      return INSTANT;
    default:
      return INSTANT;
  }
}

const PROGRESS_WORDING: Record<ProgressTask, readonly string[]> = {
  RATE: ["Let me check that rate for you 👀"],
  BALANCE: ["Checking your wallet…"],
  RECIPIENT: ["Let me find them."],
  PAYMENT: ["Got you. Let me work that out."],
  ROUTE: ["Let me work out the best route."],
};

/** The words for a task, varied by a stable seed (the same message always gets the same words). */
export function progressText(task: ProgressTask, seed: string): string {
  const options = PROGRESS_WORDING[task];
  let hash = 0;
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return options[hash % options.length] ?? options[0] ?? "";
}
