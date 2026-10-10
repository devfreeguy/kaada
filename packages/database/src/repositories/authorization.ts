import { PIN_ATTEMPT_POLICY } from "@kaada/domain";
import type {
  AuthorizationSessionRepository,
  PaymentAuthorizationRepository,
  TransactionPinRepository,
} from "@kaada/domain";

import { Prisma } from "../generated/prisma/client.js";
import {
  paymentAuthorizationCreateData,
  toAuthorizationSession,
  toPaymentAuthorization,
  toTransactionPinSecurity,
} from "../mappers/authorization.js";
import type { Db } from "./db.js";

/** The lock ladder as a SQL array literal. Built from code constants only, never from input. */
const LOCK_SECONDS = Prisma.raw(`ARRAY[${PIN_ATTEMPT_POLICY.lockSeconds.join(",")}]::int[]`);
const LOCK_STEPS = PIN_ATTEMPT_POLICY.lockSeconds.length;
const MAX_ATTEMPTS = PIN_ATTEMPT_POLICY.maxAttempts;

export function createTransactionPinRepository(db: Db): TransactionPinRepository {
  return {
    async findByUserId(userId) {
      const row = await db.transactionPinSecurity.findUnique({ where: { userId } });
      return row ? toTransactionPinSecurity(row) : null;
    },

    async create({ id, userId, pinHash, now }) {
      const { count } = await db.transactionPinSecurity.createMany({
        data: [{ id, userId, pinHash, changedAt: now, createdAt: now, updatedAt: now }],
        skipDuplicates: true,
      });
      if (count !== 1) return null;
      const row = await db.transactionPinSecurity.findUnique({ where: { userId } });
      return row ? toTransactionPinSecurity(row) : null;
    },

    async replaceHash({ userId, pinHash, now }) {
      const { count } = await db.transactionPinSecurity.updateMany({
        where: { userId },
        data: {
          pinHash,
          failedAttempts: 0,
          lockLevel: 0,
          lockedUntil: null,
          resetRequired: false,
          changedAt: now,
        },
      });
      if (count !== 1) return null;
      const row = await db.transactionPinSecurity.findUnique({ where: { userId } });
      return row ? toTransactionPinSecurity(row) : null;
    },

    async reserveAttempt(userId, now) {
      // One statement, one row lock: concurrent callers queue behind each other, each seeing the
      // count the previous one left. The attempt is counted as a failure up front and forgiven by
      // recordSuccess, so a burst of guesses can never exceed the budget.
      const rows = await db.$queryRaw<
        { failedAttempts: number; lockedUntil: Date | null }[]
      >(Prisma.sql`
        UPDATE "TransactionPinSecurity" SET
          "failedAttempts" = CASE WHEN "failedAttempts" + 1 >= ${MAX_ATTEMPTS} THEN 0 ELSE "failedAttempts" + 1 END,
          "lockLevel" = CASE WHEN "failedAttempts" + 1 >= ${MAX_ATTEMPTS} THEN "lockLevel" + 1 ELSE "lockLevel" END,
          "lockedUntil" = CASE WHEN "failedAttempts" + 1 >= ${MAX_ATTEMPTS}
            THEN ${now}::timestamptz + make_interval(secs => (${LOCK_SECONDS})[LEAST("lockLevel" + 1, ${LOCK_STEPS})])
            ELSE "lockedUntil" END,
          "updatedAt" = ${now}::timestamptz
        WHERE "userId" = ${userId}::uuid
          AND "resetRequired" = false
          AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now}::timestamptz)
        RETURNING "failedAttempts", "lockedUntil"
      `);
      const updated = rows[0];
      if (updated) {
        const lockedUntil = updated.lockedUntil;
        const lockedNow = lockedUntil !== null && lockedUntil.getTime() > now.getTime();
        return {
          state: "ADMITTED",
          failedAttempts: lockedNow ? MAX_ATTEMPTS : updated.failedAttempts,
          lockedNow,
          ...(lockedNow && lockedUntil && { lockedUntil }),
        };
      }
      const row = await db.transactionPinSecurity.findUnique({ where: { userId } });
      if (!row) return { state: "NOT_SET" };
      if (row.resetRequired) return { state: "RESET_REQUIRED" };
      return { state: "LOCKED", lockedUntil: row.lockedUntil ?? now };
    },

    async recordSuccess(userId) {
      const rows = await db.$queryRaw<{ previous: number }[]>(Prisma.sql`
        WITH prior AS (
          SELECT "lockLevel" AS level FROM "TransactionPinSecurity" WHERE "userId" = ${userId}::uuid FOR UPDATE
        )
        UPDATE "TransactionPinSecurity" AS t
        SET "failedAttempts" = 0, "lockLevel" = 0, "lockedUntil" = NULL
        FROM prior
        WHERE t."userId" = ${userId}::uuid
        RETURNING prior.level AS previous
      `);
      return { hadLocked: (rows[0]?.previous ?? 0) > 0 };
    },

    async markResetRequired(userId) {
      const { count } = await db.transactionPinSecurity.updateMany({
        where: { userId },
        data: { resetRequired: true },
      });
      return count === 1;
    },
  };
}

