/*
 * The Redis rate limiter against the REAL Redis in REDIS_URL: the atomic window, real concurrency, the TTL, and the
 * fail-closed behaviour when the connection is dead. Keys use a unique prefix and are deleted afterwards.
 * Skipped without REDIS_URL. Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createRedis } from "../../src/infrastructure/redis/connection.js";
import { RedisRateLimiter } from "../../src/infrastructure/redis/redis-rate-limiter.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["REDIS_URL"];
const skip = url ? false : "REDIS_URL is not set";

describe("redis rate limiter on the real Redis", { skip }, () => {
  const prefix = `kaada:test:${randomUUID()}:`;
  const client = createRedis(url ?? "redis://127.0.0.1:6379", { lazyConnect: true });

  before(async () => {
    await client.connect();
  });

  after(async () => {
    try {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length > 0) await client.del(...keys);
    } finally {
      client.disconnect();
    }
  });

  it("counts atomically: exactly `limit` of many concurrent requests pass", async () => {
    const limiter = new RedisRateLimiter(client, { name: "c", limit: 7, windowMs: 30_000, prefix });
    const results = await Promise.all(Array.from({ length: 40 }, () => limiter.allow("same")));
    assert.equal(results.filter(Boolean).length, 7);
  });

  it("gives every key a TTL (nothing lives forever) and a fresh window after it", async () => {
    // The Redis here is remote: allow generous margins instead of assuming sub-100ms round trips.
    const limiter = new RedisRateLimiter(client, { name: "t", limit: 1, windowMs: 4000, prefix });
    assert.equal(await limiter.allow("k"), true);
    const ttl = await client.pttl(`${prefix}t:k`);
    assert.ok(ttl > 0 && ttl <= 4000, `ttl ${String(ttl)}`);
    assert.equal(await limiter.allow("k"), false);
    while ((await client.pttl(`${prefix}t:k`)) !== -2) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(await limiter.allow("k"), true);
  });

  it("is shared by independent connections (as two API instances would be)", async () => {
    const other = createRedis(url ?? "", { lazyConnect: true });
    await other.connect();
    try {
      const a = new RedisRateLimiter(client, { name: "s", limit: 2, windowMs: 30_000, prefix });
      const b = new RedisRateLimiter(other, { name: "s", limit: 2, windowMs: 30_000, prefix });
      assert.deepEqual(
        [await a.allow("x"), await b.allow("x"), await a.allow("x")],
        [true, true, false],
      );
    } finally {
      other.disconnect();
    }
  });

  it("fails closed when the connection is dead", async () => {
    const dead = createRedis("redis://127.0.0.1:1", { retryStrategy: () => null });
    try {
      const limiter = new RedisRateLimiter(dead, { name: "d", limit: 100, windowMs: 1000, prefix });
      assert.equal(await limiter.allow("k"), false);
    } finally {
      dead.disconnect();
    }
  });
});
