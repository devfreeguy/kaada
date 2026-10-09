const MAX_SPOKEN_LENGTH = 40;

const PLAIN = /^[0-9]+(\.[0-9]+)?$/;
/** US-style thousands separators: "1,000" and "12,345,678.90". */
const COMMA_THOUSANDS = /^[1-9][0-9]{0,2}(,[0-9]{3})+(\.[0-9]+)?$/;
/** "1.000" or "12.345.678": a thousands separator in many locales but a decimal point in others. */
const AMBIGUOUS_DOT_GROUPS = /^[1-9][0-9]{0,2}(\.[0-9]{3})+$/;
/** A plain number followed by k (thousand) or m (million), e.g. "10k", "2.5k", "1.2 m". */
const SUFFIXED = /^([0-9]+(?:\.[0-9]+)?)\s?([kKmM])$/;

/** Moves the decimal point right by `places` using digit strings only: no floating point. */
function shiftDecimalRight(value: string, places: number): string {
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = fraction.padEnd(places, "0");
  const moved = padded.slice(0, places);
  const rest = padded.slice(places);
  const integer = (whole + moved).replace(/^0+(?=[0-9])/, "");
  return rest.length > 0 ? `${integer}.${rest}` : integer;
}

/**
 * Turns a number as people write it into the plain decimal string that parseHumanAmount accepts, or
 * returns undefined when the text is not a number or could mean more than one thing.
 *
 * Accepted: "20", "20.50", "10,000", "1,234,567.89", "10k", "2.5k", "1.2m".
 * Refused (undefined): "1.000" and "12.345.678" (thousands separator or decimal point?), "20,50"
 * (decimal comma), "1,5", currency symbols, signs, exponents, words. Callers should treat a refusal
 * as "ask again", never guess.
 *
 * The result is still a human decimal. Converting it to a smallest-unit amount for a specific asset
 * remains the job of parseHumanAmount, which also refuses anything that would need rounding.
 */
export function normalizeSpokenAmount(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_SPOKEN_LENGTH) return undefined;

  const suffixed = SUFFIXED.exec(trimmed);
  if (suffixed) {
    const base = suffixed[1] ?? "";
    if (AMBIGUOUS_DOT_GROUPS.test(base)) return undefined;
    return shiftDecimalRight(base, (suffixed[2] ?? "").toLowerCase() === "k" ? 3 : 6);
  }
  if (COMMA_THOUSANDS.test(trimmed)) return trimmed.replace(/,/g, "");
  if (AMBIGUOUS_DOT_GROUPS.test(trimmed)) return undefined;
  return PLAIN.test(trimmed) ? trimmed : undefined;
}
