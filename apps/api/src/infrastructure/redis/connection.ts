import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";

/**
 * ioredis options for REDIS_URL. For rediss:// the TLS server name is set explicitly: managed Redis endpoints that route by
 * SNI refuse a connection that does not name its host. Requests fail fast instead of queueing behind a dead connection, so
 * the limiter built on it refuses (fails closed) rather than hangs.
 */
export function redisOptions(url: string, overrides: RedisOptions = {}): RedisOptions {
  const parsed = new URL(url);
  return {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    ...(parsed.protocol === "rediss:" && { tls: { servername: parsed.hostname } }),
    ...overrides,
  };
}

export function createRedis(url: string, overrides: RedisOptions = {}): Redis {
  const client = new Redis(url, redisOptions(url, overrides));
  // Connection errors surface as refused requests (fail closed), not as process-level unhandled events.
  client.on("error", () => undefined);
  return client;
}
