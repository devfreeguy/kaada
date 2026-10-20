import { randomUUID } from "node:crypto";

import { RECOVERY_AUDIT_EVENTS } from "@kaada/domain";
import type { SponsorLimit, SponsorReservation, SponsorshipLedger } from "@kaada/domain";

interface Row {
  id: string;
  type: string;
  walletId: string;
  ref?: string;
  wei: bigint;
  at: number;
}

/**
 * The same ledger as the database one, in memory. Calls are serialised the way the database lock serialises them, so a test that
 * fires many reservations at once sees the same all-or-nothing totals.
 */
export class MemorySponsorshipLedger implements SponsorshipLedger {
  readonly rows: Row[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  /** The reservations passing `keep`, each at its settlement (looked up among all rows) when it has one. */
  private tally(keep: (row: Row) => boolean): bigint {
    const settled = new Map<string, bigint>();
    for (const row of this.rows) {
      if (row.type === RECOVERY_AUDIT_EVENTS.sponsorSettled && row.ref)
        settled.set(row.ref, row.wei);
    }
    let total = 0n;
    for (const row of this.rows) {
      if (row.type === RECOVERY_AUDIT_EVENTS.sponsorReserved && keep(row)) {
        total += settled.get(row.id) ?? row.wei;
      }
    }
    return total;
  }

  reserve(input: Parameters<SponsorshipLedger["reserve"]>[0]): Promise<SponsorReservation> {
    const run = this.tail.then(async () => {
      // A pause inside the critical section: without the serialisation above, parallel calls would all read the same totals here.
      await new Promise((resolve) => setImmediate(resolve));
      const since = input.now.getTime() - input.windowMs;
      const walletUsed = this.tally((r) => r.walletId === input.walletId);
      const dayUsed = this.tally((r) => r.at >= since);
      const walletLeft = input.walletCapWei > walletUsed ? input.walletCapWei - walletUsed : 0n;
      const dayLeft = input.dailyCapWei > dayUsed ? input.dailyCapWei - dayUsed : 0n;
      if (walletLeft === 0n) return { granted: false, reason: "WALLET_CAP" } as const;
      if (dayLeft === 0n) return { granted: false, reason: "DAILY_BUDGET" } as const;
      const grantedWei = [input.wantWei, walletLeft, dayLeft].reduce((a, b) => (a < b ? a : b));
      const id = randomUUID();
      this.rows.push({
        id,
        type: RECOVERY_AUDIT_EVENTS.sponsorReserved,
        walletId: input.walletId,
        wei: grantedWei,
        at: input.now.getTime(),
      });
      const limitedBy: SponsorLimit | undefined =
        grantedWei >= input.wantWei
          ? undefined
          : grantedWei === walletLeft
            ? "WALLET_CAP"
            : "DAILY_BUDGET";
      return { granted: true, id, grantedWei, ...(limitedBy && { limitedBy }) } as const;
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  settle(input: { id: string; userId: string; walletId: string; spentWei: bigint }): Promise<void> {
    this.rows.push({
      id: randomUUID(),
      type: RECOVERY_AUDIT_EVENTS.sponsorSettled,
      walletId: input.walletId,
      ref: input.id,
      wei: input.spentWei,
      at: Date.now(),
    });
    return Promise.resolve();
  }

  usedInWindow(now: Date, windowMs: number): Promise<bigint> {
    return Promise.resolve(this.tally((r) => r.at >= now.getTime() - windowMs));
  }
}
