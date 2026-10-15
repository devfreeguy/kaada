import { TEST_NETWORK_TOKENS, networkTokenId } from "@kaada/config";
import type { AppConfig } from "@kaada/config";
import { evmAddressCodec } from "@kaada/domain";
import type { Asset, AssetRegistry } from "@kaada/domain";

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

/** The registry the balance reader resolves token ids with: test-network tokens first, everything else as before. */
export function withNetworkTokens(registry: AssetRegistry, tokens: Asset[] | null): AssetRegistry {
  if (!tokens) return registry;
  const byId = new Map(tokens.map((token) => [token.id, token]));
  return {
    ...registry,
    getById: async (id) => byId.get(id) ?? registry.getById(id),
  };
}
