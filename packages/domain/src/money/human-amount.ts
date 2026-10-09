import { KaadaError } from "../errors/index.js";
import { assertDecimals, assertSmallestUnitAmount, bigIntToAmount } from "./amount.js";

/**
 * An amount as a person or an LLM wrote it: a decimal string plus an unresolved currency or asset
 * label ("USD", "USDT"). It is NOT money: it has no asset id and must never be persisted as a
 * canonical amount. Resolve it to Money with moneyFromHuman once the asset is known.
 */
export interface HumanAmount {
  value: string;
  currencyOrAsset: string;
}

const MAX_HUMAN_LENGTH = 100;

/** Digits, optionally followed by "." and at least one digit. No sign, exponent, commas or ".5". */
const HUMAN_AMOUNT = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Same syntax check as parseHumanAmount, without needing decimals. Outer whitespace is trimmed. */
export function isHumanAmountValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_HUMAN_LENGTH && HUMAN_AMOUNT.test(trimmed);
}

/**
 * Converts a decimal string to a smallest-unit amount, exactly.
 *
 * - Outer whitespace is trimmed; anything else non-numeric is rejected.
 * - Never rounds: more fractional digits than `decimals` is rejected, unless the extra digits are
 *   all zeros ("20.500" with 2 decimals is exactly 2050).
 * - ".5" and "1." are rejected on purpose: a missing digit is more likely a typo than intent.
 * - Thousands separators must be removed by the caller before parsing.
 */
export function parseHumanAmount(value: string, decimals: number): string {
  assertDecimals(decimals);
  if (typeof value !== "string") {
    throw new KaadaError("INVALID_AMOUNT", "amount must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_HUMAN_LENGTH) {
    throw new KaadaError("INVALID_AMOUNT", "amount is empty or too long");
  }
  const match = HUMAN_AMOUNT.exec(trimmed);
  if (!match) {
    throw new KaadaError("INVALID_AMOUNT", "amount must be a plain decimal number such as 20.50");
  }

  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").slice(1).replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new KaadaError(
      "INVALID_AMOUNT",
      `amount has more than ${decimals} decimal places and would require rounding`,
      { details: { decimals } },
    );
  }
  return bigIntToAmount(BigInt(whole + fraction.padEnd(decimals, "0")));
}

/** Exact decimal rendering of a smallest-unit amount. Keeps every digit: 1 at 6 decimals is "0.000001". */
export function formatSmallestUnit(amount: string, decimals: number): string {
  assertSmallestUnitAmount(amount);
  assertDecimals(decimals);
  if (decimals === 0) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}
