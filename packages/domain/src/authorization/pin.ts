/**
 * The 4-digit transaction PIN: a CONVENIENCE authorization that a person approved one payment.
 * It is not a wallet key, not an encryption key, not a recovery credential, and it can never change
 * security-sensitive account settings. Because only 10,000 values exist, every control below is
 * enforced by the database, not by hoping callers are polite.
 */
export const PIN_LENGTH = 4;
/** Exactly four digits. 0000 and 1234 are syntactically valid: no "weak PIN" rejection by design. */
export const PIN_PATTERN = /^[0-9]{4}$/;

export function isValidPinFormat(pin: unknown): pin is string {
  return typeof pin === "string" && PIN_PATTERN.test(pin);
}

/**
 * Online guessing is bounded per USER (never per session, device or request): after `maxAttempts`
 * wrong guesses the PIN locks, for longer each time, and a successful verification resets the ladder.
 * An attempt is RESERVED before its hash is checked, so a burst of parallel guesses cannot exceed the
 * budget.
 */
export const PIN_ATTEMPT_POLICY = {
  maxAttempts: 3,
  /** Lock length in seconds for the 1st, 2nd, 3rd... lock; the last value repeats. */
  lockSeconds: [5 * 60, 15 * 60, 60 * 60],
} as const;

export interface TransactionPinSecurity {
  id: string;
  userId: string;
  /** Argon2id hash. Never leaves the server: not in a response, a log or an audit payload. */
  pinHash: string;
  /** Wrong guesses since the last lock or success. Always below `maxAttempts` at rest. */
  failedAttempts: number;
  /** How many times the PIN has locked since the last success (drives the lock length). */
  lockLevel: number;
  lockedUntil?: Date;
  changedAt: Date;
  /** Set when the PIN may only be replaced through account recovery (future build). */
  resetRequired: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** The outcome of reserving one verification attempt. */
export type PinAttemptReservation =
  | {
      state: "ADMITTED";
      /** Wrong guesses counted so far INCLUDING this one (until it succeeds). */
      failedAttempts: number;
      /** True when this very attempt used up the budget and locked the PIN. */
      lockedNow: boolean;
      lockedUntil?: Date;
    }
  | { state: "LOCKED"; lockedUntil: Date }
  | { state: "RESET_REQUIRED" }
  | { state: "NOT_SET" };

export interface TransactionPinRepository {
  findByUserId(userId: string): Promise<TransactionPinSecurity | null>;
  /** Creates the user's PIN state, or returns null if one already exists (one per user). */
  create(input: {
    id: string;
    userId: string;
    pinHash: string;
    now: Date;
  }): Promise<TransactionPinSecurity | null>;
  /** Replaces the hash and clears every counter and lock. Null if the user has no PIN. */
  replaceHash(input: {
    userId: string;
    pinHash: string;
    now: Date;
  }): Promise<TransactionPinSecurity | null>;
  /**
   * ONE atomic statement: unless the PIN is locked or reset-required, counts this attempt as a
   * failure and locks if that used up the budget. Concurrent callers are serialised by the row.
   */
  reserveAttempt(userId: string, now: Date): Promise<PinAttemptReservation>;
  /** After a correct PIN: clears failures and locks. Returns whether it had been locked before. */
  recordSuccess(userId: string): Promise<{ hadLocked: boolean }>;
  markResetRequired(userId: string): Promise<boolean>;
}
