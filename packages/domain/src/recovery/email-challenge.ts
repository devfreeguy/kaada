/**
 * A short-lived email challenge for ONE recovery attempt. Only a keyed hash of the code is stored. The code is single use,
 * counted per guess in one atomic statement, and dies after `maxAttempts` wrong tries. Proving the email proves nothing
 * on chain: it only lets the attempt move on to the Recovery Code step.
 */
export interface RecoveryEmailChallenge {
  id: string;
  attemptId: string;
  /** SHA-256 of the session token this challenge unlocks (it becomes the attempt token once verified). */
  sessionTokenHash: string;
  /** HMAC-SHA-256 (hex) of the code under a server secret, bound to the attempt. */
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  usedAt?: Date;
  createdAt: Date;
}

export type NewRecoveryEmailChallenge = Pick<
  RecoveryEmailChallenge,
  "id" | "attemptId" | "sessionTokenHash" | "codeHash" | "expiresAt" | "maxAttempts"
>;

/** The outcome of reserving one verification attempt. */
export type EmailChallengeReservation =
  | { state: "ADMITTED"; challenge: RecoveryEmailChallenge }
  | { state: "NONE" | "EXPIRED" | "USED" | "EXHAUSTED" };

export interface RecoveryEmailChallengeRepository {
  create(challenge: NewRecoveryEmailChallenge): Promise<RecoveryEmailChallenge>;
  /** The newest challenge issued for a session token, in any state. */
  findLatestBySessionTokenHash(sessionTokenHash: string): Promise<RecoveryEmailChallenge | null>;
  /**
   * Counts one guess against challenge `id` in ONE conditional update (so parallel guesses cannot exceed the budget) and
   * returns it when the guess may be compared.
   */
  reserveAttempt(id: string, now: Date): Promise<EmailChallengeReservation>;
  /** Marks the challenge used. True for exactly one concurrent caller; a replay gets false. */
  markUsed(id: string, now: Date): Promise<boolean>;
  /** How many challenges were issued for the attempt (the resend budget). */
  countForAttempt(attemptId: string): Promise<number>;
  /** When the newest challenge for the attempt was issued. */
  lastIssuedAt(attemptId: string): Promise<Date | null>;
}
