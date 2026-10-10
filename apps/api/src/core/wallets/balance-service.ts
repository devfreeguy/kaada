import { CELO_CHAIN_ID, KaadaError, formatSmallestUnit, isWalletActive } from "@kaada/domain";
import type { Asset, AssetRepository, Money, Wallet, WalletBalanceReader } from "@kaada/domain";

import type { WalletService } from "./wallet-service.js";

/** One supported token's balance. `money` is canonical; `formatted` is for people only. */
export interface BalanceLine {
  assetId: string;
  symbol: string;
  decimals: number;
  money: Money;
  formatted: string;
}

export interface WalletBalancesView {
  wallet: Wallet;
  balances: BalanceLine[];
}

/** Trailing zeros trimmed for display: "2.000000" -> "2". Presentation only. */
function display(amount: string, decimals: number): string {
  const exact = formatSmallestUnit(amount, decimals);
  return exact.includes(".") ? exact.replace(/\.?0+$/, "") : exact;
}

/**
 * Reads what a user's wallet holds of the tokens Kaada supports, fresh from the chain every time.
 * The blockchain is the only authority: nothing is cached or stored as a balance, and there is no
 * ledger. Read only: it cannot sign or move funds.
 */
export class WalletBalanceService {
  constructor(
    private readonly deps: {
      assets: Pick<AssetRepository, "listActive">;
      reader: WalletBalanceReader;
      wallets: Pick<WalletService, "getWallet">;
    },
  ) {}

  /** The active Celo tokens Kaada supports (never discovered from chain history), in plain (locale-independent) symbol order. */
  async supportedTokens(): Promise<Asset[]> {
    const active = await this.deps.assets.listActive();
    return active
      .filter(
        (asset) =>
          asset.chainId === CELO_CHAIN_ID &&
          asset.contractAddress !== undefined &&
          (asset.kind === "USD_STABLECOIN" || asset.kind === "LOCAL_STABLECOIN"),
      )
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  /** The user's ACTIVE wallet, or WALLET_NOT_ACTIVE. */
  async activeWallet(userId: string): Promise<Wallet & { address: string }> {
    const wallet = await this.deps.wallets.getWallet(userId);
    if (!wallet || !isWalletActive(wallet)) {
      throw new KaadaError("WALLET_NOT_ACTIVE", "the user has no active wallet");
    }
    return wallet;
  }

  async forUser(userId: string): Promise<WalletBalancesView> {
    const wallet = await this.activeWallet(userId);
    const tokens = await this.supportedTokens();
    const read = await this.deps.reader.readBalances({
      chainId: wallet.chainId,
      address: wallet.address,
      assetIds: tokens.map((token) => token.id),
    });
    return {
      wallet,
      balances: tokens.map((token, index) => {
        const money = read.tokens[index];
        if (!money) throw new Error("the balance reader returned fewer balances than requested");
        return {
          assetId: token.id,
          symbol: token.symbol,
          decimals: token.decimals,
          money,
          formatted: display(money.amount, token.decimals),
        };
      }),
    };
  }

  /** Balances of the given assets for an address, as smallest-unit bigint by asset id. */
  async balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> {
    const unique = [...new Set(assetIds)];
    const read = await this.deps.reader.readBalances({
      chainId: CELO_CHAIN_ID,
      address,
      assetIds: unique,
    });
    return new Map(unique.map((id, index) => [id, BigInt(read.tokens[index]?.amount ?? "0")]));
  }
}
