import { PERMIT2 } from "@kaada/domain";
import type {
  ExecutionPlan,
  Permit2Allowance,
  Permit2GrantPolicy,
  StandingConversionPolicy,
  TokenPolicy,
} from "@kaada/domain";

import { hasRoot } from "../roots/root-credentials.js";
import type { LiveExecution } from "./live-execution.js";
import { buildExecutionPlan } from "./plan-builder.js";
import type { ChainState, ExecutionRepositories } from "./ports.js";
import { defaultTokenPolicy } from "./token-policy.js";

/**
 * The sizes that shape a plan's permission and one-time grants. ONE value, handed to everything that rebuilds a plan
 * (preparation, the runner and the signer), because a plan rebuilt without them describes a different permission from
 * the one that was installed and the signer then refuses the payment.
 */
export interface PlanPolicy {
  /** The size and lifetime of a one-time Permit2 grant. Absent means a Permit2 route is refused. */
  permit2Grant?: Permit2GrantPolicy;
  /** Standing permissions for conversions between a person's own currencies. Absent means every payment gets an exact one. */
  standingConversion?: StandingConversionPolicy;
}

export interface FreshPlanDeps {
  repositories: ExecutionRepositories;
  chain: Pick<ChainState, "allowances" | "isDeployed" | "permit2Allowances">;
  tokenPolicy?: TokenPolicy;
  planPolicy?: PlanPolicy;
  infrastructure: { rpcConfigured: boolean; bundlerConfigured: boolean };
}

/**
 * The plan for an execution, re-derived from stored facts plus fresh READ-ONLY chain state (allowance,
 * whether the account exists, the wallet's permissions and root). Nothing here trusts a plan that
 * was stored earlier, and nothing writes.
 */
export async function freshPlan(
  deps: FreshPlanDeps,
  live: LiveExecution,
  now: Date,
): Promise<ExecutionPlan> {
  const { repositories } = deps;
  const spender = live.quote.spender ?? live.quote.reactor;
  // Only a Permit2-routed quote needs the second allowance; reading it otherwise is a wasted call.
  const viaPermit2 = spender?.toLowerCase() === PERMIT2;
  const [deployed, rootAvailable, permissions, currentAllowance, currentPermit2Allowance] =
    await Promise.all([
      deps.chain.isDeployed({ chainId: live.quote.chainId, address: live.wallet.address }),
      hasRoot(repositories, live.wallet),
      repositories.delegatedPermissions.listForWallet(live.wallet.id),
      spender
        ? deps.chain.allowances.readAllowance({
            chainId: live.quote.chainId,
            token: live.sellAsset.contractAddress,
            owner: live.wallet.address,
            spender,
          })
        : Promise.resolve(0n),
      viaPermit2 && deps.chain.permit2Allowances
        ? deps.chain.permit2Allowances.readPermit2Allowance({
            chainId: live.quote.chainId,
            owner: live.wallet.address,
            token: live.sellAsset.contractAddress,
            spender: live.transactions.swap.to,
          })
        : Promise.resolve(undefined as Permit2Allowance | undefined),
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
    ...(currentPermit2Allowance !== undefined && { currentPermit2Allowance }),
    ...(deps.planPolicy?.permit2Grant && { permit2Grant: deps.planPolicy.permit2Grant }),
    ...(deps.planPolicy?.standingConversion && {
      standingConversion: deps.planPolicy.standingConversion,
    }),
    deployed,
    rootAvailable,
    infrastructure: deps.infrastructure,
    permissions,
    now,
  });
}
