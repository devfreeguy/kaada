import type { JsonObject } from "../json.js";
import type { PermissionScope } from "../firm/plan.js";
import type { SecretValue } from "../firm/secret.js";
import type { RootCredential } from "../wallets/ports.js";

/** One call an account makes. `value` is native currency in wei (decimal string), normally "0". */
export interface AccountCall {
  to: string;
  data: string;
  value: string;
}

export type OperationReceipt =
  | { status: "NOT_FOUND" }
  | { status: "PENDING" }
  | { status: "INCLUDED"; success: boolean; txHash: string; blockNumber: string };

/** The result of preparing an operation that needs the user's root passkey. Nothing is sent yet. */
export interface PreparedRootOperation {
  /** The 32-byte hash (hex) the passkey signs. */
  challenge: string;
  /** The unsigned operation, JSON-safe, to be completed later with the passkey assertion. */
  prepared: JsonObject;
  /** A fresh restricted session key for the permission being installed, when one is. */
  sessionKey?: { address: string; privateKey: SecretValue };
}

/**
 * Everything Kaada does on chain through the smart account, behind one Kaada-owned interface. The only
 * implementations are the real Kernel/bundler adapter and a test fake; no provider SDK type crosses it.
 *
 * Two kinds of operation, signed by two different authorities:
 *  - ROOT operations (deploy, install a permission) need the user's passkey assertion;
 *  - DELEGATED calls are signed by the restricted session key, and only the validated-execution signer
 *    may ever call `sendDelegatedCalls`.
 */
export interface KernelExecutionPort {
  isDeployed(address: string): Promise<boolean>;
  nativeBalance(address: string): Promise<bigint>;
  prepareRootOperation(input: {
    walletAddress: string;
    credential: RootCredential;
    /** Calls to run after the account exists (usually none: deployment is the operation). */
    calls: AccountCall[];
    /** The permission to install; the adapter creates the session key that will use it. */
    permission?: { scope: PermissionScope };
  }): Promise<PreparedRootOperation>;
  /** Completes a prepared root operation with the passkey assertion and sends it. */
  sendRootOperation(input: {
    prepared: JsonObject;
    assertion: unknown;
  }): Promise<{ userOpHash: string; approval?: SecretValue }>;
  /** Reads the chain: is the session key's permission installed on this account? */
  isPermissionInstalled(input: {
    walletAddress: string;
    sessionKeyAddress: string;
    scope: PermissionScope;
  }): Promise<boolean>;
  sendDelegatedCalls(input: {
    walletAddress: string;
    sessionKey: SecretValue;
    approval: SecretValue;
    calls: AccountCall[];
  }): Promise<{ userOpHash: string }>;
  getUserOperationReceipt(userOpHash: string): Promise<OperationReceipt>;
  getTransactionReceipt(
    txHash: string,
  ): Promise<{ status: "NOT_FOUND" | "PENDING" | "SUCCESS" | "REVERTED"; blockNumber?: string }>;
}

export type ProviderOrderState =
  "QUOTED" | "SUBMITTED" | "FILLED" | "FAILED" | "EXPIRED" | "UNKNOWN";

export interface ProviderOrderStatus {
  state: ProviderOrderState;
  txHash?: string;
  /** Settled amounts in smallest units, once the provider reports them. */
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  failReason?: string;
}

/** Telling the provider about an executed order, and asking how it settled. Never signs or sends. */
export interface ProviderOrderPort {
  readonly id: string;
  /** Reports the on-chain transaction hash. Idempotent for the same hash. */
  submit(input: {
    providerQuoteId: string;
    claimToken: SecretValue;
    txHash: string;
  }): Promise<ProviderOrderStatus>;
  status(input: { providerQuoteId: string; claimToken: SecretValue }): Promise<ProviderOrderStatus>;
}

/** Token-specific ERC-20 quirks, kept as data about the token rather than scattered through code. */
export interface TokenPolicy {
  /** Some tokens (USDT-style) refuse to change a non-zero allowance to another non-zero value. */
  requiresZeroResetBeforeChange(token: {
    chainId: number;
    symbol: string;
    address: string;
  }): boolean;
}
