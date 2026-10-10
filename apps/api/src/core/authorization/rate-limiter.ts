/**
 * A small in-process limiter for the PIN endpoints: at most `limit` requests per `windowMs` for a
 * key. It is the SECOND line of defence (it also spares the server the cost of hashing a flood);
 * the database lockout is authoritative and does not depend on it. Memory is bounded: expired keys
 * are swept as new ones arrive.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one request. False means the key is over its limit for the current window. */
  allow(key: string): boolean {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.sweep(now);
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
    // Still full of live keys: drop the oldest rather than grow without bound.
    while (this.hits.size >= this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}
