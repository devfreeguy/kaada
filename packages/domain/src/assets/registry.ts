import { KaadaError } from "../errors/index.js";
import type { Asset, AssetKind } from "./asset.js";

/** Persistence port for assets. Implemented in @kaada/database. */
export interface AssetRepository {
  findById(id: string): Promise<Asset | null>;
  /** Case-insensitive symbol match. */
  findBySymbol(symbol: string, options?: { chainId?: number }): Promise<Asset[]>;
  /** Case-insensitive ISO 4217 code match. */
  findByFiatCode(code: string): Promise<Asset[]>;
  listActive(): Promise<Asset[]>;
  /** Every asset including inactive ones; the table is small and changes rarely. */
  listAll(): Promise<Asset[]>;
}

export interface FindAssetOptions {
  chainId?: number;
  kind?: AssetKind;
  /** Inactive assets are hidden unless requested. */
  includeInactive?: boolean;
}

/**
 * Answers "what is this asset?" It deliberately says nothing about whether any provider can trade
 * or route it; that is provider capability data, not asset identity.
 */
export interface AssetRegistry {
  getById(id: string): Promise<Asset | null>;
  findBySymbol(symbol: string, options?: FindAssetOptions): Promise<Asset[]>;
  findByFiatCode(
    code: string,
    options?: Pick<FindAssetOptions, "includeInactive">,
  ): Promise<Asset[]>;
  /** The asset, or ASSET_NOT_SUPPORTED when it does not exist or is inactive. */
  requireActive(id: string): Promise<Asset>;
  /** Decimals for an existing asset (active or not), or ASSET_NOT_SUPPORTED. */
  decimalsOf(id: string): Promise<number>;
}

export function createAssetRegistry(repository: AssetRepository): AssetRegistry {
  const visible = (assets: Asset[], options: FindAssetOptions = {}): Asset[] =>
    assets.filter(
      (asset) =>
        (options.includeInactive === true || asset.isActive) &&
        (options.kind === undefined || asset.kind === options.kind),
    );

  return {
    getById: (id) => repository.findById(id),

    async findBySymbol(symbol, options = {}) {
      const assets = await repository.findBySymbol(
        symbol,
        options.chainId === undefined ? undefined : { chainId: options.chainId },
      );
      return visible(assets, options);
    },

    async findByFiatCode(code, options = {}) {
      return visible(await repository.findByFiatCode(code), options);
    },

    async requireActive(id) {
      const asset = await repository.findById(id);
      if (!asset || !asset.isActive) {
        throw new KaadaError("ASSET_NOT_SUPPORTED", "asset is unknown or inactive", {
          details: { assetId: id },
        });
      }
      return asset;
    },

    async decimalsOf(id) {
      const asset = await repository.findById(id);
      if (!asset) {
        throw new KaadaError("ASSET_NOT_SUPPORTED", "asset is unknown", {
          details: { assetId: id },
        });
      }
      return asset.decimals;
    },
  };
}
