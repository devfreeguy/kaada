import { formatSmallestUnit } from "@kaada/domain";

/**
 * What people think in, as opposed to what Kaada settles in.
 *
 * A UserCurrency is a familiar currency (Naira, Real, Peso, Rupiah, Dollar). A settlement asset is a token on a chain (cNGN,
 * wBRL, wARS, IDRX, USDC/USDT) with an exact contract address, decimals and smallest-unit amounts. The two are joined by the
 * asset's own `fiatCode` metadata, never by naming conventions, and the join is used for WORDS only: routing, balances,
 * authorization and execution keep working on asset ids, chain ids, contract addresses and smallest-unit integers. Nothing
 * financial is ever done with a display string like "Naira".
 */
export interface UserCurrency {
  /** ISO 4217 code. */
  code: string;
  name: string;
  /** The symbol written before an amount: ₦1,000. */
  symbol: string;
  flag: string;
  /** Lower-case words and symbols that name the currency, after normalization (see `normalizeLabel`). */
  aliases: readonly string[];
}

export const USER_CURRENCIES: readonly UserCurrency[] = [
  {
    code: "NGN",
    name: "Nigerian Naira",
    symbol: "₦",
    flag: "🇳🇬",
    aliases: ["ngn", "naira", "nairas", "nigerian naira", "nigerian nairas", "₦"],
  },
  {
    code: "BRL",
    name: "Brazilian Real",
    symbol: "R$",
    flag: "🇧🇷",
    aliases: ["brl", "real", "reais", "brazilian real", "brazilian reais", "r$"],
  },
  {
    code: "ARS",
    name: "Argentine Peso",
    symbol: "AR$",
    flag: "🇦🇷",
    aliases: ["ars", "peso", "pesos", "argentine peso", "argentine pesos", "ar$"],
  },
  {
    code: "IDR",
    name: "Indonesian Rupiah",
    symbol: "Rp",
    flag: "🇮🇩",
    aliases: ["idr", "rupiah", "rupiahs", "indonesian rupiah", "indonesian rupiahs", "rp"],
  },
  {
    code: "MXN",
    name: "Mexican Peso",
    symbol: "MX$",
    flag: "🇲🇽",
    aliases: ["mxn", "mexican peso", "mexican pesos", "mx$"],
  },
  {
    code: "COP",
    name: "Colombian Peso",
    symbol: "COL$",
    flag: "🇨🇴",
    aliases: ["cop", "colombian peso", "colombian pesos", "col$"],
  },
  {
    code: "CLP",
    name: "Chilean Peso",
    symbol: "CLP$",
    flag: "🇨🇱",
    aliases: ["clp", "chilean peso", "chilean pesos", "clp$"],
  },
  {
    code: "PEN",
    name: "Peruvian Sol",
    symbol: "S/",
    flag: "🇵🇪",
    aliases: ["pen", "sol", "soles", "peruvian sol", "peruvian soles", "s/"],
  },
  {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    flag: "🇺🇸",
    aliases: ["usd", "dollar", "dollars", "us dollar", "us dollars", "u.s. dollar", "$"],
  },
];

const BY_CODE = new Map(USER_CURRENCIES.map((currency) => [currency.code, currency]));

/** Lower-cased, trimmed, single-spaced: "  Brazilian   REAL " -> "brazilian real". */
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_ALIAS = new Map<string, UserCurrency>(
  USER_CURRENCIES.flatMap((currency) =>
    currency.aliases.map((alias): [string, UserCurrency] => [alias, currency]),
  ),
);

/** The currency a word or symbol names ("Naira", "₦", "R$", "rupiah", "US dollars"), or undefined. Token symbols are not aliases. */
export function currencyForLabel(label: string): UserCurrency | undefined {
  return BY_ALIAS.get(normalizeLabel(label));
}

export function currencyByCode(code: string | undefined): UserCurrency | undefined {
  return code === undefined ? undefined : BY_CODE.get(code.trim().toUpperCase());
}

/** The shape of an asset that matters here. */
export interface AssetLike {
  symbol: string;
  kind?: string;
  fiatCode?: string | undefined;
}

/** The currency an asset represents (from its own `fiatCode` metadata), when Kaada presents it as one. */
export function currencyOfAsset(asset: AssetLike): UserCurrency | undefined {
  return currencyByCode(asset.fiatCode);
}

/** "1234.5" -> "1,234.5". */
export function groupThousands(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}

/** Trailing zeros trimmed: "2.000000" -> "2". */
function trimmed(exact: string): string {
  return exact.includes(".") ? exact.replace(/\.?0+$/, "") : exact;
}

/** A human amount for display: grouped, no trailing zeros. */
export function formatHuman(amount: string, decimals: number): string {
  return groupThousands(trimmed(formatSmallestUnit(amount, decimals)));
}

/**
 * An amount as people say it: "₦300", "R$50", "$15". An asset that is not a familiar currency keeps its symbol ("12.5 XYZ").
 * Display only: it is never parsed back.
 */
export function describeMoney(asset: AssetLike & { decimals: number }, amount: string): string {
  const human = formatHuman(amount, asset.decimals);
  const currency = currencyOfAsset(asset);
  return currency ? `${currency.symbol}${human}` : `${human} ${asset.symbol}`;
}

