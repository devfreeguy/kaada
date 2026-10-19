import { createId } from "@kaada/domain";
import type {
  ChannelInboundEventRepository,
  ChannelPaymentStatusRepository,
  ChannelType,
  ConversationTurn,
  IdentityRepository,
  IdentityType,
  WalletFundingEvent,
} from "@kaada/domain";

import type { AgentTurnResult, IncomingAgentInput } from "../agent/agent-service.js";
import { ConversationAccessError } from "../agent/errors.js";
import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import {
  NO_CAPABILITIES,
  availableFundingMethods,
  isSuggestionId,
  labelOf,
} from "../conversation/capabilities.js";
import type { CapabilityFlags } from "../conversation/capabilities.js";
import { ConversationPresenter } from "../conversation/presenter.js";
import { suggestionPolicy } from "../conversation/suggestions.js";
import type { OpenPaymentNeeds } from "../intents/coordinator.js";
import type { ResumeInfo } from "../responses/agent-response.js";
import {
  HOME_COUNTRIES,
  plainAmount,
  OTHER_COUNTRY,
  currencyByCode,
  describeAsset,
  describeHome,
  describeMoney,
  homeFor,
} from "../currency/catalog.js";
import { pick } from "../conversation/fallbacks.js";
import {
  FUNDING_NONE,
  FUNDING_NOT_READY,
  FUNDING_UNAVAILABLE,
  fundingInstructions,
  networkFeeFundingMessage,
  supportedAssetsMessage,
  walletAddressMessage,
} from "../conversation/funding.js";
import type { FundingInfo } from "../conversation/funding.js";
import type { OnboardingLifecycleService, Announcement } from "../onboarding/lifecycle-service.js";
import type { OnboardingFacts, OnboardingStep } from "../onboarding/state.js";
import type { ChannelActionService } from "./action-service.js";
import { beginActivity } from "./activity.js";
import type { Activity } from "./activity.js";
import { classifyAction } from "./latency.js";
import type { LatencyTimings } from "./latency.js";
import { helpText } from "./commands.js";
import { errorDetails } from "./error-details.js";
import type { ChannelIdentityService } from "./identity-service.js";
import { describeProgress } from "./payment-status.js";
import type { PaymentFactsReader } from "./payment-status.js";
import { deriveProgress } from "./payment-status.js";
import { presentAgentResponse } from "./presenter.js";
import type { PresentedMessage } from "./presenter.js";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  ChannelCommand,
  OutboundAction,
  OutboundChannelMessage,
} from "./types.js";

/** What the service needs from the rest of the application, as narrow ports (no Telegram, no Prisma, no Nest). */
export interface ChannelMessageServiceDeps {
  adapters: ReadonlyMap<ChannelType, ChannelAdapter>;
  identities: ChannelIdentityService;
  actions: ChannelActionService;
  inboundEvents: ChannelInboundEventRepository;
  statuses: ChannelPaymentStatusRepository;
  /** The Agent Core. Absent when no interpreter is configured: the channel then says so politely. */
  agent: {
    handle(input: IncomingAgentInput): Promise<AgentTurnResult>;
    /** The payment still open in a chat, if any. Optional: without it funding messages simply do not offer to carry on. */
    openPaymentResume?(input: {
      userId: string;
      channel: ChannelType;
      externalConversationId: string;
    }): Promise<ResumeInfo | undefined>;
    /** The open payment and what it needs from the wallet, for matching a deposit. Optional: without it deposits are just announced. */
    openPaymentNeeds?(input: {
      userId: string;
      channel: ChannelType;
      externalConversationId: string;
    }): Promise<OpenPaymentNeeds | undefined>;
    /** The last few turns, for the conversation layer's tone. Optional: without it the reply is phrased from the answer alone. */
    recentTurns?(
      conversationId: string,
      excludeMessageId: string,
      limit?: number,
    ): Promise<ConversationTurn[]>;
  } | null;
  /**
   * Phrases the Agent Core's answer in Kaada's voice (greetings, small talk, friendly questions, lead-ins around the summary).
   * Absent: the plain deterministic text is used, exactly as before. It can never change a figure or a status.
   */
  conversation?: ConversationPresenter | null;
  /**
   * Where the person is on the way to a working wallet, and the notification outbox that tells them when it changes. Absent:
   * the original first-contact welcome is used and nothing is announced.
   */
  onboarding?: OnboardingLifecycleService | null;
  /** Trusted funding details for the person's wallet; null while they have none. Absent: funding is not offered. */
  funding?: {
    info(userId: string): Promise<FundingInfo | null>;
    /**
     * What the wallet holds of a supported token right now (smallest units), read fresh. Used to tell whether a deposit makes an
     * open payment affordable. Absent or null: the payment is simply not mentioned.
     */
    holdings?(
      userId: string,
    ): Promise<{ symbol: string; assetId: string; amount: string }[] | null>;
  } | null;
  /**
   * The person's own home country and default currency (their choice, never guessed from a chat account). Absent: the feature is
   * off and nothing asks about a country.
   */
  profile?: {
    get(userId: string): Promise<{ country?: string; currency?: string }>;
    set(userId: string, home: { country: string; currency: string | null }): Promise<void>;
  } | null;
  /**
   * Whether money in one currency can really be converted to another here (a route exists). A conversion is only ever offered
   * when this says yes. Absent: conversions are never offered.
   */
  conversions?: { available(from: string, to: string): Promise<boolean> } | null;
  /** How long ago a payment may have last moved and still be offered back after a deposit. Default one hour. */
  resumeWindowMs?: number;
  /** Whether symbols alone may tie an open payment's token to a held one (test networks only; see funding announcements). */
  matchBySymbol?: boolean;
  /** The accounts a person has linked, so a proactive message can reach them without an inbound message. */
  linked?: Pick<IdentityRepository, "listForUser">;
  links: {
    /**
     * A secure link to the existing wallet setup page, or null when wallets are not enabled. `existingWallet` asks for the
     * link that continues a wallet that already exists (the PIN step) instead of creating one.
     */
    setupLink(userId: string, options?: { existingWallet?: boolean }): Promise<string | null>;
    /** The secure PIN page for a priced payment (the existing /authorize page). */
    authorizationLink(input: { sessionId: string; userId: string }): Promise<string>;
  };
  wallets: { hasActiveWallet(userId: string): Promise<boolean> };
  facts: PaymentFactsReader;
  log?: AgentLog;
  now?: () => Date;
  /** How long a RECEIVED event may sit before a retry may take it over. */
  staleClaimMs?: number;
  /**
   * Perceived-latency timings (see LatencyTimings). Typing is shown at once for anything that is not instant and renewed while it
   * lasts; a contextual status appears only for real work that is still unanswered after `statusAfterMs`.
   */
  activity?: Partial<LatencyTimings> | undefined;
}

