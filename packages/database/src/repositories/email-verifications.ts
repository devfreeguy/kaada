import type {
  EmailVerification,
  EmailVerificationRepository,
} from "@kaada/domain";

import type { Db } from "./db.js";

interface Row {
  id: string;
  userId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  usedAt: Date | null;
  createdAt: Date;
}

const toVerification = (row: Row): EmailVerification => ({
  id: row.id,
  userId: row.userId,
  email: row.email,
  codeHash: row.codeHash,
  expiresAt: row.expiresAt,
  attempts: row.attempts,
  maxAttempts: row.maxAttempts,
  ...(row.usedAt && { usedAt: row.usedAt }),
  createdAt: row.createdAt,
});

export function createEmailVerificationRepository(db: Db): EmailVerificationRepository {
  return {
    async create(input) {
      return toVerification(await db.emailVerification.create({ data: input }));
    },

    async findLatest(userId) {
      const row = await db.emailVerification.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });
      return row ? toVerification(row) : null;
    },

    countSince(userId, since) {
      return db.emailVerification.count({ where: { userId, createdAt: { gte: since } } });
    },

    async reserveAttempt(id, now) {
      const found = await db.emailVerification.findUnique({ where: { id } });
      if (!found) return { state: "NONE" };
      // The guess is counted in ONE conditional update, so parallel guesses cannot exceed the budget.
      const { count } = await db.emailVerification.updateMany({
        where: {
          id,
          usedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: found.maxAttempts },
        },
        data: { attempts: { increment: 1 } },
      });
      if (count !== 1) return { state: "CLOSED" };
      return {
        state: "ADMITTED",
        verification: toVerification(await db.emailVerification.findUniqueOrThrow({ where: { id } })),
      };
    },

    async markUsed(id, now) {
      const { count } = await db.emailVerification.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: now },
      });
      return count === 1;
    },
  };
}
