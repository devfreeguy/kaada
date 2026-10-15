import { Logger, Module } from "@nestjs/common";
import { createRepositories } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import type { AppConfig } from "@kaada/config";
import { SETTINGS } from "@kaada/config";
import { CELO_CHAIN_ID, KaadaError } from "@kaada/domain";
import type { ChannelType, WalletFundingStore } from "@kaada/domain";

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
import {
  WALLET_BALANCE_SERVICE,
  WALLET_FUNDING_STORE,
  WALLET_FUNDING_WATCHER,
  WALLET_SERVICE,
  WALLET_SETUP_SERVICE,
} from "../wallet/wallet.tokens.js";
import type { WalletBalanceService } from "../core/wallets/balance-service.js";
import type { WalletService } from "../core/wallets/wallet-service.js";
import { labelOf } from "../core/conversation/capabilities.js";
import { describeSupportedCurrencies } from "../core/currency/catalog.js";
import type { CapabilityFlags } from "../core/conversation/capabilities.js";
import { suggestionPolicy } from "../core/conversation/suggestions.js";
import { ConversationPresenter } from "../core/conversation/presenter.js";
import { FundingAnnouncer } from "../core/channels/funding-announcer.js";
import { OnboardingAnnouncer } from "../core/channels/onboarding-announcer.js";
import type { WalletFundingWatcher } from "../core/wallets/funding-watcher.js";
import { OnboardingLifecycleService } from "../core/onboarding/lifecycle-service.js";
import type { OnboardingStateReader } from "../core/onboarding/state.js";
import { GroqConversationWriter } from "../infrastructure/llm/groq-conversation-writer.js";
import { createGroqSdkTransport } from "../infrastructure/llm/groq-sdk-transport.js";
import { ChannelSweeper } from "./channel-sweeper.js";
import {
  CHANNEL_MESSAGE_SERVICE,
  CHANNEL_REPOSITORIES,
  CONVERSATION_PRESENTER,
  FUNDING_ANNOUNCER,
  ONBOARDING_ANNOUNCER,
  ONBOARDING_LIFECYCLE,
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
      // Kaada's voice. The model (when Groq is configured) only phrases; the application states every fact. Without it the
      // deterministic wording is used, so the bot works the same, just a little plainer.
      provide: CONVERSATION_PRESENTER,
      inject: [APP_CONFIG, WALLET_SERVICE, WALLET_BALANCE_SERVICE, AUTHORIZATION_SESSION_SERVICE],
      useFactory: (
        config: AppConfig,
        wallets: WalletService | null,
        balances: WalletBalanceService | null,
        authorization: AuthorizationSessionService | null,
      ): ConversationPresenter => {
        const groq = config.agent.groq;
        const log = nestLog();
        return new ConversationPresenter({
          writer: groq
            ? new GroqConversationWriter(createGroqSdkTransport({ apiKey: groq.apiKey }), {
                model: groq.model,
                timeoutMs: groq.presentation.timeoutMs,
                temperature: groq.presentation.temperature,
                log,
              })
            : null,
          flags: capabilityFlags(config, { wallets, balances, authorization }),
          timeoutMs: groq?.presentation.timeoutMs ?? 5_000,
          log,
        });
      },
    },
    {
      // Where each person is on the way to a working wallet, read from the services' own records (wallet, PIN, recovery).
      provide: ONBOARDING_LIFECYCLE,
      inject: [CHANNEL_REPOSITORIES, TELEGRAM_ADAPTER, APP_CONFIG],
      useFactory: (
        repositories: Repositories,
        telegram: TelegramAdapter | null,
        config: AppConfig,
      ): OnboardingLifecycleService | null => {
        if (!telegram) return null;
        const reader: OnboardingStateReader = {
          async read(userId) {
            const wallet = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
            const walletReady = wallet?.status === "ACTIVE" && wallet.address !== undefined;
            const pinConfigured =
              (await repositories.transactionPins.findByUserId(userId)) !== null;
            // Recovery only applies where this deployment has it; and only a wallet can have it armed.
            const recoveryConfigured = !config.recovery.enabled
              ? null
              : wallet
                ? (await repositories.recoveryConfigurations.findActive(wallet.id)) !== null
                : false;
            return {
              walletReady,
              ...(walletReady && wallet?.address && { walletAddress: wallet.address }),
              pinConfigured,
              recoveryConfigured,
            };
          },
        };
        return new OnboardingLifecycleService({
          notifications: repositories.userNotifications,
          state: reader,
          policy: { requireRecovery: SETTINGS.onboarding.requireRecovery },
          log: nestLog(),
        });
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
        CONVERSATION_PRESENTER,
        ONBOARDING_LIFECYCLE,
        WALLET_BALANCE_SERVICE,
      ],
      useFactory: (
        repositories: Repositories,
        telegram: TelegramAdapter | null,
        agent: AgentService | null,
        sessions: AuthorizationSessionService | null,
        setup: WalletSetupService | null,
        runs: RunTracker,
        conversation: ConversationPresenter,
        onboarding: OnboardingLifecycleService | null,
        balances: WalletBalanceService | null,
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
          conversation,
          onboarding,
          linked: repositories.identities,
          // The person's own choice of country and default currency; nothing here guesses it.
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
          conversions: {
            available: (from, to) => agent?.canConvert(from, to) ?? Promise.resolve(false),
          },
          funding: balances
            ? {
                // The trusted details for "fund my wallet": the person's own address, the network and the tokens Kaada supports.
                async info(userId) {
                  try {
                    const wallet = await balances.activeWallet(userId);
                    const tokens = await balances.supportedTokens();
                    return {
                      address: wallet.address,
                      network: balances.networkLabel,
                      assets: describeSupportedCurrencies(tokens),
                    };
                  } catch (error) {
                    if (error instanceof KaadaError && error.code === "WALLET_NOT_ACTIVE")
                      return null;
                    throw error;
                  }
                },
                // What the wallet holds right now, so a deposit can be matched against an open payment.
                async holdings(userId) {
                  try {
                    const view = await balances.forUser(userId);
                    return view.balances.map((line) => ({
                      symbol: line.symbol,
                      assetId: line.assetId,
                      amount: line.money.amount,
                    }));
                  } catch {
                    return null;
                  }
                },
              }
            : null,
          resumeWindowMs: SETTINGS.funding.resumeWindowMs,
          // On a test network the open payment's token (a registry asset) and the held test token are tied by symbol only.
          matchBySymbol: balances?.isTestNetwork === true,
          links: {
            setupLink: async (userId, options) => {
              if (!setup) return null;
              try {
                // `existingWallet` continues a wallet that already exists (the PIN step) without creating another.
                return (await setup.createSession(userId, options ?? {})).url;
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
      // Delivers queued onboarding notifications on every chat the person has linked, and retries failures.
      provide: ONBOARDING_ANNOUNCER,
      inject: [ONBOARDING_LIFECYCLE, CHANNEL_MESSAGE_SERVICE],
      useFactory: (
        lifecycle: OnboardingLifecycleService | null,
        messages: ChannelMessageService | null,
      ): OnboardingAnnouncer | null => {
        if (!lifecycle || !messages) return null;
        return new OnboardingAnnouncer({
          lifecycle,
          announce: (announcement) => messages.announceOnboarding(announcement),
          log: nestLog(),
        });
      },
    },
    {
      // Looks for supported deposits (polled by the sweeper) and tells people on every chat they have linked.
      provide: FUNDING_ANNOUNCER,
      inject: [WALLET_FUNDING_WATCHER, WALLET_FUNDING_STORE, CHANNEL_MESSAGE_SERVICE],
      useFactory: (
        watcher: WalletFundingWatcher | null,
        store: WalletFundingStore,
        messages: ChannelMessageService | null,
      ): FundingAnnouncer | null => {
        if (!watcher || !messages) return null;
        return new FundingAnnouncer({
          watcher,
          store,
          announce: (event) => messages.announceFunding(event),
          log: nestLog(),
        });
      },
    },
    {
      provide: PAYMENT_STATUS_DISPATCHER,
      inject: [
        CHANNEL_REPOSITORIES,
        TELEGRAM_ADAPTER,
        ROOT_ACTION_SERVICE,
        RUN_TRACKER,
        APP_CONFIG,
        WALLET_SERVICE,
        WALLET_BALANCE_SERVICE,
        AUTHORIZATION_SESSION_SERVICE,
      ],
      useFactory: (
        repositories: Repositories,
        telegram: TelegramAdapter | null,
        rootActions: RootActionService | null,
        runs: RunTracker,
        config: AppConfig,
        wallets: WalletService | null,
        balances: WalletBalanceService | null,
        authorization: AuthorizationSessionService | null,
      ): PaymentStatusDispatcher | null => {
        if (!telegram) return null;
        const actions = new ChannelActionService(repositories.channelActions);
        const completionIds = suggestionPolicy(
          "PAYMENT_COMPLETED",
          capabilityFlags(config, { wallets, balances, authorization }),
        );
        return new PaymentStatusDispatcher({
          statuses: repositories.channelPaymentStatuses,
          facts: paymentFacts(repositories, runs),
          adapters: new Map<ChannelType, ChannelAdapter>([["TELEGRAM", telegram]]),
          // Light follow-ups under a finished payment. A payment status is a one-to-one chat, where the chat id is the person.
          completionActions: async (status) =>
            Promise.all(
              completionIds.map(async (id) => ({
                type: "ACTION" as const,
                semantic: "SUGGESTION" as const,
                label: labelOf(id),
                handle: await actions.issue({
                  userId: status.userId,
                  channel: status.channel,
                  externalUserId: status.externalConversationId,
                  conversationId: status.id,
                  kind: "SUGGESTION",
                  payload: { suggestion: id },
                  reusable: true,
                }),
              })),
            ),
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
  exports: [
    FUNDING_ANNOUNCER,
    CHANNEL_MESSAGE_SERVICE,
    PAYMENT_STATUS_DISPATCHER,
    TELEGRAM_ADAPTER,
    ONBOARDING_LIFECYCLE,
    ONBOARDING_ANNOUNCER,
  ],
})
export class ChannelsModule {}

/**
 * Which features this deployment really has, from the same conditions that switch them on in the agent: a pricing provider for
 * rates, a pricing provider plus wallets plus the PIN step for payments, a wallet service for balances. A suggestion or a
 * sentence about a feature is only ever produced when its flag is true.
 */
function capabilityFlags(
  config: AppConfig,
  deps: {
    wallets: WalletService | null;
    balances: WalletBalanceService | null;
    authorization: AuthorizationSessionService | null;
  },
): CapabilityFlags {
  const rates = config.fx.provider !== "none";
  return {
    rates,
    send: rates && deps.wallets !== null && deps.balances !== null && deps.authorization !== null,
    balance: deps.balances !== null,
    funding: {
      // Anyone with a Kaada wallet can be sent tokens from another wallet or an exchange.
      walletTransfer: deps.balances !== null,
      // There is no on-ramp provider flow yet, so this stays off until one exists. Never switch it on "for later".
      localCurrency: false,
    },
  };
}

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
