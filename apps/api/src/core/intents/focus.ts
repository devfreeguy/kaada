import { FOCUS_TTL_MS, normalizeSpokenAmount } from "@kaada/domain";
import type { ConversationFocus, Intent, Interpretation } from "@kaada/domain";

import { currencyForCountryWord, resolveCurrencyLabel } from "../currency/registry.js";

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

/** Words that carry no part of a currency's name and are dropped from either side of a pair. */
const FILLER = new Set([
  "and",
  "the",
  "rate",
  "rates",
  "of",
  "price",
  "prices",
  "check",
  "pair",
  "please",
  "what's",
  "whats",
  "what",
  "is",
  "current",
  "currently",
  "today",
  "today's",
  "todays",
  "now",
  "much",
  "how",
]);

/** Words that separate the two sides of a pair: "naira TO argentine pesos", "USDT VS cNGN". */
const SEPARATOR_WORDS = new Set(["to", "into", "vs", "versus", "against", "in", "for", "per"]);

/** Separator characters: "wARS/USDT", "wARS -> USDT". */
const SEPARATOR_CHARS = /[/\\–—>→=|]|->/;

/** A single token that could be a token ticker ("USDT", "cNGN"). Multi-word sides are currency phrases instead. */
const SYMBOL = /^[A-Za-z][A-Za-z0-9]{1,11}$/;

/**
 * Everything left of a side once filler and stray separator words are dropped: "the Argentina Peso" -> "Argentina Peso".
 * A side that is only a country ("...Naira in ARGENTINA") becomes that country's currency code: inside a pair, both sides are
 * known to be currencies, so naming the country can only mean its money.
 */
function cleanSide(words: readonly string[]): string {
  const kept = words.filter(
    (word) => !FILLER.has(word.toLowerCase()) && !SEPARATOR_WORDS.has(word.toLowerCase()),
  );
  const side = kept.join(" ").trim();
  if (side === "" || resolveCurrencyLabel(side).status !== "UNKNOWN") return side;
  return currencyForCountryWord(side)?.code ?? side;
}

/** A side names something only if it is a currency phrase we know, or a single plausible ticker. No digits either way. */
function plausibleSide(side: string): boolean {
  if (side.length === 0 || /\d/.test(side)) return false;
  if (resolveCurrencyLabel(side).status !== "UNKNOWN") return true;
  return !side.includes(" ") && SYMBOL.test(side);
}

/**
 * Reads a rate question as a pair of labels, each of which may be several words:
 *   "wARS to USDT", "wARS/USDT", "USDT cNGN", "Naira to Argentina Peso", "Nigerian money to Brazilian reais".
 *
 * It only SPLITS and tidies; it never decides what a label means. Whether each side names a real currency or asset, and
 * whether a word like "pesos" is too vague to act on, is settled by the caller against the registry.
 */
export function parseRatePair(
  text: string,
): { from: string; to: string; explicit: boolean } | null {
  const cleaned = text.replace(/[?!.,;:()"“”]/g, " ");
  const explicit = SEPARATOR_CHARS.test(cleaned);
  // A separator character splits first; it is the clearest statement that a pair was meant.
  const parts = cleaned
    .split(/\s*(?:->|[/\\–—>→=|])\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  let fromWords: string[];
  let toWords: string[];
  if (parts.length === 2) {
    fromWords = (parts[0] ?? "").split(/[\s-]+/);
    toWords = (parts[1] ?? "").split(/[\s-]+/);
  } else if (parts.length === 1) {
    // Filler goes first, so "what's the current rate FOR naira IN argentina" splits on the separator that really divides the
    // two sides rather than on one that happened to sit inside the question's wording.
    const words = (parts[0] ?? "")
      .split(/[\s-]+/)
      .filter((word) => word.length > 0 && !FILLER.has(word.toLowerCase()));
    while (words.length > 0 && SEPARATOR_WORDS.has((words[0] ?? "").toLowerCase())) words.shift();
    const at = words.findIndex((word) => SEPARATOR_WORDS.has(word.toLowerCase()));
    if (at > 0) {
      fromWords = words.slice(0, at);
      toWords = words.slice(at + 1);
    } else {
      // No separator at all: only two bare labels can still be a pair ("USDT cNGN").
      const bare = words.filter((word) => !FILLER.has(word.toLowerCase()));
      if (bare.length !== 2) return null;
      fromWords = [bare[0] ?? ""];
      toWords = [bare[1] ?? ""];
    }
  } else {
    return null;
  }

  const from = cleanSide(fromWords);
  const to = cleanSide(toWords);
  if (!plausibleSide(from) || !plausibleSide(to)) return null;
  if (from.toLowerCase() === to.toLowerCase()) return null;
  return { from, to, explicit };
}

/**
 * The follow-up to a rate that was just given: "20,000" after "Naira to Argentine pesos" means 20,000 Naira in Argentine
 * pesos. It is a QUOTE of a real amount (not a rate probe), so it is priced and worded as a conversion. It names no recipient
 * and no wallet, so it cannot become a payment; the person still has to say who to pay.
 */
export function amountOnQuotedPair(
  focus: { from: string; to: string },
  value: string,
): Interpretation {
  return {
    kind: "INTENT",
    intent: {
      type: "QUOTE",
      amount: { value, currencyOrAsset: focus.from, mode: "EXACT_INPUT" },
      fromAsset: focus.from,
      toAsset: focus.to,
    },
  };
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
      // The person asked for a rate, not for a conversion of one unit: the answer is worded as a rate.
      rateOnly: true,
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
  const kind = value["kind"];
  if ((kind !== "RATE_PAIR" && kind !== "RATE_QUOTED") || typeof value["setAt"] !== "string") {
    return undefined;
  }
  const setAt = Date.parse(value["setAt"]);
  if (Number.isNaN(setAt) || now.getTime() - setAt > FOCUS_TTL_MS) return undefined;
  const intentId = typeof value["intentId"] === "string" ? value["intentId"] : undefined;
  const intentRevision =
    typeof value["intentRevision"] === "number" ? value["intentRevision"] : undefined;
  if (intentId !== undefined && (open?.id !== intentId || open.revision !== intentRevision)) {
    return undefined;
  }
  const base = {
    setAt: value["setAt"],
    ...(intentId !== undefined && { intentId }),
    ...(intentRevision !== undefined && { intentRevision }),
  };
  if (kind === "RATE_PAIR") return { kind, ...base };
  // A quoted pair is only usable if both sides survived storage intact.
  const from = value["from"];
  const to = value["to"];
  if (typeof from !== "string" || typeof to !== "string" || from === "" || to === "") {
    return undefined;
  }
  return { kind, from, to, ...base };
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
