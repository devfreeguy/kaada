import type { Money } from "../money/index.js";
import type { ExecutionCandidate } from "../authorization/policy.js";
import type { FirmExecutionCandidate, UnsignedTransaction } from "./firm-quote.js";

/**
 * The pre-signing execution plan: everything that WOULD have to happen for one authorized payment,
 * in provider-independent terms. It is a description, not an action: it holds no signature, no
 * private material and no claim token, and building it writes nothing to any chain.
 *
 * Which key signs each step matters and is stated, never assumed:
 *   ROOT             - the wallet's root credential, whatever its type: a passkey or a P-256 device key (account
 *                      deployment, installing a delegated permission)
 *   DELEGATED_SIGNER - the restricted session key a permission authorizes (the payment itself)
 */
export type SignerKind = "ROOT" | "DELEGATED_SIGNER";

export interface AccountRequirements {
  /** The smart account does not exist on chain yet; the first operation must deploy it. */
  deploymentRequired: boolean;
  /** True when deployment or a permission installation needs the wallet's root signature. */
  rootSignatureRequired: boolean;
  /** The wallet has a usable root credential (a passkey or a device key) to provide that signature. */
  rootAvailable: boolean;
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
  /**
   * The one contract the swap call may target, never with native value. ABSENT for a direct transfer, which has no swap: such a
   * permission allows the payout transfer and nothing else.
   */
  swapTarget?: string;
  /**
   * The ONE function selector (4 bytes, from the provider's own swap calldata) allowed on `swapTarget`.
   * An omitted selector is not a wildcard on-chain (verified on Celo Sepolia): it is a literal 0x00000000.
   * Present exactly when `swapTarget` is.
   */
  swapSelector?: string;
  validFrom: Date;
  expiresAt: Date;
}

/**
 * How large and how long the standing permission for conversions between a person's OWN currencies is.
 *
 * A conversion pays out to the wallet it came from, so there is no recipient to pin per payment. Its permission can
 * therefore be installed once, with a ceiling instead of the exact amounts of one payment, and reused for every later
 * conversion of the same pair without asking the person again. Sized in WHOLE tokens for the same reason the Permit2
 * grant is: a raw figure means a different amount for every token precision.
 */
export interface StandingConversionPolicy {
  wholeTokens: bigint;
  windowMs: number;
}

/** The ceiling, in the token's smallest unit, that a standing conversion permission pins on chain. */
export function standingLimitAmount(policy: StandingConversionPolicy, decimals: number): bigint {
  return policy.wholeTokens * 10n ** BigInt(decimals);
}

/**
 * Everything in a scope that is PINNED ON CHAIN, as one canonical string; the validity window is left out on purpose.
 *
 * Two scopes have the same key exactly when the installed permission for one would accept the other's calls: the same
 * contracts, the same swap target and function, the same approval token, spender and ceiling, and the same payout token,
 * RECIPIENT and ceiling. It is stored with the permission when it is created, and a later payment may reuse that
 * permission only if its own scope has the identical key.
 *
 * WHY IT EXISTS. A permission used to be matched to a payment by broad sets (contracts, assets, operations) alone, while the
 * recipient and the amounts are pinned on chain and were not remembered. A second payment to a different recipient, or for a
 * different amount, was therefore planned as "already covered" and then refused at signing, when the signer read the exact
 * scope back from the chain, and a retry hit the same wall until the permission expired.
 */
export function permissionScopeKey(scope: PermissionScope): string {
  const lower = (value: string): string => value.toLowerCase();
  return JSON.stringify({
    chain: scope.chainId,
    operations: [...scope.allowedOperations].sort(),
    contracts: scope.allowedContracts.map(lower).sort(),
    assets: [...scope.allowedAssetIds].sort(),
    swap:
      scope.swapTarget && scope.swapSelector
        ? [lower(scope.swapTarget), lower(scope.swapSelector)]
        : null,
    approval: scope.approval
      ? [
          lower(scope.approval.tokenAddress),
          lower(scope.approval.spender),
          scope.approval.limit.amount,
        ]
      : null,
    payout: scope.payout
      ? [lower(scope.payout.tokenAddress), lower(scope.payout.recipient), scope.payout.limit.amount]
      : null,
    perTransaction: [scope.perTransactionLimit.assetId, scope.perTransactionLimit.amount],
  });
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
  /** Installing a permission is signed by the wallet's root, whatever its type. */
  installSigner: "ROOT";
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
  "SWAP_CALLDATA_INVALID",
  "TAKER_MISMATCH",
  "NO_ROOT",
  "RECIPIENT_ADDRESS_REQUIRED",
  // A Permit2-routed swap needs a one-time root grant and the plan was given no size for one.
  "PERMIT2_GRANT_UNAVAILABLE",
  // A Permit2-routed swap targets a contract Kaada has not deliberately decided may hold a Permit2 allowance.
  "PERMIT2_SPENDER_NOT_TRUSTED",
] as const;
export type PlanBlocker = (typeof PLAN_BLOCKERS)[number];

export type ExecutionPlanStatus = "READY" | "BLOCKED" | "EXPIRED";

/**
 * The plan of a DIRECT transfer: the payment is already in the right currency, so the token goes from the wallet to the recipient
 * with no swap, no provider and no firm quote. It carries only what that needs, and is told apart from a swap plan by `kind`.
 * Like every plan it holds no secret, signature or claim token.
 */
export interface TransferExecutionPlan {
  kind: "TRANSFER";
  candidate: ExecutionCandidate;
  accountRequirements: AccountRequirements;
  permissionRequirement: PermissionRequirement;
  /** The one transfer: the token, the ONE recipient and the exact amount. */
  payoutRequirement: PayoutRequirement;
  signingPrerequisites: string[];
  blockers: PlanBlocker[];
  /** The authorization's own deadline: a transfer has no quote to expire. */
  expiresAt: Date;
  status: ExecutionPlanStatus;
}

/**
 * One call that must run ONCE, under the wallet's ROOT, before a delegated payment can work.
 *
 * It is not part of the payment. It is signed by the root (a passkey or a device key) alongside the
 * account deployment and the permission install, never by the restricted session key, and it therefore
 * never passes through the payment path's selector allowlist. That separation is the point: a provider
 * whose execution needs a grant the session key may not make gets it from the root instead, and nothing
 * about what a payment may do changes.
 *
 * The only case today is the Permit2 -> Universal Router allowance a Uniswap swap needs.
 */
export interface SetupRequirement {
  /** Why this call exists, as a stable code: it is shown and audited, never free text. */
  purpose: "PERMIT2_ROUTER_ALLOWANCE";
  to: string;
  data: string;
  /** Always "0": a setup call never carries native value. */
  value: "0";
  /** The asset the grant concerns, for the audit trail. */
  assetId: string;
  signer: "ROOT";
}

export interface ExecutionPlan {
  candidate: FirmExecutionCandidate;
  accountRequirements: AccountRequirements;
  permissionRequirement: PermissionRequirement;
  approvalRequirements: TokenApprovalRequirement[];
  /**
   * One-time grants this payment needs that a session key may not make. Empty for a provider that
   * needs none, which is every provider but Uniswap today.
   */
  setupRequirements: SetupRequirement[];
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
