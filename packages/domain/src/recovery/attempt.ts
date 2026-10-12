import type { JsonObject } from "../json.js";

/*
 * One attempt to recover a wallet. It is an explicit state machine; every transition is a conditional update, so two
 * processes (or a retried request) can never both apply it.
 *
 *   EMAIL_PENDING --verify email--> EMAIL_VERIFIED --propose new root--> ROOT_PROPOSED
 *     --Recovery Code proof + attestor--> INITIATING --on-chain initiate--> PENDING (timelock running)
 *     --maturity + no in-flight payment--> FINALIZING --root read back--> ROOT_CHANGED
 *     --new credential proves it can sign--> COMPLETED
 *
 *   Terminal exits: CANCELLED (the existing root cancelled), VETOED (the attestor vetoed), EXPIRED (never reached the
 *   chain and ran out of time), FAILED (the chain refused it). A terminal attempt is never reused.
 */

export const RECOVERY_ATTEMPT_STATUSES = [
  "EMAIL_PENDING",
  "EMAIL_VERIFIED",
  "ROOT_PROPOSED",
  "INITIATING",
  "PENDING",
  "FINALIZING",
  "ROOT_CHANGED",
  "COMPLETED",
  "CANCELLED",
  "VETOED",
  "EXPIRED",
  "FAILED",
] as const;
export type RecoveryAttemptStatus = (typeof RECOVERY_ATTEMPT_STATUSES)[number];

/** Statuses from which nothing further happens. */
export const RECOVERY_TERMINAL_STATUSES = [
  "COMPLETED",
  "CANCELLED",
  "VETOED",
  "EXPIRED",
  "FAILED",
] as const;

