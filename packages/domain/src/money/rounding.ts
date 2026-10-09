import { assertDecimals } from "./amount.js";

/*
 * Explicit rounding for money. Everything here is BigInt integer arithmetic; nothing rounds
 * implicitly. The policy Kaada applies to prices:
 *
 *   EXACT_INPUT  ("spend exactly 20 USDT")      the input is never exceeded and the OUTPUT is
 *                                               rounded DOWN to a whole smallest unit.
 *   EXACT_OUTPUT ("they receive exactly 500")   the OUTPUT is never short and the required INPUT is
 *                                               rounded UP to a whole smallest unit.
 *   Fees, and the maximum spend allowed by slippage, round UP; a minimum receive rounds DOWN.
 *
 * The side that could otherwise favour a rounding error is always the provider's, never the user's.
 */

function assertPositive(divisor: bigint): void {
  if (divisor <= 0n) throw new RangeError("divisor must be positive");
}

/** floor(numerator / divisor) for non-negative numerators. */
export function divRoundDown(numerator: bigint, divisor: bigint): bigint {
  assertPositive(divisor);
  return numerator / divisor;
}

/** ceil(numerator / divisor) for non-negative numerators. */
export function divRoundUp(numerator: bigint, divisor: bigint): bigint {
  assertPositive(divisor);
  return (numerator + divisor - 1n) / divisor;
}

export type RoundingMode = "DOWN" | "UP";

/** floor or ceil of (value * numerator / denominator). */
export function mulDiv(
  value: bigint,
  numerator: bigint,
  denominator: bigint,
  rounding: RoundingMode,
): bigint {
  return rounding === "DOWN"
    ? divRoundDown(value * numerator, denominator)
    : divRoundUp(value * numerator, denominator);
}

/**
 * Re-expresses an amount at another precision with no change in value ("500.00" at 2 decimals is
 * 500 * 10^16 at 18). Going to more decimals is exact; going to fewer rounds as requested.
 */
export function rescaleAmount(
  amount: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: RoundingMode = "DOWN",
): bigint {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (toDecimals >= fromDecimals) return amount * 10n ** BigInt(toDecimals - fromDecimals);
  return mulDiv(amount, 1n, 10n ** BigInt(fromDecimals - toDecimals), rounding);
}

/** An exact rational rate: output units per input unit, both in human (not smallest) units. */
export interface Rate {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

/**
 * Output for a given input at a rate, rounded DOWN to a smallest unit (EXACT_INPUT).
 * 1 USDT = 5.42 wBRL is { numerator: 542n, denominator: 100n }.
 */
export function outputForInput(
  input: bigint,
  rate: Rate,
  inputDecimals: number,
  outputDecimals: number,
): bigint {
  assertDecimals(inputDecimals);
  assertDecimals(outputDecimals);
  return divRoundDown(
    input * rate.numerator * 10n ** BigInt(outputDecimals),
    rate.denominator * 10n ** BigInt(inputDecimals),
  );
}

/**
 * The smallest input that yields at least `output` at a rate, rounded UP (EXACT_OUTPUT). Feeding the
 * result to outputForInput never gives less than `output`.
 */
export function inputForOutput(
  output: bigint,
  rate: Rate,
  inputDecimals: number,
  outputDecimals: number,
): bigint {
  assertDecimals(inputDecimals);
  assertDecimals(outputDecimals);
  return divRoundUp(
    output * rate.denominator * 10n ** BigInt(inputDecimals),
    rate.numerator * 10n ** BigInt(outputDecimals),
  );
}

const BPS = 10_000n;

/** A basis-point share of an amount, rounded as requested. Fees use UP. */
export function bpsOf(amount: bigint, bps: bigint, rounding: RoundingMode): bigint {
  return mulDiv(amount, bps, BPS, rounding);
}
