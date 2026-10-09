export interface CountryEntry {
  /** ISO 3166-1 alpha-2. */
  code: string;
  /** ISO 4217 code of the local currency. */
  currency: string;
  /** Lowercase names and spellings people use for the country. */
  names: readonly string[];
}

export interface CountryDirectory {
  /** "Brazil", "brasil", "br" and "BR" all give "BR". Unknown names give undefined. */
  normalize(input: string): string | undefined;
  /** The local currency of a country code, when known. */
  currencyOf(countryCode: string): string | undefined;
}

export function createCountryDirectory(entries: readonly CountryEntry[]): CountryDirectory {
  const byName = new Map<string, string>();
  const currencies = new Map<string, string>();
  for (const entry of entries) {
    currencies.set(entry.code, entry.currency);
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
  };
}

/** Deliberately small: only the countries of the corridors Kaada currently cares about. */
export const defaultCountryDirectory: CountryDirectory = createCountryDirectory([
  { code: "BR", currency: "BRL", names: ["brazil", "brasil"] },
  { code: "AR", currency: "ARS", names: ["argentina"] },
  { code: "NG", currency: "NGN", names: ["nigeria"] },
  { code: "ID", currency: "IDR", names: ["indonesia"] },
  { code: "US", currency: "USD", names: ["united states", "usa", "united states of america"] },
]);
