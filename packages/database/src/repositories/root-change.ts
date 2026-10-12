import type { RootChangeRepository } from "@kaada/domain";

import { toRootChange } from "../mappers/root-change.js";
import type { Db } from "./db.js";

const LIVE = ["PREPARED", "SUBMITTED"] as const;

/** A unique-constraint violation (a second live change for the wallet). */
const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

export function createRootChangeRepository(db: Db): RootChangeRepository {
  const reload = async (id: string) => {
    const row = await db.rootChange.findUnique({ where: { id } });
    return row ? toRootChange(row) : null;
  };

  return {
    async create(change, now) {
      // A live change that has expired is finished off first; one that is still live blocks the new one.
      await db.rootChange.updateMany({
        where: { walletId: change.walletId, status: { in: [...LIVE] }, expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });
      try {
        const row = await db.rootChange.create({
          data: {
            id: change.id,
            userId: change.userId,
            walletId: change.walletId,
            kind: change.kind,
            newCredentialId: change.newCredentialId,
            ...(change.signerCredentialId && { signerCredentialId: change.signerCredentialId }),
            challenge: change.challenge,
            prepared: change.prepared,
            expiresAt: change.expiresAt,
            createdAt: now,
          },
        });
        return toRootChange(row);
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    findById: reload,

    async findLive(walletId) {
      const row = await db.rootChange.findFirst({
        where: { walletId, status: { in: [...LIVE] } },
      });
      return row ? toRootChange(row) : null;
    },

    async advance({ id, from, to, patch }) {
      const { count } = await db.rootChange.updateMany({
        where: { id, status: { in: from } },
        data: {
          status: to,
          ...(patch?.userOpHash && { userOpHash: patch.userOpHash }),
          ...(patch?.failureCode && { failureCode: patch.failureCode }),
          ...(patch?.completedAt && { completedAt: patch.completedAt }),
        },
      });
      return count === 1 ? reload(id) : null;
    },

    async listExpired(now, limit) {
      const rows = await db.rootChange.findMany({
        where: { status: { in: [...LIVE] }, expiresAt: { lte: now } },
        orderBy: { expiresAt: "asc" },
        take: limit,
      });
      return rows.map(toRootChange);
    },
  };
}
