import type { Money } from "../money/index.js";
import type { PaymentRoute } from "../routing/index.js";
import type { WalletDeployment } from "./wallet.js";
import type { Enforcement, PermissionConstraint, PermissionRequest } from "./permission.js";

/*
 * Kaada-owned wallet contracts. The wallet technology (today: ZeroDev Kernel) lives behind these in
 * @kaada/blockchain; domain and application code never import a provider SDK type.
 */

/** The user's root authority as Kaada knows it: a PUBLIC passkey. Never a secret. */
export interface RootCredential {
  credentialId: string;
  publicKeyX: string;
  publicKeyY: string;
  rpId: string;
}

export interface DerivedAccount {
  /** Lower-case EVM address of the smart account. */
  address: string;
  /** Stable identifier of the wallet stack and version, e.g. "zerodev-kernel-v3.3". */
  provider: string;
  providerAccountId?: string;
  /** COUNTERFACTUAL until the account contract exists on chain. */
  deployment: WalletDeployment;
}

/**
 * Derives (and, later, deploys) the user's smart account. Derivation is deterministic: the same root
 * credential always yields the same address, so a retry can never create a second account.
 */
export interface WalletProvisioningAdapter {
  readonly provider: string;
  deriveAccount(input: { chainId: number; root: RootCredential }): Promise<DerivedAccount>;
}

/** What a stack can enforce for a requested permission, constraint by constraint. Pure; issues nothing. */
export interface PermissionPlan {
  provider: string;
  enforcement: Record<PermissionConstraint, Enforcement>;
  /** Constraints the stack cannot honour at all; a request needing them is rejected. */
  unsupported: PermissionConstraint[];
}

export interface WalletPolicyAdapter {
  readonly provider: string;
  plan(request: PermissionRequest): PermissionPlan;
}

/**
 * THE signer boundary. There is no `sign(bytes)` and no `signTransaction(tx)` anywhere: the only way
 * to ask for a signature is by the id of an execution Kaada already stored and validated. An
 * implementation loads that execution itself and must refuse unless ALL of these hold: the wallet
 * and chain match, the delegated permission is ACTIVE and unexpired, a valid PaymentAuthorization
 * binds this execution, the target contract and asset are allowed, the spend is within limits, the
 * execution has not expired, and it has not been signed before (replay protection).
 */
export interface ExecutionSigner {
  signValidatedExecution(executionId: string): Promise<SignedExecution>;
}

export interface SignedExecution {
  executionId: string;
  /** The submitted transaction/user-operation hash. */
  reference: string;
}

/** Balances of one wallet. Always canonical Money; never a float. */
export interface WalletBalances {
  chainId: number;
  address: string;
  /** Native CELO in wei (18 decimals), as canonical Money in the native asset. */
  native?: Money;
  /** One entry per requested token, in the order requested; a missing balance is zero, never absent. */
  tokens: Money[];
}

/** READ-ONLY. Never writes, never signs, never moves funds. */
export interface WalletBalanceReader {
  readBalances(input: {
    chainId: number;
    address: string;
    assetIds: string[];
  }): Promise<WalletBalances>;
}

/**
 * What a future FIRM Textile quote needs. The taker address always comes from WalletService, never
 * from request input. Nothing requests a firm quote yet; this fixes the contract for later.
 */
export interface FirmQuoteContext {
  takerAddress: string;
  intentId: string;
  intentRevision: number;
  route: PaymentRoute;
}
