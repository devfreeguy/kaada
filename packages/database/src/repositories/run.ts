import type { ExecutionTransactionRepository, RootActionSessionRepository } from "@kaada/domain";

import { toExecutionTransaction, toRootActionSession } from "../mappers/run.js";
import { jsonInput, maybe } from "../mappers/support.js";
import type { Db } from "./db.js";

export function createExecutionTransactionRepository(db: Db): ExecutionTransactionRepository {
  const reload = async (id: string) => {
    const row = await db.transaction.findUnique({ where: { id } });
    return row ? toExecutionTransaction(row) : null;
  };

  return {
    async begin(input) {
      // ON CONFLICT DO NOTHING: a retry (or a second worker) finds the existing row, never a second one.
      const { count } = await db.transaction.createMany({
        data: [
          {
            id: crypto.randomUUID(),
            executionId: input.executionId,
            type: input.type,
            status: "CREATED",
            chainId: input.chainId,
            fromAddress: input.fromAddress,
            toAddress: input.toAddress ?? null,
            assetId: input.assetId ?? null,
            amount: input.amount ?? null,
            idempotencyKey: input.idempotencyKey,
            ...maybe("metadata", jsonInput(input.metadata, "Transaction.metadata")),
          },
        ],
        skipDuplicates: true,
      });
      const row = await db.transaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (!row) throw new Error("transaction step vanished after creation");
      return { transaction: toExecutionTransaction(row), created: count === 1 };
    },

    async findByKey(idempotencyKey) {
      const row = await db.transaction.findUnique({ where: { idempotencyKey } });
      return row ? toExecutionTransaction(row) : null;
    },

    async listByExecution(executionId) {
      const rows = await db.transaction.findMany({
        where: { executionId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toExecutionTransaction);
    },

    async markSubmitted(id, { userOpHash, now }) {
      const { count } = await db.transaction.updateMany({
        where: { id, status: "CREATED" },
        data: { status: "SUBMITTED", userOpHash, submittedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async markIncluded(id, { hash, blockNumber, success, now }) {
      const { count } = await db.transaction.updateMany({
        where: { id, status: { in: ["SUBMITTED", "CONFIRMING", "UNKNOWN"] } },
        data: {
          status: success ? "CONFIRMED" : "FAILED",
          hash,
          blockNumber,
          confirmedAt: now,
          ...(success ? {} : { failureCode: "REVERTED" }),
        },
      });
      return count === 1 ? reload(id) : null;
    },

    async markUnknown(id, now) {
      const { count } = await db.transaction.updateMany({
        where: { id, status: { in: ["CREATED", "SUBMITTED", "CONFIRMING"] } },
        data: { status: "UNKNOWN", updatedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async markNotSent(id, code, now) {
      const { count } = await db.transaction.updateMany({
        where: { id, status: "CREATED" },
        data: { status: "FAILED", failureCode: code, updatedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async listUnsettled(limit) {
      const rows = await db.transaction.findMany({
        where: { status: { in: ["SUBMITTED", "CONFIRMING", "UNKNOWN"] } },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.map(toExecutionTransaction);
    },
  };
}

export function createRootActionSessionRepository(db: Db): RootActionSessionRepository {
  const reload = async (id: string) => {
    const row = await db.rootActionSession.findUnique({ where: { id } });
    return row ? toRootActionSession(row) : null;
  };

  return {
    async createOrGetPending(session, now) {
      const live = () =>
        db.rootActionSession.findFirst({
          where: { executionId: session.executionId, status: "PENDING" },
        });
      const existing = await live();
      if (existing) {
        if (existing.expiresAt.getTime() > now.getTime()) {
          return { session: toRootActionSession(existing), created: false };
        }
        await db.rootActionSession.updateMany({
          where: { id: existing.id, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
      }
      const { count } = await db.rootActionSession.createMany({
        data: [
          {
            id: session.id,
            userId: session.userId,
            walletId: session.walletId,
            executionId: session.executionId,
            kind: session.kind,
            challenge: session.challenge,
            prepared: session.prepared,
            expiresAt: session.expiresAt,
            createdAt: now,
          },
        ],
        skipDuplicates: true,
      });
      const row = await live();
      if (!row) throw new Error("root action vanished after creation");
      return { session: toRootActionSession(row), created: count === 1 };
    },

    findById: reload,

    async findByTokenHash(tokenHash) {
      const row = await db.rootActionSession.findUnique({ where: { tokenHash } });
      return row ? toRootActionSession(row) : null;
    },

    async issueToken({ id, tokenHash, now }) {
      const { count } = await db.rootActionSession.updateMany({
        where: { id, status: "PENDING", expiresAt: { gt: now } },
        data: { tokenHash },
      });
      return count === 1 ? reload(id) : null;
    },

    async complete(id, now) {
      const { count } = await db.rootActionSession.updateMany({
        where: { id, status: "PENDING", expiresAt: { gt: now } },
        data: { status: "COMPLETED", usedAt: now },
      });
      return count === 1 ? reload(id) : null;
    },

    async close(id, status) {
      const { count } = await db.rootActionSession.updateMany({
        where: { id, status: "PENDING" },
        data: { status },
      });
      return count === 1 ? reload(id) : null;
    },

    async findPendingByExecution(executionId) {
      const row = await db.rootActionSession.findFirst({
        where: { executionId, status: "PENDING" },
      });
      return row ? toRootActionSession(row) : null;
    },
  };
}