export type InboundResult = "PROCESSED" | "DUPLICATE" | "IN_PROGRESS" | "IGNORED";

const HELP =
  "I can send money for you. Try “Send Daniel $20” or “Send João R$500”. I'll show you the payment, and you confirm it with your 6-digit PIN on a secure Kaada page.\n\nCommands: /cancel stops what we're doing, /help shows this.";

/** What the person wrote, for tone only: the text, or a short label for a command or a button press. */
function userMessageOf(inbound: InboundChannelMessage): string {
  const { content } = inbound;
  if (content.kind === "TEXT") return content.text;
  if (content.kind === "COMMAND") return `/${content.command.toLowerCase()}`;
  return "(pressed a button)";
}

/** A message that is exactly six digits looks like a PIN. It must never be stored, interpreted or kept in the chat. */
const LOOKS_LIKE_PIN = /^\s*\d{6}\s*$/;

const PIN_WARNING =
  "That looks like a PIN. Never type your PIN here: I've removed it from this chat. You confirm payments with your PIN on the secure Kaada page I link to.\n\n(If you meant an amount, add the currency, for example “250000 NGN”.)";

/** The chat a linked account of this kind is reached through. */
const CHANNEL_OF_IDENTITY: Partial<Record<IdentityType, ChannelType>> = {
  TELEGRAM: "TELEGRAM",
  WHATSAPP: "WHATSAPP",
};

const COUNTRY_QUESTION = "Where will you mainly use Kaada?";
const ACCOUNT_READY_COUNTRY_QUESTION = `Your Kaada account is ready ✅
One last thing: where will you mainly use Kaada? This helps me choose your default currency.`;

/** Typed words that a state-aware onboarding answer may replace ("done", thanks, hello, "didn't understand"). */
function canAnswerWithOnboarding(response: AgentTurnResult["response"]): boolean {
  if (response.type === "MESSAGE") return true;
  if (response.type !== "CHAT") return false;
  return (
    response.topic === "FAREWELL" ||
    response.topic === "SMALL_TALK" ||
    response.topic === "GREETING"
  );
}

/** Wording-only presenter for when no model is configured: onboarding and funding still work, in fixed words. */
const FIXED_WORDING = new ConversationPresenter({ writer: null, flags: NO_CAPABILITIES });

const GENERIC_TROUBLE = "Something went wrong on my side. Please try again in a moment.";

/**
 * The channel-independent orchestrator between a chat adapter and the Agent Core.
 *
 *   adapter -> normalised InboundChannelMessage -> here -> identity -> Agent Core -> neutral response -> adapter
 *
 * It decides nothing about money. It maps the chat account to a Kaada user, makes the delivery idempotent, hands text, button
 * choices and commands to the Agent Core, and turns the Agent Core's channel-neutral response into a message with semantic
 * actions that any adapter can render. Nothing here is Telegram-specific, so a WhatsApp adapter reuses all of it unchanged.
 */
export class ChannelMessageService {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: ChannelMessageServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async handleInbound(message: InboundChannelMessage): Promise<InboundResult> {
    const adapter = this.deps.adapters.get(message.channel);
    if (!adapter) return "IGNORED";
    const target = { externalConversationId: message.externalConversationId };

    // Payments are only ever handled in a one-to-one chat: a group is public, and a button there could be pressed by anyone.
    if (!message.isPrivate) {
      await adapter.send(target, {
        text: "I only work in private chats. Message me directly to send money.",
      });
      return "IGNORED";
    }

    const claim = await this.deps.inboundEvents.claim({
      id: createId(),
      channel: message.channel,
      externalEventId: message.externalEventId,
      now: this.now(),
      staleMs: this.deps.staleClaimMs ?? 60_000,
    });
    if (claim === "DUPLICATE") {
      if (message.content.kind === "ACTION")
        await adapter
          .acknowledge(message)
          .catch(this.recover("channel.acknowledge_failed", undefined));
      return "DUPLICATE";
    }
    if (claim === "IN_PROGRESS") return "IN_PROGRESS";

    // From here the message is ours (a duplicate delivery never gets this far), so the person sees Kaada is on it right away.
    const activity = beginActivity({
      adapter,
      message,
      timings: this.deps.activity,
      quiet: message.content.kind === "TEXT" && LOOKS_LIKE_PIN.test(message.content.text),
    });
    try {
      await this.process(adapter, message, activity);
    } catch (error) {
      // Let the provider's retry be processed (the agent turn itself is idempotent by message id).
      await this.deps.inboundEvents.release(message.channel, message.externalEventId);
      this.log("error", "channel.inbound.failed", {
        channel: message.channel,
        ...errorDetails(error),
      });
      throw error;
    } finally {
      await activity.end();
    }
    await this.deps.inboundEvents.markProcessed(
      message.channel,
      message.externalEventId,
      this.now(),
    );
    return "PROCESSED";
  }

  // ───────────────────────────────── processing ─────────────────────────────────

