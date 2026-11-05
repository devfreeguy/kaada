import type {
  AgentIntent,
  ConvertIntent,
  Destination,
  IntentAmount,
  PaymentConstraints,
  QuoteIntent,
  SendIntent,
} from "./agent-intent.js";

/**
 * What happened when a newly extracted intent met the conversation's active intent.
 * - NEW:          there was no active transactional intent; start one.
 * - MERGED:       same operation; new details were folded into the active intent.
 * - REPLACED:     a different operation; the active intent is superseded by a fresh one.
 * - SIDE_REQUEST: informational (help, balance, ...); the active intent is left untouched.
 */
export type MergeOutcome =
  | { kind: "NEW"; intent: AgentIntent }
  | { kind: "MERGED"; intent: AgentIntent }
  | { kind: "REPLACED"; intent: AgentIntent }
  | { kind: "SIDE_REQUEST"; intent: AgentIntent };

/** The intents that describe a money operation and can be built up over several messages. */
export type TransactionalIntent = SendIntent | ConvertIntent | QuoteIntent;

/** Intents that describe a money operation and can be built up over several messages. */
export function isTransactionalIntent(intent: AgentIntent): intent is TransactionalIntent {
  return intent.type === "SEND" || intent.type === "CONVERT" || intent.type === "QUOTE";
}

/** Drops keys whose value is undefined so they cannot overwrite real values when spread. */
function compact<T extends object>(value: T): T {
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries.filter(([, entry]) => entry !== undefined)) as unknown as T;
}

/** Whether two currency or asset labels name the same thing, as written. */
export const sameCurrency = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * For a CONVERT or a QUOTE the amount's currency and `fromAsset` are two names for ONE side: "2000 pesos to naira" states
 * "pesos" in both. They must therefore move together. When the two agreed before and only one of them has just been restated
 * — the person answered "which peso?" with "mexican", or picked the option — the other still carries the superseded label,
 * and resolving it would ask the very same question again. This brings the stale one along.
 *
 * It only ever copies a label the person themselves just gave, and only when the two were already in lockstep: a side that
 * was deliberately different ("convert 100 USDT, paying from my USDC") is left exactly as it is.
 */
export function alignedSourceLabel(
  previous: { amount?: IntentAmount | undefined; fromAsset?: string | undefined },
  merged: { amount?: IntentAmount | undefined; fromAsset?: string | undefined },
): string | undefined {
  const amountLabel = merged.amount?.currencyOrAsset;
  const { fromAsset } = merged;
  if (amountLabel === undefined || fromAsset === undefined) return undefined;
  if (sameCurrency(amountLabel, fromAsset)) return undefined;
  // Whichever one still reads as it did before is the stale one; the other is what was just said.
  if (sameCurrency(amountLabel, previous.amount?.currencyOrAsset)) {
    return sameCurrency(fromAsset, previous.fromAsset) ? undefined : fromAsset;
  }
  return undefined;
}

/**
 * A replacement amount wins. When it names no currency ("make it 40") it keeps the earlier amount's
 * currency; and it keeps the earlier mode unless it states one or changes currency.
 */
function mergeAmount(
  previous: IntentAmount | undefined,
  next: IntentAmount | undefined,
): IntentAmount | undefined {
  if (!next) return previous;
  if (!previous) return next;

  const currencyOrAsset = next.currencyOrAsset ?? previous.currencyOrAsset;
  const keepMode =
    next.mode === undefined &&
    previous.mode !== undefined &&
    (next.currencyOrAsset === undefined ||
      sameCurrency(previous.currencyOrAsset, next.currencyOrAsset));
  return compact({
    value: next.value,
    currencyOrAsset,
    mode: keepMode ? previous.mode : next.mode,
  });
}

/**
 * Destination details merge field by field, except that naming a different country starts the
 * destination over: a currency or asset stated for the old country ("in BRL") no longer applies to
 * "actually Argentina".
 */
function mergeDestination(
  previous: Destination | undefined,
  next: Destination | undefined,
): Destination | undefined {
  if (!previous || !next) return previous ?? next;
  const countryChanged =
    next.country !== undefined &&
    previous.country !== undefined &&
    next.country !== previous.country;
  return countryChanged ? compact(next) : { ...compact(previous), ...compact(next) };
}

function mergeConstraints(
  previous: PaymentConstraints | undefined,
  next: PaymentConstraints | undefined,
): PaymentConstraints | undefined {
  return previous || next ? { ...compact(previous ?? {}), ...compact(next ?? {}) } : undefined;
}

function mergeSend(previous: SendIntent, next: SendIntent): SendIntent {
  return compact({
    ...compact(previous),
    ...compact(next),
    amount: mergeAmount(previous.amount, next.amount),
    destination: mergeDestination(previous.destination, next.destination),
    constraints: mergeConstraints(previous.constraints, next.constraints),
  });
}

