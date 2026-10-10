import { randomUUID } from "node:crypto";

import { PIN_ATTEMPT_POLICY } from "@kaada/domain";
import type {
  AuditEvent,
  AuditRepository,
  AuthorizationSession,
  AuthorizationSessionRepository,
  PaymentAuthorization,
  PaymentAuthorizationRepository,
  PinAttemptReservation,
  TransactionPinRepository,
  TransactionPinSecurity,
} from "@kaada/domain";

/*
 * In-memory implementations of the authorization repository contracts for offline tests. Every method
 * is synchronous inside, so each conditional transition is atomic exactly like the single SQL UPDATE
 * it stands in for: two racing callers are decided by who runs first, never both.
 */

export interface AuthorizationStores {
  pins: Map<string, TransactionPinSecurity>;
  sessions: AuthorizationSession[];
  payments: PaymentAuthorization[];
  audit: AuditEvent[];
  repositories: {
    transactionPins: TransactionPinRepository;
    authorizationSessions: AuthorizationSessionRepository;
    paymentAuthorizations: PaymentAuthorizationRepository;
    audit: AuditRepository;
  };
}

export function createAuthorizationStores(
  stamp: () => Date = () => new Date(),
): AuthorizationStores {
  const pins = new Map<string, TransactionPinSecurity>();
  const sessions: AuthorizationSession[] = [];
  const payments: PaymentAuthorization[] = [];
  const audit: AuditEvent[] = [];

  const transactionPins: TransactionPinRepository = {
    findByUserId: (userId) => Promise.resolve(pins.get(userId) ?? null),

    create: ({ id, userId, pinHash, now }) => {
      if (pins.has(userId)) return Promise.resolve(null);
      const row: TransactionPinSecurity = {
        id,
        userId,
        pinHash,
        failedAttempts: 0,
        lockLevel: 0,
        changedAt: now,
        resetRequired: false,
        createdAt: now,
        updatedAt: now,
      };
      pins.set(userId, row);
      return Promise.resolve({ ...row });
    },

    replaceHash: ({ userId, pinHash, now }) => {
      const row = pins.get(userId);
      if (!row) return Promise.resolve(null);
      row.pinHash = pinHash;
      row.failedAttempts = 0;
      row.lockLevel = 0;
      delete row.lockedUntil;
      row.resetRequired = false;
      row.changedAt = now;
      return Promise.resolve({ ...row });
    },

    reserveAttempt: (userId, now): Promise<PinAttemptReservation> => {
      const row = pins.get(userId);
      if (!row) return Promise.resolve({ state: "NOT_SET" });
      if (row.resetRequired) return Promise.resolve({ state: "RESET_REQUIRED" });
      if (row.lockedUntil && row.lockedUntil.getTime() > now.getTime()) {
        return Promise.resolve({ state: "LOCKED", lockedUntil: row.lockedUntil });
      }
      const { maxAttempts, lockSeconds } = PIN_ATTEMPT_POLICY;
      if (row.failedAttempts + 1 >= maxAttempts) {
        const seconds = lockSeconds[Math.min(row.lockLevel, lockSeconds.length - 1)] ?? 3600;
        row.failedAttempts = 0;
        row.lockLevel += 1;
        row.lockedUntil = new Date(now.getTime() + seconds * 1000);
        return Promise.resolve({
          state: "ADMITTED",
          failedAttempts: maxAttempts,
          lockedNow: true,
          lockedUntil: row.lockedUntil,
        });
      }
      row.failedAttempts += 1;
      return Promise.resolve({
        state: "ADMITTED",
        failedAttempts: row.failedAttempts,
        lockedNow: false,
      });
    },

    recordSuccess: (userId) => {
      const row = pins.get(userId);
      const hadLocked = (row?.lockLevel ?? 0) > 0;
      if (row) {
        row.failedAttempts = 0;
        row.lockLevel = 0;
        delete row.lockedUntil;
      }
      return Promise.resolve({ hadLocked });
    },

    markResetRequired: (userId) => {
      const row = pins.get(userId);
      if (row) row.resetRequired = true;
      return Promise.resolve(row !== undefined);
    },
  };

  const copy = <T extends object>(value: T): T => ({ ...value });

  const authorizationSessions: AuthorizationSessionRepository = {
    createOrGetPending: (input, now) => {
      const live = () =>
        sessions.find(
          (s) =>
            s.userId === input.userId &&
            s.intentId === input.intentId &&
            s.intentRevision === input.intentRevision &&
            s.routeId === input.routeId &&
            s.status === "PENDING",
        );
      const existing = live();
      if (existing) {
        if (existing.expiresAt.getTime() > now.getTime()) {
          return Promise.resolve({ session: copy(existing), created: false });
        }
        existing.status = "EXPIRED";
      }
      const session: AuthorizationSession = { ...input, status: "PENDING", createdAt: now };
      sessions.push(session);
      return Promise.resolve({ session: copy(session), created: true });
    },
    findById: (id) => {
      const found = sessions.find((s) => s.id === id);
      return Promise.resolve(found ? copy(found) : null);
    },
    findByTokenHash: (hash) => {
      const found = sessions.find((s) => s.tokenHash === hash);
      return Promise.resolve(found ? copy(found) : null);
    },
    issueToken: ({ id, tokenHash, now }) => {
      const found = sessions.find((s) => s.id === id);
      if (!found || found.status !== "PENDING" || found.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(null);
      }
      found.tokenHash = tokenHash;
      found.tokenIssuedAt = now;
      return Promise.resolve(copy(found));
    },
    markAuthorized: (id, now) => {
      const found = sessions.find((s) => s.id === id);
      if (!found || found.status !== "PENDING" || found.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(null);
      }
      found.status = "AUTHORIZED";
      found.usedAt = now;
      return Promise.resolve(copy(found));
    },
    markExpired: (id) => {
      const found = sessions.find((s) => s.id === id);
      if (!found || found.status !== "PENDING") return Promise.resolve(null);
      found.status = "EXPIRED";
      return Promise.resolve(copy(found));
    },
    cancel: (id, reason) => {
      const found = sessions.find((s) => s.id === id);
      if (!found || found.status !== "PENDING") return Promise.resolve(null);
      found.status = "CANCELLED";
      found.cancelReason = reason;
      return Promise.resolve(copy(found));
    },
    cancelPendingExcept: (intentId, keep, reason) => {
      const cancelled: AuthorizationSession[] = [];
      for (const s of sessions) {
        if (s.intentId !== intentId || s.status !== "PENDING") continue;
        if (keep && s.intentRevision === keep.revision && s.routeId === keep.routeId) continue;
        s.status = "CANCELLED";
        s.cancelReason = reason;
        cancelled.push(copy(s));
      }
      return Promise.resolve(cancelled);
    },
  };

  const paymentAuthorizations: PaymentAuthorizationRepository = {
    create: (input) => {
      if (payments.some((p) => p.intentId === input.intentId && p.status === "ACTIVE")) {
        return Promise.reject(new Error("an active authorization already exists for this intent"));
      }
      const row: PaymentAuthorization = { ...input, status: "ACTIVE", createdAt: stamp() };
      payments.push(row);
      return Promise.resolve(copy(row));
    },
    findById: (id) => {
      const found = payments.find((p) => p.id === id);
      return Promise.resolve(found ? copy(found) : null);
    },
    findActiveByIntent: (intentId) => {
      const found = payments.find((p) => p.intentId === intentId && p.status === "ACTIVE");
      return Promise.resolve(found ? copy(found) : null);
    },
    consume: (id, now) => {
      const found = payments.find((p) => p.id === id);
      if (!found || found.status !== "ACTIVE" || found.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(null);
      }
      found.status = "CONSUMED";
      found.consumedAt = now;
      return Promise.resolve(copy(found));
    },
    revoke: (id, reason, now) => {
      const found = payments.find((p) => p.id === id);
      if (!found || found.status !== "ACTIVE") return Promise.resolve(null);
      found.status = "REVOKED";
      found.revokedAt = now;
      found.revocationReason = reason;
      return Promise.resolve(copy(found));
    },
    revokeActiveExcept: (intentId, keep, reason, now) => {
      const revoked: PaymentAuthorization[] = [];
      for (const p of payments) {
        if (p.intentId !== intentId || p.status !== "ACTIVE") continue;
        if (keep && p.intentRevision === keep.revision && p.routeId === keep.routeId) continue;
        p.status = "REVOKED";
        p.revokedAt = now;
        p.revocationReason = reason;
        revoked.push(copy(p));
      }
      return Promise.resolve(revoked);
    },
    expireDue: (now) => {
      const expired: PaymentAuthorization[] = [];
      for (const p of payments) {
        if (p.status === "ACTIVE" && p.expiresAt.getTime() <= now.getTime()) {
          p.status = "EXPIRED";
          expired.push(copy(p));
        }
      }
      return Promise.resolve(expired);
    },
  };

  const auditRepository: AuditRepository = {
    append: (event) => {
      const row: AuditEvent = { ...event, createdAt: stamp() };
      audit.push(row);
      return Promise.resolve(row);
    },
    listForUser: (userId) => Promise.resolve(audit.filter((a) => a.userId === userId).reverse()),
  };

  return {
    pins,
    sessions,
    payments,
    audit,
    repositories: {
      transactionPins,
      authorizationSessions,
      paymentAuthorizations,
      audit: auditRepository,
    },
  };
}

export const newId = (): string => randomUUID();
