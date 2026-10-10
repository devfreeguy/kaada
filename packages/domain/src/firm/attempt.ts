import type { Money } from "../money/index.js";
import type { AmountMode } from "../quotes/amount-mode.js";
import type { FirmQuoteFailureCode, UnsignedTransactions } from "./firm-quote.js";

/**
 * One request for a firm quote, recorded durably BEFORE the provider is called, so a duplicate
 * delivery, a retry or a second process can never spend another provider slot for the same approval.
 *
 *   REQUESTING -> QUOTED   (a firm quote exists; reusable while unexpired)
 *              -> FAILED   (the provider answered with a failure; no quote reserved)
 *              -> TIMED_OUT (no answer: a quote MAY exist, so the slot is counted as held for a while)
 *   QUOTED -> UNUSABLE (outside the authorized bounds or too close to expiry; still holds its slot)
 *          -> EXPIRED  (its accept window passed)
 */
export const FIRM_ATTEMPT_STATUSES = [
  "REQUESTING",
  "QUOTED",
  "UNUSABLE",
  "EXPIRED",
  "FAILED",
  "TIMED_OUT",
] as const;
export type FirmAttemptStatus = (typeof FIRM_ATTEMPT_STATUSES)[number];

export interface FirmQuoteAttempt {
  id: string;
  paymentAuthorizationId: string;
  userId: string;
  walletId: string;
  /** The Provider row id. */
  providerId: string;
  status: FirmAttemptStatus;
  /** Durable, unique per live attempt: what a retried request is matched on. */
  idempotencyKey: string;
  amountMode: AmountMode;
  /** The fixed side that was asked for. */
  exactAmount: Money;
  /** The wallet address the quote is bound to, read from the wallet service. */
  takerAddress: string;
  providerQuoteId?: string;
  input?: Money;
  output?: Money;
  fee?: Money;
  reactor?: string;
  spender?: string;
  expiresAt?: Date;
  orderDeadline?: Date;
  latestOrderDeadline?: Date;
  unsignedTransactions?: UnsignedTransactions;
  /** The ExecutionSecret holding the encrypted claim token. Never the token. */
  claimSecretId?: string;
  failureCode?: FirmQuoteFailureCode | "OUT_OF_BOUNDS" | "TOO_CLOSE_TO_EXPIRY";
  createdAt: Date;
  updatedAt: Date;
}

export type NewFirmQuoteAttempt = Pick<
  FirmQuoteAttempt,
  | "id"
  | "paymentAuthorizationId"
  | "userId"
  | "walletId"
  | "providerId"
  | "idempotencyKey"
  | "amountMode"
  | "exactAmount"
  | "takerAddress"
>;

export interface QuotedFields {
  providerQuoteId: string;
  input: Money;
  output: Money;
  fee?: Money;
  reactor?: string;
  spender?: string;
  expiresAt: Date;
  orderDeadline?: Date;
  latestOrderDeadline?: Date;
  unsignedTransactions: UnsignedTransactions;
  claimSecretId: string;
}

export interface FirmQuoteAttemptRepository {
  /**
   * Records a REQUESTING attempt unless the authorization already has a live one (REQUESTING or
   * QUOTED) with this provider; then the live one is returned and nothing is created.
   */
  claim(
    attempt: NewFirmQuoteAttempt,
    now: Date,
  ): Promise<{ attempt: FirmQuoteAttempt; claimed: boolean }>;
  findById(id: string): Promise<FirmQuoteAttempt | null>;
  /** Newest first. */
  listByAuthorization(paymentAuthorizationId: string): Promise<FirmQuoteAttempt[]>;
  /** REQUESTING -> QUOTED, storing the quote. Null if it was not REQUESTING. */
  recordQuoted(id: string, fields: QuotedFields, now: Date): Promise<FirmQuoteAttempt | null>;
  /** REQUESTING -> FAILED or TIMED_OUT. Null if it was not REQUESTING. */
  recordFailure(
    id: string,
    status: "FAILED" | "TIMED_OUT",
    code: FirmQuoteFailureCode,
    now: Date,
  ): Promise<FirmQuoteAttempt | null>;
  /** QUOTED -> UNUSABLE (it still holds the provider's slot until its deadlines). */
  markUnusable(
    id: string,
    code: "OUT_OF_BOUNDS" | "TOO_CLOSE_TO_EXPIRY",
    now: Date,
  ): Promise<FirmQuoteAttempt | null>;
  /** QUOTED -> EXPIRED once its accept window has passed. */
  markExpired(id: string, now: Date): Promise<FirmQuoteAttempt | null>;
  /**
   * How many provider slots Kaada believes are held at `now`: REQUESTING attempts, QUOTED and UNUSABLE
   * ones until their latest order deadline (or accept cutoff), and recent TIMED_OUT ones.
   */
  countHeldSlots(providerId: string, now: Date, timedOutHoldMs: number): Promise<number>;
}

/** Encrypted execution material (a provider claim token), never readable without the key. */
export interface ExecutionSecretRepository {
  put(secret: {
    id: string;
    purpose: string;
    keyVersion: number;
    ciphertext: string;
    now: Date;
  }): Promise<void>;
  /** The secret, or null if it does not exist or was destroyed. */
  get(
    id: string,
  ): Promise<{ id: string; purpose: string; keyVersion: number; ciphertext: string } | null>;
  /** Destroys the ciphertext (idempotent). The row stays as proof it existed; nobody can recover it. */
  tombstone(id: string, now: Date): Promise<void>;
}
