import type {
  ChannelAction,
  ChannelActionRepository,
  ChannelInboundEventRepository,
  ChannelPaymentStatus,
  ChannelPaymentStatusRepository,
} from "@kaada/domain";

import type {
  ChannelAction as ActionRow,
  ChannelPaymentStatus as StatusRow,
} from "../generated/prisma/client.js";
import { maybe, readJsonObjectOrEmpty } from "../mappers/support.js";
import type { Db } from "./db.js";

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

function toAction(row: ActionRow): ChannelAction {
  const payload: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    readJsonObjectOrEmpty(row.payload, "ChannelAction.payload"),
  )) {
    if (typeof value === "string") payload[key] = value;
  }
  return {
    id: row.id,
    handle: row.handle,
    userId: row.userId,
    channel: row.channel,
    externalUserId: row.externalUserId,
    conversationId: row.conversationId,
    kind: row.kind,
    payload,
    reusable: row.reusable,
    expiresAt: row.expiresAt,
    ...maybe("usedAt", row.usedAt),
    createdAt: row.createdAt,
  };
}

function toStatus(row: StatusRow): ChannelPaymentStatus {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    externalConversationId: row.externalConversationId,
    authorizationSessionId: row.authorizationSessionId,
    ...maybe("externalSummaryMessageId", row.externalSummaryMessageId),
    ...maybe("externalStatusMessageId", row.externalStatusMessageId),
    lastState: row.lastState,
    terminal: row.terminal,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createChannelActionRepository(db: Db): ChannelActionRepository {
  return {
    async create(action, now) {
      const row = await db.channelAction.create({
        data: {
          id: action.id,
          handle: action.handle,
          userId: action.userId,
          channel: action.channel,
          externalUserId: action.externalUserId,
          conversationId: action.conversationId,
          kind: action.kind,
          payload: action.payload,
          reusable: action.reusable,
          expiresAt: action.expiresAt,
          createdAt: now,
        },
      });
      return toAction(row);
    },

    async findByHandle(handle) {
      const row = await db.channelAction.findUnique({ where: { handle } });
      return row ? toAction(row) : null;
    },

    async consume(input) {
      const row = await db.channelAction.findUnique({ where: { handle: input.handle } });
      if (!row) return { ok: false, reason: "UNKNOWN" };
      // A button shown to someone else is indistinguishable, to the caller, from a button that never existed.
      if (row.channel !== input.channel) return { ok: false, reason: "UNKNOWN" };
      if (row.externalUserId !== input.externalUserId) return { ok: false, reason: "WRONG_USER" };
      if (row.expiresAt <= input.now) return { ok: false, reason: "EXPIRED" };
      if (row.reusable) return { ok: true, action: toAction(row) };
      // One conditional UPDATE decides the winner of any number of concurrent presses.
      const { count } = await db.channelAction.updateMany({
        where: { id: row.id, usedAt: null, expiresAt: { gt: input.now } },
        data: { usedAt: input.now },
      });
      if (count !== 1) return { ok: false, reason: "USED" };
      return { ok: true, action: toAction({ ...row, usedAt: input.now }) };
    },

    async deleteExpiredBefore(before, limit) {
      const stale = await db.channelAction.findMany({
        where: { expiresAt: { lt: before } },
        select: { id: true },
        take: limit,
      });
      if (stale.length === 0) return 0;
      const { count } = await db.channelAction.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } },
      });
      return count;
    },
  };
}

export function createChannelInboundEventRepository(db: Db): ChannelInboundEventRepository {
  return {
    async claim(input) {
      try {
        await db.channelInboundEvent.create({
          data: {
            id: input.id,
            channel: input.channel,
            externalEventId: input.externalEventId,
            receivedAt: input.now,
          },
        });
        return "NEW";
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      const existing = await db.channelInboundEvent.findUnique({
        where: {
          channel_externalEventId: {
            channel: input.channel,
            externalEventId: input.externalEventId,
          },
        },
      });
      if (!existing) return "IN_PROGRESS";
      if (existing.status === "PROCESSED") return "DUPLICATE";
      // RECEIVED: someone is on it, unless they died. Reclaim atomically: only one retry wins the stale row.
      const { count } = await db.channelInboundEvent.updateMany({
        where: {
          id: existing.id,
          status: "RECEIVED",
          receivedAt: { lt: new Date(input.now.getTime() - input.staleMs) },
        },
        data: { receivedAt: input.now },
      });
      return count === 1 ? "RECLAIMED" : "IN_PROGRESS";
    },

    async markProcessed(channel, externalEventId, now) {
      await db.channelInboundEvent.updateMany({
        where: { channel, externalEventId },
        data: { status: "PROCESSED", processedAt: now },
      });
    },

    async release(channel, externalEventId) {
      await db.channelInboundEvent.deleteMany({
        where: { channel, externalEventId, status: "RECEIVED" },
      });
    },

    async deleteOlderThan(before, limit) {
      const old = await db.channelInboundEvent.findMany({
        where: { receivedAt: { lt: before } },
        select: { id: true },
        take: limit,
      });
      if (old.length === 0) return 0;
      const { count } = await db.channelInboundEvent.deleteMany({
        where: { id: { in: old.map((row) => row.id) } },
      });
      return count;
    },
  };
}

export function createChannelPaymentStatusRepository(db: Db): ChannelPaymentStatusRepository {
  const reload = async (id: string) => {
    const row = await db.channelPaymentStatus.findUnique({ where: { id } });
    return row ? toStatus(row) : null;
  };
  return {
    async create(status) {
      try {
        const row = await db.channelPaymentStatus.create({
          data: {
            id: status.id,
            userId: status.userId,
            channel: status.channel,
            externalConversationId: status.externalConversationId,
            authorizationSessionId: status.authorizationSessionId,
            ...(status.externalSummaryMessageId && {
              externalSummaryMessageId: status.externalSummaryMessageId,
            }),
            ...(status.externalStatusMessageId && {
              externalStatusMessageId: status.externalStatusMessageId,
            }),
            lastState: status.lastState,
            terminal: status.terminal,
          },
        });
        return toStatus(row);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const existing = await db.channelPaymentStatus.findUnique({
          where: { authorizationSessionId: status.authorizationSessionId },
        });
        if (!existing) throw error;
        return toStatus(existing);
      }
    },

    async findBySession(authorizationSessionId) {
      const row = await db.channelPaymentStatus.findUnique({ where: { authorizationSessionId } });
      return row ? toStatus(row) : null;
    },

    async listActive(limit) {
      const rows = await db.channelPaymentStatus.findMany({
        where: { terminal: false },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows.map(toStatus);
    },

    async transition(input) {
      const { count } = await db.channelPaymentStatus.updateMany({
        where: { id: input.id, lastState: input.from, terminal: false },
        data: {
          lastState: input.to,
          ...(input.terminal !== undefined && { terminal: input.terminal }),
          ...(input.externalStatusMessageId !== undefined && {
            externalStatusMessageId: input.externalStatusMessageId,
          }),
        },
      });
      return count === 1 ? reload(input.id) : null;
    },

    async attachStatusMessage(id, externalStatusMessageId) {
      await db.channelPaymentStatus.update({ where: { id }, data: { externalStatusMessageId } });
    },

    async revert(input) {
      await db.channelPaymentStatus.updateMany({
        where: { id: input.id, lastState: input.to },
        data: { lastState: input.from, terminal: false },
      });
    },
  };
}
