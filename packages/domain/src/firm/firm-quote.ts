import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { ExecutionCandidate } from "../authorization/policy.js";
import type { SecretValue } from "./secret.js";

/**
 * A FIRM price: reserved by the provider for one wallet, valid for a short accept window, and holding
 * one of the provider's outstanding-quote slots. Provider-independent: nothing Textile-specific is
 * named here, so the authorization policy and the plan builder never see a provider DTO.
 */
export interface FirmQuote {
  /** Kaada's id for this quote (the attempt that obtained it). */
  id: string;
  /** The pricing provider's slug, e.g. "textile". */
  provider: string;
  /** The provider's id for the reserved quote (not secret). */
  providerQuoteId: string;
  chainId: number;
  /** What leaves the wallet if executed (the provider's "taker pays"). */
  input: Money;
  /** What the recipient receives. */
  output: Money;
  fee?: Money;
  /** The accept cutoff: after this the provider rejects the order. */
  expiresAt: Date;
  /** When the signed order can no longer settle fully. */
  orderDeadline?: Date;
  /** When the provider releases the reserved funds and the slot. */
  latestOrderDeadline?: Date;
  /** The contract that must be approved to pull the input, when the provider names one. */
  spender?: string;
  /** The contract the order settles through. */
  reactor?: string;
  /** The wallet the quote is bound to. */
  taker: string;
  /** What a later execution cites; never a credential. */
  executionReference: string;
  indicative: false;
}

/** A transaction the provider returned UNSIGNED. Kaada signs nothing in this build. */
export interface UnsignedTransaction {
  to: string;
  data: string;
  /** Native value in wei as a decimal string. */
  value: string;
  chainId: number;
}

export interface UnsignedTransactions {
  approval: UnsignedTransaction;
  swap: UnsignedTransaction;
}

/** What to ask a provider for. The taker always comes from the wallet service, never from a caller. */
export interface FirmQuoteRequest {
  chainId: number;
  sellAssetId: string;
  buyAssetId: string;
  /** Token contract addresses of the two assets. */
  sellToken: string;
  buyToken: string;
  mode: AmountMode;
  /** The fixed side in smallest units: the sell amount (EXACT_INPUT) or the buy amount (EXACT_OUTPUT). */
  exactAmount: string;
  taker: string;
}

export type FirmQuoteFailureCode =
  | "NO_QUOTE"
  | "INSUFFICIENT_FUNDS_AT_PROVIDER"
  | "PROVIDER_CAPACITY_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "QUOTE_MISMATCH";

export type FirmQuoteProviderResult =
  | {
      status: "QUOTED";
      quote: Omit<FirmQuote, "id">;
      transactions: UnsignedTransactions;
      /** Returned once by the provider; must be encrypted before it is stored. */
      claimToken: SecretValue;
    }
  | {
      status: "FAILED";
      code: FirmQuoteFailureCode;
      /** True when the provider may still have reserved a quote (a timeout): it is counted as a held slot. */
      mayHoldSlot: boolean;
      providerReason?: string;
    };

/** The firm-quote capability of a pricing provider. Separate from indicative pricing on purpose. */
export interface FirmQuoteProvider {
  readonly id: string;
  requestFirm(request: FirmQuoteRequest): Promise<FirmQuoteProviderResult>;
}

/** The exact proposed financial operation, before any signing. Contains no secret of any kind. */
export interface FirmExecutionCandidate extends ExecutionCandidate {
  intentId: string;
  authorizationId: string;
  provider: string;
  providerQuoteId: string;
  executionReference: string;
  fee?: Money;
  expiresAt: Date;
  orderDeadline?: Date;
  latestOrderDeadline?: Date;
  /** The steps of the (single-hop) route that would run. */
  routeSteps: { type: "SWAP"; provider: string; input: Money; output: Money }[];
}
