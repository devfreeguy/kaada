import { createId } from "@kaada/domain";
import type {
  ChannelInboundEventRepository,
  ChannelPaymentStatusRepository,
  ChannelType,
  ConversationTurn,
  IdentityRepository,
  IdentityType,
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
import { ConversationPresenter } from "../conversation/presenter.js";
import { pick } from "../conversation/fallbacks.js";
import {
  FUNDING_NOT_READY,
  FUNDING_UNAVAILABLE,
  fundingInstructions,
  walletAddressMessage,
} from "../conversation/funding.js";
import type { FundingInfo } from "../conversation/funding.js";
import type { OnboardingLifecycleService, Announcement } from "../onboarding/lifecycle-service.js";
import type { OnboardingFacts, OnboardingStep } from "../onboarding/state.js";
import type { ChannelActionService } from "./action-service.js";
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
  funding?: { info(userId: string): Promise<FundingInfo | null> } | null;
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
        await adapter.acknowledge(message).catch(() => undefined);
      return "DUPLICATE";
    }
    if (claim === "IN_PROGRESS") return "IN_PROGRESS";

    try {
      await this.process(adapter, message);
    } catch (error) {
      // Let the provider's retry be processed (the agent turn itself is idempotent by message id).
      await this.deps.inboundEvents.release(message.channel, message.externalEventId);
      this.log("error", "channel.inbound.failed", {
        channel: message.channel,
        ...errorDetails(error),
      });
      throw error;
    }
    await this.deps.inboundEvents.markProcessed(
      message.channel,
      message.externalEventId,
      this.now(),
    );
    return "PROCESSED";
  }

  // ───────────────────────────────── processing ─────────────────────────────────

  private async process(adapter: ChannelAdapter, message: InboundChannelMessage): Promise<void> {
    const target = { externalConversationId: message.externalConversationId };
    const { content } = message;

    if (content.kind === "ACTION") await adapter.acknowledge(message).catch(() => undefined);

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
      }
      return;
    }
    if (content.kind === "COMMAND" && content.command === "HELP") {
      await adapter.send(target, { text: HELP });
      return;
    }

    if (content.kind === "TEXT" && LOOKS_LIKE_PIN.test(content.text)) {
      // Never stored, never interpreted, never left in the chat.
      await adapter.remove?.(target, message.externalMessageId).catch(() => undefined);
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
        await adapter.indicateTyping?.(target).catch(() => undefined);
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
          command: "CANCEL_ACTIVE_INTENT",
          externalMessageId: `cmd:${message.externalEventId}`,
        });
      } else {
        turn = await this.handleAction(adapter, message, userId, content.handle, base);
        if (!turn) return;
      }
    } catch (error) {
      if (error instanceof ConversationAccessError) {
        await adapter.send(target, { text: GENERIC_TROUBLE });
        return;
      }
      throw error;
    }

    // A turn the agent already answered is still delivered. A redelivery of a PROCESSED update never gets this far (the
    // channel claim answers DUPLICATE first), so reaching here means an earlier attempt stored the answer but failed to send
    // it. Skipping would drop the person's reply for good; at worst this repeats a message after a crash.
    if (await this.answerFromOnboardingState(adapter, message, userId, turn)) return;
    await this.deliver(adapter, message, userId, turn);
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
      userMessage: string;
      seed: string;
      firstName: string | undefined;
      facts: OnboardingFacts;
    },
  ): Promise<void> {
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
    const accounts = (await this.deps.linked?.listForUser(userId)) ?? [];
    for (const account of accounts) {
      const channel = CHANNEL_OF_IDENTITY[account.type];
      const adapter = channel ? this.deps.adapters.get(channel) : undefined;
      if (!channel || !adapter) continue;
      try {
        const presented = await this.presentOnboardingStep(state.step, {
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

  /** A pressed button. Claimed atomically first, so a replay, a wrong account or an expired button does nothing. */
  private async handleAction(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    handle: string,
    base: { userId: string; channel: ChannelType; externalConversationId: string },
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
      case "SUGGESTION": {
        const id = action.payload["suggestion"];
        if (!id || !isSuggestionId(id)) return null;
        if (
          id === "FUND_WALLET" ||
          id === "FUND_FROM_WALLET" ||
          id === "VIEW_WALLET_ADDRESS" ||
          id === "FUND_LOCAL_CURRENCY"
        ) {
          await this.handleFunding(adapter, message, userId, id, action.conversationId);
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
        await adapter.send(target, {
          text:
            id === "SEND_MONEY"
              ? pick(message.externalEventId, [
                  "Sure 👍 Who are we sending to, and how much? For example “Send Daniel $20”.",
                  "Okay! Tell me who it's for and how much, like “Send Daniel $20”.",
                ])
              : pick(message.externalEventId, [
                  "Which rate should I check? Tell me the pair, like “USDT to cNGN”.",
                  "Sure, which pair? For example “USDT to cNGN”.",
                ]),
        });
        return null;
      }
    }
  }

  /** Funding buttons. Only methods the capability registry says exist are ever answered; the details come from trusted state. */
  private async handleFunding(
    adapter: ChannelAdapter,
    message: InboundChannelMessage,
    userId: string,
    id: "FUND_WALLET" | "FUND_FROM_WALLET" | "VIEW_WALLET_ADDRESS" | "FUND_LOCAL_CURRENCY",
    conversationId: string,
  ): Promise<void> {
    const target = { externalConversationId: message.externalConversationId };
    const presenter = this.deps.conversation ?? FIXED_WORDING;
    if (id === "FUND_WALLET") {
      const presented = presenter.presentFundingOptions(message.externalEventId);
      await adapter.send(
        target,
        await this.compose(
          { channel: message.channel, externalUserId: message.sender.externalUserId },
          userId,
          conversationId,
          presented,
        ),
      );
      return;
    }
    const offered = availableFundingMethods(presenter.flags).some((method) => method.id === id);
    if (!offered) {
      await adapter.send(target, { text: FUNDING_UNAVAILABLE });
      return;
    }
    const info = (await this.deps.funding?.info(userId)) ?? null;
    if (!info) {
      await adapter.send(target, { text: FUNDING_NOT_READY });
      return;
    }
    await adapter.send(target, {
      text: id === "VIEW_WALLET_ADDRESS" ? walletAddressMessage(info) : fundingInstructions(info),
    });
  }

  /** Renders an agent turn as a neutral message (with stored actions and secure links) and sends it. */
  private async deliver(
    adapter: ChannelAdapter,
    inbound: InboundChannelMessage,
    userId: string,
    turn: AgentTurnResult,
  ): Promise<void> {
    const presented = await this.present(inbound, userId, turn);
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
    inbound: InboundChannelMessage,
    userId: string,
    turn: AgentTurnResult,
  ): Promise<PresentedMessage> {
    const plain = presentAgentResponse(turn.response, this.now());
    const presenter = this.deps.conversation;
    if (!presenter) return plain;
    try {
      const history =
        (await this.deps.agent?.recentTurns?.(turn.conversationId, turn.messageId)) ?? [];
      // The conversation knows where setup stands (a trusted fact), so until it is complete nothing that needs a wallet and a
      // PIN is suggested or described as available, whatever the person said earlier.
      const onboardingStep = await this.deps.onboarding
        ?.stateOf(userId)
        .then((state) => state.step)
        .catch(() => undefined);
      return await presenter.present({
        onboardingStep,
        response: turn.response,
        corrected: turn.corrected,
        userMessage: userMessageOf(inbound),
        history,
        seed: turn.messageId,
        firstName: inbound.sender.displayName?.split(" ")[0],
        now: this.now(),
      });
    } catch (error) {
      this.log("warn", "channel.presentation.failed", { ...errorDetails(error) });
      return plain;
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
      kind: "SELECT_OPTION" | "CANCEL" | "SUGGESTION",
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
        label: "Cancel",
        handle: await issue("CANCEL"),
      });
    }
    return { text: presented.text, ...(actions.length > 0 && { actions }) };
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
