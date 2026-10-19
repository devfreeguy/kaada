import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Header,
  Inject,
  Ip,
  Logger,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";

import { RateLimiter } from "../core/authorization/rate-limiter.js";
import type { RateLimit } from "../core/authorization/rate-limiter.js";
import type { PublicStats, PublicStatsService } from "../core/stats/public-stats-service.js";
import { errorText } from "../logging/error-text.js";
import { RATE_LIMIT_FACTORY } from "../rate-limit/rate-limit.tokens.js";
import type { RateLimitFactory } from "../rate-limit/rate-limit.module.js";
import { PUBLIC_STATS_SERVICE } from "./stats.tokens.js";

/**
 * The one PUBLIC, unauthenticated read: totals for the marketing page. It returns aggregates only (see PublicStatsService), takes no
 * input, is cached for the browser and any CDN, and is rate limited per address as a second line of defence.
 */
@Controller({ path: "stats", version: "1" })
export class StatsController {
  private readonly logger = new Logger("PublicStats");
  private readonly perAddress: RateLimit;

  constructor(
    @Inject(PUBLIC_STATS_SERVICE) private readonly service: PublicStatsService,
    @Optional() @Inject(RATE_LIMIT_FACTORY) limits?: RateLimitFactory,
  ) {
    const make = limits ?? ((_name, limit, windowMs) => new RateLimiter(limit, windowMs));
    this.perAddress = make("public-stats:address", 60, 60_000);
  }

  @Get("public")
  @Header("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=600")
  async publicStats(@Ip() ip: string): Promise<PublicStats> {
    if (!(await this.perAddress.allow(ip || "unknown"))) {
      throw new HttpException("too many requests", HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      return await this.service.get();
    } catch (error) {
      this.logger.error({
        event: "public_stats.unavailable",
        reason: errorText(error),
        effect: "the marketing page shows no totals until the database answers",
      });
      throw new ServiceUnavailableException("totals are not available right now");
    }
  }
}
