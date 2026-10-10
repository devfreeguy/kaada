import { aggregateFees } from "@kaada/domain";
import type { Asset, AssetRegistry, AmountMode, Money, PaymentRoute, Quote } from "@kaada/domain";

import type { AuthorizationSummary, MoneyView } from "../responses/agent-response.js";
import { formatAmount } from "../routing/format.js";
import { maxSpend, minReceive, totalSlippageBps } from "./bounds.js";

export interface PricedSummary {
  summary: AuthorizationSummary;
  fees: MoneyView[];
  slippageBps: number;
  mock: boolean;
  indicative: boolean;
}

/**
 * Turns a stored, priced route into what a person is asked to authorize. The limits come from
 * bounds.ts, the same functions the authorization itself uses, so the screen and the approval can
 * never disagree. Presentation strings are for people only; `amount` stays the canonical value.
 */
export async function buildPricedSummary(input: {
  route: PaymentRoute;
  quotes: readonly Quote[];
  mode: AmountMode;
  recipient?: string;
  assets: Pick<AssetRegistry, "getById">;
}): Promise<PricedSummary> {
  const cache = new Map<string, Asset>();
  const view = async (money: Money): Promise<MoneyView> => {
    let asset = cache.get(money.assetId);
    if (!asset) {
      const found = await input.assets.getById(money.assetId);
      if (!found) throw new Error(`unknown asset ${money.assetId}`);
      asset = found;
      cache.set(asset.id, asset);
    }
    return {
      amount: money.amount,
      assetId: money.assetId,
      symbol: asset.symbol,
      display: `${formatAmount(money.amount, asset.decimals)} ${asset.symbol}`,
    };
  };

  const slippageBps = totalSlippageBps(input.quotes);
  const fees = await Promise.all(
    aggregateFees(input.quotes.map((quote) => quote.fee)).map((fee) => view(fee)),
  );
  return {
    summary: {
      amountMode: input.mode,
      ...(input.recipient && { recipient: input.recipient }),
      senderSpends: await view(input.route.input),
      maximumSpend: await view(maxSpend(input.route, slippageBps, input.mode)),
      recipientReceives: await view(input.route.output),
      minimumReceive: await view(minReceive(input.route, slippageBps, input.mode)),
    },
    fees,
    slippageBps,
    mock: input.quotes.some((quote) => quote.rawProviderData?.["mock"] === true),
    indicative: input.quotes.some((quote) => quote.rawProviderData?.["indicative"] === true),
  };
}
