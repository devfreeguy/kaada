/**
 * A pending proof that a person controls an email address they want to use for account recovery. The code itself is never stored,
 * only a keyed hash of it. An address becomes the person's EMAIL identity only after the right code was entered.
 */
export interface EmailVerification {
  id: string;
  userId: string;
  /** Normalized (trimmed, lower case). */
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  usedAt?: Date;
  createdAt: Date;
}

export type NewEmailVerification = Pick<
  EmailVerification,
  "id" | "userId" | "email" | "codeHash" | "expiresAt" | "maxAttempts"
>;

export type EmailVerificationAttempt =
  | { state: "NONE" }
  /** Used, expired, or out of attempts: nothing more can be tried on it. */
  | { state: "CLOSED" }
  | { state: "ADMITTED"; verification: EmailVerification };

export interface EmailVerificationRepository {
  create(input: NewEmailVerification): Promise<EmailVerification>;
  /** The newest verification issued to this person, if any. */
  findLatest(userId: string): Promise<EmailVerification | null>;
  /** How many were issued to this person since `since` (the sending limit). */
  countSince(userId: string, since: Date): Promise<number>;
  /** Counts one guess in a single conditional update, so parallel guesses cannot exceed the budget. */
  reserveAttempt(id: string, now: Date): Promise<EmailVerificationAttempt>;
  /** Marks it used (once). False if it already was. */
  markUsed(id: string, now: Date): Promise<boolean>;
}
