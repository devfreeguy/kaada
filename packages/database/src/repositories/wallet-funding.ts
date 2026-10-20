import { randomUUID } from "node:crypto";

import type {
  BalanceSnapshot,
  WalletBalanceCheckpoint,
  WalletFundingEvent,
  WalletFundingItem,
  WalletFundingStore,
} from "@kaada/domain";

import type { Database } from "../client/index.js";
import type { WalletFundingEvent as EventRow } from "../generated/prisma/client.js";
import { maybe } from "../mappers/support.js";

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

const asSnapshot = (value: unknown): BalanceSnapshot =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

const asItems = (value: unknown): WalletFundingItem[] =>
  Array.isArray(value) ? (value as WalletFundingItem[]) : [];

function toEvent(row: EventRow): WalletFundingEvent {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    address: row.address,
    items: asItems(row.items),
    createdAt: row.createdAt,
    ...maybe("claimedAt", row.claimedAt),
    ...maybe("deliveredAt", row.deliveredAt),
    attempts: row.attempts,
  };
}

/**
 * The checkpoint and its event are moved in ONE transaction, guarded by the checkpoint's version: a conditional update that only
 * one of any number of concurrent observers can win. The loser changes nothing and records nothing.
 */
export function createWalletFundingStore(database: Database): WalletFundingStore {
  const db = database.client;
  return {
    async walletsToWatch(limit) {
      const rows = await db.wallet.findMany({
        where: {
          type: "EMBEDDED",
          status: "ACTIVE",
          address: { not: null },
          user: { identities: { some: {} } },
        },
        select: { userId: true, address: true, provisionedAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: limit,
      });
      return rows.flatMap((row) =>
        row.address
          ? [
              {
                userId: row.userId,
                address: row.address,
                activatedAt: row.provisionedAt ?? row.createdAt,
              },
            ]
          : [],
      );
    },

    async hasBeenFunded(userId, chainId) {
      const event = await db.walletFundingEvent.findFirst({
        where: { userId, chainId },
        select: { id: true },
      });
      if (event) return true;
      const checkpoints = await db.walletDepositCheckpoint.findMany({
        where: { userId, chainId },
        select: { observed: true },
      });
      return checkpoints.some((row) =>
        Object.values(asSnapshot(row.observed)).some(
          (amount) => /^[0-9]+$/.test(amount) && BigInt(amount) > 0n,
        ),
      );
    },

    async checkpoint(chainId, address): Promise<WalletBalanceCheckpoint | null> {
      const row = await db.walletDepositCheckpoint.findUnique({
        where: { chainId_address: { chainId, address } },
      });
      return row
        ? {
            id: row.id,
            userId: row.userId,
            chainId: row.chainId,
            address: row.address,
            balances: asSnapshot(row.observed),
            version: row.version,
            observedAt: row.observedAt,
          }
        : null;
    },

    async commit(input) {
      try {
        return await db.$transaction(async (tx) => {
          let checkpointId: string;
          let version: number;
          if (input.expectedVersion === null) {
            checkpointId = randomUUID();
            version = 0;
            await tx.walletDepositCheckpoint.create({
              data: {
                id: checkpointId,
                userId: input.userId,
                chainId: input.chainId,
                address: input.address,
                observed: input.balances,
                version,
                observedAt: input.now,
              },
            });
          } else {
            const current = await tx.walletDepositCheckpoint.findUnique({
              where: { chainId_address: { chainId: input.chainId, address: input.address } },
            });
            if (!current) return { committed: false };
            const { count } = await tx.walletDepositCheckpoint.updateMany({
              where: { id: current.id, version: input.expectedVersion },
              data: {
                observed: input.balances,
                version: { increment: 1 },
                observedAt: input.now,
              },
            });
            if (count !== 1) return { committed: false };
            checkpointId = current.id;
            version = input.expectedVersion + 1;
          }
          if (input.event) {
            await tx.walletFundingEvent.create({
              data: {
                id: input.event.id,
                userId: input.userId,
                checkpointId,
                version,
                chainId: input.chainId,
                address: input.address,
                items: input.event.items.map((item) => ({ ...item })),
                createdAt: input.now,
              },
            });
          }
          return { committed: true };
        });
      } catch (error) {
        // A concurrent first observation of the same wallet: the other one won.
        if (isUniqueViolation(error)) return { committed: false };
        throw error;
      }
    },

    async claim(input) {
      const staleBefore = new Date(input.now.getTime() - input.staleMs);
      const candidates = await db.walletFundingEvent.findMany({
        where: {
          deliveredAt: null,
          attempts: { lt: input.maxAttempts },
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
        },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
      const claimed: WalletFundingEvent[] = [];
      for (const row of candidates) {
        // One conditional update per row: of any number of concurrent claimers exactly one sees count 1.
        const { count } = await db.walletFundingEvent.updateMany({
          where: {
            id: row.id,
            deliveredAt: null,
            OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
          },
          data: { claimedAt: input.now },
        });
        if (count === 1) claimed.push({ ...toEvent(row), claimedAt: input.now });
      }
      return claimed;
    },

    async markDelivered(ids, now) {
      if (ids.length === 0) return;
      await db.walletFundingEvent.updateMany({
        where: { id: { in: ids }, deliveredAt: null },
        data: { deliveredAt: now },
      });
    },

    async release(ids) {
      if (ids.length === 0) return;
      await db.walletFundingEvent.updateMany({
        where: { id: { in: ids }, deliveredAt: null },
        data: { claimedAt: null, attempts: { increment: 1 } },
      });
    },
  };
}
