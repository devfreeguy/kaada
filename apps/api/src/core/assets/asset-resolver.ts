import { isUuid } from "@kaada/domain";
import type { Asset, AssetRegistry } from "@kaada/domain";

import { currencyForCountryWord, resolveCurrencyLabel } from "../currency/registry.js";
import type { UserCurrency } from "../currency/registry.js";

export type AssetResolution =
  | { status: "RESOLVED"; asset: Asset }
  | { status: "AMBIGUOUS"; candidates: Asset[] }
  | { status: "NOT_FOUND" };

/**
 * Turns a label a person (or LLM) used - "USD", "USDT", "NGN", "Argentine pesos" - into an asset Kaada knows.
 * It only ever answers from the registry, so an asset that was not seeded cannot be resolved, and
 * it never maps between a fiat currency and a token: "USD" is the dollar, not USDC or USDT.
 *
 * A label may also be an asset id. That is how a selected option is applied: the ambiguous label is
 * replaced by the chosen asset's id, which resolves exactly (and only while the asset is active).
 *
 * A word that names SEVERAL currencies ("pesos") is never resolved to whichever is listed first. It is narrowed by what this
 * deployment actually settles: if exactly one of those currencies has an asset here, that is what the person meant and no
 * question is needed; if more than one does, the caller is handed the candidates and asks.
 */
export interface AssetResolver {
  resolve(label: string): Promise<AssetResolution>;
}

export function createAssetResolver(registry: AssetRegistry): AssetResolver {
  /** Every active asset that settles a currency, by its own `fiatCode` metadata. */
  const assetsOf = async (currency: UserCurrency): Promise<Asset[]> =>
    registry.findByFiatCode(currency.code);

  return {
    async resolve(label) {
      const normalized = label.trim();
      if (normalized.length === 0) return { status: "NOT_FOUND" };

      if (isUuid(normalized)) {
        const asset = await registry.getById(normalized);
        return asset?.isActive ? { status: "RESOLVED", asset } : { status: "NOT_FOUND" };
      }

      // A label can name a fiat currency (by ISO code, a word, a symbol or a phrase) or a token / coin (by symbol).
      // Everyday words and phrases ("Naira", "₦", "R$", "rupiah", "Argentina money") name a CURRENCY first; the currency's own
      // code is then looked up like any other label. A token symbol ("cNGN", "USDT") is not a currency alias.
      const currency = resolveCurrencyLabel(normalized);

      // "pesos": several currencies. Only those this deployment really settles are candidates.
      if (currency.status === "AMBIGUOUS") {
        const perCurrency = await Promise.all(currency.candidates.map(assetsOf));
        const supported = perCurrency.filter((assets) => assets.length > 0);
        const [only] = supported;
        if (supported.length === 0) return { status: "NOT_FOUND" };
        // Exactly one of them is settled here, so the word was not really ambiguous for this person.
        if (supported.length === 1 && only) {
          return only.length === 1 && only[0]
            ? { status: "RESOLVED", asset: only[0] }
            : { status: "AMBIGUOUS", candidates: sorted(only) };
        }
        return { status: "AMBIGUOUS", candidates: sorted(supported.flat()) };
      }

      // A bare country word, in an asset slot, names that country's currency. "Which pesos do you mean?" is answered
      // "mexican" far more often than "Mexican pesos", and that answer can only be about money: it was a reply to a
      // question about money, and nothing but an asset is read from here. resolveCurrencyLabel refuses it on purpose,
      // because "Mexican" on its own is a place; the licence to read it as a currency belongs to this caller, not to it.
      const viaCountry =
        currency.status === "UNKNOWN" ? currencyForCountryWord(normalized) : undefined;

      const lookup =
        currency.status === "RESOLVED"
          ? currency.currency.code
          : (viaCountry?.code ?? normalized);
      const [byFiat, bySymbol] = await Promise.all([
        registry.findByFiatCode(lookup),
        registry.findBySymbol(lookup),
      ]);
      const unique = new Map<string, Asset>();
      for (const asset of [...byFiat, ...bySymbol]) unique.set(asset.id, asset);
      const candidates = sorted([...unique.values()]);

      const [only, ...rest] = candidates;
      if (!only) return { status: "NOT_FOUND" };
      return rest.length === 0
        ? { status: "RESOLVED", asset: only }
        : { status: "AMBIGUOUS", candidates };
    },
  };
}

/**
 * A stable AND meaningful order, so the same question always lists its options the same way and the list reads as a list.
 * Sorting by id was stable but the ids are random uuids, so "which pesos?" offered Colombian, Chilean, Argentine, Mexican in
 * an order nobody could predict or scan. Currency code first, then symbol, then id as the final tie-break.
 */
function sorted(assets: readonly Asset[]): Asset[] {
  return [...assets].sort(
    (a, b) =>
      (a.fiatCode ?? "").localeCompare(b.fiatCode ?? "") ||
      a.symbol.localeCompare(b.symbol) ||
      a.id.localeCompare(b.id),
  );
}

/** A short label for showing an asset to a person, e.g. "USDC (chain 42220)". */
export function describeAsset(asset: Asset): string {
  return asset.chainId === undefined ? asset.symbol : `${asset.symbol} (chain ${asset.chainId})`;
}
