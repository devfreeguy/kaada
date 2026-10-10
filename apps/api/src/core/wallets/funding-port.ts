import type { WalletFundingPort } from "../routing/funding-resolver.js";
import type { WalletBalanceService } from "./balance-service.js";
import type { WalletService } from "./wallet-service.js";

/**
 * Gives routing the two facts it may ask the wallet side for: the address of an ACTIVE wallet and
 * fresh balances at it. Routing receives this narrow port, never the wallet or balance services.
 */
export class WalletServiceFundingPort implements WalletFundingPort {
  constructor(
    private readonly deps: {
      wallets: Pick<WalletService, "getWallet">;
      balances: Pick<WalletBalanceService, "balancesOf">;
    },
  ) {}

  async activeAddress(userId: string): Promise<string | null> {
    const wallet = await this.deps.wallets.getWallet(userId);
    return wallet?.status === "ACTIVE" && wallet.address !== undefined ? wallet.address : null;
  }

  balancesOf(address: string, assetIds: string[]): Promise<Map<string, bigint>> {
    return this.deps.balances.balancesOf(address, assetIds);
  }
}
