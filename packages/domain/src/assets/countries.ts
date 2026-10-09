export interface CountryEntry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** ISO 4217 code of the local currency. */
  currency: string;
  /** The name to show people. */
  name: string;
  /** Lowercase names and spellings people use for the country. */
  names: readonly string[];
}

export interface CountryDirectory {
  /** "Brazil", "brasil", "br" and "BR" all give "BR". Unknown names give undefined. */
  normalize(input: string): string | undefined;
  /** The local currency of a country code, when known. */
  currencyOf(countryCode: string): string | undefined;
  /** A name to show people ("Brazil"), or the code itself when the country is not in the directory. */
  labelOf(countryCode: string): string;
}

export function createCountryDirectory(entries: readonly CountryEntry[]): CountryDirectory {
  const byName = new Map<string, string>();
  const currencies = new Map<string, string>();
  const labels = new Map<string, string>();
  for (const entry of entries) {
    currencies.set(entry.code, entry.currency);
    labels.set(entry.code, entry.name);
    byName.set(entry.code.toLowerCase(), entry.code);
    for (const name of entry.names) byName.set(name.toLowerCase(), entry.code);
  }

  return {
    normalize(input) {
      const key = input.trim().toLowerCase();
      if (key.length === 0) return undefined;
      const known = byName.get(key);
      if (known) return known;
      // Any other two-letter value is passed through as a country code.
      return /^[a-z]{2}$/.test(key) ? key.toUpperCase() : undefined;
    },
    currencyOf: (countryCode) => currencies.get(countryCode.toUpperCase()),
    labelOf: (countryCode) => labels.get(countryCode.toUpperCase()) ?? countryCode.toUpperCase(),
  };
}

/** Deliberately small: only the countries of the corridors Kaada currently cares about. */
export const defaultCountryDirectory: CountryDirectory = createCountryDirectory([
  { code: "BR", name: "Brazil", currency: "BRL", names: ["brazil", "brasil"] },
  { code: "AR", name: "Argentina", currency: "ARS", names: ["argentina"] },
  { code: "NG", name: "Nigeria", currency: "NGN", names: ["nigeria"] },
  { code: "ID", name: "Indonesia", currency: "IDR", names: ["indonesia"] },
  {
    code: "US",
    name: "United States",
    currency: "USD",
    names: ["united states", "usa", "united states of america"],
  },
]);
