import { bpsOf, createMoney } from "@kaada/domain";
import type {
  AmountMode,
  AuthorizedBounds,
  AuthorizedRoute,
  Money,
  PaymentRoute,
  Quote,
} from "@kaada/domain";

/*
 * The money limits of a priced payment, computed ONCE so that what a person is shown, what they
 * authorize and what a later execution is checked against are the same numbers. Integer arithmetic on
 * smallest units; slippage only ever widens what may be SPENT upward and what must be RECEIVED downward.
 */

/** The most a route can take from the sender. EXACT_INPUT spends exactly the input, never more. */
export function maxSpend(
  route: Pick<PaymentRoute, "input">,
  slippageBps: number,
  mode: AmountMode,
): Money {
  if (mode === "EXACT_INPUT") return route.input;
  const spend = BigInt(route.input.amount);
  return createMoney(
    (spend + bpsOf(spend, BigInt(slippageBps), "UP")).toString(),
    route.input.assetId,
  );
}

/** The least the recipient can end up with. EXACT_OUTPUT delivers exactly the output, never less. */
export function minReceive(
  route: Pick<PaymentRoute, "output">,
  slippageBps: number,
  mode: AmountMode,
): Money {
  if (mode === "EXACT_OUTPUT") return route.output;
  const receive = BigInt(route.output.amount);
  return createMoney(
    (receive - bpsOf(receive, BigInt(slippageBps), "UP")).toString(),
    route.output.assetId,
  );
}

export function totalSlippageBps(quotes: readonly Pick<Quote, "slippageBps">[]): number {
  return quotes.reduce((sum, quote) => sum + (quote.slippageBps ?? 0), 0);
}

export function authorizationBounds(
  route: Pick<PaymentRoute, "input" | "output">,
  slippageBps: number,
  mode: AmountMode,
): AuthorizedBounds {
  return mode === "EXACT_INPUT"
    ? {
        mode,
        authorizedInput: maxSpend(route, slippageBps, mode),
        minimumOutput: minReceive(route, slippageBps, mode),
      }
    : {
        mode,
        exactOutput: minReceive(route, slippageBps, mode),
        maximumInput: maxSpend(route, slippageBps, mode),
      };
}

/** The shape a priced route is approved in: the asset path and the pricing providers. */
export function authorizedRoute(
  route: Pick<PaymentRoute, "input" | "steps">,
  quotes: readonly Pick<Quote, "id" | "rawProviderData">[],
): AuthorizedRoute {
  const swaps = route.steps.filter((step) => step.type === "SWAP");
  const providers = new Set<string>();
  for (const step of swaps) {
    const adapter = quotes.find((quote) => quote.id === step.quoteId)?.rawProviderData?.["adapter"];
    if (typeof adapter === "string" && adapter !== "") providers.add(adapter);
  }
  return {
    assetPath: [route.input.assetId, ...swaps.map((step) => step.output.assetId)],
    providers: [...providers].sort(),
  };
}
