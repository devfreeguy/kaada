import { CELO_CHAIN_ID } from "@kaada/domain";
import type { DelegatedPermission, Wallet } from "@kaada/domain";

import type { ChainState, ExecutionRepositories } from "./ports.js";

/** What the account looks like right now. Gathered by reads only: nothing here deploys or installs. */
export interface AccountSnapshot {
  /** The Kernel account exists on chain. A COUNTERFACTUAL wallet has an address but no code. */
  deployed: boolean;
  /** At least one unrevoked passkey credential exists to provide the root signature. */
  passkeyRootAvailable: boolean;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
  /** The wallet's delegated permissions in every state; only ACTIVE installed ones ever count. */
  permissions: DelegatedPermission[];
}

export interface AccountReadinessOptions {
  repositories: Pick<ExecutionRepositories, "passkeys" | "delegatedPermissions">;
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
    const [deployed, credentials, permissions] = await Promise.all([
      this.options.chain.isDeployed({ chainId: CELO_CHAIN_ID, address: wallet.address }),
      this.options.repositories.passkeys.listActiveForUser(wallet.userId),
      this.options.repositories.delegatedPermissions.listForWallet(wallet.id),
    ]);
    return {
      deployed,
      passkeyRootAvailable: credentials.length > 0,
      infrastructure: this.options.infrastructure,
      permissions,
    };
  }
}
