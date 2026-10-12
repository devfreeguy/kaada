import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RecoveryFlowService } from "../src/core/recovery/recovery-flow.js";
import { RedisRateLimiter } from "../src/infrastructure/redis/redis-rate-limiter.js";
import type { RateLimit } from "../src/core/authorization/rate-limiter.js";
import { createRecoveryWorld, expectKaada } from "./support/recovery-world.js";

/** An asynchronous shared limiter, like the Redis one: counts per key across every service instance using it. */
function sharedLimiter(limit: number): RateLimit & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    allow: async (key) => {
      await Promise.resolve();
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next <= limit;
    },
  };
}

describe("recovery rate limits are injectable and asynchronous", () => {
  it("start is limited per email through the shared limiter, whichever instance serves it", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const start = sharedLimiter(2);
    const one = new RecoveryFlowService({ context: world.context, limiters: { start } });
    const two = new RecoveryFlowService({ context: world.context, limiters: { start } });
    await one.start({ email: user.email });
    await two.start({ email: user.email });
    // A third request is refused on EITHER instance: the count lives in the shared store, not in the process.
    await expectKaada(one.start({ email: user.email }), "RECOVERY_RATE_LIMITED");
    await expectKaada(two.start({ email: user.email }), "RECOVERY_RATE_LIMITED");
  });

  it("the per-address limit applies too, and a different email is not affected by the first", async () => {
    const world = createRecoveryWorld();
    const a = await world.createUser();
    const b = await world.createUser();
    const ip = sharedLimiter(1);
    const flow = new RecoveryFlowService({ context: world.context, limiters: { ip } });
    await flow.start({ email: a.email, ip: "203.0.113.9" });
    await expectKaada(flow.start({ email: b.email, ip: "203.0.113.9" }), "RECOVERY_RATE_LIMITED");
    await flow.start({ email: b.email, ip: "203.0.113.10" });
  });

  it("a limiter that cannot reach its store refuses everything (fail closed) instead of opening", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const dead = new RedisRateLimiter(
      { eval: () => Promise.reject(new Error("ECONNREFUSED")) },
      { name: "recovery:start", limit: 5, windowMs: 1000 },
    );
    const flow = new RecoveryFlowService({
      context: world.context,
      limiters: { start: dead, ip: dead, step: dead },
    });
    await expectKaada(flow.start({ email: user.email }), "RECOVERY_RATE_LIMITED");
  });

  it("step limits bound the email-code and proof attempts through the same store", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const step = sharedLimiter(3);
    const flow = new RecoveryFlowService({ context: world.context, limiters: { step } });
    const { token } = await flow.start({ email: user.email });
    let refused = 0;
    for (let i = 0; i < 6; i += 1) {
      try {
        await flow.verifyEmail(token, "000000");
      } catch (error) {
        if ((error as { code?: string }).code === "RECOVERY_RATE_LIMITED") refused += 1;
      }
    }
    assert.ok(refused >= 3, `refused ${String(refused)}`);
    assert.ok([...step.counts.keys()].every((key) => /^(verify|resend|step|proof):/.test(key)));
  });
});
