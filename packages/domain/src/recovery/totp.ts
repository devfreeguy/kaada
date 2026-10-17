/*
 * The authenticator-app (TOTP) factor of a wallet's recovery. TOTP is checked OFF-CHAIN by Kaada before it submits a
 * recovery; the recovery contract never sees it. The secret is stored ONLY encrypted (AES-256-GCM, a dedicated key) and is
 * never returned after enrolment, logged, or part of any audit record.
 *
 *   PENDING --first valid code--> ACTIVE --recovery completes / wallet re-arms / user disables--> DISABLED
 *
 * Replay protection: `lastUsedStep` only ever moves forward. A code is accepted for a time step strictly greater than the
 * last one used, in ONE conditional update, so the same code can never be accepted twice, by one process or by two.
 */

export const RECOVERY_TOTP_STATUSES = ["PENDING", "ACTIVE", "DISABLED"] as const;
export type RecoveryTotpStatus = (typeof RECOVERY_TOTP_STATUSES)[number];

export interface RecoveryTotp {
  id: string;
  userId: string;
  walletId: string;
  status: RecoveryTotpStatus;
  /** `v<key version>.<nonce>.<ciphertext+tag>`: the base32 secret, encrypted, bound to this record. */
  encryptedSecret: string;
  keyVersion: number;
  /** When the first valid code was entered (enrolment complete). Absent while PENDING. */
  enabledAt?: Date;
  /** The newest 30-second time step already accepted. Moves forward only. */
  lastUsedStep?: number;
  createdAt: Date;
  updatedAt: Date;
  disabledAt?: Date;
}

export type NewRecoveryTotp = Pick<
  RecoveryTotp,
  "id" | "userId" | "walletId" | "encryptedSecret" | "keyVersion"
>;

export interface RecoveryTotpRepository {
  /**
   * Stores a new PENDING enrolment. Any older PENDING one of the wallet is discarded (it never protected anything).
   * Refused (null) when the wallet already has an ACTIVE one: that must be disabled first.
   */
  createPending(totp: NewRecoveryTotp): Promise<RecoveryTotp | null>;
  findById(id: string): Promise<RecoveryTotp | null>;
  findPending(walletId: string): Promise<RecoveryTotp | null>;
  findActive(walletId: string): Promise<RecoveryTotp | null>;
  /** PENDING -> ACTIVE in one conditional update, recording the step of the code that proved it. Null if not PENDING. */
  activate(input: { id: string; step: number; at: Date }): Promise<RecoveryTotp | null>;
  /**
   * Accepts `step` for an ACTIVE enrolment only when it is newer than every step used before. True for exactly one
   * concurrent caller per step; a replay (or an older step) gets false.
   */
  consumeStep(input: { id: string; step: number }): Promise<boolean>;
  /** Disables the wallet's ACTIVE and PENDING enrolments. Returns how many were disabled. */
  disableForWallet(walletId: string, at: Date): Promise<number>;
}
