import { Global, Inject, Injectable, Logger, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { createDatabase } from "@kaada/database";
import type { Database } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";

export const DATABASE = Symbol("DATABASE");

/** Closes the connection pool when the app shuts down. */
@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Database => {
        const logger = new Logger("Database");
        return createDatabase({
          url: config.database.url,
          poolMax: config.database.poolMax,
          poolTimeoutMs: config.database.poolTimeoutMs,
          onError: (error) => logger.error(`Connection pool error: ${error.name}`),
        });
      },
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
