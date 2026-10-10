import type { PlanBlocker, UnsignedTransaction } from "@kaada/domain";

/** ERC-20 `approve(address spender, uint256 amount)`. */
export const APPROVE_SELECTOR = "0x095ea7b3";
export const MAX_UINT256 = (1n << 256n) - 1n;
/** Anything this large is "unlimited" in practice, not just exactly 2^256 - 1. */
const UNLIMITED_FLOOR = 1n << 255n;

export interface ApprovalInspection {
  /** Decoded from the calldata, when it is an approve call. */
  spender?: string;
  amount?: bigint;
  blockers: PlanBlocker[];
}

/**
 * Looks INSIDE the approval transaction a provider returned instead of trusting it. It decodes the
 * ERC-20 approve calldata and checks it does exactly what the payment needs: on the sell token, on the
 * right chain, no native value, to the expected spender, for the required amount.
 *
 * An approval for more than needed is a blocker, and an unlimited one (2^256 - 1, or anything above
 * 2^255) is a distinct blocker: it is never accepted silently. Nothing here signs or sends anything.
 */
export function inspectApprovalTransaction(
  transaction: UnsignedTransaction,
  expected: { chainId: number; token: string; spender: string; requiredAmount: bigint },
): ApprovalInspection {
  const blockers: PlanBlocker[] = [];
  if (transaction.chainId !== expected.chainId) blockers.push("TRANSACTION_CHAIN_MISMATCH");
  if (transaction.to.toLowerCase() !== expected.token.toLowerCase()) {
    blockers.push("APPROVAL_TOKEN_MISMATCH");
  }
  if (transaction.value !== "0") blockers.push("APPROVAL_CARRIES_VALUE");

  const data = transaction.data.toLowerCase();
  // 4-byte selector + two 32-byte words.
  if (!data.startsWith(APPROVE_SELECTOR) || !/^0x[0-9a-f]+$/.test(data) || data.length !== 138) {
    return { blockers: [...blockers, "APPROVAL_NOT_AN_APPROVE_CALL"] };
  }
  const word1 = data.slice(10, 74);
  const word2 = data.slice(74, 138);
  // The spender word is a left-padded address: its first 12 bytes must be zero.
  if (!word1.startsWith("0".repeat(24))) {
    return { blockers: [...blockers, "APPROVAL_NOT_AN_APPROVE_CALL"] };
  }
  const spender = `0x${word1.slice(24)}`;
  const amount = BigInt(`0x${word2}`);

  if (spender !== expected.spender.toLowerCase()) blockers.push("APPROVAL_TARGET_MISMATCH");
  if (amount >= UNLIMITED_FLOOR) blockers.push("APPROVAL_UNLIMITED");
  else if (amount > expected.requiredAmount) blockers.push("APPROVAL_EXCEEDS_REQUIRED");
  else if (amount < expected.requiredAmount) blockers.push("APPROVAL_BELOW_REQUIRED");
  return { spender, amount, blockers };
}

/** The swap transaction is not decoded here (its semantics are the provider's); only what is checkable. */
export function inspectSwapTransaction(
  transaction: UnsignedTransaction,
  expected: { chainId: number },
): PlanBlocker[] {
  const blockers: PlanBlocker[] = [];
  if (transaction.chainId !== expected.chainId) blockers.push("TRANSACTION_CHAIN_MISMATCH");
  // Paying in a token never needs native currency; a value here would spend CELO.
  if (transaction.value !== "0") blockers.push("SWAP_CARRIES_UNEXPECTED_VALUE");
  // The permission pins the swap's function selector, so the calldata must carry one.
  if (!/^0x[0-9a-fA-F]{8}/.test(transaction.data)) blockers.push("SWAP_CALLDATA_INVALID");
  return blockers;
}
