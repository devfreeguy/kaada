import type { Asset } from "../assets/index.js";
import { MAX_DECIMALS, rescaleAmount } from "../money/index.js";
import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { PlannedRoute } from "./planned-route.js";

/**
 * Deterministic route ranking. Only routes that already passed validation and honour the fixed side
 * are ranked, so the order below starts after "valid" and "satisfies the mode":
 *
 *   1. EXACT_OUTPUT: lowest source cost.   EXACT_INPUT: highest destination output.
 *   2. Lower fees.
 *   3. Fewer hops.
 *   4. Lower slippage.
 *   5. A stable tie-breaker on the route key.
 *
 * The first criterion is strict: a two-step route that is genuinely better beats a direct one, and an
 * equal one loses on hop count. Amounts of different assets are compared only when the assets
 * represent the same currency (their `fiatCode`), at par, re-expressed at a common precision; across
 * currencies there is no rate, so such amounts are treated as equal and the next criterion decides.
 * Nothing here uses a model or a clock.
 */
export interface RankingContext {
  mode: AmountMode;
  assets: ReadonlyMap<string, Asset>;
}

const COMMON_DECIMALS = MAX_DECIMALS;

/** The amount at a common precision, plus the currency it is denominated in (undefined if unknown). */
function normalized(
  money: Money,
  assets: ReadonlyMap<string, Asset>,
): { currency: string; value: bigint } | undefined {
  const asset = assets.get(money.assetId);
  if (!asset) return undefined;
  return {
    currency: asset.fiatCode ?? asset.id,
    value: rescaleAmount(BigInt(money.amount), asset.decimals, COMMON_DECIMALS, "DOWN"),
  };
}

/** -1 when `a` is cheaper/better than `b` for a "lower is better" amount, 1 when worse, 0 if equal or incomparable. */
function compareLower(a: Money, b: Money, assets: ReadonlyMap<string, Asset>): number {
  const left = normalized(a, assets);
  const right = normalized(b, assets);
  if (!left || !right || left.currency !== right.currency) return 0;
  return left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

/** Fee totals per currency, at a common precision. */
function feeTotals(route: PlannedRoute, assets: ReadonlyMap<string, Asset>): Map<string, bigint> {
  const totals = new Map<string, bigint>();
  for (const fee of route.fees) {
    const value = normalized(fee, assets);
    if (value) totals.set(value.currency, (totals.get(value.currency) ?? 0n) + value.value);
  }
  return totals;
}

function compareFees(a: PlannedRoute, b: PlannedRoute, assets: ReadonlyMap<string, Asset>): number {
  const left = feeTotals(a, assets);
  const right = feeTotals(b, assets);
  for (const currency of [...left.keys()].filter((key) => right.has(key)).sort()) {
    const x = left.get(currency) ?? 0n;
    const y = right.get(currency) ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Negative when `a` ranks before `b`. */
export function compareRoutes(a: PlannedRoute, b: PlannedRoute, context: RankingContext): number {
  const primary =
    context.mode === "EXACT_OUTPUT"
      ? compareLower(a.input, b.input, context.assets)
      : -compareLower(a.output, b.output, context.assets);
  if (primary !== 0) return primary;

  const fees = compareFees(a, b, context.assets);
  if (fees !== 0) return fees;

  if (a.hops.length !== b.hops.length) return a.hops.length - b.hops.length;
  if (a.slippageBps !== b.slippageBps) return a.slippageBps - b.slippageBps;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function rankRoutes(
  routes: readonly PlannedRoute[],
  context: RankingContext,
): PlannedRoute[] {
  return [...routes].sort((a, b) => compareRoutes(a, b, context));
}