/** At most one non-terminal attempt may exist per wallet (a partial unique index enforces it). */
export function isRecoveryAttemptActive(status: RecoveryAttemptStatus): boolean {
  return !(RECOVERY_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The ONLY legal moves. Anything else is a bug and is refused. */
export const RECOVERY_TRANSITIONS: Readonly<
  Record<RecoveryAttemptStatus, readonly RecoveryAttemptStatus[]>
> = {
  EMAIL_PENDING: ["EMAIL_VERIFIED", "EXPIRED"],
  EMAIL_VERIFIED: ["ROOT_PROPOSED", "EXPIRED", "FAILED"],
  ROOT_PROPOSED: ["INITIATING", "EXPIRED", "FAILED"],
  INITIATING: ["PENDING", "FAILED"],
  PENDING: ["FINALIZING", "CANCELLED", "VETOED", "FAILED"],
  // A crashed finalizer's lease may be reclaimed (FINALIZING -> FINALIZING); the chain decides what happened.
  FINALIZING: ["FINALIZING", "ROOT_CHANGED", "PENDING", "CANCELLED", "VETOED", "FAILED"],
  ROOT_CHANGED: ["COMPLETED"],
  COMPLETED: [],
  CANCELLED: [],
  VETOED: [],
  EXPIRED: [],
  FAILED: [],
};

export function canTransitionRecovery(
  from: RecoveryAttemptStatus,
  to: RecoveryAttemptStatus,
): boolean {
  return RECOVERY_TRANSITIONS[from].includes(to);
}

export const RECOVERY_TERMINATORS = ["ROOT", "ATTESTOR", "SYSTEM"] as const;
/** Who ended an attempt: the existing root (cancel), the attestor (veto) or Kaada itself (expiry, failure). */
export type RecoveryTerminator = (typeof RECOVERY_TERMINATORS)[number];

export interface RecoveryAttempt {
  id: string;
  userId: string;
  walletId: string;
  /** The configuration (Recovery Code verifier) this attempt relies on. */
  configurationId?: string;
  status: RecoveryAttemptStatus;

  /** SHA-256 of the opaque session token the person holds. The token itself is never stored. */
  tokenHash: string;
  tokenExpiresAt: Date;
  /** SHA-256 of the one-use "this was not me" token sent ONLY through notifications. */
  cancelTokenHash?: string;
  emailVerifiedAt?: Date;

  // The exact new root the person committed to (public data).
  newCredentialId?: string;
  newRootKind?: "PASSKEY" | "DEVICE_KEY";
  newValidator?: string;
  /** 0x-hex install data of the new root (public: a key and an id). */
  newValidatorData?: string;
  newValidatorDataHash?: string;
  newHook?: string;
  newHookData?: string;
  newHookDataHash?: string;
  /** keccak256(abi.encode(rootId, hook, validatorDataHash, hookDataHash)): what the contract stores. */
  commitmentHash?: string;
  /** The recovery validator nonce the signatures were made for. */
  recoveryNonce?: string;
  proofDeadline?: Date;
  proposedAt?: Date;

  // On-chain progress.
  /** The root validator the account had when recovery was initiated (to be replaced). */
  previousRootValidator?: string;
  initiatedAt?: Date;
  executeAfter?: Date;
  initiateTxHash?: string;
  /** The account currentNonce just before the recovery batch; the batch invalidates `nonceBefore + 1`. */
  nonceBefore?: number;
  finalizeUserOpHash?: string;
  finalizeTxHash?: string;
  /** Why a matured recovery is waiting (for example an in-flight payment). A code, never provider output. */
  blockedReason?: string;
  /** Finalizer lease: only one process drives FINALIZING at a time. */
  lockedBy?: string;
  lockedUntil?: Date;

  // Confirmation and completion.
  rootConfirmedAt?: Date;
  /** The userOpHash the existing ROOT must sign to cancel, and the unsigned operation it covers (no secret). */
  cancelChallenge?: string;
  cancelPrepared?: JsonObject;
  cancelUserOpHash?: string;
  /** The random challenge the new credential must sign to prove it works (hex). */
  proofChallenge?: string;
  /** Wrong Recovery Code signatures submitted so far; the attempt fails after a few. */
  proofFailures: number;
  proofVerifiedAt?: Date;
  completedAt?: Date;

  // Terminal exits.
  terminatedBy?: RecoveryTerminator;
  terminatedAt?: Date;
  terminationTxHash?: string;
  failureCode?: string;

  // After the root changed.
  cleanupCompletedAt?: Date;
  pinResetAt?: Date;
  newConfigurationId?: string;

  createdAt: Date;
  updatedAt: Date;
}

export type NewRecoveryAttempt = Pick<
  RecoveryAttempt,
  "id" | "userId" | "walletId" | "tokenHash" | "tokenExpiresAt"
> &
  Partial<Pick<RecoveryAttempt, "configurationId">>;

/** The fields a transition may set. `status` is set through `advance`, never through a patch. */
export type RecoveryAttemptPatch = Partial<
  Omit<
    RecoveryAttempt,
    "id" | "userId" | "walletId" | "status" | "createdAt" | "updatedAt" | "proofFailures"
  >
>;

/**
 * Fields a transition may blank: the deferral reason, the finalizer lease (holder and expiry together) and a recorded
 * finalize submission (its UserOperation hash and the nonce read before it).
 */
export type RecoveryClearable = "blockedReason" | "lease" | "finalizeSubmission";

export interface RecoveryAttemptRepository {
  /** Inserts a new EMAIL_PENDING attempt. Null when the wallet already has a non-terminal attempt. */
  create(attempt: NewRecoveryAttempt): Promise<RecoveryAttempt | null>;
  findById(id: string): Promise<RecoveryAttempt | null>;
  findByTokenHash(tokenHash: string): Promise<RecoveryAttempt | null>;
  findByCancelTokenHash(tokenHash: string): Promise<RecoveryAttempt | null>;
  /** Counts one wrong Recovery Code signature and returns the new total. */
  recordProofFailure(id: string): Promise<number>;
  /** The wallet non-terminal attempt, if any. */
  findActiveByWallet(walletId: string): Promise<RecoveryAttempt | null>;
  /**
   * Moves `id` to `to` and applies `patch`, in ONE conditional update that requires the current status to be one of
   * `from` (and the transition to be legal). Returns the updated attempt, or null when the attempt was not in `from`
   * (another process already moved it). This is the only way a status changes.
   */
  advance(input: {
    id: string;
    from: RecoveryAttemptStatus[];
    to: RecoveryAttemptStatus;
    patch?: RecoveryAttemptPatch;
    clear?: RecoveryClearable[];
  }): Promise<RecoveryAttempt | null>;
  /** Applies `patch` without changing the status. When `guard.lockedBy` is given it must hold the finalizer lease. */
  patch(
    id: string,
    patch: RecoveryAttemptPatch,
    guard?: { status?: RecoveryAttemptStatus[]; lockedBy?: string; clear?: RecoveryClearable[] },
  ): Promise<RecoveryAttempt | null>;
  /**
   * Claims the finalizer lease in one conditional update: a PENDING attempt that has matured (`executeAfter <= now`)
   * becomes FINALIZING, or a FINALIZING one whose lease expired is taken over. Exactly one concurrent caller gets it.
   */
  claimFinalization(input: {
    id: string;
    owner: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<RecoveryAttempt | null>;
  /** Gives the lease back and returns a FINALIZING attempt to PENDING (a deferred finalization, e.g. a payment is in flight). */
  releaseFinalization(input: {
    id: string;
    owner: string;
    blockedReason: string;
  }): Promise<RecoveryAttempt | null>;
  /** The wallet's COMPLETED attempt that still waits for a new Recovery Code, if any. */
  findCompletedAwaitingConfiguration(walletId: string): Promise<RecoveryAttempt | null>;
  /** Attempts in any of `statuses`, oldest first. Used by the reconciler. */
  listByStatus(statuses: RecoveryAttemptStatus[], limit: number): Promise<RecoveryAttempt[]>;
  /** PENDING attempts whose timelock has passed, oldest `executeAfter` first. */
  listMatured(now: Date, limit: number): Promise<RecoveryAttempt[]>;
  /** FINALIZING attempts whose lease expired (a crashed finalizer). */
  listAbandoned(now: Date, limit: number): Promise<RecoveryAttempt[]>;
  /** ROOT_CHANGED / COMPLETED attempts whose cleanup has not finished. */
  listNeedingCleanup(limit: number): Promise<RecoveryAttempt[]>;
  /** Pre-chain attempts (EMAIL_PENDING .. ROOT_PROPOSED) past their token expiry become EXPIRED. Returns how many. */
  expireStale(now: Date): Promise<number>;
  /** Attempts the user started since `since` (any status): the rate and cooldown input. */
  countStartedSince(userId: string, since: Date): Promise<number>;
  /** When the user most recent attempt reached COMPLETED, if ever. */
  lastCompletedAt(userId: string): Promise<Date | null>;
}
