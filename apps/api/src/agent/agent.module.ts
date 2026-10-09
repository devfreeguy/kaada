import { Logger, Module } from "@nestjs/common";
import { createRepositories, withTransaction } from "@kaada/database";
import { createCachedAssetRepository } from "@kaada/domain";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";

import { APP_CONFIG } from "../config/config.module.js";
import { DATABASE } from "../database/database.module.js";
import { AgentService } from "../core/agent/agent-service.js";
import { createDevInterpreter } from "../core/agent/dev-fixtures.js";
import type { IntentInterpreter } from "../core/agent/interpreter.js";
import type { AgentLog } from "../core/agent/ports.js";
import { composeRevisionHooks } from "../core/intents/intent-commit.js";
import { createDefaultResolvers } from "../core/agent/resolvers.js";
import { GroqIntentInterpreter, createGroqSdkTransport } from "../infrastructure/llm/index.js";
import { AgentController } from "./agent.controller.js";
import { createCandidateServices } from "../core/routing/candidate-services.js";
import type { CandidateServices } from "../core/routing/candidate-services.js";
import { AGENT_REPOSITORIES, AGENT_SERVICE, CANDIDATE_SERVICES } from "./agent.tokens.js";

function nestAgentLog(): AgentLog {
  const logger = new Logger("Agent");
  return (level, event, fields) => {
    const entry = { event, ...fields };
    if (level === "info") logger.log(entry);
    else if (level === "warn") logger.warn(entry);
    else logger.error(entry);
  };
}

/** Picks the interpreter from configuration. Production can never get the mock: config rejects it. */
function createInterpreter(config: AppConfig, log: AgentLog): IntentInterpreter | null {
  switch (config.agent.interpreter) {
    case "groq": {
      const groq = config.agent.groq;
      if (!groq) throw new Error("AGENT_INTERPRETER=groq requires Groq settings");
      return new GroqIntentInterpreter(createGroqSdkTransport({ apiKey: groq.apiKey }), {
        model: groq.model,
        timeoutMs: groq.timeoutMs,
        log,
      });
    }
    case "mock":
      if (config.nodeEnv === "production") {
        throw new Error("the mock interpreter cannot be used in production");
      }
      return createDevInterpreter();
    case "none":
      return null;
  }
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
      // Asset resolution and provider capabilities for the router (Build 8 injects this). It reads
      // data only: no provider is called and nothing is quoted.
      provide: CANDIDATE_SERVICES,
      inject: [AGENT_REPOSITORIES],
      useFactory: (repositories: Repositories): CandidateServices =>
        createCandidateServices({
          assets: createCachedAssetRepository(repositories.assets),
          providers: repositories.providers,
        }),
    },
    {
      provide: AGENT_SERVICE,
      inject: [DATABASE, APP_CONFIG, AGENT_REPOSITORIES],
      useFactory: (
        database: Database,
        config: AppConfig,
        repositories: Repositories,
      ): AgentService | null => {
        const log = nestAgentLog();
        const interpreter = createInterpreter(config, log);
        if (!interpreter) return null;

        // Assets change rarely, so lookups for interpretation share one short-lived snapshot.
        const assets = createCachedAssetRepository(repositories.assets);
        return new AgentService({
          interpreter,
          unitOfWork: {
            read: repositories,
            transaction: (work) => withTransaction(database, work),
          },
          createResolvers: (transactional) => createDefaultResolvers({ ...transactional, assets }),
          // The one place anything derived from an earlier revision is discarded. Candidate sets
          // are recomputed on demand and bound to a revision (isCandidateSetCurrent), so nothing is
          // persisted yet; a later build that stores candidates, quotes or routes adds its
          // invalidation here.
          onIntentRevised: composeRevisionHooks((_repositories, intent, previousRevision) => {
            log("info", "agent.intent.revised", {
              intentId: intent.id,
              revision: intent.revision,
              previousRevision,
            });
            return Promise.resolve();
          }),
          log,
        });
      },
    },
  ],
})
export class AgentModule {}
