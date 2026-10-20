import { Module } from "@nestjs/common";
import { createLoggerOptions } from "@kaada/logger";
import type { AppConfig } from "@kaada/config";
import { LoggerModule } from "nestjs-pino";

import {
  allExceptionsFilterProvider,
  httpLogLevel,
  originalUrlOf,
  requestSerializer,
} from "./logging/all-exceptions.filter.js";
import { AgentModule } from "./agent/agent.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { AuthorizationModule } from "./authorization/authorization.module.js";
import { ExecutionModule } from "./execution/execution.module.js";
import { AppConfigModule, APP_CONFIG } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { StatsModule } from "./stats/stats.module.js";
import { RateLimitModule } from "./rate-limit/rate-limit.module.js";
import { RecoverySwitchModule } from "./recovery/recovery-switch.js";
import { PlatformModule } from "./platform/platform.module.js";
import { RecoveryModule } from "./recovery/recovery.module.js";
import { WalletModule } from "./wallet/wallet.module.js";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RateLimitModule,
    RecoverySwitchModule,
    PlatformModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          ...createLoggerOptions({
            level: config.logLevel,
            pretty: config.nodeEnv === "development",
          }),
          customLogLevel: httpLogLevel,
          serializers: { req: requestSerializer },
          // The load balancer's liveness probe fires every 30 seconds and would bury everything else.
          autoLogging: {
            ignore: (req: { url?: string; originalUrl?: string }) =>
              originalUrlOf(req).split("?")[0] === "/api/health",
          },
        },
      }),
    }),
    HealthModule,
    StatsModule,
    AgentModule,
    WalletModule,
    AuthorizationModule,
    ExecutionModule,
    RecoveryModule,
    ChannelsModule,
  ],
  providers: [allExceptionsFilterProvider],
})
export class AppModule {}
