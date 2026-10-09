import { isUuid } from "@kaada/domain";
import type { Asset, AssetRegistry } from "@kaada/domain";

export type AssetResolution =
  | { status: "RESOLVED"; asset: Asset }
  | { status: "AMBIGUOUS"; candidates: Asset[] }
  | { status: "NOT_FOUND" };

/**
 * Turns a label a person (or LLM) used - "USD", "USDT", "NGN" - into an asset Kaada knows.
 * It only ever answers from the registry, so an asset that was not seeded cannot be resolved, and
 * it never maps between a fiat currency and a token: "USD" is the dollar, not USDC or USDT.
 *
 * A label may also be an asset id. That is how a selected option is applied: the ambiguous label is
 * replaced by the chosen asset's id, which resolves exactly (and only while the asset is active).
 */
export interface AssetResolver {
  resolve(label: string): Promise<AssetResolution>;
}

export function createAssetResolver(registry: AssetRegistry): AssetResolver {
  return {
    async resolve(label) {
      const normalized = label.trim();
      if (normalized.length === 0) return { status: "NOT_FOUND" };

      if (isUuid(normalized)) {
        const asset = await registry.getById(normalized);
        return asset?.isActive ? { status: "RESOLVED", asset } : { status: "NOT_FOUND" };
      }

      // A label can name a fiat currency (by ISO code) or a token / coin (by symbol).
      const [byFiat, bySymbol] = await Promise.all([
        registry.findByFiatCode(normalized),
        registry.findBySymbol(normalized),
      ]);
      const unique = new Map<string, Asset>();
      for (const asset of [...byFiat, ...bySymbol]) unique.set(asset.id, asset);
      const candidates = [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));

      const [only, ...rest] = candidates;
      if (!only) return { status: "NOT_FOUND" };
      return rest.length === 0
        ? { status: "RESOLVED", asset: only }
        : { status: "AMBIGUOUS", candidates };
    },
  };
}

/** A short label for showing an asset to a person, e.g. "USDC (chain 42220)". */
export function describeAsset(asset: Asset): string {
  return asset.chainId === undefined ? asset.symbol : `${asset.symbol} (chain ${asset.chainId})`;
}
