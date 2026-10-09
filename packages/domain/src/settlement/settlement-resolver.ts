import type { Asset, AssetRegistry } from "../assets/index.js";

/** Celo mainnet. Every settlement asset Kaada routes through today lives on this chain. */
export const CELO_CHAIN_ID = 42220;

export const SETTLEMENT_UNSUPPORTED_REASONS = [
  /** No active token on the chain is marked as representing this currency. */
  "NO_SETTLEMENT_ASSET",
  /** The asset id is not known. */
  "UNKNOWN_ASSET",
  /** The asset exists but has been deactivated. */
  "ASSET_INACTIVE",
  /** The asset is a token on another chain (or has no chain at all and is not a currency). */
  "WRONG_CHAIN",
] as const;
export type SettlementUnsupportedReason = (typeof SETTLEMENT_UNSUPPORTED_REASONS)[number];

/**
 * What a human currency or an asset means on a chain.
 * - RESOLVED:    exactly one eligible settlement asset.
 * - AMBIGUOUS:   several eligible assets (for example more than one USD stablecoin). Nothing is
 *                chosen; callers get every candidate.
 * - UNSUPPORTED: none, with the reason.
 *
 * "Eligible" is read from explicit Asset metadata (an active token on the chain whose `fiatCode` is
 * the currency), never from naming conventions: BRL does not become wBRL because of the letter w.
 * It also says nothing about whether any provider can trade the asset or whether anyone owns it.
 */
export type SettlementResolution =
  | { status: "RESOLVED"; denomination: string; assets: [Asset] }
  | { status: "AMBIGUOUS"; denomination: string; assets: Asset[] }
  | { status: "UNSUPPORTED"; denomination: string; reason: SettlementUnsupportedReason };

export interface SettlementAssetResolver {
  /** The settlement assets that represent a currency code (ISO 4217) on a chain. */
  resolveCurrency(request: { chainId: number; fiatCode: string }): Promise<SettlementResolution>;
  /**
   * An asset Kaada was given by id. A fiat asset resolves like its currency; a token resolves to
   * itself when it is active and on the chain (an explicit choice is never second-guessed).
   */
  resolveAsset(request: { chainId: number; assetId: string }): Promise<SettlementResolution>;
}

function classify(denomination: string, assets: Asset[]): SettlementResolution {
  const sorted = [...assets].sort((a, b) => a.id.localeCompare(b.id));
  const [only, ...rest] = sorted;
  if (!only) return { status: "UNSUPPORTED", denomination, reason: "NO_SETTLEMENT_ASSET" };
  return rest.length === 0
    ? { status: "RESOLVED", denomination, assets: [only] }
    : { status: "AMBIGUOUS", denomination, assets: sorted };
}

export function createSettlementAssetResolver(registry: AssetRegistry): SettlementAssetResolver {
  async function resolveCurrency(request: {
    chainId: number;
    fiatCode: string;
  }): Promise<SettlementResolution> {
    const denomination = request.fiatCode.trim().toUpperCase();
    const tokens = await registry.findByDenomination(denomination, { chainId: request.chainId });
    return classify(denomination, tokens);
  }

  return {
    resolveCurrency,

    async resolveAsset({ chainId, assetId }) {
      const asset = await registry.getById(assetId);
      if (!asset) return { status: "UNSUPPORTED", denomination: assetId, reason: "UNKNOWN_ASSET" };
      const denomination = asset.fiatCode ?? asset.symbol;
      if (!asset.isActive) return { status: "UNSUPPORTED", denomination, reason: "ASSET_INACTIVE" };

      if (asset.kind === "FIAT") {
        return resolveCurrency({ chainId, fiatCode: asset.fiatCode ?? asset.symbol });
      }
      if (asset.chainId !== chainId) {
        return { status: "UNSUPPORTED", denomination, reason: "WRONG_CHAIN" };
      }
      return { status: "RESOLVED", denomination, assets: [asset] };
    },
  };
}
