import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RedisRateLimiter } from "../src/infrastructure/redis/redis-rate-limiter.js";
import type { RedisEvalClient } from "../src/infrastructure/redis/redis-rate-limiter.js";

/** Implements the script's semantics (INCR, PEXPIRE on first hit, window expiry) on a fake clock. */
function fakeRedis() {
  let now = 1_000_000;
  const store = new Map<string, { count: number; expiresAt: number }>();
  const client: RedisEvalClient & { fail: boolean } = {
    fail: false,
    eval(_script, _n, key, windowMs) {
      if (client.fail) return Promise.reject(new Error("ECONNREFUSED"));
      const k = String(key);
      let entry = store.get(k);
      if (entry && entry.expiresAt <= now) {
        store.delete(k);
        entry = undefined;
      }
      if (!entry) {
        entry = { count: 0, expiresAt: now + Number(windowMs) };
        store.set(k, entry);
      }
      entry.count += 1;
      return Promise.resolve(entry.count);
    },
  };
  return { client, advance: (ms: number) => (now += ms), store };
}

describe("redis rate limiter", () => {
  it("allows up to the limit per key and window, then refuses", async () => {
    const { client } = fakeRedis();
    const limiter = new RedisRateLimiter(client, { name: "t", limit: 3, windowMs: 60_000 });
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(() => limiter.allow("a"))), [
      true,
      true,
      true,
      false,
      false,
    ]);
    assert.equal(await limiter.allow("b"), true, "another key has its own count");
  });

  it("starts a new window after the old one expires", async () => {
    const { client, advance } = fakeRedis();
    const limiter = new RedisRateLimiter(client, { name: "t", limit: 1, windowMs: 1000 });
    assert.equal(await limiter.allow("a"), true);
    assert.equal(await limiter.allow("a"), false);
    advance(1001);
    assert.equal(await limiter.allow("a"), true);
  });

  it("separates limiters by name and prefixes every key", async () => {
    const { client, store } = fakeRedis();
    const one = new RedisRateLimiter(client, {
      name: "one",
      limit: 1,
      windowMs: 1000,
      prefix: "p:",
    });
    const two = new RedisRateLimiter(client, {
      name: "two",
      limit: 1,
      windowMs: 1000,
      prefix: "p:",
    });
    assert.equal(await one.allow("k"), true);
    assert.equal(await two.allow("k"), true);
    assert.deepEqual([...store.keys()].sort(), ["p:one:k", "p:two:k"]);
  });

  it("fails closed, and says so in the log, when Redis is unreachable", async () => {
    const { client } = fakeRedis();
    client.fail = true;
    const logs: string[] = [];
    const limiter = new RedisRateLimiter(client, {
      name: "t",
      limit: 100,
      windowMs: 1000,
      log: (_level, event) => logs.push(event),
    });
    assert.equal(await limiter.allow("a"), false);
    assert.deepEqual(logs, ["rate_limit.redis_unavailable"]);
  });

  it("refuses an unexpected reply", async () => {
    const limiter = new RedisRateLimiter(
      { eval: () => Promise.resolve("nope") },
      { name: "t", limit: 5, windowMs: 1000 },
    );
    assert.equal(await limiter.allow("a"), false);
  });
});