/**
 * A bare number, denominated from the side the person already named.
 *
 * "Swap from Naira to Argentine Pesos", then "200", is two hundred NAIRA. The input side was stated a turn ago, and an
 * EXACT_INPUT amount is in the input currency; when the OUTPUT is the fixed side, the same reasoning points at `toAsset`
 * instead. Asking "which currency is that amount in?" here is not a missing value being requested, it is a value the
 * person already gave being ignored — and it sends the conversation round a loop, because their answer ("Pesos") is then
 * read as the amount's currency rather than the destination they chose at the start.
 *
 * Nothing is invented: the label is copied from a side the person stated themselves. When neither side names one, the
 * question is still asked.
 */
function withDenominatedAmount<T extends ConvertIntent | QuoteIntent>(intent: T): T {
  const { amount } = intent;
  if (!amount || amount.currencyOrAsset !== undefined) return intent;
  const side = amount.mode === "EXACT_OUTPUT" ? intent.toAsset : intent.fromAsset;
  return side === undefined ? intent : { ...intent, amount: { ...amount, currencyOrAsset: side } };
}

/** The same, for an intent that may be of any type: only a conversion or a quote has sides to read. */
function denominated(intent: AgentIntent): AgentIntent {
  return intent.type === "CONVERT" || intent.type === "QUOTE" ? withDenominatedAmount(intent) : intent;
}

/** The merged operation with the amount's currency brought into line with a just-restated `fromAsset`. */
function withAlignedSource<T extends ConvertIntent | QuoteIntent>(previous: T, merged: T): T {
  const label = alignedSourceLabel(previous, merged);
  return label === undefined || !merged.amount
    ? merged
    : { ...merged, amount: { ...merged.amount, currencyOrAsset: label } };
}

function mergeConvert(previous: ConvertIntent, next: ConvertIntent): ConvertIntent {
  return withDenominatedAmount(
    withAlignedSource(
      previous,
      compact({
        ...compact(previous),
        ...compact(next),
        amount: mergeAmount(previous.amount, next.amount),
        constraints: mergeConstraints(previous.constraints, next.constraints),
      }),
    ),
  );
}

function mergeQuote(previous: QuoteIntent, next: QuoteIntent): QuoteIntent {
  const merged = withDenominatedAmount(
    withAlignedSource(
      previous,
      compact({
        ...compact(previous),
        ...compact(next),
        amount: mergeAmount(previous.amount, next.amount),
        destination: mergeDestination(previous.destination, next.destination),
        constraints: mergeConstraints(previous.constraints, next.constraints),
      }),
    ),
  );
  // Naming a size ends the rate question. "What's the naira to pesos rate?" then "20000" is a request to convert twenty
  // thousand naira, and deserves "₦20,000 gives AR$23,988" — not the unit rate repeated back with their number priced
  // invisibly behind it. `rateOnly` only ever means "they named no amount", so an amount arriving retires it.
  //
  // A rate question is not such an amount, even though it carries one. It is built with a synthetic unit probe of its
  // own, so reading that probe as "they named a size" makes every rate question after the first in a conversation
  // retire itself: "USD to Naira" answers "$1 = ₦1,378.98", and "Naira to usd" straight after answers "₦1 currently
  // gives approximately <$0.01" — the same question, degraded, because the turn before it existed.
  if (merged.rateOnly === true && next.rateOnly !== true && next.amount?.value !== undefined) {
    const { rateOnly: _retired, ...rest } = merged;
    return rest;
  }
  return merged;
}

/**
 * Folds a newly extracted intent into the active one, deterministically and without inventing
 * anything:
 * - values the user states now replace earlier ones; everything else is kept;
 * - a different operation never inherits fields from the old one;
 * - informational intents never touch the active intent.
 */
export function mergeAgentIntent(
  active: AgentIntent | undefined,
  incoming: AgentIntent,
): MergeOutcome {
  if (!isTransactionalIntent(incoming)) return { kind: "SIDE_REQUEST", intent: incoming };
  // A first or replacing statement gets the same reading as a merged one: "swap 200 from naira" names its side in the
  // same breath, and should no more be asked what the 200 is in than if it had arrived a turn later.
  if (!active || !isTransactionalIntent(active)) return { kind: "NEW", intent: denominated(incoming) };
  if (active.type !== incoming.type) return { kind: "REPLACED", intent: denominated(incoming) };

  if (active.type === "SEND" && incoming.type === "SEND") {
    return { kind: "MERGED", intent: mergeSend(active, incoming) };
  }
  if (active.type === "CONVERT" && incoming.type === "CONVERT") {
    return { kind: "MERGED", intent: mergeConvert(active, incoming) };
  }
  if (active.type === "QUOTE" && incoming.type === "QUOTE") {
    return { kind: "MERGED", intent: mergeQuote(active, incoming) };
  }
  return { kind: "REPLACED", intent: incoming };
}

/** The same operation without its explicit funding preference ("don't use USDT"). */
export function withoutSourcePreference(intent: AgentIntent): AgentIntent {
  if (intent.type !== "SEND" || intent.sourceAsset === undefined) return intent;
  const { sourceAsset: _removed, ...rest } = intent;
  return rest;
}
