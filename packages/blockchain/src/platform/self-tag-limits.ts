import { getAddress } from "viem";
import type { Address, Hex } from "viem";

import { attributionSuffix } from "../attribution.js";

/*
 * The hard limits of send-tagged-self.ts, the operator script that sends one tagged transaction from the platform wallet. They
 * live here, apart from the script, so a test can pin each one without a key, a node or a network.
 */

/** The most the script may spend on gas, worst case. The transaction must cost STRICTLY less. 0.02 CELO. */
export const MAX_COST_WEI = 20_000_000_000_000_000n;

export interface SelfTagPlan {
  from: Address;
  to: Address;
  value: bigint;
  gas: bigint;
  /** The most the transaction may pay per gas (EIP-1559 maxFeePerGas), so `gas * maxFeePerGas` bounds the cost. */
  maxFeePerGas: bigint;
  balance: bigint;
}

/** The worst-case cost of the plan, in wei. */
export function planCostWei(plan: Pick<SelfTagPlan, "gas" | "maxFeePerGas">): bigint {
  return plan.gas * plan.maxFeePerGas;
}

/** Throws, in words an operator can act on, unless the plan is a zero-value tagged transaction to the wallet itself, cheap and affordable. */
export function assertSelfTagLimits(plan: SelfTagPlan): void {
  if (getAddress(plan.to) !== getAddress(plan.from))
    throw new Error("refusing: the recipient must be the platform wallet's own address");
  if (plan.value !== 0n) throw new Error("refusing: the value must be 0");
  const cost = planCostWei(plan);
  if (cost >= MAX_COST_WEI)
    throw new Error(
      `refusing: the worst-case gas cost ${cost} wei is not under ${MAX_COST_WEI} wei (0.02 CELO)`,
    );
  if (plan.balance < cost)
    throw new Error(
      `the wallet's balance ${plan.balance} wei cannot pay the worst-case gas cost ${cost} wei: fund ${plan.from} first`,
    );
}

/** True when the transaction input ends with the Celo attribution suffix (ERC-8021: at the very end of the calldata). */
export function endsWithAttribution(input: Hex): boolean {
  return input.toLowerCase().endsWith(attributionSuffix().slice(2).toLowerCase());
}
