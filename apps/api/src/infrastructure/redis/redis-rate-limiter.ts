import type { RateLimit } from "../../core/authorization/rate-limiter.js";
import { errorDetails } from "../../core/channels/error-details.js";
import type { AgentLog } from "../../core/agent/ports.js";

/** The one ioredis method used, so tests (and any other client) can stand in. */
export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// Atomic fixed window: count the request and make sure the key can never outlive its window (or live forever).
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

/**
 * A Redis-backed fixed-window limiter, shared by every API instance and surviving restarts. It FAILS CLOSED: when Redis
 * cannot be reached the request is refused (and logged), because a limiter that opens on failure is a limiter an attacker
 * can switch off. The PIN lockout and the recovery state machine in the database remain authoritative either way.
 */
export class RedisRateLimiter implements RateLimit {
  constructor(
    private readonly client: RedisEvalClient,
    private readonly options: {
      /** Distinguishes limiters that share keys (for example "recovery:start"). */
      name: string;
      limit: number;
      windowMs: number;
      prefix?: string;
      log?: AgentLog;
    },
  ) {}

  async allow(key: string): Promise<boolean> {
    const redisKey = `${this.options.prefix ?? "kaada:rl:"}${this.options.name}:${key}`;
    try {
      const count = await this.client.eval(SCRIPT, 1, redisKey, this.options.windowMs);
      return typeof count === "number" && count <= this.options.limit;
    } catch (error) {
      // Failing closed: while Redis is unreachable every request through this limiter is refused, so this is an outage.
      this.options.log?.("error", "rate_limit.redis_unavailable", {
        limiter: this.options.name,
        ...errorDetails(error),
      });
      return false;
    }
  }
}
