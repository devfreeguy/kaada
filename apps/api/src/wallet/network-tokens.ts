import { TEST_NETWORK_TOKENS, networkTokenId } from "@kaada/config";
import type { AppConfig } from "@kaada/config";
import { evmAddressCodec } from "@kaada/domain";
import type { Asset, AssetRepository } from "@kaada/domain";

/**
 * The supported tokens of a TEST network, as assets: kept in code, never in the shared registry (a second "cNGN" there would
 * make the symbol ambiguous for every payment request). Null for mainnet, whose tokens are the registry's active assets.
 * Identity is chain id + contract address; the id is derived from exactly those two.
 */
export function testNetworkAssets(config: AppConfig): Asset[] | null {
  const { network, chainId, testnet } = config.wallet.balances;
  if (!testnet || network !== "celo-sepolia") return null;
  return TEST_NETWORK_TOKENS[network].map((token) => {
    const contractAddress = evmAddressCodec.normalize(token.contractAddress);
    return {
      id: networkTokenId(chainId, contractAddress),
      symbol: token.symbol,
      name: token.name,
      kind: token.kind,
      decimals: token.decimals,
      chainId,
      contractAddress,
      fiatCode: token.fiatCode,
      isActive: true,
    };
  });
}

/**
 * A deployment sees ONE network's tokens at a time: the currencies (fiat assets, which are on no chain) and the tokens of the
 * network it runs on. A test network's tokens may sit in the same table as mainnet's (the database holds both, each by chain id
 * + contract), but the other network's are invisible, so "Naira" can only ever mean this network's token and a mainnet
 * contract can never be picked up on a test network (or the reverse).
 */
export function scopeAssetsToChain(repository: AssetRepository, chainId: number): AssetRepository {
  const visible = (asset: Asset): boolean =>
    asset.chainId === undefined || asset.chainId === chainId;
  const only = async (assets: Promise<Asset[]>): Promise<Asset[]> => (await assets).filter(visible);
  return {
    findById: async (id) => {
      const asset = await repository.findById(id);
      return asset && visible(asset) ? asset : null;
    },
    findBySymbol: (symbol, options) => only(repository.findBySymbol(symbol, options)),
    findByFiatCode: (code) => only(repository.findByFiatCode(code)),
    findByDenomination: (code, options) => only(repository.findByDenomination(code, options)),
    listActive: () => only(repository.listActive()),
    listAll: () => only(repository.listAll()),
  };
}
