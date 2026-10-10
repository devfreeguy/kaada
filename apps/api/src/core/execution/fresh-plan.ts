import type { ExecutionPlan, TokenPolicy } from "@kaada/domain";

import type { LiveExecution } from "./live-execution.js";
import { buildExecutionPlan } from "./plan-builder.js";
import type { ChainState, ExecutionRepositories } from "./ports.js";
import { defaultTokenPolicy } from "./token-policy.js";

export interface FreshPlanDeps {
  repositories: ExecutionRepositories;
  chain: Pick<ChainState, "allowances" | "isDeployed">;
  tokenPolicy?: TokenPolicy;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
}

/**
 * The plan for an execution, re-derived from stored facts plus fresh READ-ONLY chain state (allowance,
 * whether the account exists, the wallet's permissions and passkeys). Nothing here trusts a plan that
 * was stored earlier, and nothing writes.
 */
export async function freshPlan(
  deps: FreshPlanDeps,
  live: LiveExecution,
  now: Date,
): Promise<ExecutionPlan> {
  const { repositories } = deps;
  const spender = live.quote.spender ?? live.quote.reactor;
  const [deployed, credentials, permissions, currentAllowance] = await Promise.all([
    deps.chain.isDeployed({ chainId: live.quote.chainId, address: live.wallet.address }),
    repositories.passkeys.listActiveForUser(live.wallet.userId),
    repositories.delegatedPermissions.listForWallet(live.wallet.id),
    spender
      ? deps.chain.allowances.readAllowance({
          chainId: live.quote.chainId,
          token: live.sellAsset.contractAddress,
          owner: live.wallet.address,
          spender,
        })
      : Promise.resolve(0n),
  ]);
  return buildExecutionPlan({
    candidate: live.candidate,
    quote: live.quote,
    transactions: live.transactions,
    claimTokenStored: live.attempt.claimSecretId !== undefined,
    authorization: live.authorization,
    wallet: live.wallet,
    sellAsset: live.sellAsset,
    buyAsset: live.buyAsset,
    tokenPolicy: deps.tokenPolicy ?? defaultTokenPolicy,
    currentAllowance,
    deployed,
    passkeyRootAvailable: credentials.length > 0,
    infrastructure: deps.infrastructure,
    permissions,
    now,
  });
}
