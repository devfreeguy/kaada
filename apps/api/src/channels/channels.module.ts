import { Logger, Module } from "@nestjs/common";
import { createRepositories } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";
import { CELO_CHAIN_ID } from "@kaada/domain";
import type { ChannelType } from "@kaada/domain";

import { AgentModule } from "../agent/agent.module.js";
import { AGENT_SERVICE } from "../agent/agent.tokens.js";
import { AuthorizationModule } from "../authorization/authorization.module.js";
import { AUTHORIZATION_SESSION_SERVICE } from "../authorization/authorization.tokens.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AgentService } from "../core/agent/agent-service.js";
import type { AgentLog } from "../core/agent/ports.js";
import type { AuthorizationSessionService } from "../core/authorization/session-service.js";
import { ChannelActionService } from "../core/channels/action-service.js";
import { ChannelIdentityService } from "../core/channels/identity-service.js";
import { ChannelMessageService } from "../core/channels/message-service.js";
import { PaymentStatusDispatcher } from "../core/channels/payment-status.js";
import type { PaymentFactsReader } from "../core/channels/payment-status.js";
import type { ChannelAdapter } from "../core/channels/types.js";
import type { RootActionService } from "../core/execution/root-action-service.js";
import type { RunTracker } from "../core/execution/run-tracker.js";
import type { WalletSetupService } from "../core/wallets/setup-service.js";
import { DATABASE } from "../database/database.module.js";
import { ExecutionModule } from "../execution/execution.module.js";
import { ROOT_ACTION_SERVICE, RUN_TRACKER } from "../execution/execution.tokens.js";
import { TelegramAdapter } from "../infrastructure/channels/telegram/telegram-adapter.js";
import { WalletModule } from "../wallet/wallet.module.js";
import { WALLET_SETUP_SERVICE } from "../wallet/wallet.tokens.js";
import { ChannelSweeper } from "./channel-sweeper.js";
import {
  CHANNEL_MESSAGE_SERVICE,
  CHANNEL_REPOSITORIES,
  PAYMENT_STATUS_DISPATCHER,
  TELEGRAM_ADAPTER,
} from "./channels.tokens.js";
import { TelegramWebhookController } from "./telegram-webhook.controller.js";

function nestLog(): AgentLog {
  const logger = new Logger("Channels");
  return (level, event, fields) => {
    const entry = { event, ...fields };
    if (level === "info") logger.log(entry);
    else if (level === "warn") logger.warn(entry);
    else logger.error(entry);
  };
}

/**
 * Chat channels. Telegram is the first adapter; the orchestration (ChannelMessageService, the payment status dispatcher, the
 * opaque button handles, idempotency) is channel-independent, so another adapter only has to implement ChannelAdapter and be
 * added to the map below. Every route here answers "not enabled" until a channel is configured.
 */
@Module({
  imports: [AgentModule, AuthorizationModule, ExecutionModule, WalletModule],
  controllers: [TelegramWebhookController],
  providers: [
    ChannelSweeper,
    {
      provide: CHANNEL_REPOSITORIES,
      inject: [DATABASE],
      useFactory: (database: Database): Repositories => createRepositories(database),
    },
    {
      provide: TELEGRAM_ADAPTER,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): TelegramAdapter | null => {
        const telegram = config.channels.telegram;
        return telegram
          ? new TelegramAdapter({
              botToken: telegram.botToken,
              webhookSecret: telegram.webhookSecret,
            })
          : null;
      },
    },
    {
      provide: CHANNEL_MESSAGE_SERVICE,
      inject: [
        CHANNEL_REPOSITORIES,
        TELEGRAM_ADAPTER,
        AGENT_SERVICE,
        AUTHORIZATION_SESSION_SERVICE,
        WALLET_SETUP_SERVICE,
        RUN_TRACKER,
      ],
      useFactory: (
        repositories: Repositories,
        telegram: TelegramAdapter | null,
        agent: AgentService | null,
        sessions: AuthorizationSessionService | null,
        setup: WalletSetupService | null,
        runs: RunTracker,
      ): ChannelMessageService | null => {
        if (!telegram) return null;
        const adapters = new Map<ChannelType, ChannelAdapter>([["TELEGRAM", telegram]]);
        return new ChannelMessageService({
          adapters,
          identities: new ChannelIdentityService({
            users: repositories.users,
            identities: repositories.identities,
          }),
          actions: new ChannelActionService(repositories.channelActions),
          inboundEvents: repositories.channelInboundEvents,
          statuses: repositories.channelPaymentStatuses,
          agent,
          links: {
            setupLink: async (userId) => {
              if (!setup) return null;
              try {
                return (await setup.createSession(userId)).url;
              } catch {
                // A person whose wallet is already active has nothing to set up.
                return null;
              }
            },
            authorizationLink: async (input) => {
              if (!sessions) throw new Error("payment authorization is not enabled");
              return (await sessions.issueLink(input)).url;
            },
          },
          wallets: {
            hasActiveWallet: async (userId) =>
              (await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID))?.status === "ACTIVE",
          },
          facts: paymentFacts(repositories, runs),
          log: nestLog(),
        });
      },
    },
    {
      provide: PAYMENT_STATUS_DISPATCHER,
      inject: [CHANNEL_REPOSITORIES, TELEGRAM_ADAPTER, ROOT_ACTION_SERVICE, RUN_TRACKER],
      useFactory: (
        repositories: Repositories,
        telegram: TelegramAdapter | null,
        rootActions: RootActionService | null,
        runs: RunTracker,
      ): PaymentStatusDispatcher | null => {
        if (!telegram) return null;
        return new PaymentStatusDispatcher({
          statuses: repositories.channelPaymentStatuses,
          facts: paymentFacts(repositories, runs),
          adapters: new Map<ChannelType, ChannelAdapter>([["TELEGRAM", telegram]]),
          rootActionLink: async (sessionId, userId) => {
            if (!rootActions) return null;
            const authorization = await repositories.paymentAuthorizations.findBySession(sessionId);
            const plan = authorization
              ? await repositories.executionPlans.findByAuthorization(authorization.id)
              : null;
            const pending = plan
              ? await repositories.rootActions.findPendingByExecution(plan.id)
              : null;
            if (!pending) return null;
            return (await rootActions.issueLink({ sessionId: pending.id, userId })).url;
          },
          log: nestLog(),
        });
      },
    },
  ],
  exports: [CHANNEL_MESSAGE_SERVICE, PAYMENT_STATUS_DISPATCHER, TELEGRAM_ADAPTER],
})
export class ChannelsModule {}

/** Reads what the payment services already decided; the channel layer never changes any of it. */
function paymentFacts(repositories: Repositories, runs: RunTracker): PaymentFactsReader {
  return {
    async read(authorizationSessionId) {
      const session = await repositories.authorizationSessions.findById(authorizationSessionId);
      const authorization = session
        ? await repositories.paymentAuthorizations.findBySession(session.id)
        : null;
      const plan = authorization
        ? await repositories.executionPlans.findByAuthorization(authorization.id)
        : null;
      return {
        session: session ? { status: session.status, expiresAt: session.expiresAt } : null,
        authorized: authorization !== null,
        plan,
        latestRun: plan ? runs.outcome(plan.id) : undefined,
      };
    },
  };
}
