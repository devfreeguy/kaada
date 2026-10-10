import type {
  ExecutionPlanRepository,
  ExecutionSecretRepository,
  FirmQuoteAttemptRepository,
} from "@kaada/domain";

import { toExecutionPlanRecord, toFirmQuoteAttempt } from "../mappers/firm.js";
import { jsonInput, maybe } from "../mappers/support.js";
import type { Db } from "./db.js";

const LIVE = ["REQUESTING", "QUOTED"] as const;

export function createFirmQuoteAttemptRepository(db: Db): FirmQuoteAttemptRepository {
  const reload = async (id: string) => {
    const row = await db.firmQuoteAttempt.findUnique({ where: { id } });
    return row ? toFirmQuoteAttempt(row) : null;
  };

  return {
    async claim(attempt, now) {
      const live = () =>
        db.firmQuoteAttempt.findFirst({
          where: {
            paymentAuthorizationId: attempt.paymentAuthorizationId,
            providerId: attempt.providerId,
            status: { in: [...LIVE] },
          },
        });
      const existing = await live();
      if (existing) return { attempt: toFirmQuoteAttempt(existing), claimed: false };

      // ON CONFLICT DO NOTHING: of two racing claims exactly one inserts; the loser reads the winner.
      const { count } = await db.firmQuoteAttempt.createMany({
        data: [
          {
            id: attempt.id,
            paymentAuthorizationId: attempt.paymentAuthorizationId,
            userId: attempt.userId,
            walletId: attempt.walletId,
            providerId: attempt.providerId,
            idempotencyKey: attempt.idempotencyKey,
            amountMode: attempt.amountMode,
            exactAmount: attempt.exactAmount.amount,
            exactAssetId: attempt.exactAmount.assetId,
            takerAddress: attempt.takerAddress,
            createdAt: now,
            updatedAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const row =
        (await live()) ?? (await db.firmQuoteAttempt.findUnique({ where: { id: attempt.id } }));
      if (!row) throw new Error("firm quote attempt vanished after claim");
      return { attempt: toFirmQuoteAttempt(row), claimed: count === 1 };
    },

    findById: reload,

    async listByAuthorization(paymentAuthorizationId) {
      const rows = await db.firmQuoteAttempt.findMany({
        where: { paymentAuthorizationId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toFirmQuoteAttempt);
    },

    async recordQuoted(id, fields, now) {
      const { count } = await db.firmQuoteAttempt.updateMany({
        where: { id, status: "REQUESTING" },
        data: {
          status: "QUOTED",
          providerQuoteId: fields.providerQuoteId,
          inputAmount: fields.input.amount,
          inputAssetId: fields.input.assetId,
          outputAmount: fields.output.amount,
          outputAssetId: fields.output.assetId,
          feeAmount: fields.fee?.amount ?? null,
          feeAssetId: fields.fee?.assetId ?? null,
          reactor: fields.reactor ?? null,
          spender: fields.spender ?? null,
          expiresAt: fields.expiresAt,
          orderDeadline: fields.orderDeadline ?? null,
          latestOrderDeadline: fields.latestOrderDeadline ?? null,
          ...maybe("unsignedTransactions", jsonInput(fields.unsignedTransactions, "transactions")),
          claimSecretId: fields.claimSecretId,
          updatedAt: now,
        },
      });
      return count === 1 ? reload(id) : null;
    },

    async recordFailure(id, status, code, now) {
      const { count } = await db.firmQuoteAttempt.updateMany({
        where: { id, status: "REQUESTING" },
        data: { status, failureCode: code, updatedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async markUnusable(id, code, now) {
      const { count } = await db.firmQuoteAttempt.updateMany({
        where: { id, status: "QUOTED" },
        data: { status: "UNUSABLE", failureCode: code, updatedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async markExpired(id, now) {
      const { count } = await db.firmQuoteAttempt.updateMany({
        where: { id, status: "QUOTED", expiresAt: { lte: now } },
        data: { status: "EXPIRED", updatedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async countHeldSlots(providerId, now, timedOutHoldMs) {
      const stillHeld = [
        { latestOrderDeadline: { gt: now } },
        { latestOrderDeadline: null, expiresAt: { gt: now } },
      ];
      const [requesting, quoted, timedOut] = await Promise.all([
        db.firmQuoteAttempt.count({ where: { providerId, status: "REQUESTING" } }),
        db.firmQuoteAttempt.count({
          where: { providerId, status: { in: ["QUOTED", "UNUSABLE"] }, OR: stillHeld },
        }),
        db.firmQuoteAttempt.count({
          where: {
            providerId,
            status: "TIMED_OUT",
            updatedAt: { gt: new Date(now.getTime() - timedOutHoldMs) },
          },
        }),
      ]);
      return requesting + quoted + timedOut;
    },
  };
}

export function createExecutionSecretRepository(db: Db): ExecutionSecretRepository {
  return {
    async put({ id, purpose, keyVersion, ciphertext, now }) {
      await db.executionSecret.create({
        data: { id, purpose, keyVersion, ciphertext, createdAt: now },
      });
    },
    async get(id) {
      const row = await db.executionSecret.findUnique({ where: { id } });
      if (!row || row.ciphertext === null) return null;
      return {
        id: row.id,
        purpose: row.purpose,
        keyVersion: row.keyVersion,
        ciphertext: row.ciphertext,
      };
    },
    async tombstone(id, now) {
      // Idempotent: a second call finds nothing left to destroy.
      await db.executionSecret.updateMany({
        where: { id, ciphertext: { not: null } },
        data: { ciphertext: null, tombstonedAt: now },
      });
    },
  };
}

export function createExecutionPlanRepository(db: Db): ExecutionPlanRepository {
  const find = async (paymentAuthorizationId: string) => {
    const row = await db.execution.findUnique({ where: { paymentAuthorizationId } });
    return row ? toExecutionPlanRecord(row) : null;
  };

  const find2 = async (id: string) => {
    const row = await db.execution.findUnique({ where: { id } });
    return row && row.paymentAuthorizationId ? toExecutionPlanRecord(row) : null;
  };

  return {
    async begin(record) {
      const { count } = await db.execution.createMany({
        data: [
          {
            id: record.id,
            intentId: record.intentId,
            routeId: record.routeId,
            userId: record.userId,
            status: "PREPARING",
            // One plan per authorization: the key is derived, so a retry can never make a second.
            idempotencyKey: `plan:${record.paymentAuthorizationId}`,
            paymentAuthorizationId: record.paymentAuthorizationId,
            walletId: record.walletId,
          },
        ],
        skipDuplicates: true,
      });
      const existing = await find(record.paymentAuthorizationId);
      if (!existing) throw new Error("execution plan vanished after creation");
      return { record: existing, created: count === 1 };
    },

    findByAuthorization: find,

    async findById(id) {
      const row = await db.execution.findUnique({ where: { id } });
      return row && row.paymentAuthorizationId ? toExecutionPlanRecord(row) : null;
    },

    async transition(id, from, to, fields = {}) {
      const { count } = await db.execution.updateMany({
        where: { id, status: { in: [...from] }, paymentAuthorizationId: { not: null } },
        data: {
          status: to,
          ...maybe("failureCode", fields.failureCode),
          ...(fields.userActionKind !== undefined && { userActionKind: fields.userActionKind }),
          ...maybe("providerSubmitState", fields.providerSubmitState),
          ...maybe("settledInputAmount", fields.settledInputAmount),
          ...maybe("settledOutputAmount", fields.settledOutputAmount),
          ...maybe("claimTombstonedAt", fields.claimTombstonedAt),
          ...maybe("lastReconciledAt", fields.lastReconciledAt),
          ...maybe("startedAt", fields.startedAt),
          ...maybe("completedAt", fields.completedAt),
          ...maybe("failedAt", fields.failedAt),
          ...maybe("plan", jsonInput(fields.plan, "Execution.plan")),
          ...maybe("firmQuoteAttemptId", fields.firmQuoteAttemptId),
        },
      });
      return count === 1 ? find2(id) : null;
    },

    async acquire(id, now) {
      // Inside the caller's transaction: take the row lock, so a racing acquire waits here and then
      // sees SIGNING. Nothing is written unless BOTH the execution and its authorization can move.
      const locked = await db.$queryRaw<
        { status: string; paymentAuthorizationId: string | null }[]
      >`SELECT "status", "paymentAuthorizationId" FROM "Execution" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const row = locked[0];
      if (!row || row.status !== "READY" || !row.paymentAuthorizationId) {
        return { status: "NOT_READY" };
      }
      const consumed = await db.paymentAuthorization.updateMany({
        where: { id: row.paymentAuthorizationId, status: "ACTIVE", expiresAt: { gt: now } },
        data: { status: "CONSUMED", consumedAt: now },
      });
      if (consumed.count !== 1) return { status: "AUTHORIZATION_UNAVAILABLE" };
      await db.execution.update({
        where: { id },
        data: {
          status: "SIGNING",
          authorizationConsumedAt: now,
          startedAt: now,
          providerSubmitState: "PENDING",
        },
      });
      const record = await find2(id);
      if (!record) throw new Error("execution vanished while it was being acquired");
      return { status: "ACQUIRED", record };
    },

    async listByStatus(statuses, limit) {
      const rows = await db.execution.findMany({
        where: { status: { in: [...statuses] }, paymentAuthorizationId: { not: null } },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows.map(toExecutionPlanRecord);
    },

    async update(id, update) {
      const row = await db.execution.update({
        where: { id },
        data: {
          status: update.status,
          ...maybe("plan", jsonInput(update.plan, "Execution.plan")),
          ...maybe("failureCode", update.failureCode),
          ...maybe("firmQuoteAttemptId", update.firmQuoteAttemptId),
        },
      });
      return toExecutionPlanRecord(row);
    },
  };
}
