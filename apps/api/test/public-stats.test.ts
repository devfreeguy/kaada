import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CompletedPaymentGroup } from "@kaada/domain";

import { PublicStatsService } from "../src/core/stats/public-stats-service.js";

/*
 * The public marketing numbers: aggregates only, rounded down, small groups withheld, cached, and never broken by one bad read.
 */

const group = (over: Partial<CompletedPaymentGroup>): CompletedPaymentGroup => ({
  assetId: "a",
  symbol: "cNGN",
  fiatCode: "NGN",
  decimals: 6,
  payments: 10,
  total: "1500000000",
  ...over,
});

function service(
  groups: CompletedPaymentGroup[] | Error,
  options: { ttlMs?: number; min?: number; clock?: { now: Date } } = {},
) {
  const reads = { count: 0 };
  const clock = options.clock ?? { now: new Date("2026-10-20T12:00:00Z") };
  const logs: string[] = [];
  const instance = new PublicStatsService({
    stats: {
      completedByAsset: () => {
        reads.count += 1;
        return groups instanceof Error ? Promise.reject(groups) : Promise.resolve(groups);
      },
    },
    ...(options.ttlMs !== undefined && { ttlMs: options.ttlMs }),
    ...(options.min !== undefined && { minPaymentsPerCurrency: options.min }),
    log: (_level, event) => void logs.push(event),
    now: () => clock.now,
  });
  return { instance, reads, clock, logs };
}

describe("public payment totals", () => {
  it("reports the number of completed payments and whole units delivered per currency", async () => {
    const { instance } = service([group({ payments: 12, total: "1500123456" })]);
    const stats = await instance.get();
    assert.equal(stats.completedPayments, 12);
    assert.deepEqual(stats.volume, [{ currency: "NGN", amount: "1500", payments: 12 }]);
  });

  it("rounds DOWN to whole units, so an exact amount is never published", async () => {
    const { instance } = service([group({ total: "299999999" })]);
    assert.equal((await instance.get()).volume[0]?.amount, "299");
  });

  it("joins tokens of one currency, whatever their decimals, and does not add different currencies", async () => {
    const { instance } = service([
      group({
        assetId: "1",
        symbol: "USDT",
        fiatCode: "USD",
        decimals: 6,
        total: "5000000",
        payments: 3,
      }),
      group({
        assetId: "2",
        symbol: "USDC",
        fiatCode: "USD",
        decimals: 18,
        total: `${"7".padEnd(19, "0")}`,
        payments: 4,
      }),
      group({ assetId: "3", symbol: "cNGN", fiatCode: "NGN", total: "9000000000", payments: 6 }),
    ]);
    const stats = await instance.get();
    assert.equal(stats.completedPayments, 13);
    assert.deepEqual(stats.volume, [
      { currency: "USD", amount: "12", payments: 7 }, // 5 + 7
      { currency: "NGN", amount: "9000", payments: 6 },
    ]);
  });

  it("lists a coin that is not a currency (CELO) by its symbol", async () => {
    const { instance } = service(
      [group({ symbol: "CELO", decimals: 18, total: `${"3".padEnd(19, "0")}`, payments: 5 })].map(
        ({ fiatCode: _omit, ...rest }) => rest as CompletedPaymentGroup,
      ),
    );
    assert.deepEqual((await instance.get()).volume, [
      { currency: "CELO", amount: "3", payments: 5 },
    ]);
  });

  it("withholds a currency with too few payments (they still count in the total), so one payment cannot be read", async () => {
    const { instance } = service([
      group({ payments: 2, total: "777000000" }),
      group({
        assetId: "9",
        symbol: "wBRL",
        fiatCode: "BRL",
        decimals: 18,
        payments: 40,
        total: `${"5".padEnd(22, "0")}`,
      }),
    ]);
    const stats = await instance.get();
    assert.equal(stats.completedPayments, 42);
    assert.deepEqual(
      stats.volume.map((v) => v.currency),
      ["BRL"],
    );
    assert.equal(JSON.stringify(stats).includes("777"), false);
  });

  it("contains nothing but the fields of the public contract", async () => {
    const { instance } = service([group({})]);
    const stats = await instance.get();
    assert.deepEqual(Object.keys(stats).sort(), ["completedPayments", "updatedAt", "volume"]);
    assert.deepEqual(Object.keys(stats.volume[0] ?? {}).sort(), ["amount", "currency", "payments"]);
  });

  it("with nothing completed yet it is zero, not an error", async () => {
    const { instance } = service([]);
    const stats = await instance.get();
    assert.equal(stats.completedPayments, 0);
    assert.deepEqual(stats.volume, []);
  });
});

describe("the endpoint cannot be used to load the database", () => {
  it("reads once per window however many callers there are, and concurrent callers share one read", async () => {
    const { instance, reads } = service([group({})], { ttlMs: 60_000 });
    await Promise.all(Array.from({ length: 50 }, () => instance.get()));
    await instance.get();
    assert.equal(reads.count, 1);
  });

  it("reads again after the window", async () => {
    const clock = { now: new Date("2026-10-20T12:00:00Z") };
    const { instance, reads } = service([group({})], { ttlMs: 60_000, clock });
    await instance.get();
    clock.now = new Date(clock.now.getTime() + 61_000);
    await instance.get();
    assert.equal(reads.count, 2);
  });

  it("serves the last good answer when a refresh fails, and says so in the log", async () => {
    const clock = { now: new Date("2026-10-20T12:00:00Z") };
    let fail = false;
    const logs: string[] = [];
    const instance = new PublicStatsService({
      stats: {
        completedByAsset: () =>
          fail ? Promise.reject(new Error("database down")) : Promise.resolve([group({})]),
      },
      ttlMs: 1000,
      log: (_l, event) => void logs.push(event),
      now: () => clock.now,
    });
    const first = await instance.get();
    fail = true;
    clock.now = new Date(clock.now.getTime() + 5000);
    assert.deepEqual(await instance.get(), first);
    assert.deepEqual(logs, ["public_stats.compute_failed"]);
  });

  it("with nothing to serve, a failed read is an error (the endpoint answers 503)", async () => {
    const { instance, logs } = service(new Error("database down"));
    await assert.rejects(instance.get(), /database down/);
    assert.deepEqual(logs, ["public_stats.compute_failed"]);
  });
});
