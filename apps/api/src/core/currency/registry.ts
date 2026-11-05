/*
 * Who a currency IS, and which words name it.
 *
 * A currency here is an identity (ISO 4217), not a settlement asset: "Argentine Peso" is ARS, which Kaada happens to settle with
 * the wARS token. The join to a token lives in the asset's own `fiatCode` metadata and is made by the asset resolver, never here,
 * and never by matching names or symbols.
 *
 * Resolution answers one of three things, and the third matters as much as the first: a word may name SEVERAL currencies
 * ("peso", "$"). Those are kept apart from the unambiguous ones and are never silently resolved to whichever came first in the
 * list; the caller narrows them (by what this deployment really supports) and, if more than one survives, asks.
 *
 * Phrases are handled by rule rather than by enumeration: a country word and a currency noun combine ("Argentina pesos",
 * "Nigerian money"), so the table below stays small enough to keep correct.
 */

export interface UserCurrency {
  /** ISO 4217 code. The canonical identity. */
  code: string;
  /** The official English name. */
  name: string;
  /** The symbol written before an amount: ₦1,000. */
  symbol: string;
  flag: string;
  /** ISO 3166 alpha-2 countries that use it, first being the one it is named for. */
  countries: readonly string[];
  /**
   * Words and symbols that name THIS currency and no other, after normalization. Resolve on their own.
   * Duplicates across currencies are a programming error and are rejected when this module loads.
   */
  aliases: readonly string[];
  /** Nouns for the unit ("peso", "dollar"), used to read "<country> <noun>" phrases. May be shared with other currencies. */
  nouns: readonly string[];
  /** Words and symbols this currency SHARES with others. Never resolve alone: they produce an ambiguous answer. */
  shared?: readonly string[];
}

/**
 * The currencies Kaada can talk about. Being listed here means Kaada understands the WORDS; whether a payment or conversion can
 * actually be made in one is a separate question, answered from the asset registry and the provider's routes.
 */
export const USER_CURRENCIES: readonly UserCurrency[] = [
  {
    code: "NGN",
    name: "Nigerian Naira",
    symbol: "₦",
    flag: "🇳🇬",
    countries: ["NG"],
    aliases: ["ngn", "naira", "nairas", "naria", "₦", "n₦"],
    nouns: ["naira", "nairas", "naria"],
  },
  {
    code: "BRL",
    name: "Brazilian Real",
    symbol: "R$",
    flag: "🇧🇷",
    countries: ["BR"],
    aliases: ["brl", "real", "reais", "reals", "r$", "brazilian real", "brazilian reais"],
    nouns: ["real", "reais", "reals"],
  },
  {
    code: "ARS",
    name: "Argentine Peso",
    symbol: "AR$",
    flag: "🇦🇷",
    countries: ["AR"],
    aliases: ["ars", "ar$", "arg$"],
    nouns: ["peso", "pesos"],
    shared: ["peso", "pesos"],
  },
  {
    code: "IDR",
    name: "Indonesian Rupiah",
    symbol: "Rp",
    flag: "🇮🇩",
    countries: ["ID"],
    aliases: ["idr", "rupiah", "rupiahs", "rupia", "rupias", "rp"],
    nouns: ["rupiah", "rupiahs", "rupia", "rupias"],
  },
  {
    code: "MXN",
    name: "Mexican Peso",
    symbol: "MX$",
    flag: "🇲🇽",
    countries: ["MX"],
    aliases: ["mxn", "mx$"],
    nouns: ["peso", "pesos"],
    shared: ["peso", "pesos"],
  },
  {
    code: "COP",
    name: "Colombian Peso",
    symbol: "COL$",
    flag: "🇨🇴",
    countries: ["CO"],
    aliases: ["cop", "col$"],
    nouns: ["peso", "pesos"],
    shared: ["peso", "pesos"],
  },
  {
    code: "CLP",
    name: "Chilean Peso",
    symbol: "CLP$",
    flag: "🇨🇱",
    countries: ["CL"],
    aliases: ["clp", "clp$"],
    nouns: ["peso", "pesos"],
    shared: ["peso", "pesos"],
  },
  {
    code: "PEN",
    name: "Peruvian Sol",
    symbol: "S/",
    flag: "🇵🇪",
    countries: ["PE"],
    aliases: ["pen", "sol", "soles", "s/"],
    nouns: ["sol", "soles"],
  },
  {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    flag: "🇺🇸",
    countries: ["US"],
    // "dólar"/"dólares" is how most of the people Kaada serves write it; "dolar"/"dolares" is the same word unaccented, and
    // "dolars" is the misspelling that turns up most. Each is an exact entry, not a fuzzy match: nothing is guessed.
    aliases: [
      "usd",
      "dollar",
      "dollars",
      "dolar",
      "dolars",
      "dolares",
      "dólar",
      "dólares",
      "buck",
      "bucks",
      "us dollar",
      "us dollars",
      "u.s. dollar",
      "$",
      "us$",
    ],
    nouns: ["dollar", "dollars", "dolar", "dolares", "dólar", "dólares"],
  },
];

