import { CELO_CHAIN_ID, KaadaError, createMoney, evmAddressCodec } from "@kaada/domain";
import type {
  Asset,
  AssetRegistry,
  Money,
  WalletBalanceReader,
  WalletBalances,
} from "@kaada/domain";

/** The read-only chain calls the reader needs. Implemented over viem; faked in tests. */
export interface ChainReader {
  /** `balanceOf(owner)` for each token, in order, in ONE batched call where possible. */
  getErc20Balances(owner: string, tokens: string[]): Promise<bigint[]>;
  /** `decimals()` for each token, in order. */
  getErc20Decimals(tokens: string[]): Promise<number[]>;
}

export interface BalanceReaderOptions {
  assets: AssetRegistry;
  chain: ChainReader;
  /** Also compare each token's on-chain `decimals()` with the registry, and refuse a mismatch. */
  verifyDecimals?: boolean;
}

/**
 * READ-ONLY. Reads ERC-20 balances (one batched call) and returns canonical smallest-unit Money in
 * each requested asset. The amounts are never scaled, rounded or turned into floating point: a
 * balance of 1_500_000 of a 6-decimal token is the string "1500000". Decimals matter only when a
 * person is shown the amount, via the asset's own `decimals`.
 */
export class ChainBalanceReader implements WalletBalanceReader {
  constructor(private readonly options: BalanceReaderOptions) {}

  async readBalances(input: {
    chainId: number;
    address: string;
    assetIds: string[];
  }): Promise<WalletBalances> {
    if (input.chainId !== CELO_CHAIN_ID) {
      throw new KaadaError("ASSET_NOT_SUPPORTED", "balances are read on Celo mainnet only");
    }
    const address = evmAddressCodec.normalize(input.address);

    const assets: Asset[] = [];
    for (const id of input.assetIds) {
      const asset = await this.options.assets.getById(id);
      if (!asset || !asset.isActive) {
        throw new KaadaError("ASSET_NOT_SUPPORTED", "asset is unknown or inactive", {
          details: { assetId: id },
        });
      }
      if (asset.chainId !== CELO_CHAIN_ID || asset.contractAddress === undefined) {
        throw new KaadaError("ASSET_NOT_SUPPORTED", "only Celo ERC-20 tokens can be read", {
          details: { assetId: id },
        });
      }
      assets.push(asset);
    }

    const tokens = assets.map((asset) => asset.contractAddress as string);
    if (this.options.verifyDecimals && tokens.length > 0) {
      const onChain = await this.options.chain.getErc20Decimals(tokens);
      assets.forEach((asset, index) => {
        if (onChain[index] !== asset.decimals) {
          throw new KaadaError("ASSET_MISMATCH", "token decimals differ from the asset registry", {
            details: { assetId: asset.id },
          });
        }
      });
    }

    const balances = tokens.length === 0 ? [] : await this.readAll(address, tokens, assets);
    if (balances.length !== assets.length) {
      throw new KaadaError(
        "PROVIDER_UNAVAILABLE",
        "the chain returned an unexpected number of balances",
      );
    }
    const money: Money[] = assets.map((asset, index) =>
      createMoney((balances[index] ?? 0n).toString(), asset.id),
    );
    return { chainId: input.chainId, address, tokens: money };
  }

  /**
   * One batched call. If it fails, each token is asked on its own to find out WHICH one cannot be read, so the failure names a
   * token (an address that is not a contract on this chain, typically a fixture left over from a test network) instead of
   * collapsing every balance into one anonymous error. A token that answers alone means the failure was elsewhere (the RPC),
   * and the original error stands. Nothing is skipped or guessed.
   */
  private async readAll(address: string, tokens: string[], assets: Asset[]): Promise<bigint[]> {
    try {
      return await this.options.chain.getErc20Balances(address, tokens);
    } catch (batchError) {
      for (const [index, token] of tokens.entries()) {
        try {
          await this.options.chain.getErc20Balances(address, [token]);
        } catch {
          const asset = assets[index];
          throw new KaadaError("ASSET_NOT_SUPPORTED", "this token cannot be read on this chain", {
            details: {
              assetId: asset?.id ?? "",
              symbol: asset?.symbol ?? "",
              reason: "NOT_A_TOKEN_CONTRACT",
            },
            cause: batchError,
          });
        }
      }
      throw batchError;
    }
  }
}