  private async process(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    activity: Activity,
  ): Promise<void> {
    const target = { externalConversationId: message.externalConversationId };
    const { content } = message;

    if (content.kind === "ACTION")
      await adapter
        .acknowledge(message)
        .catch(this.recover("channel.acknowledge_failed", undefined));

    const { userId, created } = await this.deps.identities.resolve(message.sender);

    if (
      this.deps.onboarding &&
      (created || (content.kind === "COMMAND" && content.command === "START"))
    ) {
      await this.deps.onboarding.track(userId);
    }

    if (content.kind === "COMMAND" && content.command === "START") {
      if (this.deps.onboarding) {
        await this.startReply(adapter, message, userId);
      } else {
        await adapter.send(target, await this.welcome(userId));
        // Without onboarding tracking, an active wallet is the only sign that secure setup is done.
        if (await this.deps.wallets.hasActiveWallet(userId)) {
          await this.offerCountryIfNeeded(adapter, message, userId);
        }
      }
      return;
    }
    if (
      content.kind === "COMMAND" &&
      (await this.handleCommand(adapter, message, userId, content.command))
    ) {
      return;
    }

    if (content.kind === "TEXT" && LOOKS_LIKE_PIN.test(content.text)) {
      // Never stored, never interpreted, never left in the chat.
      await adapter
        .remove?.(target, message.externalMessageId)
        .catch(this.recover("channel.pin_message_removal_failed", undefined));
      await adapter.send(target, { text: PIN_WARNING });
      return;
    }

    if (!this.deps.agent) {
      await adapter.send(target, {
        text: "I can't take requests yet. Please try again later.",
      });
      return;
    }

    const base = {
      userId,
      channel: message.channel,
      externalConversationId: message.externalConversationId,
    };

    let turn: AgentTurnResult | null = null;
    try {
      if (content.kind === "TEXT") {
        turn = await this.deps.agent.handle({
          kind: "TEXT",
          ...base,
          content: content.text,
          externalMessageId: message.externalMessageId,
        });
      } else if (content.kind === "COMMAND") {
        turn = await this.deps.agent.handle({
          kind: "COMMAND",
          ...base,
          command:
            content.command === "BALANCE"
              ? "SHOW_BALANCE"
              : content.command === "RATES"
                ? "ASK_RATE_PAIR"
                : "CANCEL_ACTIVE_INTENT",
          externalMessageId: `cmd:${message.externalEventId}`,
        });
      } else {
        turn = await this.handleAction(adapter, message, userId, content.handle, base, activity);
        if (!turn) return;
      }
    } catch (error) {
      if (error instanceof ConversationAccessError) {
        await adapter.send(target, { text: GENERIC_TROUBLE });
        return;
      }
      throw error;
    }

    // The work is done: take any temporary status away BEFORE the answer is shown (typing carries on while it is worded).
    await activity.clearStatus();

    // A turn the agent already answered is still delivered. A redelivery of a PROCESSED update never gets this far (the
    // channel claim answers DUPLICATE first), so reaching here means an earlier attempt stored the answer but failed to send
    // it. Skipping would drop the person's reply for good; at worst this repeats a message after a crash.
    // "How do I fund my account?" is answered with the wallet's real funding details (or, mid-setup, the next setup step).
    if (turn.response.type === "CHAT" && turn.response.topic === "FUNDING") {
      await this.fundWallet(adapter, message, userId);
      return;
    }
    // "What do you support?" / "Can I receive CELO?" is answered from the wallet's real details, never from model wording.
    if (turn.response.type === "CHAT" && turn.response.topic === "SUPPORTED_ASSETS") {
      await this.sendSupportedAssets(adapter, message, userId);
      return;
    }
    if (await this.answerFromOnboardingState(adapter, message, userId, turn)) return;
    await this.deliver(adapter, message, userId, turn, activity);
  }

  // ───────────────────────────────── onboarding awareness ─────────────────────────────────

  /**
   * /start for someone the application already knows. What they are told comes from their CURRENT state: a returning person is
   * welcomed back (no setup prompt), someone mid-setup is taken to the exact step they stopped at, and only a person with no
   * wallet gets the setup link. Any announcement that was waiting is moot (this message says where things stand), so it is
   * settled here and cannot arrive a moment later as a duplicate.
   */
  private async startReply(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
  ): Promise<void> {
    const onboarding = this.deps.onboarding;
    if (!onboarding) return;
    await onboarding.observe(userId);
    const claimed = await onboarding.claimAnnouncements(userId);
    const state = await onboarding.stateOf(userId);
    try {
      await this.sendOnboardingStep(adapter, message, userId, state.step, {
        context: "RESUMING",
        complete: "RETURNING_USER",
        instant: true,
        userMessage: userMessageOf(message),
        seed: message.externalEventId,
        firstName: message.sender.displayName?.split(" ")[0],
        facts: state.facts,
      });
    } catch (error) {
      await onboarding.release(claimed.flatMap((a) => a.ids));
      throw error;
    }
    for (const announcement of claimed) await onboarding.markDelivered(announcement.ids);
  }

  /**
   * "Done", "thanks", "hello" or a message the interpreter could not place, from someone who is still setting up (or who has
   * just finished): the answer is the person's real onboarding state, never a guess from the word. The same announcement the
   * background delivery would send is claimed first, so the two paths cannot both speak: whichever claims it tells the person.
   */
  private async answerFromOnboardingState(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    turn: AgentTurnResult,
  ): Promise<boolean> {
    const onboarding = this.deps.onboarding;
    if (!onboarding || message.content.kind !== "TEXT" || !canAnswerWithOnboarding(turn.response)) {
      return false;
    }
    if (!(await onboarding.isTracked(userId))) return false;

    await onboarding.observe(userId);
    const state = await onboarding.stateOf(userId);
    const claimed = (await onboarding.claimAnnouncements(userId)).filter(
      (a) => a.userId === userId,
    );
    const ids = claimed.flatMap((a) => a.ids);

    if (state.step === "COMPLETE" && claimed.length === 0) return false; // nothing new to say: an ordinary reply
    if (state.step !== "COMPLETE" && claimed.length === 0) {
      // The background delivery already holds the news for this person and is sending it now: stay quiet rather than repeat it.
      if (await onboarding.hasAnnouncementInFlight(userId)) return true;
      // Or it has already arrived since the person typed: it answers them, so answering again would repeat it.
      if (await onboarding.announcedSince(userId, message.timestamp)) return true;
    }
    try {
      await this.sendOnboardingStep(adapter, message, userId, state.step, {
        context: "CHECK_IN",
        complete: "ONBOARDING_COMPLETE",
        userMessage: userMessageOf(message),
        seed: turn.messageId,
        firstName: message.sender.displayName?.split(" ")[0],
        facts: state.facts,
      });
    } catch (error) {
      await onboarding.release(ids);
      throw error;
    }
    await onboarding.markDelivered(ids);
    return true;
  }

