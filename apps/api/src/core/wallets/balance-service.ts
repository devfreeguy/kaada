import {
  CELO_CHAIN_ID,
  KaadaError,
  formatSmallestUnit,
  isNativeCelo,
  isWalletActive,
} from "@kaada/domain";
import type { Asset, AssetRepository, Money, Wallet, WalletBalanceReader } from "@kaada/domain";

import { formatHuman } from "../currency/catalog.js";
import type { WalletService } from "./wallet-service.js";

/** One supported token's balance. `money` is canonical; `formatted` is for people only. */
export interface BalanceLine {
  assetId: string;
  symbol: string;
  decimals: number;
  money: Money;
  formatted: string;
  /** The currency the token represents (its own metadata), for presenting it as one. */
  fiatCode?: string;
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

export const formatTokenAmount = (amount: string, decimals: number): string =>
  formatHuman(amount, decimals);

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
      /**
       * The network balances are read on. Absent means Celo mainnet. A person's wallet has the same address on every network, so
       * the SAME address is read on this one; payments are unaffected (they stay on mainnet).
       */
      network?: { chainId: number; label: string; testnet: boolean };
      /**
       * The supported tokens of a network that does not keep them in the shared registry (a test network). Absent: the active
       * tokens of the network in the registry.
       */
      networkTokens?: () => Promise<Asset[]>;
      /** The least CELO (wei) a transfer needs for its fee. Absent: the fee balance is not checked here. */
      minNativeWei?: bigint;
    },
  ) {}

  /** The chain id balances are read on. */
  get chainId(): number {
    return this.deps.network?.chainId ?? CELO_CHAIN_ID;
  }

  /** How a person is told the network's name. */
  get networkLabel(): string {
    return this.deps.network?.label ?? "Celo";
  }

  get isTestNetwork(): boolean {
    return this.deps.network?.testnet === true;
  }

  /** The active Celo tokens Kaada supports (never discovered from chain history), in plain (locale-independent) symbol order. */
  async supportedTokens(): Promise<Asset[]> {
    if (this.deps.networkTokens) {
      return (await this.deps.networkTokens())
        .filter((asset) => asset.chainId === this.chainId)
        .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
    }
    const active = await this.deps.assets.listActive();
    return active
      .filter(
        (asset) =>
          asset.chainId === this.chainId &&
          asset.contractAddress !== undefined &&
          (asset.kind === "USD_STABLECOIN" ||
            asset.kind === "LOCAL_STABLECOIN" ||
            // CELO itself: held and sent like any token (it is also the coin that pays the network fee).
            isNativeCelo(asset)),
      )
      .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  }

  /**
   * Whether the wallet holds enough CELO to pay a transfer's network fee (the network-fee balance, which is not one of the
   * currencies a person holds). `undefined` when it cannot be read or no limit is set: nothing is claimed either way.
   * `spendingWei` is CELO the payment itself is about to send: the fee must still be there afterwards.
   */
  async enoughForFees(address: string, spendingWei = 0n): Promise<boolean | undefined> {
    const minimum = this.deps.minNativeWei;
    if (minimum === undefined || !this.deps.reader.readNativeBalance) return undefined;
    const have = await this.deps.reader.readNativeBalance({ chainId: this.chainId, address });
    return have >= minimum + spendingWei;
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
      chainId: this.chainId,
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
          ...(token.fiatCode && { fiatCode: token.fiatCode }),
        };
      }),
    };
  }

  /** Balances of the given assets for an address, as smallest-unit bigint by asset id. */
  async balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> {
    const unique = [...new Set(assetIds)];
    const read = await this.deps.reader.readBalances({
      chainId: this.chainId,
      address,
      assetIds: unique,
    });
    return new Map(unique.map((id, index) => [id, BigInt(read.tokens[index]?.amount ?? "0")]));
  }
}
