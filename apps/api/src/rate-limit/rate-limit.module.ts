import { Global, Module } from "@nestjs/common";
import type { AppConfig } from "@kaada/config";

import { RateLimiter } from "../core/authorization/rate-limiter.js";
import type { RateLimit } from "../core/authorization/rate-limiter.js";
import { APP_CONFIG } from "../config/config.module.js";
import { createRedis } from "../infrastructure/redis/connection.js";
import { RedisRateLimiter } from "../infrastructure/redis/redis-rate-limiter.js";
import { RATE_LIMIT_FACTORY } from "./rate-limit.tokens.js";

export type RateLimitFactory = (name: string, limit: number, windowMs: number) => RateLimit;

/**
 * One place that decides what limits requests: Redis when REDIS_URL is set (required in production, see the config), a
 * per-process limiter otherwise (development and tests only).
 */
@Global()
@Module({
  providers: [
    {
      provide: RATE_LIMIT_FACTORY,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): RateLimitFactory => {
        if (!config.redis) {
          return (_name, limit, windowMs) => new RateLimiter(limit, windowMs);
        }
        const client = createRedis(config.redis.url);
        return (name, limit, windowMs) =>
          new RedisRateLimiter(client, {
            name,
            limit,
            windowMs,
            prefix: config.redis?.prefix ?? "kaada:rl:",
          });
      },
    },
  ],
  exports: [RATE_LIMIT_FACTORY],
})
export class RateLimitModule {}
