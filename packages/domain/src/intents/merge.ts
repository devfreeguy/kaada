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

type TransactionalIntent = SendIntent | ConvertIntent | QuoteIntent;

/** Intents that describe a money operation and can be built up over several messages. */
export function isTransactionalIntent(intent: AgentIntent): intent is TransactionalIntent {
  return intent.type === "SEND" || intent.type === "CONVERT" || intent.type === "QUOTE";
}

/** Drops keys whose value is undefined so they cannot overwrite real values when spread. */
function compact<T extends object>(value: T): T {
  const entries: [string, unknown][] = Object.entries(value);
  return Object.fromEntries(entries.filter(([, entry]) => entry !== undefined)) as unknown as T;
}

const sameCurrency = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.trim().toLowerCase() === b.trim().toLowerCase();

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

function mergeDestination(
  previous: Destination | undefined,
  next: Destination | undefined,
): Destination | undefined {
  return previous || next ? { ...compact(previous ?? {}), ...compact(next ?? {}) } : undefined;
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

function mergeConvert(previous: ConvertIntent, next: ConvertIntent): ConvertIntent {
  return compact({
    ...compact(previous),
    ...compact(next),
    amount: mergeAmount(previous.amount, next.amount),
    constraints: mergeConstraints(previous.constraints, next.constraints),
  });
}

function mergeQuote(previous: QuoteIntent, next: QuoteIntent): QuoteIntent {
  return compact({
    ...compact(previous),
    ...compact(next),
    amount: mergeAmount(previous.amount, next.amount),
    destination: mergeDestination(previous.destination, next.destination),
    constraints: mergeConstraints(previous.constraints, next.constraints),
  });
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
  if (!active || !isTransactionalIntent(active)) return { kind: "NEW", intent: incoming };
  if (active.type !== incoming.type) return { kind: "REPLACED", intent: incoming };

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
