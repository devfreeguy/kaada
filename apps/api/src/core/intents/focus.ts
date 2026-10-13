import { FOCUS_TTL_MS, normalizeSpokenAmount } from "@kaada/domain";
import type { ConversationFocus, Intent, Interpretation } from "@kaada/domain";

/**
 * What a short message means depends on what Kaada just asked. The question is remembered as state, never recovered by reading the
 * wording of an earlier message, and the plainly structured answers are understood WITHOUT a language model:
 *
 *   "Which rate should I check?"   -> "wARS to USDT"   a pair of assets
 *   "How much would you like to send?" -> "20"          an amount
 *   "What currency is the 20 in?"  -> "USDT"            a currency
 *
 * Only what cannot be read this way goes to the interpreter, and a new request is still never trapped by the question.
 */

/** The size of the one-unit quote that answers a rate question. A constant of the product, never chosen by a model. */
export const RATE_UNIT_AMOUNT = "1";

const FILLER = new Set([
  "to",
  "into",
  "vs",
  "versus",
  "and",
  "in",
  "for",
  "the",
  "rate",
  "rates",
  "of",
  "from",
  "price",
  "check",
  "pair",
  "per",
  "against",
  "please",
  "what's",
  "whats",
  "is",
]);
const SYMBOL = /^[A-Za-z][A-Za-z0-9]{1,11}$/;

/**
 * Reads "wARS to USDT", "wARS/USDT", "wARS -> USDT", "USDT cNGN" as a pair of asset labels. Anything that is not exactly two
 * plausible labels once filler words and separators are dropped is NOT a pair (it may still be an answer the interpreter can read).
 * Whether the labels name real assets is checked by the caller against the registry.
 */
export function parseRatePair(
  text: string,
): { from: string; to: string; explicit: boolean } | null {
  const tokens = text
    .replace(/[?!.,;:()"“”]/g, " ")
    .split(/[\s/\\\-–—>→=|]+/)
    .filter((token) => token.length > 0 && !FILLER.has(token.toLowerCase()));
  const [from, to] = tokens;
  if (tokens.length !== 2 || !from || !to) return null;
  if (!SYMBOL.test(from) || !SYMBOL.test(to) || from.toLowerCase() === to.toLowerCase())
    return null;
  // A written separator ("/", "->", "-") says the person meant a pair even if a label is not one we know; plain words do not.
  return { from, to, explicit: /[/\-–—>→=|]/.test(text) };
}

/** The one-unit price question for a pair, as the interpretation a typed rate question would have produced. */
export function rateQuestion(pair: { from: string; to: string }): Interpretation {
  return {
    kind: "INTENT",
    intent: {
      type: "QUOTE",
      amount: { value: RATE_UNIT_AMOUNT, currencyOrAsset: pair.from, mode: "EXACT_INPUT" },
      fromAsset: pair.from,
      toAsset: pair.to,
    },
  };
}

/** A message that is only a number ("20", "10,000", "10k"). Returns the canonical value, or undefined. */
export function parseBareAmount(text: string): string | undefined {
  if (!/^\s*\d[\d.,]*\s*[kKmM]?\s*$/.test(text)) return undefined;
  return normalizeSpokenAmount(text.trim());
}

/** A message that is a single label that could name a currency or an asset ("USDT", "ngn"). */
export function parseBareLabel(text: string): string | undefined {
  const label = text.trim();
  return SYMBOL.test(label) ? label : undefined;
}

/**
 * The stored focus, if it still applies: well formed, not older than FOCUS_TTL_MS, and recorded beside the SAME payment (and
 * revision) that is open now. A focus whose payment has been cancelled, replaced or revised since is a question about a situation
 * that no longer exists, so it is ignored (and cleared by the next turn).
 */
export function activeFocus(
  metadata: Record<string, unknown> | undefined,
  now: Date,
  open: Pick<Intent, "id" | "revision"> | null,
): ConversationFocus | undefined {
  const raw = metadata?.["focus"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value["kind"] !== "RATE_PAIR" || typeof value["setAt"] !== "string") return undefined;
  const setAt = Date.parse(value["setAt"]);
  if (Number.isNaN(setAt) || now.getTime() - setAt > FOCUS_TTL_MS) return undefined;
  const intentId = typeof value["intentId"] === "string" ? value["intentId"] : undefined;
  const intentRevision =
    typeof value["intentRevision"] === "number" ? value["intentRevision"] : undefined;
  if (intentId !== undefined && (open?.id !== intentId || open.revision !== intentRevision)) {
    return undefined;
  }
  return {
    kind: "RATE_PAIR",
    setAt: value["setAt"],
    ...(intentId !== undefined && { intentId }),
    ...(intentRevision !== undefined && { intentRevision }),
  };
}

/**
 * Whether a reading is an explicit request in its own right (so it may override the question being waited on), as opposed to a
 * fragment ("20", a lone name) that only makes sense as an answer to something. A fragment never starts a payment.
 */
export function isExplicitIntent(interpretation: Interpretation): boolean {
  if (interpretation.kind === "COMMAND") return true;
  const { intent } = interpretation;
  switch (intent.type) {
    case "SEND":
      return intent.recipient !== undefined && intent.amount !== undefined;
    case "CONVERT":
      return (
        intent.amount !== undefined &&
        (intent.fromAsset !== undefined || intent.toAsset !== undefined)
      );
    case "QUOTE":
      return (
        intent.fromAsset !== undefined ||
        intent.toAsset !== undefined ||
        intent.destination !== undefined
      );
    case "BALANCE":
    case "TRANSACTION_STATUS":
    case "HELP":
      return true;
    case "UNKNOWN":
      return false;
  }
}