/** The name of what an asset is, for people: "Nigerian Naira" for the token that settles Naira, else its symbol. */
export function describeAsset(asset: AssetLike): string {
  return currencyOfAsset(asset)?.name ?? asset.symbol;
}

/** One holding, with the smallest-unit amount it came from. */
export interface HeldAsset extends AssetLike {
  decimals: number;
  amount: string;
}

/**
 * What a person holds, by currency: several tokens of one currency (USDT and USDC are both US Dollars) are one entry, summed
 * exactly in smallest units at a common precision. Zero holdings are dropped. Assets that are not a familiar currency are
 * listed by their symbol, after the currencies.
 */
export function summarizeHoldings(
  holdings: readonly HeldAsset[],
): { flag?: string; name: string; amount: string }[] {
  const perCurrency = new Map<string, { currency: UserCurrency; total: bigint; scale: number }>();
  const others: { name: string; amount: string }[] = [];
  for (const held of holdings) {
    if (BigInt(held.amount) === 0n) continue;
    const currency = currencyOfAsset(held);
    if (!currency) {
      others.push({ name: held.symbol, amount: formatHuman(held.amount, held.decimals) });
      continue;
    }
    const current = perCurrency.get(currency.code) ?? { currency, total: 0n, scale: 0 };
    const scale = Math.max(current.scale, held.decimals);
    const total =
      current.total * 10n ** BigInt(scale - current.scale) +
      BigInt(held.amount) * 10n ** BigInt(scale - held.decimals);
    perCurrency.set(currency.code, { currency, total, scale });
  }
  return [
    ...[...perCurrency.values()].map(({ currency, total, scale }) => ({
      flag: currency.flag,
      name: currency.name,
      amount: `${currency.symbol}${formatHuman(total.toString(), scale)}`,
    })),
    ...others,
  ];
}

/**
 * The balance as people read it. One currency: "₦1,000 Nigerian Naira". Several: one line each,
 * "🇳🇬 Nigerian Naira: ₦1,000". Never a token ticker for a familiar currency, never a contract.
 */
export function balanceBlock(holdings: readonly HeldAsset[]): string {
  const entries = summarizeHoldings(holdings);
  const [only] = entries;
  if (entries.length === 1 && only) return `${only.amount} ${only.name}`;
  return entries
    .map((entry) => `${entry.flag ? `${entry.flag} ` : ""}${entry.name}: ${entry.amount}`)
    .join("\n");
}

/**
 * The currencies a set of settlement assets covers, one line each ("🇳🇬 Nigerian Naira"), in the catalog's order. Several tokens
 * of one currency are one line; a token that is not a familiar currency is listed by its symbol, last.
 */
export function describeSupportedCurrencies(assets: readonly AssetLike[]): string[] {
  const codes = new Set(assets.map((asset) => currencyOfAsset(asset)?.code));
  const lines = USER_CURRENCIES.filter((currency) => codes.has(currency.code)).map(
    (currency) => `${currency.flag} ${currency.name}`,
  );
  const others = [
    ...new Set(assets.filter((asset) => !currencyOfAsset(asset)).map((asset) => asset.symbol)),
  ];
  return [...lines, ...others];
}

/** Where a person may say they mainly use Kaada, and the default currency that follows. */
export interface HomeCountry {
  /** ISO 3166 alpha-2. */
  code: string;
  name: string;
  flag: string;
  /** The default currency (ISO 4217), one of USER_CURRENCIES. */
  currency: string;
}

export const HOME_COUNTRIES: readonly HomeCountry[] = [
  { code: "NG", name: "Nigeria", flag: "🇳🇬", currency: "NGN" },
  { code: "BR", name: "Brazil", flag: "🇧🇷", currency: "BRL" },
  { code: "AR", name: "Argentina", flag: "🇦🇷", currency: "ARS" },
  { code: "ID", name: "Indonesia", flag: "🇮🇩", currency: "IDR" },
];

/** "Other": the person chose not to name one of the supported countries. No default currency follows. */
export const OTHER_COUNTRY = "ZZ";

export function homeCountryByCode(code: string | undefined): HomeCountry | undefined {
  return code === undefined ? undefined : HOME_COUNTRIES.find((c) => c.code === code.toUpperCase());
}

/** What choosing a country means: the country to record and the default currency that goes with it (none for Other). */
export function homeFor(code: string): { country: string; currency: string | null } | undefined {
  if (code.toUpperCase() === OTHER_COUNTRY) return { country: OTHER_COUNTRY, currency: null };
  const country = homeCountryByCode(code);
  return country ? { country: country.code, currency: country.currency } : undefined;
}

/** The sentence that confirms a choice: "Nigeria 🇳🇬\nYour default currency will be Nigerian Naira (₦)." */
export function describeHome(home: { country: string; currency: string | null }): string {
  const country = homeCountryByCode(home.country);
  const currency = currencyByCode(home.currency ?? undefined);
  if (!country || !currency) {
    return "Okay. I won't assume a currency for you: just tell me which one when you send money.";
  }
  return `${country.name} ${country.flag}\nYour default currency will be ${currency.name} (${currency.symbol}).`;
}

/** An exact human amount with no grouping, for building a request ("500", "1234.5"). Not for display. */
export function plainAmount(amount: string, decimals: number): string {
  return trimmed(formatSmallestUnit(amount, decimals));
}