  private async sendOnboardingStep(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    step: OnboardingStep,
    options: {
      context: "JUST_CREATED" | "RESUMING" | "CHECK_IN";
      complete: "ONBOARDING_COMPLETE" | "RETURNING_USER";
      /** Fixed wording, never a model call (the first impression must not wait on one). */
      instant?: boolean;
      userMessage: string;
      seed: string;
      firstName: string | undefined;
      facts: OnboardingFacts;
    },
  ): Promise<void> {
    // Setup is finished but the country is not chosen yet: this is the only point to ask. Nothing is asked before this point.
    if (step === "COMPLETE" && (await this.countryMissing(userId))) {
      await this.sendCountryPrompt(adapter, message, userId, ACCOUNT_READY_COUNTRY_QUESTION);
      return;
    }
    const presented = await this.presentOnboardingStep(step, options);
    if (step === "WALLET" && presented.link && !(await this.deps.links.setupLink(userId))) {
      // Wallet setup is not switched on here: say so rather than offering a button that does nothing.
      await adapter.send(
        { externalConversationId: message.externalConversationId },
        { text: "Welcome to Kaada. Wallet setup isn't available yet, please check back soon." },
      );
      return;
    }
    const outbound = await this.compose(
      { channel: message.channel, externalUserId: message.sender.externalUserId },
      userId,
      createId(),
      presented,
    );
    await adapter.send({ externalConversationId: message.externalConversationId }, outbound);
  }

  private presentOnboardingStep(
    step: OnboardingStep,
    options: {
      context: "JUST_CREATED" | "RESUMING" | "CHECK_IN";
      complete: "ONBOARDING_COMPLETE" | "RETURNING_USER";
      instant?: boolean;
      userMessage: string;
      seed: string;
      firstName: string | undefined;
      facts: OnboardingFacts;
    },
  ): Promise<PresentedMessage> {
    const presenter = this.deps.conversation ?? FIXED_WORDING;
    return presenter.presentOnboarding({
      state:
        step === "WALLET"
          ? "ONBOARDING_WALLET_NEEDED"
          : step === "PIN"
            ? "ONBOARDING_PIN_NEEDED"
            : step === "RECOVERY"
              ? "ONBOARDING_RECOVERY_NEEDED"
              : options.complete,
      context: options.context,
      facts: options.facts,
      userMessage: options.userMessage,
      history: [],
      seed: options.seed,
      firstName: options.firstName,
      ...(options.instant && { instant: true }),
    });
  }

  /**
   * Tells a person, on every chat they have linked, that their setup moved on. Called by the notification dispatcher, never from
   * an inbound message. The words come from their CURRENT state, so this can never contradict what an inbound "Done" says.
   */
  async announceOnboarding(
    announcement: Announcement,
  ): Promise<{ delivered: number; failed: number }> {
    const result = { delivered: 0, failed: 0 };
    const { userId, state } = announcement;
    if (state.step === "WALLET") return result; // nothing the person could act on yet
    const askCountry = state.step === "COMPLETE" && (await this.countryMissing(userId));
    const accounts = (await this.deps.linked?.listForUser(userId)) ?? [];
    for (const account of accounts) {
      const channel = CHANNEL_OF_IDENTITY[account.type];
      const adapter = channel ? this.deps.adapters.get(channel) : undefined;
      if (!channel || !adapter) continue;
      try {
        const presented: PresentedMessage = askCountry
          ? { text: ACCOUNT_READY_COUNTRY_QUESTION, countryChoice: true }
          : await this.presentOnboardingStep(state.step, {
              context: "JUST_CREATED",
              complete: "ONBOARDING_COMPLETE",
              userMessage: "",
              seed: announcement.ids[0] ?? userId,
              firstName: undefined,
              facts: state.facts,
            });
        const outbound = await this.compose(
          { channel, externalUserId: account.externalId },
          userId,
          announcement.ids[0] ?? userId,
          presented,
        );
        // In a one-to-one chat the provider's account id is also the chat id.
        await adapter.send({ externalConversationId: account.externalId }, outbound);
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        this.log("warn", "onboarding.announce_failed", { channel, ...errorDetails(error) });
      }
    }
    return result;
  }

  /**
   * Tells a person their wallet just received supported tokens, on every chat they have linked. The wording is fixed and built
   * from the stored event (never a model). If a payment is still open and recent AND this deposit is what makes it affordable,
   * it is offered back with Continue and Cancel: nothing is executed, and the person still authorizes normally. A payment older
   * than the progress window is not brought back; the person just gets the plain message.
   */
  async announceFunding(event: WalletFundingEvent): Promise<{ delivered: number; failed: number }> {
    const result = { delivered: 0, failed: 0 };
    const accounts = (await this.deps.linked?.listForUser(event.userId)) ?? [];
    const received = event.items.map((item) => describeMoney(item, item.delta));
    const list =
      received.length <= 1
        ? (received[0] ?? "funds")
        : `${received.slice(0, -1).join(", ")} and ${received[received.length - 1] ?? ""}`;
    const home = await this.deps.profile
      ?.get(event.userId)
      .catch(this.recover("profile.read_failed", undefined));
    for (const account of accounts) {
      const channel = CHANNEL_OF_IDENTITY[account.type];
      const adapter = channel ? this.deps.adapters.get(channel) : undefined;
      if (!channel || !adapter) continue;
      try {
        const resume = await this.paymentFundedBy(event, channel, account.externalId);
        const presented: PresentedMessage = resume
          ? {
              text: `Your ${resume.token} just arrived 💰

You now have enough to continue your payment${resume.recipient ? ` to ${resume.recipient}` : ""}.`,
              resume: { intentId: resume.intentId, revision: resume.revision },
              cancellable: true,
            }
          : await this.receivedMessage(event, list, home?.currency);
        const outbound = await this.compose(
          { channel, externalUserId: account.externalId },
          event.userId,
          event.id,
          presented,
        );
        // In a one-to-one chat the provider's account id is also the chat id.
        await adapter.send({ externalConversationId: account.externalId }, outbound);
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        this.log("warn", "funding.announce_failed", { channel, ...errorDetails(error) });
      }
    }
    return result;
  }

