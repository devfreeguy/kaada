import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";

/**
 * WHAT THE USER APPROVED, not a provider quote. It records the bounded financial conditions a person
 * saw and confirmed with their PIN; a later build may fetch ONE firm price after this exists and may
 * execute only if that price fits inside the bounds. A price outside them needs a new authorization.
 *
 * It is immutable: the bounds, the parties and the route shape are never edited. Anything that
 * changes (amount, recipient, an asset, the intent revision, the route) makes it unusable and a new
 * one is created; the old row stays as history. It is short-lived and single-use.
 *
 *   ACTIVE -> CONSUMED (an execution took it, atomically, once)
 *          -> REVOKED  (the payment changed, or it was withdrawn)
 *          -> EXPIRED  (time ran out)
 */
export const PAYMENT_AUTHORIZATION_STATUSES = ["ACTIVE", "CONSUMED", "REVOKED", "EXPIRED"] as const;
export type PaymentAuthorizationStatus = (typeof PAYMENT_AUTHORIZATION_STATUSES)[number];

/**
 * - EXACT_INPUT:  the person spends `authorizedInput` (never more) and must receive at least
 *                 `minimumOutput`.
 * - EXACT_OUTPUT: the recipient must receive at least `exactOutput` and the person spends at most
 *                 `maximumInput`.
 */
export type AuthorizedBounds =
  | { mode: "EXACT_INPUT"; authorizedInput: Money; minimumOutput: Money }
  | { mode: "EXACT_OUTPUT"; exactOutput: Money; maximumInput: Money };

/** The two limits every mode reduces to. */
export function boundLimits(bounds: AuthorizedBounds): { maxInput: Money; minOutput: Money } {
  return bounds.mode === "EXACT_INPUT"
    ? { maxInput: bounds.authorizedInput, minOutput: bounds.minimumOutput }
    : { maxInput: bounds.maximumInput, minOutput: bounds.exactOutput };
}

export function boundsAmountMode(bounds: AuthorizedBounds): AmountMode {
  return bounds.mode;
}

export interface AuthorizedRecipient {
  recipientId?: string;
  /** Resolved destination address, lower-case, when the recipient has one. */
  address?: string;
}

/** The shape of the priced route that was approved: which assets, in which order, via which providers. */
export interface AuthorizedRoute {
  /** Asset ids from the funding asset to the destination asset, e.g. [USDT, wBRL]. */
  assetPath: string[];
  /** Pricing provider slugs of the swap steps. Empty for a plain transfer. */
  providers: string[];
}

export interface PaymentAuthorization {
  id: string;
  userId: string;
  walletId: string;
  intentId: string;
  intentRevision: number;
  routeId: string;
  /** The UI session that produced it. Informational only; never a credential. */
  sessionId?: string;
  status: PaymentAuthorizationStatus;
  operation: "SEND" | "CONVERT";
  chainId: number;
  recipient: AuthorizedRecipient;
  destinationCountry?: string;
  bounds: AuthorizedBounds;
  route: AuthorizedRoute;
  expiresAt: Date;
  consumedAt?: Date;
  revokedAt?: Date;
  revocationReason?: string;
  createdAt: Date;
}

export type NewPaymentAuthorization = Omit<
  PaymentAuthorization,
  "status" | "consumedAt" | "revokedAt" | "revocationReason" | "createdAt"
>;

export interface PaymentAuthorizationRepository {
  create(authorization: NewPaymentAuthorization): Promise<PaymentAuthorization>;
  findById(id: string): Promise<PaymentAuthorization | null>;
  /** The authorization a UI session produced, if any (any status). */
  findBySession(sessionId: string): Promise<PaymentAuthorization | null>;
  /** The intent's ACTIVE authorization (at most one exists), if any. */
  findActiveByIntent(intentId: string): Promise<PaymentAuthorization | null>;
  /**
   * ACTIVE -> CONSUMED atomically, only if unexpired at `now`. Of any number of concurrent
   * callers exactly one gets the authorization back; everyone else gets null.
   */
  consume(id: string, now: Date): Promise<PaymentAuthorization | null>;
  /** ACTIVE -> REVOKED. Null if it was not ACTIVE. */
  revoke(id: string, reason: string, now: Date): Promise<PaymentAuthorization | null>;
  /**
   * Revokes the intent's ACTIVE authorizations that do not match `keep` (all when `keep` is null):
   * those for another revision or another route. Returns what it revoked.
   */
  revokeActiveExcept(
    intentId: string,
    keep: { revision: number; routeId: string } | null,
    reason: string,
    now: Date,
  ): Promise<PaymentAuthorization[]>;
  /** ACTIVE -> EXPIRED for everything past its time. Returns what it expired. */
  expireDue(now: Date): Promise<PaymentAuthorization[]>;
}