/**
 * The words that name a country, for "<country> <noun>" and "<country> money" phrases.
 *
 * The Spanish and Portuguese forms are here because the people who say "pesos" mostly write them: "pesos argentinos",
 * "pesos mexicanos". Word order does not matter (the phrase reader looks for a country word and a currency noun anywhere in
 * the phrase), so one entry per spelling covers both "Argentine pesos" and "pesos argentinos".
 */
const COUNTRY_WORDS: Readonly<Record<string, string>> = {
  nigeria: "NG",
  nigerian: "NG",
  nigeriana: "NG",
  nigeriano: "NG",
  brazil: "BR",
  brasil: "BR",
  brazilian: "BR",
  brasilian: "BR",
  brasileiro: "BR",
  brasileiros: "BR",
  argentina: "AR",
  argentine: "AR",
  argentinian: "AR",
  argentinean: "AR",
  argentino: "AR",
  argentinos: "AR",
  argentinas: "AR",
  indonesia: "ID",
  indonesian: "ID",
  mexico: "MX",
  méxico: "MX",
  mexican: "MX",
  mexicano: "MX",
  mexicanos: "MX",
  mejicano: "MX",
  colombia: "CO",
  colombian: "CO",
  colombiano: "CO",
  colombianos: "CO",
  chile: "CL",
  chilean: "CL",
  chileno: "CL",
  chilenos: "CL",
  peru: "PE",
  perú: "PE",
  peruvian: "PE",
  peruano: "PE",
  peruanos: "PE",
  america: "US",
  american: "US",
  americano: "US",
  americanos: "US",
  usa: "US",
  us: "US",
};

/** Words that add nothing to a currency name: "Nigerian MONEY", "the Naira CURRENCY". */
const FILLER_WORDS = new Set(["money", "currency", "currencies", "cash", "the", "a", "an"]);

const BY_CODE = new Map(USER_CURRENCIES.map((currency) => [currency.code, currency]));

/** Lower-cased, trimmed, single-spaced: "  Brazilian   REAL " -> "brazilian real". */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_ALIAS = new Map<string, UserCurrency>();
for (const currency of USER_CURRENCIES) {
  for (const alias of currency.aliases) {
    const existing = BY_ALIAS.get(alias);
    if (existing) {
      throw new Error(
        `currency alias "${alias}" names both ${existing.code} and ${currency.code}: an alias must be unambiguous, list it under "shared" instead`,
      );
    }
    BY_ALIAS.set(alias, currency);
  }
}

const BY_SHARED = new Map<string, UserCurrency[]>();
for (const currency of USER_CURRENCIES) {
  for (const word of currency.shared ?? []) {
    BY_SHARED.set(word, [...(BY_SHARED.get(word) ?? []), currency]);
  }
}

const BY_COUNTRY = new Map<string, UserCurrency>();
for (const currency of USER_CURRENCIES) {
  const [home] = currency.countries;
  if (home && !BY_COUNTRY.has(home)) BY_COUNTRY.set(home, currency);
}

/**
 * What a word or phrase names.
 * - RESOLVED:  exactly one currency.
 * - AMBIGUOUS: several, in catalog order ("pesos"). The caller narrows or asks; it must never just take the first.
 * - UNKNOWN:   nothing in the registry. Not the same as "unsupported".
 */
export type CurrencyResolution =
  | { status: "RESOLVED"; currency: UserCurrency }
  | { status: "AMBIGUOUS"; candidates: UserCurrency[] }
  | { status: "UNKNOWN" };

const UNKNOWN: CurrencyResolution = { status: "UNKNOWN" };

function fromCandidates(candidates: UserCurrency[]): CurrencyResolution {
  const [only] = candidates;
  if (!only) return UNKNOWN;
  return candidates.length === 1
    ? { status: "RESOLVED", currency: only }
    : { status: "AMBIGUOUS", candidates };
}

/**
 * The currency a word or phrase names: "Naira", "₦", "Argentine pesos", "Argentina money", "reais", "pesos" (ambiguous).
 * Token symbols are never currency words: "cNGN" is an asset and resolves as one, elsewhere.
 */
