import { randomUUID } from "node:crypto";

import { RECOVERY_AUDIT_EVENTS } from "@kaada/domain";
import type { SponsorLimit, SponsorshipLedger } from "@kaada/domain";

import type { Database } from "../client/index.js";

/** One number every instance takes for the length of a reservation, so only one at a time can read the totals and add to them. */
const LOCK_KEY = 7_265_001;

interface Row {
  id: string;
  type: string;
  data: unknown;
  createdAt: Date;
}

const weiOf = (data: unknown): bigint => {
  const wei = (data as { wei?: unknown } | null)?.wei;
  return typeof wei === "string" && /^[0-9]+$/.test(wei) ? BigInt(wei) : 0n;
};

const refOf = (data: unknown): string | undefined => {
  const ref = (data as { ref?: unknown } | null)?.ref;
  return typeof ref === "string" ? ref : undefined;
};

/**
 * What the reservations in `rows` come to: each counts at its settlement (the last one) when it has one, in full otherwise.
 */
function tally(rows: readonly Row[], only?: (reservation: Row) => boolean): bigint {
  const settled = new Map<string, { at: number; id: string; wei: bigint }>();
  for (const row of rows) {
    if (row.type !== RECOVERY_AUDIT_EVENTS.sponsorSettled) continue;
    const ref = refOf(row.data);
    if (!ref) continue;
    const at = row.createdAt.getTime();
    const known = settled.get(ref);
    if (!known || at > known.at || (at === known.at && row.id > known.id)) {
      settled.set(ref, { at, id: row.id, wei: weiOf(row.data) });
    }
  }
  let total = 0n;
  for (const row of rows) {
    if (row.type !== RECOVERY_AUDIT_EVENTS.sponsorReserved) continue;
    if (only && !only(row)) continue;
    total += settled.get(row.id)?.wei ?? weiOf(row.data);
  }
  return total;
}

const TYPES = [RECOVERY_AUDIT_EVENTS.sponsorReserved, RECOVERY_AUDIT_EVENTS.sponsorSettled];

/**
 * The sponsoring ledger over the audit table. A reservation takes a database-wide advisory lock for the length of its transaction,
 * reads what the wallet and the platform have used, and adds its own row before the lock is released: two reservations can never
 * both read the same totals, however many run at once or on how many instances. The totals come from these rows alone, so they
 * survive restarts.
 */
export function createSponsorshipLedger(database: Database): SponsorshipLedger {
  const db = database.client;
  return {
    async reserve(input) {
      return db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
          const since = new Date(input.now.getTime() - input.windowMs);
          const [walletRows, windowRows] = await Promise.all([
            tx.auditEvent.findMany({
              where: { entityType: "wallet", entityId: input.walletId, type: { in: TYPES } },
              select: { id: true, type: true, data: true, createdAt: true },
            }),
            tx.auditEvent.findMany({
              where: { type: { in: TYPES }, createdAt: { gte: since } },
              select: { id: true, type: true, data: true, createdAt: true },
            }),
          ]);
          const walletUsed = tally(walletRows);
          const dayUsed = tally(windowRows);
          const walletLeft = input.walletCapWei > walletUsed ? input.walletCapWei - walletUsed : 0n;
          const dayLeft = input.dailyCapWei > dayUsed ? input.dailyCapWei - dayUsed : 0n;
          if (walletLeft === 0n) return { granted: false as const, reason: "WALLET_CAP" as const };
          if (dayLeft === 0n) return { granted: false as const, reason: "DAILY_BUDGET" as const };
          const grantedWei = [input.wantWei, walletLeft, dayLeft].reduce((a, b) => (a < b ? a : b));
          if (grantedWei <= 0n) return { granted: false as const, reason: "DAILY_BUDGET" as const };
          const id = randomUUID();
          await tx.auditEvent.create({
            data: {
              id,
              userId: input.userId,
              type: RECOVERY_AUDIT_EVENTS.sponsorReserved,
              entityType: "wallet",
              entityId: input.walletId,
              data: { wei: grantedWei.toString() },
              createdAt: input.now,
            },
          });
          const limitedBy: SponsorLimit | undefined =
            grantedWei >= input.wantWei
              ? undefined
              : grantedWei === walletLeft
                ? "WALLET_CAP"
                : "DAILY_BUDGET";
          return {
            granted: true as const,
            id,
            grantedWei,
            ...(limitedBy && { limitedBy }),
          };
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
    },

    async settle(input) {
      await db.auditEvent.create({
        data: {
          id: randomUUID(),
          userId: input.userId,
          type: RECOVERY_AUDIT_EVENTS.sponsorSettled,
          entityType: "wallet",
          entityId: input.walletId,
          data: { ref: input.id, wei: input.spentWei.toString() },
        },
      });
    },

    async usedInWindow(now, windowMs) {
      const rows = await db.auditEvent.findMany({
        where: {
          type: { in: TYPES },
          createdAt: { gte: new Date(now.getTime() - windowMs) },
        },
        select: { id: true, type: true, data: true, createdAt: true },
      });
      return tally(rows);
    },
  };
}