  /**
   * What a deposit says, by what the person's home currency is.
   *  - Their own currency: just that it arrived. No conversion, no buttons.
   *  - Another currency: that it arrived, in that currency (it stays in their balance as it is, nothing is converted for them), and
   *    an offer to convert it to their own currency ONLY if a conversion route really exists, with the choice to keep it.
   *  - No home currency chosen (nobody to compare with): the plain welcome-style message.
   * The sender is not known from a balance change, so none is claimed.
   */
  private async receivedMessage(
    event: WalletFundingEvent,
    list: string,
    homeCurrency: string | undefined,
  ): Promise<PresentedMessage> {
    if (!homeCurrency) {
      return {
        text: `Nice, your wallet just received ${list} 💰

You're ready to use it.`,
        suggestions: [
          ...(this.flags().send ? (["SEND_MONEY"] as const) : []),
          ...(this.flags().balance ? (["CHECK_BALANCE"] as const) : []),
        ],
      };
    }
    const foreign = event.items.find((item) => item.fiatCode && item.fiatCode !== homeCurrency);
    const from = currencyByCode(foreign?.fiatCode);
    const to = currencyByCode(homeCurrency);
    if (!foreign || !from || !to) return { text: `You received ${list} 💰` };

    const offered = Boolean(
      await this.deps.conversions
        ?.available(from.code, to.code)
        .catch(this.recover("conversion.availability_check_failed", false)),
    );
    return {
      text: offered
        ? `You received ${list} ${from.flag}

Would you like to convert it to ${to.name}?`
        : `You received ${list} ${from.flag}

It's in your ${from.name} balance.`,
      ...(offered && {
        conversionOffer: {
          from: from.code,
          to: to.code,
          amount: plainAmount(foreign.delta, foreign.decimals),
          fromName: from.name,
          toName: to.name,
        },
      }),
    };
  }

  /** "Where will you mainly use Kaada?": a button per supported country. The answer sets the default currency. */
  private async sendCountryPrompt(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    text: string = COUNTRY_QUESTION,
  ): Promise<void> {
    const outbound = await this.compose(
      { channel: message.channel, externalUserId: message.sender.externalUserId },
      userId,
      createId(),
      { text, countryChoice: true },
    );
    await adapter.send({ externalConversationId: message.externalConversationId }, outbound);
  }

  /** Whether this person still has to say where they use Kaada. False when the feature is off or they already answered. */
  private async countryMissing(userId: string): Promise<boolean> {
    if (!this.deps.profile) return false;
    return !(await this.deps.profile.get(userId)).country;
  }

  /** A person who has not said where they use Kaada is asked after secure setup. Never guessed from their chat account. */
  private async offerCountryIfNeeded(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
  ): Promise<void> {
    if (!this.deps.profile) return;
    const home = await this.deps.profile.get(userId);
    if (home.country) return;
    await this.sendCountryPrompt(adapter, message, userId);
  }

  /** The recent open payment this deposit made affordable, if any. Read only; never starts, resumes or changes anything. */
  private async paymentFundedBy(
    event: WalletFundingEvent,
    channel: ChannelType,
    externalConversationId: string,
  ): Promise<
    { intentId: string; revision: number; recipient: string | undefined; token: string } | undefined
  > {
    const needs = await this.deps.agent?.openPaymentNeeds?.({
      userId: event.userId,
      channel,
      externalConversationId,
    });
    const required = needs?.required;
    if (!needs || !required) return undefined;
    const window = this.deps.resumeWindowMs ?? 60 * 60 * 1000;
    if (this.now().getTime() - needs.lastActiveAt.getTime() > window) return undefined;

    const sameToken = (item: { assetId: string; symbol: string }): boolean =>
      item.assetId === required.assetId ||
      (this.deps.matchBySymbol === true && item.symbol === required.symbol);
    const item = event.items.find(sameToken);
    if (!item) return undefined;
    const holdings = await this.deps.funding?.holdings?.(event.userId);
    const held = holdings?.find(sameToken);
    if (!held) return undefined;
    const need = BigInt(required.amount);
    // Affordable now, and it was this deposit that made it so (it was not before).
    if (BigInt(held.amount) < need || BigInt(item.previous) >= need) return undefined;
    return {
      intentId: needs.resume.intentId,
      revision: needs.resume.revision,
      recipient: needs.resume.recipient,
      token: describeAsset(item),
    };
  }