export function createAuthorizationSessionRepository(db: Db): AuthorizationSessionRepository {
  return {
    async createOrGetPending(session, now) {
      const live = async () => {
        const row = await db.authorizationSession.findFirst({
          where: {
            userId: session.userId,
            intentId: session.intentId,
            intentRevision: session.intentRevision,
            routeId: session.routeId,
            status: "PENDING",
          },
        });
        return row;
      };
      const existing = await live();
      if (existing) {
        if (existing.expiresAt.getTime() > now.getTime()) {
          return { session: toAuthorizationSession(existing), created: false };
        }
        await db.authorizationSession.updateMany({
          where: { id: existing.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
      }
      // ON CONFLICT DO NOTHING: a concurrent twin loses quietly instead of failing the transaction.
      const { count } = await db.authorizationSession.createMany({
        data: [{ ...session, createdAt: now }],
        skipDuplicates: true,
      });
      const row = await live();
      if (!row) throw new Error("authorization session vanished after creation");
      return { session: toAuthorizationSession(row), created: count === 1 };
    },

    async findById(id) {
      const row = await db.authorizationSession.findUnique({ where: { id } });
      return row ? toAuthorizationSession(row) : null;
    },

    async findByTokenHash(tokenHash) {
      const row = await db.authorizationSession.findUnique({ where: { tokenHash } });
      return row ? toAuthorizationSession(row) : null;
    },

    async issueToken({ id, tokenHash, now }) {
      const { count } = await db.authorizationSession.updateMany({
        where: { id, status: "PENDING", expiresAt: { gt: now } },
        data: { tokenHash, tokenIssuedAt: now },
      });
      if (count !== 1) return null;
      const row = await db.authorizationSession.findUnique({ where: { id } });
      return row ? toAuthorizationSession(row) : null;
    },

    async markAuthorized(id, now) {
      const { count } = await db.authorizationSession.updateMany({
        where: { id, status: "PENDING", expiresAt: { gt: now } },
        data: { status: "AUTHORIZED", usedAt: now },
      });
      if (count !== 1) return null;
      const row = await db.authorizationSession.findUnique({ where: { id } });
      return row ? toAuthorizationSession(row) : null;
    },

    async markExpired(id) {
      const { count } = await db.authorizationSession.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "EXPIRED" },
      });
      if (count !== 1) return null;
      const row = await db.authorizationSession.findUnique({ where: { id } });
      return row ? toAuthorizationSession(row) : null;
    },

    async cancel(id, reason) {
      const { count } = await db.authorizationSession.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "CANCELLED", cancelReason: reason },
      });
      if (count !== 1) return null;
      const row = await db.authorizationSession.findUnique({ where: { id } });
      return row ? toAuthorizationSession(row) : null;
    },

    async cancelPendingExcept(intentId, keep, reason) {
      const candidates = await db.authorizationSession.findMany({
        where: {
          intentId,
          status: "PENDING",
          ...(keep && { NOT: { intentRevision: keep.revision, routeId: keep.routeId } }),
        },
        select: { id: true },
      });
      if (candidates.length === 0) return [];
      const ids = candidates.map((row) => row.id);
      await db.authorizationSession.updateMany({
        where: { id: { in: ids }, status: "PENDING" },
        data: { status: "CANCELLED", cancelReason: reason },
      });
      const rows = await db.authorizationSession.findMany({
        where: { id: { in: ids }, status: "CANCELLED", cancelReason: reason },
      });
      return rows.map(toAuthorizationSession);
    },
  };
}

export function createPaymentAuthorizationRepository(db: Db): PaymentAuthorizationRepository {
  return {
    async create(authorization) {
      return toPaymentAuthorization(
        await db.paymentAuthorization.create({
          data: paymentAuthorizationCreateData(authorization),
        }),
      );
    },

    async findById(id) {
      const row = await db.paymentAuthorization.findUnique({ where: { id } });
      return row ? toPaymentAuthorization(row) : null;
    },

    async findActiveByIntent(intentId) {
      const row = await db.paymentAuthorization.findFirst({
        where: { intentId, status: "ACTIVE" },
      });
      return row ? toPaymentAuthorization(row) : null;
    },

    async consume(id, now) {
      // The whole state machine step is one conditional UPDATE: of any number of racing callers,
      // the database lets exactly one match the WHERE clause.
      const { count } = await db.paymentAuthorization.updateMany({
        where: { id, status: "ACTIVE", expiresAt: { gt: now } },
        data: { status: "CONSUMED", consumedAt: now },
      });
      if (count !== 1) return null;
      const row = await db.paymentAuthorization.findUnique({ where: { id } });
      return row ? toPaymentAuthorization(row) : null;
    },

    async revoke(id, reason, now) {
      const { count } = await db.paymentAuthorization.updateMany({
        where: { id, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revocationReason: reason },
      });
      if (count !== 1) return null;
      const row = await db.paymentAuthorization.findUnique({ where: { id } });
      return row ? toPaymentAuthorization(row) : null;
    },

    async revokeActiveExcept(intentId, keep, reason, now) {
      const candidates = await db.paymentAuthorization.findMany({
        where: {
          intentId,
          status: "ACTIVE",
          ...(keep && { NOT: { intentRevision: keep.revision, routeId: keep.routeId } }),
        },
        select: { id: true },
      });
      if (candidates.length === 0) return [];
      const ids = candidates.map((row) => row.id);
      await db.paymentAuthorization.updateMany({
        where: { id: { in: ids }, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revocationReason: reason },
      });
      const rows = await db.paymentAuthorization.findMany({
        where: { id: { in: ids }, status: "REVOKED", revokedAt: now },
      });
      return rows.map(toPaymentAuthorization);
    },

    async expireDue(now) {
      const due = await db.paymentAuthorization.findMany({
        where: { status: "ACTIVE", expiresAt: { lte: now } },
        select: { id: true },
      });
      if (due.length === 0) return [];
      const ids = due.map((row) => row.id);
      await db.paymentAuthorization.updateMany({
        where: { id: { in: ids }, status: "ACTIVE", expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });
      const rows = await db.paymentAuthorization.findMany({
        where: { id: { in: ids }, status: "EXPIRED" },
      });
      return rows.map(toPaymentAuthorization);
    },
  };
}
