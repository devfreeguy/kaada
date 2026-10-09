import type { Intent } from "./intent.js";

/** The parts of an intent that, when they change, make anything derived from it stale. */
type FinancialView = Pick<
  Intent,
  | "type"
  | "amount"
  | "sourceAssetId"
  | "destinationAssetId"
  | "preferredSourceAssetId"
  | "recipientId"
  | "destinationCountry"
  | "constraints"
>;

function fingerprint(intent: FinancialView): string {
  return JSON.stringify([
    intent.type,
    intent.amount
      ? [intent.amount.money.amount, intent.amount.money.assetId, intent.amount.mode]
      : null,
    intent.sourceAssetId ?? null,
    intent.destinationAssetId ?? null,
    intent.preferredSourceAssetId ?? null,
    intent.recipientId ?? null,
    intent.destinationCountry ?? null,
    // Key order must not matter.
    intent.constraints
      ? Object.entries(intent.constraints)
          .filter(([, value]) => value !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
      : null,
  ]);
}

/**
 * True when `next` differs from `previous` in anything a quote or route would depend on: amount,
 * amount mode, source or destination asset, funding preference, recipient, destination country,
 * constraints, or the operation itself. Status, missing fields and the human-level `parsed` data do
 * not count, so asking a question or restating the same details never invalidates anything.
 * A brand-new intent (no previous) is not a change.
 */
export function hasFinancialChange(
  previous: FinancialView | undefined,
  next: FinancialView,
): boolean {
  return previous !== undefined && fingerprint(previous) !== fingerprint(next);
}
