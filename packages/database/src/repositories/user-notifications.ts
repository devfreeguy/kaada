import type { UserNotification, UserNotificationRepository } from "@kaada/domain";

import type { UserNotification as Row } from "../generated/prisma/client.js";
import { maybe } from "../mappers/support.js";
import type { Db } from "./db.js";

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

function toNotification(row: Row): UserNotification {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    createdAt: row.createdAt,
    ...maybe("claimedAt", row.claimedAt),
    ...maybe("deliveredAt", row.deliveredAt),
    attempts: row.attempts,
  };
}

export function createUserNotificationRepository(db: Db): UserNotificationRepository {
  return {
    async record(input) {
      try {
        await db.userNotification.create({
          data: {
            id: input.id,
            userId: input.userId,
            kind: input.kind,
            createdAt: input.now,
            ...(input.silent && { deliveredAt: input.now }),
          },
        });
        return { created: true };
      } catch (error) {
        if (isUniqueViolation(error)) return { created: false };
        throw error;
      }
    },

    async listForUser(userId) {
      const rows = await db.userNotification.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toNotification);
    },

    async listUsersInOnboarding(limit) {
      const started = await db.userNotification.findMany({
        where: {
          kind: "ONBOARDING_STARTED",
          user: { userNotifications: { none: { kind: "ONBOARDING_COMPLETED" } } },
        },
        select: { userId: true },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return started.map((row) => row.userId);
    },

    async claim(input) {
      const staleBefore = new Date(input.now.getTime() - input.staleMs);
      const candidates = await db.userNotification.findMany({
        where: {
          deliveredAt: null,
          attempts: { lt: input.maxAttempts },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
          ...(input.userId && { userId: input.userId }),
        },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
      const claimed: UserNotification[] = [];
      for (const row of candidates) {
        // One conditional update per row: of any number of concurrent claimers exactly one sees count 1.
        const { count } = await db.userNotification.updateMany({
          where: {
            id: row.id,
            deliveredAt: null,
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
          },
          data: { claimedAt: input.now },
        });
        if (count === 1) claimed.push({ ...toNotification(row), claimedAt: input.now });
      }
      return claimed;
    },

    async markDelivered(ids, now) {
      if (ids.length === 0) return;
      await db.userNotification.updateMany({
        where: { id: { in: ids }, deliveredAt: null },
        data: { deliveredAt: now },
      });
    },

    async release(ids) {
      if (ids.length === 0) return;
      await db.userNotification.updateMany({
        where: { id: { in: ids }, deliveredAt: null },
        data: { claimedAt: null, attempts: { increment: 1 } },
      });
    },
  };
}