  /** A pressed button. Claimed atomically first, so a replay, a wrong account or an expired button does nothing. */
  private async handleAction(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    handle: string,
    base: { userId: string; channel: ChannelType; externalConversationId: string },
    activity: Activity,
  ): Promise<AgentTurnResult | null> {
    const target = { externalConversationId: message.externalConversationId };
    const claimed = await this.deps.actions.claim({
      handle,
      channel: message.channel,
      externalUserId: message.sender.externalUserId,
    });
    if (!claimed.ok) {
      const text =
        claimed.reason === "USED"
          ? "That button was already used."
          : "That button is no longer available. Tell me what you'd like to do.";
      await adapter.send(target, { text });
      return null;
    }
    const { action } = claimed;
    // Belt and braces: the button must belong to the account that pressed it, and to this person's Kaada user.
    if (action.userId !== userId) {
      await adapter.send(target, { text: "That button is no longer available." });
      return null;
    }

    // Now that the button is known: one that answers from stored state shows nothing; one that starts real work shows typing, and a
    // task-specific status if it is slow.
    activity.refine(classifyAction(action.kind, action.payload["suggestion"]));

    switch (action.kind) {
      case "SELECT_OPTION": {
        const optionId = action.payload["optionId"];
        if (!optionId) return null;
        return this.deps.agent!.handle({
          kind: "CHOICE",
          ...base,
          optionId,
          externalMessageId: `cb:${message.externalEventId}`,
        });
      }
      case "CANCEL":
        return this.deps.agent!.handle({
          kind: "COMMAND",
          ...base,
          command: "CANCEL_ACTIVE_INTENT",
          externalMessageId: `cb:${message.externalEventId}`,
        });
      case "VIEW_STATUS": {
        const sessionId = action.payload["sessionId"];
        if (!sessionId) return null;
        const progress = deriveProgress(await this.deps.facts.read(sessionId), this.now());
        await adapter.send(target, { text: describeProgress(progress) });
        return null;
      }
      case "RETRY":
        await adapter.send(target, { text: "Tell me what you'd like to send and I'll set it up." });
        return null;
      case "CONTINUE_PAYMENT": {
        const intentId = action.payload["intentId"];
        if (!intentId) return null;
        // Deterministic: no interpretation. The agent restates the stored payment, or says it is no longer open.
        return this.deps.agent!.handle({
          kind: "COMMAND",
          ...base,
          command: "CONTINUE_PAYMENT",
          resumeIntentId: intentId,
          externalMessageId: `cb:${message.externalEventId}`,
        });
      }
      case "SET_COUNTRY": {
        const home = homeFor(action.payload["country"] ?? "");
        if (!home || !this.deps.profile) {
          await adapter.send(target, { text: "That choice isn't available." });
          return null;
        }
        const firstChoice = !(await this.deps.profile.get(userId)).country;
        await this.deps.profile.set(userId, home);
        // The first things to do with an account, offered once, when the first default currency is settled. Not when someone
        // changes their mind later, picks Other (no currency), or presses a stale button again.
        const outbound = await this.compose(
          { channel: message.channel, externalUserId: message.sender.externalUserId },
          userId,
          createId(),
          {
            text: describeHome(home),
            ...(firstChoice &&
              home.currency && {
                suggestions: suggestionPolicy("ONBOARDING_COMPLETE", this.flags()),
              }),
          },
        );
        await adapter.send(target, outbound);
        return null;
      }
      case "KEEP_CURRENCY": {
        // Nothing to do: the balance stays as it is, in its own currency, and shows in the balance view.
        const name = action.payload["name"];
        await adapter.send(target, {
          text: name ? `Okay, I'll keep that in ${name}.` : "Okay, I'll keep it as it is.",
        });
        return null;
      }
      case "CONVERT_CURRENCY": {
        const { from, to, amount } = action.payload;
        if (!from || !to || !amount) return null;
        // The normal path from here: priced by the routing layer, summarised, and authorized like any payment.
        return this.deps.agent!.handle({
          kind: "COMMAND",
          ...base,
          command: "CONVERT_CURRENCY",
          conversion: { from, to, amount },
          externalMessageId: `cb:${message.externalEventId}`,
        });
      }
      case "SUGGESTION": {
        const id = action.payload["suggestion"];
        if (!id || !isSuggestionId(id)) return null;
        if (
          id === "FUND_WALLET" ||
          id === "FUND_FROM_WALLET" ||
          id === "VIEW_WALLET_ADDRESS" ||
          id === "FUND_CELO" ||
          id === "FUND_LOCAL_CURRENCY"
        ) {
          await this.handleFunding(adapter, message, userId, id);
          return null;
        }
        // No model is involved in a button press: a balance is read by the Agent Core, the rest are fixed prompts.
        if (id === "CHECK_BALANCE") {
          return this.deps.agent!.handle({
            kind: "COMMAND",
            ...base,
            command: "SHOW_BALANCE",
            externalMessageId: `cb:${message.externalEventId}`,
          });
        }
        if (id === "CHECK_RATE") {
          // The Agent Core asks which pair and remembers the question: the next message is read as the answer to it.
          return this.deps.agent!.handle({
            kind: "COMMAND",
            ...base,
            command: "ASK_RATE_PAIR",
            externalMessageId: `cb:${message.externalEventId}`,
          });
        }
        await adapter.send(target, {
          text: pick(message.externalEventId, [
            "Sure 👍 Who are we sending to, and how much? For example “Send Daniel $20”.",
            "Okay! Tell me who it's for and how much, like “Send Daniel $20”.",
          ]),
        });
        return null;
      }
    }
  }

  /**
   * For a step whose failure must not fail the message (a courtesy, a read that has a safe default): the failure is logged with
   * its reason, and the safe default is used.
   */
  private recover<T>(event: string, fallback: T): (error: unknown) => T {
    return (error) => {
      this.log("warn", event, { ...errorDetails(error) });
      return fallback;
    };
  }

  /** The channel's flags (what Kaada really offers here). */
  private flags(): CapabilityFlags {
    return (this.deps.conversation ?? FIXED_WORDING).flags;
  }

  /**
   * Slash commands: shortcuts to things people can also say in words. Each resolves to the same channel-neutral action as its
   * button or its sentence. Returns true when handled here; /cancel and /balance continue to the Agent Core.
   */
  private async handleCommand(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    command: ChannelCommand,
  ): Promise<boolean> {
    const target = { externalConversationId: message.externalConversationId };
    switch (command) {
      case "HELP":
        await adapter.send(target, {
          text: this.deps.conversation ? helpText(this.flags()) : HELP,
        });
        return true;
      case "FUND":
        await this.fundWallet(adapter, message, userId);
        return true;
      case "WALLET":
        await this.sendWalletDetails(adapter, message, userId, "ADDRESS");
        return true;
      case "COUNTRY":
        if (!this.deps.profile) return false;
        await this.sendCountryPrompt(adapter, message, userId);
        return true;
      case "RATES":
        // Available: the Agent Core asks which pair (and remembers it asked), so the answer is read as a pair.
        if (this.flags().rates) return false;
        await adapter.send(target, { text: "Rates aren't available right now." });
        return true;
      default:
        return false;
    }
  }

  /**
   * "Fund wallet": the funding choices that really exist. With a single way (a transfer from another wallet) there is nothing to
   * choose, so the instructions are shown straight away; a menu appears only when there is a real choice.
   */
  private async fundWallet(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
  ): Promise<void> {
    const target = { externalConversationId: message.externalConversationId };
    const presenter = this.deps.conversation ?? FIXED_WORDING;
    const choices = availableFundingMethods(presenter.flags).filter((method) => method.choice);
    if (choices.length === 0) {
      await adapter.send(target, { text: FUNDING_NONE });
      return;
    }
    if (choices.length === 1 && choices[0]?.id === "FUND_FROM_WALLET") {
      await this.sendWalletDetails(adapter, message, userId, "INSTRUCTIONS");
      return;
    }
    await adapter.send(
      target,
      await this.compose(
        { channel: message.channel, externalUserId: message.sender.externalUserId },
        userId,
        createId(),
        presenter.presentFundingOptions(message.externalEventId),
      ),
    );
  }

