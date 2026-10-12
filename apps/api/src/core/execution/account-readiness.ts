import { CELO_CHAIN_ID } from "@kaada/domain";
import type { DelegatedPermission, Wallet } from "@kaada/domain";

import { hasRoot } from "../roots/root-credentials.js";
import type { ChainState, ExecutionRepositories } from "./ports.js";

/** What the account looks like right now. Gathered by reads only: nothing here deploys or installs. */
export interface AccountSnapshot {
  /** The Kernel account exists on chain. A COUNTERFACTUAL wallet has an address but no code. */
  deployed: boolean;
  /** The wallet has a usable root (a passkey or a device key) to provide the root signature. */
  rootAvailable: boolean;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  /** The wallet's delegated permissions in every state; only ACTIVE installed ones ever count. */
  permissions: DelegatedPermission[];
}

export interface AccountReadinessOptions {
  repositories: Pick<
    ExecutionRepositories,
    "passkeys" | "walletCredentials" | "delegatedPermissions"
  >;
  chain: Pick<ChainState, "isDeployed">;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
}

/**
 * Inspects an account so the plan can say what execution will require. Read-only by construction:
 * it takes read ports only and has no method that writes, signs or sends.
 */
export class AccountReadinessService {
  constructor(private readonly options: AccountReadinessOptions) {}

  async inspect(wallet: Wallet & { address: string }): Promise<AccountSnapshot> {
    const [deployed, rootAvailable, permissions] = await Promise.all([
      this.options.chain.isDeployed({ chainId: CELO_CHAIN_ID, address: wallet.address }),
      hasRoot(this.options.repositories, wallet),
      this.options.repositories.delegatedPermissions.listForWallet(wallet.id),
    ]);
    return {
      deployed,
      rootAvailable,
      infrastructure: this.options.infrastructure,
      permissions,
    };
  }
}
