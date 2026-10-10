import type { Money } from "../money/index.js";
import type { FirmExecutionCandidate, UnsignedTransaction } from "./firm-quote.js";

/**
 * The pre-signing execution plan: everything that WOULD have to happen for one authorized payment,
 * in provider-independent terms. It is a description, not an action: it holds no signature, no
 * private material and no claim token, and building it writes nothing to any chain.
 *
 * Which key signs each step matters and is stated, never assumed:
 *   ROOT_PASSKEY     - the user's passkey (account deployment, installing a delegated permission)
 *   DELEGATED_SIGNER - the restricted session key a permission authorizes (the payment itself)
 */
export type SignerKind = "ROOT_PASSKEY" | "DELEGATED_SIGNER";

export interface AccountRequirements {
  /** The smart account does not exist on chain yet; the first operation must deploy it. */
  deploymentRequired: boolean;
  /** True when deployment or a permission installation needs the user's passkey signature. */
  rootSignatureRequired: boolean;
  /** An unrevoked passkey credential exists to provide that signature. */
  passkeyRootAvailable: boolean;
  infrastructure: {
    /** A Celo RPC is configured (needed to read state). */
    rpcConfigured: boolean;
    /** A bundler that supports Celo is configured (needed to submit UserOperations later). */
    bundlerConfigured: boolean;
  };
}

/** What a delegated permission for THIS payment must allow. Mirrors a PermissionRequest. */
export interface PermissionScope {
  chainId: number;
  allowedOperations: ("APPROVE_TOKEN" | "EXECUTE_SWAP" | "TRANSFER_TOKEN")[];
  /** Exactly the contracts the payment touches: the sell token, the spender and the swap target. */
  allowedContracts: string[];
  allowedAssetIds: string[];
  /** Never more than the authorized maximum spend. */
  perTransactionLimit: Money;
  /**
   * The payout leg: the buy token may be transferred ONLY to this recipient, ONLY up to this amount.
   * (The swap pays the wallet itself; the recipient is paid by a transfer in the same UserOperation.)
   */
  payout?: { assetId: string; tokenAddress: string; recipient: string; limit: Money };
  /**
   * The bounded token approval: ONLY `approve(spender, <= limit)` on this token. Absent when no
   * approval is needed for this payment.
   */
  approval?: { tokenAddress: string; spender: string; limit: Money };
  /** The one contract the swap call may target (any function on it, never with native value). */
  swapTarget: string;
  validFrom: Date;
  expiresAt: Date;
}

/**
 * - SATISFIED:             an ACTIVE permission that is installed on chain already covers the payment.
 * - INSTALLATION_REQUIRED: none does. A PENDING record is only an intention, never authority.
 */
export interface PermissionRequirement {
  state: "SATISFIED" | "INSTALLATION_REQUIRED";
  existingPermissionId?: string;
  /** What to install when it is required (or what is missing). */
  scope: PermissionScope;
  /** Installing a permission is signed by the user's passkey. */
  installSigner: "ROOT_PASSKEY";
}

export interface TokenApprovalRequirement {
  assetId: string;
  tokenAddress: string;
  owner: string;
  spender: string;
  /** Read from the chain, smallest units. */
  currentAllowance: string;
  /** The smallest allowance that covers the payment (the provider's `takerPays`). */
  requiredAllowance: string;
  /** False when the existing allowance already covers it. */
  required: boolean;
  /** Some tokens (USDT) refuse a change from one non-zero allowance to another. */
  resetToZeroFirst: boolean;
  signer: SignerKind;
}

/** The transfer that pays the recipient, run atomically with the swap in one UserOperation. */
export interface PayoutRequirement {
  assetId: string;
  tokenAddress: string;
  recipient: string;
  /** The firm quote's output, in smallest units. A swap that delivers less makes the batch revert. */
  amount: string;
  signer: SignerKind;
}

export interface SwapRequirement {
  provider: string;
  /** The provider's id for the firm quote (not secret). */
  providerQuoteId: string;
  /** The contract the unsigned swap transaction calls. Unverified: Build 13 must decode it. */
  target: string;
  nativeValue: string;
  input: Money;
  output: Money;
  expiresAt: Date;
  /** The provider's claim token exists, encrypted, for the later submit. Never included here. */
  claimTokenStored: boolean;
  signer: SignerKind;
}

/** Why a plan must not proceed even though a firm quote fits the authorization. */
export const PLAN_BLOCKERS = [
  "APPROVAL_TARGET_MISMATCH",
  "APPROVAL_TOKEN_MISMATCH",
  "APPROVAL_UNLIMITED",
  "APPROVAL_EXCEEDS_REQUIRED",
  "APPROVAL_BELOW_REQUIRED",
  "APPROVAL_NOT_AN_APPROVE_CALL",
  "APPROVAL_CARRIES_VALUE",
  "TRANSACTION_CHAIN_MISMATCH",
  "SWAP_CARRIES_UNEXPECTED_VALUE",
  "TAKER_MISMATCH",
  "NO_PASSKEY_ROOT",
  "RECIPIENT_ADDRESS_REQUIRED",
] as const;
export type PlanBlocker = (typeof PLAN_BLOCKERS)[number];

export type ExecutionPlanStatus = "READY" | "BLOCKED" | "EXPIRED";

export interface ExecutionPlan {
  candidate: FirmExecutionCandidate;
  accountRequirements: AccountRequirements;
  permissionRequirement: PermissionRequirement;
  approvalRequirements: TokenApprovalRequirement[];
  swapRequirement: SwapRequirement;
  payoutRequirement: PayoutRequirement;
  /**
   * Infrastructure that must exist before Build 13 can sign and send (for instance a Celo bundler).
   * Not a defect of the plan: a list of what is not switched on yet.
   */
  signingPrerequisites: string[];
  blockers: PlanBlocker[];
  /** The earliest deadline the plan depends on (the firm quote's accept cutoff). */
  expiresAt: Date;
  status: ExecutionPlanStatus;
}

/** The unsigned transactions a plan refers to, kept apart because only the executor needs them. */
export interface PlanTransactions {
  approval: UnsignedTransaction;
  swap: UnsignedTransaction;
}
