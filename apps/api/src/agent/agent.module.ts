import { Logger, Module } from "@nestjs/common";
import { createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { AgentService } from "../core/agent/agent-service.js";
import { createDevInterpreter } from "../core/agent/dev-fixtures.js";
import type { AgentLog } from "../core/agent/ports.js";
import { AgentController } from "./agent.controller.js";
import { AGENT_REPOSITORIES, AGENT_SERVICE } from "./agent.tokens.js";

function nestAgentLog(): AgentLog {
  const logger = new Logger("Agent");
  return (level, event, fields) => {
    const entry = { event, ...fields };
    if (level === "info") logger.log(entry);
    else if (level === "warn") logger.warn(entry);
    else logger.error(entry);
  };
}

@Module({
  controllers: [AgentController],
  providers: [
    {
      provide: AGENT_REPOSITORIES,
      inject: [DATABASE],
      useFactory: (database: Database): Repositories => createRepositories(database),
    },
    {
      provide: AGENT_SERVICE,
      inject: [DATABASE, APP_CONFIG, AGENT_REPOSITORIES],
      useFactory: (
        database: Database,
        config: AppConfig,
        repositories: Repositories,
      ): AgentService | null => {
        // Only the development interpreter exists until a real model is connected.
        if (config.agent.interpreter !== "mock") return null;
        return new AgentService({
          interpreter: createDevInterpreter(),
          unitOfWork: {
            read: repositories,
            transaction: (work) => withTransaction(database, work),
          },
          log: nestAgentLog(),
        });
      },
    },
  ],
})
export class AgentModule {}
