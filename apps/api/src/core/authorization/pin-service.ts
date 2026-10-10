import {
  AUTHORIZATION_AUDIT_EVENTS,
  KaadaError,
  PIN_ATTEMPT_POLICY,
  createId,
  isValidPinFormat,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { AuthorizationRepositories, AuthorizationUnitOfWork, PinHasher } from "./ports.js";

/** The result of checking a PIN. Nothing here says anything about the PIN itself. */
export type PinVerification =
  | { status: "VERIFIED" }
  | { status: "INVALID"; attemptsRemaining: number; lockedUntil?: Date }
  | { status: "LOCKED"; lockedUntil: Date }
  | { status: "NOT_SET" }
  | { status: "RESET_REQUIRED" }
  | { status: "INVALID_FORMAT" };

export interface PinStatus {
  isSet: boolean;
  resetRequired: boolean;
  lockedUntil?: Date;
}

export interface TransactionPinServiceDeps {
  unitOfWork: AuthorizationUnitOfWork;
  hasher: PinHasher;
  now?: () => Date;
  log?: AgentLog;
}

/**
 * Creates and verifies the 4-digit transaction PIN. Only an Argon2id hash is stored; the PIN is never
 * logged, audited, returned or kept anywhere but in the memory of the call that received it.
 *
 * This class does NOT decide who may SET a PIN: setting or changing one is security-sensitive and
 * needs a stronger credential (a fresh passkey assertion), which the caller must have verified. It
 * cannot be called to unlock or control a wallet: the PIN only ever confirms one payment.
 */
export class TransactionPinService {
  private readonly uow: AuthorizationUnitOfWork;
  private readonly hasher: PinHasher;
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(deps: TransactionPinServiceDeps) {
    this.uow = deps.unitOfWork;
    this.hasher = deps.hasher;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async status(userId: string): Promise<PinStatus> {
    const row = await this.uow.read.transactionPins.findByUserId(userId);
    if (!row) return { isSet: false, resetRequired: false };
    const now = this.now();
    return {
      isSet: true,
      resetRequired: row.resetRequired,
      ...(row.lockedUntil &&
        row.lockedUntil.getTime() > now.getTime() && {
          lockedUntil: row.lockedUntil,
        }),
    };
  }

  /**
   * Stores a new PIN, or replaces the existing one. The caller must already have verified a strong
   * credential. Replacing clears every failure counter and lock.
   */
  async setPin(userId: string, pin: string): Promise<"CREATED" | "CHANGED"> {
    if (!isValidPinFormat(pin)) {
      throw new KaadaError("PIN_REJECTED", "a PIN is exactly four digits");
    }
    // Hashing is slow on purpose: it happens before, and outside, any transaction.
    const pinHash = await this.hasher.hash(pin);
    const now = this.now();
    return this.uow.transaction(async (repositories) => {
      const created = await repositories.transactionPins.create({
        id: createId(),
        userId,
        pinHash,
        now,
      });
      if (created) {
        await this.audit(repositories, userId, AUTHORIZATION_AUDIT_EVENTS.pinCreated, created.id);
        return "CREATED" as const;
      }
      const replaced = await repositories.transactionPins.replaceHash({ userId, pinHash, now });
      if (!replaced) throw new KaadaError("PIN_REJECTED", "the PIN could not be saved");
      await this.audit(repositories, userId, AUTHORIZATION_AUDIT_EVENTS.pinChanged, replaced.id);
      return "CHANGED" as const;
    });
  }

  /**
   * Checks a PIN against the user's stored hash under the attempt policy. The attempt is reserved
   * (and so counted) BEFORE the hash is compared, in one atomic statement, so concurrent guesses
   * cannot exceed the budget; a correct PIN then clears the count.
   */
  async verify(userId: string, pin: string): Promise<PinVerification> {
    // A malformed value is not a guess: it cannot be a PIN, so it neither costs an attempt nor
    // reveals whether the user has one.
    if (!isValidPinFormat(pin)) return { status: "INVALID_FORMAT" };

    const now = this.now();
    const reservation = await this.uow.read.transactionPins.reserveAttempt(userId, now);
    switch (reservation.state) {
      case "NOT_SET":
        return { status: "NOT_SET" };
      case "RESET_REQUIRED":
        return { status: "RESET_REQUIRED" };
      case "LOCKED":
        return { status: "LOCKED", lockedUntil: reservation.lockedUntil };
      case "ADMITTED":
        break;
    }

    const row = await this.uow.read.transactionPins.findByUserId(userId);
    const correct = row ? await this.hasher.verify(row.pinHash, pin) : false;
    if (correct) {
      const { hadLocked } = await this.uow.read.transactionPins.recordSuccess(userId);
      if (hadLocked) {
        await this.audit(
          this.uow.read,
          userId,
          AUTHORIZATION_AUDIT_EVENTS.pinUnlocked,
          row?.id ?? userId,
        );
      }
      return { status: "VERIFIED" };
    }

    const entity = row?.id ?? userId;
    await this.audit(
      this.uow.read,
      userId,
      AUTHORIZATION_AUDIT_EVENTS.pinVerificationFailed,
      entity,
      {
        attemptsRemaining: reservation.lockedNow
          ? 0
          : Math.max(0, PIN_ATTEMPT_POLICY.maxAttempts - reservation.failedAttempts),
      },
    );
    this.log("warn", "authorization.pin_failed", { userId, locked: reservation.lockedNow });
    if (reservation.lockedNow) {
      await this.audit(this.uow.read, userId, AUTHORIZATION_AUDIT_EVENTS.pinLocked, entity);
      return {
        status: "INVALID",
        attemptsRemaining: 0,
        ...(reservation.lockedUntil && { lockedUntil: reservation.lockedUntil }),
      };
    }
    return {
      status: "INVALID",
      attemptsRemaining: Math.max(0, PIN_ATTEMPT_POLICY.maxAttempts - reservation.failedAttempts),
    };
  }

  /** Marks the PIN as replaceable only through account recovery (a future build). */
  async requireReset(userId: string, reason: string): Promise<void> {
    const row = await this.uow.read.transactionPins.findByUserId(userId);
    if (!row) return;
    if (await this.uow.read.transactionPins.markResetRequired(userId)) {
      await this.audit(this.uow.read, userId, AUTHORIZATION_AUDIT_EVENTS.pinResetRequired, row.id, {
        reason,
      });
    }
  }

  /**
   * "I forgot my PIN." There is no reset by itself: the future flow is verified email recovery PLUS a
   * strong credential. Until then the honest answer is that recovery is required.
   */
  forgotPin(): { status: "PIN_RESET_REQUIRED"; supported: false } {
    return { status: "PIN_RESET_REQUIRED", supported: false };
  }

  private async audit(
    repositories: Pick<AuthorizationRepositories, "audit">,
    userId: string,
    type: string,
    entityId: string,
    data?: Record<string, string | number>,
  ): Promise<void> {
    await repositories.audit.append({
      id: createId(),
      userId,
      type,
      entityType: "transaction_pin",
      entityId,
      // Counters and reason codes only: never the PIN, a hash or a guess.
      ...(data && { data }),
    });
  }
}
