import type { AccountCall, ExecutionPlan, PermissionScope, TransactionType } from "@kaada/domain";

import { APPROVE_SELECTOR } from "./approval-inspector.js";

/** ERC-20 `transfer(address,uint256)`. */
export const TRANSFER_SELECTOR = "0xa9059cbb";

const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

/** `approve(spender, amount)` calldata, built here from validated values and never taken from a caller. */
export function encodeApprove(spender: string, amount: bigint): string {
  return `${APPROVE_SELECTOR}${word(spender)}${word(amount.toString(16))}`;
}

/** `transfer(recipient, amount)` calldata. */
export function encodeTransfer(recipient: string, amount: bigint): string {
  return `${TRANSFER_SELECTOR}${word(recipient)}${word(amount.toString(16))}`;
}

export type StepKind = "APPROVAL_RESET" | "APPROVAL" | "SWAP";

/** One on-chain step of a payment: a stable key, what kind of transaction it is, and its calls. */
export interface PlannedStep {
  kind: StepKind;
  /** Unique per execution and step: the idempotency key of its Transaction row. */
  key: string;
  type: TransactionType;
  calls: AccountCall[];
  toAddress: string;
  assetId: string;
  amount: string;
}

export function stepKey(executionId: string, kind: StepKind): string {
  return `exec:${executionId}:${kind}`;
}

/**
 * The ordered on-chain steps of a payment, derived ONLY from a validated plan:
 *
 *   APPROVAL_RESET  approve(spender, 0)          only for a token that needs it and has a non-zero allowance
 *   APPROVAL        approve(spender, takerPays)  only when the allowance does not already cover it; bounded
 *   SWAP            [swap, transfer to recipient] ONE UserOperation: if the swap delivers less than the
 *                   transfer, the whole thing reverts and nothing is paid out
 *
 * The approval is Kaada's own encoding of the exact amount the firm quote needs (never the provider's
 * calldata, never unlimited). The swap call is the provider's unsigned transaction with no native value.
 */
export function plannedSteps(
  executionId: string,
  plan: ExecutionPlan,
  swap: { to: string; data: string; value: string },
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const approval = plan.approvalRequirements[0];
  if (approval?.required) {
    if (approval.resetToZeroFirst) {
      steps.push({
        kind: "APPROVAL_RESET",
        key: stepKey(executionId, "APPROVAL_RESET"),
        type: "APPROVAL",
        calls: [
          { to: approval.tokenAddress, data: encodeApprove(approval.spender, 0n), value: "0" },
        ],
        toAddress: approval.tokenAddress,
        assetId: approval.assetId,
        amount: "0",
      });
    }
    steps.push({
      kind: "APPROVAL",
      key: stepKey(executionId, "APPROVAL"),
      type: "APPROVAL",
      calls: [
        {
          to: approval.tokenAddress,
          data: encodeApprove(approval.spender, BigInt(approval.requiredAllowance)),
          value: "0",
        },
      ],
      toAddress: approval.tokenAddress,
      assetId: approval.assetId,
      amount: approval.requiredAllowance,
    });
  }
  const payout = plan.payoutRequirement;
  steps.push({
    kind: "SWAP",
    key: stepKey(executionId, "SWAP"),
    type: "SWAP",
    calls: [
      { to: swap.to.toLowerCase(), data: swap.data, value: swap.value },
      {
        to: payout.tokenAddress,
        data: encodeTransfer(payout.recipient, BigInt(payout.amount)),
        value: "0",
      },
    ],
    toAddress: swap.to.toLowerCase(),
    assetId: plan.candidate.input.assetId,
    amount: plan.candidate.input.amount,
  });
  return steps;
}

/** Selectors a payment may ever call. Anything else is refused before a signer is asked. */
export const ALLOWED_SELECTORS = [APPROVE_SELECTOR, TRANSFER_SELECTOR] as const;

/**
 * The scope as it was INSTALLED: the plan's scope with the stored permission's validity window. Kernel's
 * permission id hashes the policy parameters, the timestamp window included, so an on-chain read-back
 * only matches when it uses the window that was installed, not one recomputed from "now".
 */
export function installedScope(
  scope: PermissionScope,
  permission: { validFrom: Date; expiresAt: Date },
): PermissionScope {
  return { ...scope, validFrom: permission.validFrom, expiresAt: permission.expiresAt };
}