export function resolveCurrencyLabel(label: string): CurrencyResolution {
  const normalized = normalizeLabel(label);
  if (normalized.length === 0) return UNKNOWN;

  const direct = BY_ALIAS.get(normalized);
  if (direct) return { status: "RESOLVED", currency: direct };
  const shared = BY_SHARED.get(normalized);
  if (shared) return fromCandidates(shared);

  // A phrase: drop filler, then read a country word and a currency noun out of what remains.
  const words = normalized.split(/[\s-]+/).filter((word) => word.length > 0 && !FILLER_WORDS.has(word));
  if (words.length === 0) return UNKNOWN;

  const rejoined = words.join(" ");
  if (rejoined !== normalized) {
    const viaFiller = BY_ALIAS.get(rejoined) ?? undefined;
    if (viaFiller) return { status: "RESOLVED", currency: viaFiller };
    const sharedAgain = BY_SHARED.get(rejoined);
    if (sharedAgain) return fromCandidates(sharedAgain);
  }

  const countries = words.flatMap((word) => COUNTRY_WORDS[word] ?? []);
  const country = countries[0];
  // Two different countries named at once ("Nigerian Brazilian") is not a currency.
  if (countries.some((code) => code !== country)) return UNKNOWN;

  const nouns = words.filter((word) =>
    USER_CURRENCIES.some((currency) => currency.nouns.includes(word)),
  );

  if (country !== undefined) {
    const byCountry = BY_COUNTRY.get(country);
    if (!byCountry) return UNKNOWN;
    // "Argentine pesos": the noun must belong to that country's currency, or the phrase is not one we know.
    if (nouns.length > 0 && !nouns.every((noun) => byCountry.nouns.includes(noun))) return UNKNOWN;
    // "Nigerian naira", "Nigerian money", and a bare country word only when it was a phrase about money.
    if (nouns.length > 0 || words.length < normalized.split(/[\s-]+/).length) {
      return { status: "RESOLVED", currency: byCountry };
    }
    return UNKNOWN;
  }

  // No country, but a single currency noun left over ("some pesos", "in reais").
  if (nouns.length > 0) {
    const [noun] = nouns;
    if (noun !== undefined && nouns.every((other) => other === noun)) {
      const matches = USER_CURRENCIES.filter((currency) => currency.nouns.includes(noun));
      return fromCandidates(matches);
    }
  }
  return UNKNOWN;
}

/**
 * The currency a word names when it names exactly one, else undefined. The narrow form of
 * `resolveCurrencyLabel`, for callers with nothing to ask (a balance filter, a display lookup).
 */
export function currencyForLabel(label: string): UserCurrency | undefined {
  const resolution = resolveCurrencyLabel(label);
  return resolution.status === "RESOLVED" ? resolution.currency : undefined;
}

export function currencyByCode(code: string | undefined): UserCurrency | undefined {
  return code === undefined ? undefined : BY_CODE.get(code.trim().toUpperCase());
}

/** The currency of a country ("someone in Brazil" -> BRL), by ISO 3166 alpha-2. */
export function currencyOfCountry(code: string | undefined): UserCurrency | undefined {
  return code === undefined ? undefined : BY_COUNTRY.get(code.trim().toUpperCase());
}

/**
 * The currency of a country WORD ("Argentina", "Brazilian"). Deliberately not part of `resolveCurrencyLabel`: on its own,
 * "Brazil" is a place, not money. It is used only where both sides are already known to be currencies, such as the two sides
 * of a rate pair ("Naira in Argentina"), where naming the country can only mean its currency.
 */
export function currencyForCountryWord(word: string): UserCurrency | undefined {
  const code = COUNTRY_WORDS[normalizeLabel(word)];
  return code === undefined ? undefined : BY_COUNTRY.get(code);
}

/** Whether a word is one of the ambiguous ones, for wording a question about it ("pesos"). */
export function isSharedCurrencyWord(label: string): boolean {
  return BY_SHARED.has(normalizeLabel(label));
}

/**
 * How much of a currency to price when answering "what's the rate?", where the person named no amount.
 *
 * It cannot be one unit. A cross-currency rate is two hops through USDT, and one naira is worth about $0.0007: the first
 * hop prices fine and hands the second hop seven hundred-thousandths of a dollar, which Textile will not quote at all
 * ("Textile has no quote for this request"). The whole plan then fails and the person is told "Pricing is temporarily
 * unavailable" for a pair that works perfectly at any real size — ₦100,000 to Argentine pesos prices on the first try.
 *
 * So each currency is probed at roughly fifty dollars' worth, rounded to something unremarkable. The figure never
 * reaches the person: formatRate divides the priced output by the priced input, so a probe of ₦100,000 and a probe of
 * ₦1 produce the same "₦1 = AR$1.1973" line. It exists only to ask the provider a question it can answer.
 *
 * These are rounded generously on purpose. They need to stay above a provider's minimum, not track a real exchange
 * rate, so ordinary inflation will not invalidate them; a currency that redenominates will.
 */
const RATE_PROBE_AMOUNTS: Readonly<Record<string, string>> = {
  NGN: "100000",
  ARS: "50000",
  IDR: "1000000",
  COP: "200000",
  CLP: "50000",
  MXN: "1000",
  BRL: "250",
  PEN: "200",
  USD: "50",
};

/** The default for a currency with no entry: fifty of it, which is a real size in any currency Kaada settles. */
const DEFAULT_RATE_PROBE = "50";

/**
 * The amount to price a rate question with, for the currency an asset stands for. Falls back to a plain fifty, which is
 * still far above the dust that one unit of a low-value currency becomes after a hop.
 */
export function rateProbeAmount(fiatCode: string | undefined): string {
  const code = fiatCode?.trim().toUpperCase();
  return (code === undefined ? undefined : RATE_PROBE_AMOUNTS[code]) ?? DEFAULT_RATE_PROBE;
}
