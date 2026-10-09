import { addMoney } from "../money/index.js";
import type { Money } from "../money/index.js";
import type { FxQuote } from "../quotes/index.js";

/** One priced provider step of a planned route. */
export interface PlannedHop {
  /** The provider whose capability rows made this step eligible, e.g. "textile". */
  capabilityProvider: string;
  /** The adapter that priced it, e.g. "mock-textile". Matches FxProvider.id and Provider.slug. */
  providerId: string;
  quote: FxQuote;
  input: Money;
  output: Money;
}

/**
 * A priced, not yet persisted candidate way to move value from the source asset to the destination
 * asset. A TRANSFER has no hops (same asset on both sides); a SWAP has one or two.
 */
export interface PlannedRoute {
  sourceAssetId: string;
  destinationAssetId: string;
  kind: "TRANSFER" | "SWAP";
  hops: PlannedHop[];
  /** What the sender pays. */
  input: Money;
  /** What the recipient gets. */
  output: Money;
  /** Fees per asset. Different assets are never added together. */
  fees: Money[];
  /** Sum of the hops' slippage tolerance, in basis points. */
  slippageBps: number;
  /** The earliest expiry among the quotes; undefined for a TRANSFER. */
  expiresAt?: Date;
  /** Stable identity (providers and assets along the path) used to break ties deterministically. */
  key: string;
}

/** Sums fees by asset. The result is sorted by asset id so it is deterministic. */
export function aggregateFees(fees: readonly (Money | undefined)[]): Money[] {
  const byAsset = new Map<string, Money>();
  for (const fee of fees) {
    if (!fee) continue;
    const existing = byAsset.get(fee.assetId);
    byAsset.set(fee.assetId, existing ? addMoney(existing, fee) : fee);
  }
  return [...byAsset.values()].sort((a, b) => a.assetId.localeCompare(b.assetId));
}
