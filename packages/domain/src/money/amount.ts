import { KaadaError } from "../errors/index.js";

/**
 * Longest accepted amount string. 78 digits covers the full uint256 range, so any on-chain balance
 * fits, while bounding the work done on untrusted input.
 */
export const MAX_AMOUNT_DIGITS = 78;

/** Highest supported asset precision. Matches the CHECK constraint on Asset.decimals. */
export const MAX_DECIMALS = 36;

const CANONICAL_AMOUNT = /^(0|[1-9][0-9]*)$/;

/** True for canonical smallest-unit amounts: a non-negative integer, digits only, no leading zeros. */
export function isSmallestUnitAmount(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_AMOUNT_DIGITS && CANONICAL_AMOUNT.test(value)
  );
}

export function assertSmallestUnitAmount(
  value: unknown,
  label = "amount",
): asserts value is string {
  if (!isSmallestUnitAmount(value)) {
    throw new KaadaError(
      "INVALID_AMOUNT",
      `${label} must be a canonical smallest-unit integer string (digits only, no leading zeros)`,
    );
  }
}

export function assertDecimals(decimals: unknown): asserts decimals is number {
  if (typeof decimals !== "number" || !Number.isInteger(decimals)) {
    throw new KaadaError("INVALID_AMOUNT", "decimals must be an integer");
  }
  if (decimals < 0 || decimals > MAX_DECIMALS) {
    throw new KaadaError("INVALID_AMOUNT", `decimals must be between 0 and ${MAX_DECIMALS}`);
  }
}

/** Exact integer value of a canonical amount. Internal to the money package. */
export function amountToBigInt(amount: string): bigint {
  assertSmallestUnitAmount(amount);
  return BigInt(amount);
}

/** Canonical string for a non-negative bigint. Internal to the money package. */
export function bigIntToAmount(value: bigint, label = "amount"): string {
  if (value < 0n) {
    throw new KaadaError("INSUFFICIENT_AMOUNT", `${label} would be negative`);
  }
  const amount = value.toString();
  assertSmallestUnitAmount(amount, label);
  return amount;
}
