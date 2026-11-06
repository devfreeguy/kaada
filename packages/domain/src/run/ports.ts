import type { JsonObject } from "../json.js";
import type { PermissionScope } from "../firm/plan.js";
import type { SecretValue } from "../firm/secret.js";
import type { RootCredential, RootProof } from "../wallets/root.js";

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
  /** Completes a prepared root operation with the root's proof (passkey assertion or device-key signature) and sends it. */
  sendRootOperation(input: {
    prepared: JsonObject;
    proof: RootProof;
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
    /**
     * Called with the UserOperation hash AFTER it is signed and BEFORE it is submitted, so the caller can
     * persist it. If the process dies during or after the submit, the hash is what reconciliation looks up.
     */
    beforeSubmit?: (userOpHash: string) => Promise<void>;
  }): Promise<{ userOpHash: string }>;
  getUserOperationReceipt(userOpHash: string): Promise<OperationReceipt>;
  getTransactionReceipt(
    txHash: string,
  ): Promise<{ status: "NOT_FOUND" | "PENDING" | "SUCCESS" | "REVERTED"; blockNumber?: string }>;
}

export type SettlementState = "QUOTED" | "SUBMITTED" | "SETTLED" | "FAILED" | "EXPIRED" | "UNKNOWN";

export interface SettlementOutcome {
  state: SettlementState;
  txHash?: string;
  /** Settled amounts in smallest units, once they are known. */
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  failReason?: string;
}

/**
 * How a provider's side of an executed swap is confirmed. Never signs and never sends.
 *
 * WHY THIS IS NOT CALLED AN "ORDER PORT". It answers one question — did this settle, and for how
 * much — from whichever source is authoritative for that provider, and the two kinds of provider have
 * genuinely different authorities:
 *
 *  - An RFQ provider holds the order off chain. It knows things the chain does not (whether the maker
 *    filled, the settled amounts, a fill that lands up to 24 hours late), so IT is asked.
 *  - An AMM holds nothing. The swap either happened in a block or it did not, so the CHAIN is asked.
 *    This is not a workaround for a missing API: for an AMM there is no other authority in existence.
 *
 * `claimToken` is optional for the same reason it is optional on a firm quote: it is proof of ownership
 * of a reservation, and a provider that reserves nothing issues none.
 */
/**
 * What a confirmer is told about the executed swap. Identifiers only: never an amount.
 *
 * Amounts are deliberately absent. A confirmer must obtain them from its own authority — the provider,
 * for an RFQ; the stored quote plus the confirmed receipt, for an AMM — because the runner then checks
 * them against the authorized bounds. Passing the expected figures in would let a confirmer echo them
 * back and turn that check into a tautology.
 */
export interface SettlementQuery {
  /** The provider's own id for the quote. */
  providerQuoteId: string;
  /** Kaada's id for the firm-quote attempt that was executed. */
  quoteId: string;
  /** Absent for a provider that issues none. */
  claimToken?: SecretValue;
  txHash: string;
}

export interface SettlementConfirmer {
  /** The provider slug, matching its Provider row: "textile", "uniswap". */
  readonly id: string;
  /**
   * Whether this provider needs to be told the transaction hash.
   *
   * True for an RFQ, where reporting is a documented courtesy. False for an AMM, which has no order to
   * notify — and calling `notify` on one must therefore be a no-op rather than an error.
   */
  readonly notifiesProvider: boolean;
  /** Reports the on-chain transaction hash. Idempotent for the same hash. */
  notify(input: SettlementQuery): Promise<SettlementOutcome>;
  /** How it settled. Called only after the chain has confirmed the transaction succeeded. */
  confirm(input: SettlementQuery): Promise<SettlementOutcome>;
}

/** Which settlement confirmer serves a provider slug. Keyed like every other provider registry. */
export interface SettlementConfirmerRegistry {
  get(providerSlug: string): SettlementConfirmer | undefined;
  slugs(): string[];
}

export function createSettlementConfirmerRegistry(
  confirmers: readonly SettlementConfirmer[],
): SettlementConfirmerRegistry {
  const bySlug = new Map(confirmers.map((confirmer) => [confirmer.id, confirmer]));
  if (bySlug.size !== confirmers.length) {
    throw new Error("two settlement confirmers registered under the same slug");
  }
  return {
    get: (providerSlug) => bySlug.get(providerSlug),
    slugs: () => [...bySlug.keys()].sort(),
  };
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
