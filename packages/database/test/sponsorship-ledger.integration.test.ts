/*
 * The sponsoring ledger against the real database. The caps only mean something if parallel reservations cannot both read the same
 * totals, and that needs real transactions that really commit, so unlike the other integration tests this one cannot be rolled back.
 * It writes only audit rows for one throwaway user and removes them (and the user) at the end, whatever happens.
 * Run with: pnpm --filter @kaada/database test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createDatabase } from "../src/index.js";
import type { Database } from "../src/index.js";
import { createSponsorshipLedger } from "../src/repositories/sponsorship-ledger.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

const DAY = 24 * 60 * 60 * 1000;
const UNIT = 1_000n;

describe("sponsoring ledger (real transactions, cleaned up)", { skip }, () => {
  let database: Database;
  let userId: string;

  before(async () => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
    userId = randomUUID();
    await database.client.user.create({ data: { id: userId, username: `l${userId.slice(0, 8)}` } });
  });

  after(async () => {
    try {
      await database.client.auditEvent.deleteMany({ where: { userId } });
      await database.client.user.delete({ where: { id: userId } });
    } finally {
      await database.close();
    }
  });

  const reserve = (
    ledger: ReturnType<typeof createSponsorshipLedger>,
    walletId: string,
    over: Partial<Parameters<typeof ledger.reserve>[0]> = {},
  ) =>
    ledger.reserve({
      userId,
      walletId,
      wantWei: UNIT,
      walletCapWei: 1_000_000n,
      dailyCapWei: 1_000_000n,
      windowMs: DAY,
      now: new Date(),
      ...over,
    });

  it("many parallel reservations never go over the daily cap", async () => {
    const ledger = createSponsorshipLedger(database);
    const before = await ledger.usedInWindow(new Date(), DAY);
    const dailyCapWei = before + 3n * UNIT;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => reserve(ledger, randomUUID(), { dailyCapWei })),
    );
    const granted = results.filter((r) => r.granted);
    assert.equal(granted.length, 3, "exactly the three that fit");
    assert.deepEqual(
      results.filter((r) => !r.granted).map((r) => (r.granted ? null : r.reason)),
      Array(7).fill("DAILY_BUDGET"),
    );
    assert.equal(await ledger.usedInWindow(new Date(), DAY), before + 3n * UNIT);
    for (const r of results) {
      if (r.granted)
        await ledger.settle({ id: r.id, userId, walletId: randomUUID(), spentWei: 0n });
    }
    // Settling releases: the totals come back to where they were (the settlements name their reservations, not the wallets).
    assert.equal(await ledger.usedInWindow(new Date(), DAY), before);
  });

  it("a wallet's lifetime cap holds across settlements, and the last settlement of a reservation wins", async () => {
    const ledger = createSponsorshipLedger(database);
    const walletId = randomUUID();
    const first = await reserve(ledger, walletId, { wantWei: 100n, walletCapWei: 100n });
    assert.ok(first.granted && first.grantedWei === 100n);
    const second = await reserve(ledger, walletId, { wantWei: 100n, walletCapWei: 100n });
    assert.deepEqual(second, { granted: false, reason: "WALLET_CAP" });
    if (!first.granted) return;
    await ledger.settle({ id: first.id, userId, walletId, spentWei: 40n });
    const third = await reserve(ledger, walletId, { wantWei: 100n, walletCapWei: 100n });
    assert.ok(third.granted);
    assert.ok(third.granted && third.grantedWei === 60n && third.limitedBy === "WALLET_CAP");
    if (!third.granted) return;
    await ledger.settle({ id: third.id, userId, walletId, spentWei: 60n });
    await ledger.settle({ id: first.id, userId, walletId, spentWei: 10n });
    const fourth = await reserve(ledger, walletId, { wantWei: 100n, walletCapWei: 100n });
    assert.ok(fourth.granted && fourth.grantedWei === 30n, "10 + 60 spent, 30 left");
  });

  it("the day's total is read from the database, not from memory: a new ledger sees what an old one recorded", async () => {
    const one = createSponsorshipLedger(database);
    const walletId = randomUUID();
    const before = await one.usedInWindow(new Date(), DAY);
    const r = await reserve(one, walletId, { wantWei: 7n });
    assert.ok(r.granted);
    const other = createSponsorshipLedger(database);
    assert.equal(await other.usedInWindow(new Date(), DAY), before + 7n);
    if (r.granted) await other.settle({ id: r.id, userId, walletId, spentWei: 0n });
  });

  it("only the last 24 hours count", async () => {
    const ledger = createSponsorshipLedger(database);
    const walletId = randomUUID();
    const longAgo = new Date(Date.now() - 2 * DAY);
    const old = await reserve(ledger, walletId, { wantWei: 500n, now: longAgo });
    assert.ok(old.granted);
    const now = new Date();
    const before = await ledger.usedInWindow(now, DAY);
    const fresh = await reserve(ledger, randomUUID(), { wantWei: 5n, now });
    assert.ok(fresh.granted);
    assert.equal(
      await ledger.usedInWindow(now, DAY),
      before + 5n,
      "the two-day-old reservation is outside the window",
    );
    if (fresh.granted) await ledger.settle({ id: fresh.id, userId, walletId, spentWei: 0n });
  });
});
