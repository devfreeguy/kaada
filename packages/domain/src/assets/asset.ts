export const ASSET_KINDS = [
  "FIAT",
  "USD_STABLECOIN",
  "LOCAL_STABLECOIN",
  "CRYPTO",
  "NATIVE_ASSET",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * A currency or token. `decimals` defines how every smallest-unit amount of this asset is read
 * (2 for USD cents, 6 for USDC, 18 for most EVM tokens).
 *
 * Shape by kind (enforced by the database): FIAT has `fiatCode` and no chain; NATIVE_ASSET has a
 * chain and no contract; every other kind is a token with a chain and a contract address.
 */
export interface Asset {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  decimals: number;
  chainId?: number;
  contractAddress?: string;
  fiatCode?: string;
  countryCode?: string;
  isActive: boolean;
}

export function isFiatAsset(asset: Asset): boolean {
  return asset.kind === "FIAT";
}

/** True for assets that live on a chain (native coin or token). */
export function isOnChainAsset(asset: Asset): boolean {
  return asset.chainId !== undefined;
}
