import { Module } from "@nestjs/common";
import { createLoggerOptions } from "@kaada/logger";
import type { AppConfig } from "@kaada/config";
import { LoggerModule } from "nestjs-pino";

import { AgentModule } from "./agent/agent.module.js";
import { ChannelsModule } from "./channels/channels.module.js";
import { AuthorizationModule } from "./authorization/authorization.module.js";
import { ExecutionModule } from "./execution/execution.module.js";
import { AppConfigModule, APP_CONFIG } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { RateLimitModule } from "./rate-limit/rate-limit.module.js";
import { RecoveryModule } from "./recovery/recovery.module.js";
import { WalletModule } from "./wallet/wallet.module.js";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    RateLimitModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        pinoHttp: createLoggerOptions({
          level: config.logLevel,
          pretty: config.nodeEnv === "development",
        }),
      }),
    }),
    HealthModule,
    AgentModule,
    WalletModule,
    AuthorizationModule,
    ExecutionModule,
    RecoveryModule,
    ChannelsModule,
  ],
})
export class AppModule {}
