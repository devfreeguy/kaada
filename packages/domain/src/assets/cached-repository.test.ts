import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Asset } from "./asset.js";
import { createCachedAssetRepository } from "./cached-repository.js";
import type { AssetRepository } from "./registry.js";

const asset = (id: string, symbol: string, extra: Partial<Asset> = {}): Asset => ({
  id,
  symbol,
  name: symbol,
  kind: "USD_STABLECOIN",
  decimals: 6,
  isActive: true,
  ...extra,
});

function countingSource(rows: Asset[]) {
  const state = { reads: 0, fail: false, rows };
  const source: AssetRepository = {
    findById: () => Promise.reject(new Error("the cache must not call this")),
    findBySymbol: () => Promise.reject(new Error("the cache must not call this")),
    findByFiatCode: () => Promise.reject(new Error("the cache must not call this")),
    findByDenomination: () => Promise.reject(new Error("the cache must not call this")),
    listActive: () => Promise.reject(new Error("the cache must not call this")),
    listAll: () => {
      state.reads += 1;
      return state.fail ? Promise.reject(new Error("db down")) : Promise.resolve([...state.rows]);
    },
  };
  return { source, state };
}

describe("createCachedAssetRepository", () => {
  const rows = [
    asset("usd", "USD", { kind: "FIAT", fiatCode: "USD", decimals: 2 }),
    asset("usdc-1", "USDC", { chainId: 1 }),
    asset("usdc-2", "USDC", { chainId: 42220 }),
    asset("old", "OLD", { isActive: false, chainId: 42220 }),
  ];

  it("answers every lookup from one table read, with the same semantics as the database", async () => {
    const { source, state } = countingSource(rows);
    const cache = createCachedAssetRepository(source);

    assert.equal((await cache.findById("usd"))?.symbol, "USD");
    assert.equal(await cache.findById("missing"), null);
    assert.deepEqual(
      (await cache.findBySymbol("usdc")).map((a) => a.id),
      ["usdc-1", "usdc-2"],
    );
    assert.deepEqual(
      (await cache.findBySymbol("USDC", { chainId: 42220 })).map((a) => a.id),
      ["usdc-2"],
    );
    assert.deepEqual(
      (await cache.findByFiatCode(" usd ")).map((a) => a.id),
      ["usd"],
    );
    assert.deepEqual(
      (await cache.listActive()).map((a) => a.id),
      ["usd", "usdc-1", "usdc-2"],
    );
    assert.equal((await cache.listAll()).length, 4, "inactive assets stay visible to id lookups");
    assert.equal((await cache.findById("old"))?.isActive, false);
    assert.equal(state.reads, 1);
  });

  it("shares one read between concurrent first lookups", async () => {
    const { source, state } = countingSource(rows);
    const cache = createCachedAssetRepository(source);
    await Promise.all([cache.findById("usd"), cache.findBySymbol("USDC"), cache.listActive()]);
    assert.equal(state.reads, 1);
  });

  it("re-reads after the TTL and after invalidate()", async () => {
    let clock = 0;
    const { source, state } = countingSource(rows);
    const cache = createCachedAssetRepository(source, { ttlMs: 1000, now: () => clock });

    await cache.findById("usd");
    clock = 999;
    await cache.findById("usd");
    assert.equal(state.reads, 1);
    clock = 1000;
    await cache.findById("usd");
    assert.equal(state.reads, 2);

    cache.invalidate();
    await cache.findById("usd");
    assert.equal(state.reads, 3);
  });

  it("picks up database changes once the snapshot expires", async () => {
    let clock = 0;
    const { source, state } = countingSource(rows);
    const cache = createCachedAssetRepository(source, { ttlMs: 1000, now: () => clock });
    assert.equal(await cache.findById("new"), null);
    state.rows = [...rows, asset("new", "NEW")];
    assert.equal(await cache.findById("new"), null, "still the old snapshot");
    clock = 1500;
    assert.equal((await cache.findById("new"))?.symbol, "NEW");
  });

  it("never caches a failure", async () => {
    const { source, state } = countingSource(rows);
    const cache = createCachedAssetRepository(source);
    state.fail = true;
    await assert.rejects(cache.findById("usd"), /db down/);
    state.fail = false;
    assert.equal((await cache.findById("usd"))?.symbol, "USD");
    assert.equal(state.reads, 2);
  });
});