  /**
   * The wallet's address and how to fund it. Every value (address, network, tokens) is trusted application state and the wording
   * is fixed: no model writes any of it. The address is shown monospace with a copy button where the channel has one. If a
   * payment is open, Continue is offered so the person can come back to it once the funds have arrived.
   */
  private async sendWalletDetails(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    kind: "INSTRUCTIONS" | "ADDRESS" | "NETWORK_FEE",
  ): Promise<void> {
    const target = { externalConversationId: message.externalConversationId };
    const info = (await this.deps.funding?.info(userId)) ?? null;
    if (!info) {
      const state = await this.deps.onboarding?.stateOf(userId);
      if (state && state.step !== "COMPLETE") {
        await this.sendOnboardingStep(adapter, message, userId, state.step, {
          context: "CHECK_IN",
          complete: "ONBOARDING_COMPLETE",
          userMessage: userMessageOf(message),
          seed: message.externalEventId,
          firstName: message.sender.displayName?.split(" ")[0],
          facts: state.facts,
        });
        return;
      }
      await adapter.send(target, { text: FUNDING_NOT_READY });
      return;
    }
    const resume =
      kind === "INSTRUCTIONS"
        ? await this.deps.agent
            ?.openPaymentResume?.({
              userId,
              channel: message.channel,
              externalConversationId: message.externalConversationId,
            })
            .catch(this.recover("payment.resume_lookup_failed", undefined))
        : undefined;
    const presented: PresentedMessage = {
      text:
        kind === "ADDRESS"
          ? walletAddressMessage(info)
          : kind === "NETWORK_FEE"
            ? networkFeeFundingMessage(info)
            : `${fundingInstructions(info)}${resume ? "\n\nWhen the funds arrive, tap Continue and I'll check your payment again." : ""}`,
      code: [info.address],
      copy: { label: "📋 Copy address", text: info.address },
      ...(this.flags().balance && { suggestions: ["CHECK_BALANCE" as const] }),
      ...(resume && { resume: { intentId: resume.intentId, revision: resume.revision } }),
    };
    await adapter.send(
      target,
      await this.compose(
        { channel: message.channel, externalUserId: message.sender.externalUserId },
        userId,
        createId(),
        presented,
      ),
    );
  }

  private async sendSupportedAssets(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
  ): Promise<void> {
    const info = (await this.deps.funding?.info(userId)) ?? null;
    if (!info) {
      // No wallet yet (or funding is off): the setup step, or the plain "not ready" answer, is the useful reply.
      await this.sendWalletDetails(adapter, message, userId, "INSTRUCTIONS");
      return;
    }
    const canFund = availableFundingMethods(this.flags()).length > 0;
    await adapter.send(
      { externalConversationId: message.externalConversationId },
      await this.compose(
        { channel: message.channel, externalUserId: message.sender.externalUserId },
        userId,
        createId(),
        {
          text: supportedAssetsMessage(info),
          ...(canFund && { suggestions: ["FUND_WALLET" as const] }),
        },
      ),
    );
  }

  /** Funding buttons. Only methods the capability registry says exist are ever answered; the details come from trusted state. */
  private async handleFunding(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    id:
      | "FUND_WALLET"
      | "FUND_FROM_WALLET"
      | "VIEW_WALLET_ADDRESS"
      | "FUND_CELO"
      | "FUND_LOCAL_CURRENCY",
  ): Promise<void> {
    if (id === "FUND_WALLET") {
      await this.fundWallet(adapter, message, userId);
      return;
    }
    const offered = availableFundingMethods(this.flags()).some((method) => method.id === id);
    if (!offered || id === "FUND_LOCAL_CURRENCY") {
      await adapter.send(
        { externalConversationId: message.externalConversationId },
        { text: FUNDING_UNAVAILABLE },
      );
      return;
    }
    await this.sendWalletDetails(
      adapter,
      message,
      userId,
      id === "VIEW_WALLET_ADDRESS"
        ? "ADDRESS"
        : id === "FUND_CELO"
          ? "NETWORK_FEE"
          : "INSTRUCTIONS",
    );
  }

  /** Renders an agent turn as a neutral message (with stored actions and secure links) and sends it. */
  private async deliver(
    adapter: ChannelAdapter,
    inbound: InboundChannelMessage,
    userId: string,
    turn: AgentTurnResult,
    activity: Activity,
  ): Promise<void> {
    const presented = await this.present(adapter, inbound, userId, turn, activity);
    const outbound = await this.compose(
      { channel: inbound.channel, externalUserId: inbound.sender.externalUserId },
      userId,
      turn.conversationId,
      presented,
    );
    const sent = await adapter.send(
      { externalConversationId: inbound.externalConversationId },
      outbound,
    );
    if (presented.authorization) {
      await this.deps.statuses.create({
        id: createId(),
        userId,
        channel: inbound.channel,
        externalConversationId: inbound.externalConversationId,
        authorizationSessionId: presented.authorization.sessionId,
        externalSummaryMessageId: sent.externalMessageId,
        lastState: "AWAITING_AUTHORIZATION",
        terminal: false,
      });
    }
  }

  /** The conversational presentation of a turn; any failure there falls back to the plain deterministic text. */
  private async present(
    adapter: ChannelAdapter,
    inbound: InboundChannelMessage,
    userId: string,
    turn: AgentTurnResult,
    activity: Activity,
  ): Promise<PresentedMessage> {
    const plain = presentAgentResponse(turn.response, this.now());
    const presenter = this.deps.conversation;
    if (!presenter) return plain;
    // Conversational wording may be shown as it is written, where the channel can; facts never are (the presenter decides).
    const draft =
      adapter.openDraft?.({ externalConversationId: inbound.externalConversationId }) ?? null;
    try {
      const history =
        (await this.deps.agent?.recentTurns?.(turn.conversationId, turn.messageId)) ?? [];
      // The conversation knows where setup stands (a trusted fact), so until it is complete nothing that needs a wallet and a
      // PIN is suggested or described as available, whatever the person said earlier.
      const onboardingStep = await this.deps.onboarding
        ?.stateOf(userId)
        .then((state) => state.step)
        .catch(this.recover("onboarding.state_read_failed", undefined));
      return await presenter.present({
        onboardingStep,
        response: turn.response,
        corrected: turn.corrected,
        resume: turn.resume,
        userMessage: userMessageOf(inbound),
        history,
        seed: turn.messageId,
        firstName: inbound.sender.displayName?.split(" ")[0],
        now: this.now(),
        ...(draft && {
          draft: {
            push: (text: string) => {
              activity.markStreaming();
              draft.update(text);
            },
          },
        }),
      });
    } catch (error) {
      this.log("warn", "channel.presentation.failed", { ...errorDetails(error) });
      return plain;
    } finally {
      // Whatever happened, no half-written draft keeps updating after the reply is decided.
      await draft?.close().catch(this.recover("channel.draft_close_failed", undefined));
    }
  }

