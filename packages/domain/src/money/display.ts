import { assertDecimals, assertSmallestUnitAmount } from "./amount.js";

/*
 * The ONE place amounts become text for people. Exact smallest-unit integers go in, a rounded string comes out; nothing here ever
 * feeds back into a balance, a quote, a transaction or an execution value. All arithmetic is BigInt (never floating point), and
 * every rounding is explicit: half up at the displayed precision. A nonzero amount is never shown as a plain zero.
 *
 * Display precision belongs to the CURRENCY, not to the token's decimals: a token with 18 decimals that settles Argentine pesos
 * is still shown to the centavo.
 */

/** How many decimals people expect to see, by ISO 4217 code. Anything not listed uses 2, the usual fiat convention. */
const FIAT_DISPLAY_DECIMALS: Readonly<Record<string, number>> = {
  IDR: 0,
  CLP: 0,
  JPY: 0,
  KRW: 0,
  VND: 0,
  PYG: 0,
  UGX: 0,
  XOF: 0,
  XAF: 0,
  KWD: 3,
  BHD: 3,
  JOD: 3,
  OMR: 3,
  TND: 3,
};

export interface DisplayStyle {
  /** Decimals to round to. */
  decimals: number;
  /**
   * "fixed": a whole amount shows no decimals (₦1,400) and a fractional one shows exactly `decimals` (₦1,658.66).
   * "trim": trailing zeros are dropped (0.634, 0.5).
   */
  fraction: "fixed" | "trim";
  /**
   * What to do with a nonzero amount that would round to zero. "significant" shows it at two significant digits
   * ("0.000042"); "floor" shows the smallest displayable value as a bound ("<0.01"). Never a plain "0".
   */
  tiny: "significant" | "floor";
}

/** A currency's style (ISO 4217): its own decimal convention, fixed fractions, and "<0.01" for dust. */
export function fiatDisplayStyle(code: string): DisplayStyle {
  return {
    decimals: FIAT_DISPLAY_DECIMALS[code.trim().toUpperCase()] ?? 2,
    fraction: "fixed",
    tiny: "floor",
  };
}

/** The style of a token that is not a stand-in for a currency (CELO, USDT held as a token): three decimals, adaptive for dust. */
export const CRYPTO_DISPLAY_STYLE: DisplayStyle = {
  decimals: 3,
  fraction: "trim",
  tiny: "significant",
};

/** "1234567" -> "1,234,567". Digits only. */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Rounds a non-negative `value` holding `scale` decimals to `target` decimals, half up. */
function roundTo(value: bigint, scale: number, target: number): bigint {
  if (target >= scale) return value * 10n ** BigInt(target - scale);
  const divisor = 10n ** BigInt(scale - target);
  const quotient = value / divisor;
  return value % divisor >= (divisor + 1n) / 2n ? quotient + 1n : quotient;
}

/** A non-negative integer holding `scale` decimals, split into its whole and fraction digits. */
function split(value: bigint, scale: number): { whole: string; fraction: string } {
  if (scale === 0) return { whole: value.toString(), fraction: "" };
  const padded = value.toString().padStart(scale + 1, "0");
  return { whole: padded.slice(0, -scale), fraction: padded.slice(-scale) };
}

/** The shared renderer. `value` is a non-negative integer holding `scale` decimals. */
function render(value: bigint, scale: number, style: DisplayStyle): string {
  const rounded = roundTo(value, scale, style.decimals);

  if (value > 0n && rounded === 0n) {
    if (style.tiny === "floor") {
      return `<${style.decimals === 0 ? "1" : `0.${"0".repeat(style.decimals - 1)}1`}`;
    }
    // Two significant digits from the first nonzero decimal: 0.00004213 -> "0.000042".
    const { fraction } = split(value, scale);
    const digits = Math.min(scale, fraction.search(/[1-9]/) + 2);
    const tiny = split(roundTo(value, scale, digits), digits);
    return `0.${tiny.fraction.replace(/0+$/, "")}`;
  }

  const { whole, fraction } = split(rounded, style.decimals);
  const shown =
    style.fraction === "trim"
      ? fraction.replace(/0+$/, "")
      : /[1-9]/.test(fraction)
        ? fraction
        : "";
  return shown === "" ? group(whole) : `${group(whole)}.${shown}`;
}

/**
 * Formats a smallest-unit amount (`amount` at `assetDecimals`) in `style`: grouped, rounded, no symbol.
 * Dust below the displayable minimum follows `style.tiny`, so a nonzero balance never reads as zero.
 */
export function formatDisplayAmount(
  amount: string,
  assetDecimals: number,
  style: DisplayStyle,
): string {
  assertSmallestUnitAmount(amount);
  assertDecimals(assetDecimals);
  assertDecimals(style.decimals);
  return render(BigInt(amount), assetDecimals, style);
}

/**
 * How much `output` one unit of `input` buys, as text: at least two decimals and about five significant digits
 * ("1,658.66", "1.0523", "0.00094"). Computed exactly from the two smallest-unit amounts; undefined if either side is zero.
 */
export function formatRate(
  input: { amount: string; decimals: number },
  output: { amount: string; decimals: number },
): string | undefined {
  assertSmallestUnitAmount(input.amount);
  assertSmallestUnitAmount(output.amount);
  assertDecimals(input.decimals);
  assertDecimals(output.decimals);
  const inAmount = BigInt(input.amount);
  const outAmount = BigInt(output.amount);
  if (inAmount === 0n || outAmount === 0n) return undefined;

  // rate = (out / 10^outDecimals) / (in / 10^inDecimals), held to PRECISION decimals, rounded half up.
  const PRECISION = 18;
  const numerator = outAmount * 10n ** BigInt(input.decimals + PRECISION);
  const denominator = inAmount * 10n ** BigInt(output.decimals);
  const scaled = (numerator * 2n + denominator) / (denominator * 2n);
  if (scaled === 0n) return undefined;

  const { whole, fraction } = split(scaled, PRECISION);
  const integerDigits = whole === "0" ? 0 : whole.length;
  const decimals =
    integerDigits > 0
      ? Math.max(2, 5 - integerDigits)
      : Math.min(PRECISION, fraction.search(/[1-9]/) + 5);
  const text = render(scaled, PRECISION, { decimals, fraction: "trim", tiny: "significant" });

  // A rate always reads with at least two decimals: "1.5" is shown as "1.50".
  const [shownWhole = "0", shownFraction = ""] = text.split(".");
  return shownFraction.length >= 2 ? text : `${shownWhole}.${shownFraction.padEnd(2, "0")}`;
}
