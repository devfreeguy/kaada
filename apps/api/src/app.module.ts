import { Module } from "@nestjs/common";
import { createLoggerOptions } from "@kaada/logger";
import type { AppConfig } from "@kaada/config";
import { LoggerModule } from "nestjs-pino";

import { AgentModule } from "./agent/agent.module.js";
import { AppConfigModule, APP_CONFIG } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
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
  ],
})
export class AppModule {}
