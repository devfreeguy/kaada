import { Module } from "@nestjs/common";
import { createPaymentStatsRepository } from "@kaada/database";
import type { Database } from "@kaada/database";

import { PublicStatsService } from "../core/stats/public-stats-service.js";
import { DATABASE } from "../database/database.module.js";
import { nestLog } from "../logging/nest-log.js";
import { StatsController } from "./stats.controller.js";
import { PUBLIC_STATS_SERVICE } from "./stats.tokens.js";

@Module({
  controllers: [StatsController],
  providers: [
    {
      provide: PUBLIC_STATS_SERVICE,
      inject: [DATABASE],
      useFactory: (database: Database): PublicStatsService =>
        new PublicStatsService({
          stats: createPaymentStatsRepository(database),
          log: nestLog("PublicStats"),
        }),
    },
  ],
})
export class StatsModule {}
