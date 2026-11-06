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
      /**
       * Returned once by an RFQ provider as proof of ownership of a reserved quote; must be encrypted
       * before it is stored.
       *
       * OPTIONAL, because it is a trait of the provider rather than of firm quoting. An RFQ reserves a
       * price and hands back a token to claim it later. An AMM reserves nothing: the price is a reading
       * of a pool, the protection is the slippage bound written into the calldata, and there is no order
       * to claim. Such a provider returns none, and nothing downstream may require one.
       */
      claimToken?: SecretValue;
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
  /** The provider slug, matching its Provider row and its capability rows: "textile", "uniswap". */
  readonly id: string;
  requestFirm(request: FirmQuoteRequest): Promise<FirmQuoteProviderResult>;
  /**
   * Whether this provider issues a claim token with a firm quote. Declared rather than inferred, so a
   * provider that SHOULD have returned one and did not is a fault instead of a silent omission.
   */
  readonly issuesClaimToken: boolean;
  /**
   * The most firm quotes Kaada may hold at this provider at once. `null` means there is no limit.
   *
   * A provider trait, not one configured figure for everybody, and REQUIRED rather than optional so
   * every provider has to decide. An RFQ reserves funds against a slot and publishes a cap (Textile's
   * is 4), so exceeding it earns a 429 and counting locally avoids one. An AMM reserves nothing: no
   * slot is held and no cap exists, and applying the RFQ's number to it would refuse a fifth quote
   * within the deadline window for a capacity limit the provider does not have.
   */
  readonly maxOutstanding: number | null;
}

/**
 * Which firm-quote provider serves a provider slug. The same shape as FxProviderDirectory, and for the
 * same reason: the route decides the provider, so execution must look it up rather than assume it.
 */
export interface FirmQuoteProviderRegistry {
  get(providerSlug: string): FirmQuoteProvider | undefined;
  /** Registered slugs, for diagnostics and for a startup check that the seeded providers are wired. */
  slugs(): string[];
}

export function createFirmQuoteProviderRegistry(
  providers: readonly FirmQuoteProvider[],
): FirmQuoteProviderRegistry {
  const bySlug = new Map(providers.map((provider) => [provider.id, provider]));
  if (bySlug.size !== providers.length) {
    throw new Error("two firm-quote providers registered under the same slug");
  }
  return {
    get: (providerSlug) => bySlug.get(providerSlug),
    slugs: () => [...bySlug.keys()].sort(),
  };
}

/**
 * The encryption context (AAD) binding a stored claim token to its provider and its own record.
 *
 * Provider-derived rather than a literal, so a second provider cannot reuse the first one's context.
 * For "textile" it returns exactly the string used before this existed, so every already-stored Textile
 * token still decrypts: this is deliberately not a rename.
 */
export const claimTokenContext = (providerSlug: string, secretId: string): string =>
  `${providerSlug}-claim-token:${secretId}`;

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