  private async compose(
    inbound: { channel: ChannelType; externalUserId: string },
    userId: string,
    conversationId: string,
    presented: PresentedMessage,
  ): Promise<OutboundChannelMessage> {
    const actions: OutboundAction[] = [];
    const issue = (
      kind:
        | "SELECT_OPTION"
        | "CANCEL"
        | "SUGGESTION"
        | "CONTINUE_PAYMENT"
        | "SET_COUNTRY"
        | "CONVERT_CURRENCY"
        | "KEEP_CURRENCY",
      payload?: Record<string, string>,
      reusable = false,
    ) =>
      this.deps.actions.issue({
        userId,
        channel: inbound.channel,
        externalUserId: inbound.externalUserId,
        conversationId,
        kind,
        ...(payload && { payload }),
        ...(reusable && { reusable }),
      });

    for (const choice of presented.choices ?? []) {
      actions.push({
        type: "ACTION",
        semantic: "SELECT_OPTION",
        label: choice.label,
        ...(choice.description && { description: choice.description }),
        handle: await issue("SELECT_OPTION", { optionId: choice.optionId }),
      });
    }

    if (presented.authorization) {
      // The secure page issues its own single-use, short-lived link; the PIN is entered there and never here.
      const url = await this.deps.links.authorizationLink({
        sessionId: presented.authorization.sessionId,
        userId,
      });
      actions.push({
        type: "OPEN_URL",
        semantic: "OPEN_AUTHORIZATION",
        label: "Authorize payment",
        url,
      });
    }

    if (presented.link) {
      const url = await this.deps.links.setupLink(userId, {
        existingWallet: presented.link.kind === "PIN_SETUP",
      });
      if (url) {
        actions.push({
          type: "OPEN_URL",
          semantic: "OPEN_SETUP",
          label: presented.link.label,
          url,
        });
      }
    }

    if (presented.setup) {
      const url = await this.deps.links.setupLink(userId);
      if (url)
        actions.push({ type: "OPEN_URL", semantic: "OPEN_SETUP", label: "Set up Kaada", url });
    }

    // A payment is still open behind a side answer: Continue resumes exactly that payment from stored state.
    if (presented.resume) {
      actions.push({
        type: "ACTION",
        semantic: "CONTINUE_PAYMENT",
        label: "▶️ Continue",
        handle: await issue("CONTINUE_PAYMENT", {
          intentId: presented.resume.intentId,
          revision: String(presented.resume.revision),
        }),
      });
    }

    // Where the person mainly uses Kaada: one button per supported country, and Other.
    if (presented.countryChoice) {
      for (const country of HOME_COUNTRIES) {
        actions.push({
          type: "ACTION",
          semantic: "SET_COUNTRY",
          label: `${country.flag} ${country.name}`,
          handle: await issue("SET_COUNTRY", { country: country.code }),
        });
      }
      actions.push({
        type: "ACTION",
        semantic: "SET_COUNTRY",
        label: "🌍 Other",
        handle: await issue("SET_COUNTRY", { country: OTHER_COUNTRY }),
      });
    }

    // Money that arrived in another currency, with a conversion that really exists: convert it, or keep it as it is.
    if (presented.conversionOffer) {
      const offer = presented.conversionOffer;
      actions.push({
        type: "ACTION",
        semantic: "CONVERT_CURRENCY",
        label: `🔄 Convert to ${offer.toName}`,
        handle: await issue("CONVERT_CURRENCY", {
          from: offer.from,
          to: offer.to,
          amount: offer.amount,
        }),
      });
      actions.push({
        type: "ACTION",
        semantic: "KEEP_CURRENCY",
        label: `Keep as ${offer.fromName}`,
        handle: await issue("KEEP_CURRENCY", { from: offer.from, name: offer.fromName }),
      });
    }

    // Suggestions are buttons beside the conversation, never a replacement for typing. Each is server-bound like any button.
    for (const id of presented.suggestions ?? []) {
      actions.push({
        type: "ACTION",
        semantic: "SUGGESTION",
        label: labelOf(id),
        handle: await issue("SUGGESTION", { suggestion: id }, true),
      });
    }

    if (presented.cancellable) {
      actions.push({
        type: "ACTION",
        semantic: "CANCEL",
        label: "❌ Cancel",
        handle: await issue("CANCEL"),
      });
    }
    // A copy button (an address), placed before the suggestions so the most useful thing is first.
    if (presented.copy) {
      actions.unshift({
        type: "COPY_TEXT",
        label: presented.copy.label,
        text: presented.copy.text,
      });
    }
    return {
      text: presented.text,
      ...(presented.code && { code: presented.code }),
      ...(actions.length > 0 && { actions }),
    };
  }

  private async welcome(userId: string): Promise<OutboundChannelMessage> {
    if (await this.deps.wallets.hasActiveWallet(userId)) {
      return { text: `Welcome back to Kaada.\n\n${HELP}` };
    }
    const url = await this.deps.links.setupLink(userId);
    if (!url) {
      return {
        text: "Welcome to Kaada. Wallet setup isn't available yet, please check back soon.",
      };
    }
    return {
      text: "Welcome to Kaada! I send money across borders for you, from this chat.\n\nFirst, set up your wallet. It takes a minute and happens on a secure Kaada page: your keys and PIN never go through this chat.",
      actions: [{ type: "OPEN_URL", semantic: "OPEN_SETUP", label: "Set up Kaada", url }],
    };
  }
}
