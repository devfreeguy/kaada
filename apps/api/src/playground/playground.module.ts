import { Logger, Module } from "@nestjs/common";
import { createRepositories } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";
import type { ChannelType } from "@kaada/domain";

import { AgentModule } from "../agent/agent.module.js";
import { AGENT_SERVICE } from "../agent/agent.tokens.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { CONVERSATION_PRESENTER } from "../channels/channels.tokens.js";
import { APP_CONFIG } from "../config/config.module.js";
import type { AgentService } from "../core/agent/agent-service.js";
import { ChannelActionService } from "../core/channels/action-service.js";
import { ChannelIdentityService } from "../core/channels/identity-service.js";
import { ChannelMessageService } from "../core/channels/message-service.js";
import { describeSupportedCurrencies } from "../core/currency/catalog.js";
import { recordTrace } from "../core/channels/trace.js";
import type { ChannelAdapter } from "../core/channels/types.js";
import type { ConversationPresenter } from "../core/conversation/presenter.js";
import { PlaygroundService } from "../core/playground/playground-service.js";
import { DATABASE } from "../database/database.module.js";
import { PlaygroundAdapter } from "../infrastructure/channels/playground/playground-adapter.js";
import type { AgentLog } from "../core/agent/ports.js";
import { PlaygroundController } from "./playground.controller.js";
import { PLAYGROUND_SERVICE } from "./playground.tokens.js";

function playgroundLog(): AgentLog {
  const logger = new Logger("Playground");
  return (level, event, fields) => {
    const entry = { event, ...fields };
    if (level === "info") logger.log(entry);
    else if (level === "warn") logger.warn(entry);
    else logger.error(entry);
    recordTrace(level, event, fields);
  };
}

/**
 * The development agent playground.
 *
 * It builds a SECOND INSTANCE of the same ChannelMessageService, not a second pipeline: the agent, the interpreter, the
 * coordinator, the currency registry, the conversation memory, the presenter and the button handles are the very objects
 * Telegram uses, reached through the same handleInbound entry point.
 *
 * What differs is the wiring, and it differs in one direction only: every wallet-facing capability is left out.
 *
 *   onboarding: absent  - a playground identity never starts account setup or wallet provisioning
 *   funding:    absent  - no balance is ever read
 *   wallets:    always "no wallet", answered without asking any wallet service
 *   links:      setup links are unavailable, and an authorization link throws rather than ever being produced
 *   facts:      payment status lookups are unavailable
 *
 * So the playground cannot call a wallet, signing, balance, funding or execution service: those services are not injected
 * into it at all. Routing is kept away from them separately, at its own boundary (see RoutingService.plan).
 *
 * The whole module is inert unless AGENT_PLAYGROUND is on, which configuration refuses in production.
 */
@Module({
  imports: [AgentModule, ChannelsModule],
  controllers: [PlaygroundController],
  providers: [
    {
      provide: PLAYGROUND_SERVICE,
      inject: [APP_CONFIG, DATABASE, AGENT_SERVICE, CONVERSATION_PRESENTER],
      useFactory: (
        config: AppConfig,
        database: Database,
        agent: AgentService | null,
        conversation: ConversationPresenter,
      ): PlaygroundService | null => {
        if (!config.agent.playground || config.nodeEnv === "production") return null;
        const repositories: Repositories = createRepositories(database);
        const log = playgroundLog();
        const adapter = new PlaygroundAdapter();

        const messages = new ChannelMessageService({
          adapters: new Map<ChannelType, ChannelAdapter>([["WEB", adapter]]),
          identities: new ChannelIdentityService({
            users: repositories.users,
            identities: repositories.identities,
            log,
          }),
          actions: new ChannelActionService(repositories.channelActions),
          inboundEvents: repositories.channelInboundEvents,
          statuses: repositories.channelPaymentStatuses,
          agent,
          conversation,
          // Deliberately absent: nothing here may provision an account or read money.
          onboarding: null,
          funding: {
            // There is never a wallet in a playground session, so there are never wallet details to show. Answering null
            // here is the honest answer, not a failure to be fixed (see the scope note above).
            info: () => Promise.resolve(null),
            // Which currencies Kaada works with, read from the asset table alone. No wallet, no balance, no chain call:
            // this is the catalogue behind "do you support bitcoin?", and it is the same for everyone who asks.
            async catalogue() {
              const active = await repositories.assets.listActive();
              const chainId = config.wallet.balances.chainId;
              return {
                network: config.wallet.balances.label,
                assets: describeSupportedCurrencies(
                  active
                    .filter(
                      (asset) => asset.chainId === chainId && asset.contractAddress !== undefined,
                    )
                    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)),
                ),
              };
            },
          },
          // The person's own country and default currency: a stated preference, and part of the conversation under test.
          profile: {
            async get(userId) {
              const user = await repositories.users.findById(userId);
              return {
                ...(user?.homeCountry && { country: user.homeCountry }),
                ...(user?.homeCurrency && { currency: user.homeCurrency }),
              };
            },
            async set(userId, home) {
              await repositories.users.setHome(userId, home);
            },
          },
          // Read-only route discovery: it prices nothing and touches no wallet.
          conversions: {
            available: (from, to) => agent?.canConvert(from, to) ?? Promise.resolve(false),
          },
          wallets: {
            // Answered without consulting any wallet service: a playground session has no wallet and never gets one.
            hasActiveWallet: () => Promise.resolve(false),
          },
          links: {
            setupLink: () => Promise.resolve(null),
            authorizationLink: () => {
              // Unreachable: an authorization session is never opened in a playground turn. If that ever changed, this
              // refuses rather than handing a browser a link to a real PIN page.
              throw new Error("the playground never issues authorization links");
            },
          },
          facts: {
            read: () =>
              Promise.reject(new Error("the playground has no payment status to report")),
          },
          log,
        });

        return new PlaygroundService({
          messages,
          adapter,
          conversations: repositories.conversations,
          storedMessages: repositories.messages,
          intents: repositories.intents,
          log,
        });
      },
    },
  ],
  exports: [PLAYGROUND_SERVICE],
})
export class PlaygroundModule {}
