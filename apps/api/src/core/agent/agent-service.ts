import { createId, defaultCountryDirectory } from "@kaada/domain";
import type {
  JsonObject,
  ChannelType,
  Conversation,
  ConversationTurn,
  CountryDirectory,
  Interpretation,
  Message,
} from "@kaada/domain";
import { interpretationSchema } from "@kaada/schemas";

import { loadConversationContext, toHistory } from "../conversations/context.js";
import { IntentCoordinator } from "../intents/coordinator.js";
import type { Applied, ResumeTurn } from "../intents/coordinator.js";
import { composeRevisionHooks, noopOnIntentRevised } from "../intents/intent-commit.js";
import type { OnIntentRevised } from "../intents/intent-commit.js";
import {
  invalidateAuthorizationOnRevision,
  invalidateRoutesOnRevision,
} from "../routing/invalidation.js";
import type { RoutingService } from "../routing/routing-service.js";
import type { AgentResponse, ResumeInfo } from "../responses/agent-response.js";
import { responseFromStored, responseToJson } from "../responses/serialize.js";
import { ConversationAccessError } from "./errors.js";
import { InterpreterOutputError } from "./interpreter.js";
import type { IntentInterpreter } from "./interpreter.js";
import type { AgentLog, AgentRepositories, AgentUnitOfWork } from "./ports.js";
import { noopLog } from "./ports.js";
import { createDefaultResolvers } from "./resolvers.js";
import type { AgentResolvers } from "./resolvers.js";

interface IncomingBase {
  userId: string;
  channel: ChannelType;
  /** The channel's own chat id; the same chat always maps to the same conversation. */
  externalConversationId: string;
  /** The channel's own message id. When present, redelivered messages are recognised and ignored. */
  externalMessageId?: string;
}

export interface TextInput extends IncomingBase {
  kind: "TEXT";
  content: string;
}

/** The user picked one of the options of a question. The id is all the channel may send. */
export interface ChoiceInput extends IncomingBase {
  kind: "CHOICE";
  optionId: string;
}

/**
 * A conversation command from a button or a slash command ("Cancel"): deterministic, so it needs no interpreter call. It goes
 * through the same apply step as an interpreted "cancel that", so the intent history and invalidation rules are identical.
 */
export interface CommandInput extends IncomingBase {
  kind: "COMMAND";
  command: "CANCEL_ACTIVE_INTENT" | "START_OVER" | "SHOW_BALANCE" | "CONTINUE_PAYMENT";
  /** CONTINUE_PAYMENT: the payment the pressed button belonged to. */
  resumeIntentId?: string;
}

/**
 * Why a balance could not be read. Kept apart so the cause is findable in the logs even though the person only ever sees a friendly
 * "I couldn't read that right now": a wallet that is not ready is not an RPC outage, and neither is a token that is not a contract.
 */
export type BalanceFailureReason =
  "WALLET_NOT_READY" | "ASSET_UNSUPPORTED" | "RPC_UNAVAILABLE" | "BALANCE_UNAVAILABLE";

export class BalanceReadError extends Error {
  override readonly name = "BalanceReadError";
  constructor(
    readonly reason: BalanceFailureReason,
    /** Safe to log: a token symbol or an error class, never a URL or a key. */
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`balance unavailable: ${reason}`, options);
  }
}

/** What the agent needs to answer "what's my balance?": a fresh read of the wallet, or "no wallet yet". */
export interface AgentBalanceReader {
  read(userId: string): Promise<{ lines: { symbol: string; display: string }[] } | "NO_WALLET">;
}

/** What every channel is normalised to before it reaches the agent. */
export type IncomingAgentInput = TextInput | ChoiceInput | CommandInput;

export type HandleMessageInput = Omit<TextInput, "kind"> & { kind?: "TEXT" };

export interface AgentTurnResult {
  conversationId: string;
  /** The stored id of the user's message. */
  messageId: string;
  intentId?: string;
  /** Set when this message replaced an earlier operation that was still in progress. */
  supersededIntentId?: string;
  /** True when this message had already been handled; `response` is the original answer. */
  duplicate: boolean;
  response: AgentResponse;
  /** Details of an operation in progress that this message CHANGED (for tone only: "AMOUNT", "RECIPIENT", ...). */
  corrected?: string[];
  /** The payment still open behind a side answer (a rate, balance or help question): offer to carry on with it. */
  resume?: ResumeInfo;
}

export interface AgentServiceDeps {
  unitOfWork: AgentUnitOfWork;
  interpreter: IntentInterpreter;
  /** Builds resolvers from the repositories of the transaction they will run in. */
  createResolvers?: (repositories: AgentRepositories) => AgentResolvers;
  countries?: CountryDirectory;
  log?: AgentLog;
  now?: () => Date;
  /** The single hook run when an intent's financial details change (see commitIntent). */
  onIntentRevised?: OnIntentRevised;
  /**
   * Prices a ready request. When absent, the agent stops at ROUTING_REQUIRED (no pricing configured).
   * It is called outside any transaction, like the interpreter.
   */
  routing?: RoutingService;
  /** Reads wallet balances. When absent, a balance question honestly says it is not available. */
  balances?: AgentBalanceReader;
  /** How long the options of a question stay selectable. */
  choiceTtlMs?: number;
  /** How many earlier messages the interpreter sees as context. */
  historyLimit?: number;
}

/** The resume info as stored with the assistant message, so a redelivered turn still offers to carry on. */
function resumeToJson(resume: ResumeInfo): JsonObject {
  return {
    intentId: resume.intentId,
    revision: resume.revision,
    operation: resume.operation,
    ...(resume.recipient && { recipient: resume.recipient }),
    ...(resume.amount && { amount: resume.amount }),
    pending: resume.pending,
  };
}

function resumeFromJson(value: unknown): ResumeInfo | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v["intentId"] !== "string" ||
    typeof v["revision"] !== "number" ||
    (v["operation"] !== "SEND" && v["operation"] !== "CONVERT")
  ) {
    return undefined;
  }
  return {
    intentId: v["intentId"],
    revision: v["revision"],
    operation: v["operation"],
    ...(typeof v["recipient"] === "string" && { recipient: v["recipient"] }),
    ...(typeof v["amount"] === "string" && { amount: v["amount"] }),
    pending: v["pending"] === true,
  };
}

const TROUBLE_RESPONSE: AgentResponse = {
  type: "MESSAGE",
  text: "I couldn't understand that request right now. Please try again.",
};

interface Accepted {
  conversation: Conversation;
  message: Message;
  /** False for a redelivery whose first attempt never answered. Only then can another run have answered it. */
  fresh: boolean;
}

/**
 * One conversational turn, independent of any channel or language model.
 *
 * Flow: accept the message (short transaction) -> interpret it (no transaction held while the
 * interpreter runs) -> apply the result (short transaction, serialised per conversation). The
 * interpreter only proposes a structured reading; every decision about state, assets, recipients and
 * what to ask next is made here, deterministically. Nothing in this class quotes, routes, signs or
 * executes anything.
 */
export class AgentService {
  private readonly unitOfWork: AgentUnitOfWork;
  private readonly interpreter: IntentInterpreter;
  private readonly coordinator: IntentCoordinator;
  private readonly routing: RoutingService | undefined;
  private readonly balances: AgentBalanceReader | undefined;
  private readonly log: AgentLog;
  private readonly now: () => Date;
  private readonly historyLimit: number;

  constructor(deps: AgentServiceDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.interpreter = deps.interpreter;
    this.log = deps.log ?? noopLog;
    this.routing = deps.routing;
    this.balances = deps.balances;
    this.now = deps.now ?? (() => new Date());
    this.coordinator = new IntentCoordinator({
      createResolvers: deps.createResolvers ?? createDefaultResolvers,
      countries: deps.countries ?? defaultCountryDirectory,
      now: this.now,
      // Routes built for an older revision are retired first, then any caller-supplied hook runs.
      onRevised: composeRevisionHooks(
        invalidateRoutesOnRevision,
        invalidateAuthorizationOnRevision(this.now),
        deps.onIntentRevised ?? noopOnIntentRevised,
      ),
      choiceTtlMs: deps.choiceTtlMs ?? 30 * 60 * 1000,
      balancesEnabled: deps.balances !== undefined,
      sideQuotesEnabled: deps.routing !== undefined,
    });
    this.historyLimit = deps.historyLimit ?? 12;
  }

  /** The single entry point: text, selected options and conversation commands are the only kinds of input. */
  handle(input: IncomingAgentInput): Promise<AgentTurnResult> {
    if (input.kind === "CHOICE") return this.handleChoice(input);
    if (input.kind === "COMMAND") return this.handleCommand(input);
    return this.handleMessage(input);
  }

  /** A deterministic command: stored like a message (so it is idempotent), applied without the interpreter. */
  async handleCommand(input: CommandInput): Promise<AgentTurnResult> {
    const { kind: _kind, command, resumeIntentId: _resume, ...base } = input;
    const accepted = await this.accept({
      ...base,
      content:
        command === "CANCEL_ACTIVE_INTENT"
          ? "Cancel"
          : command === "SHOW_BALANCE"
            ? "Show my balance"
            : command === "CONTINUE_PAYMENT"
              ? "Continue"
              : "Start over",
    });
    if ("reply" in accepted) {
      return this.duplicateResult(accepted.conversation, accepted.message, accepted.reply);
    }
    const interpretation: Interpretation | ResumeTurn =
      command === "SHOW_BALANCE"
        ? { kind: "INTENT", intent: { type: "BALANCE" } }
        : command === "CONTINUE_PAYMENT"
          ? { kind: "RESUME", ...(input.resumeIntentId && { intentId: input.resumeIntentId }) }
          : { kind: "COMMAND", command };
    return this.route(
      await this.complete(accepted.conversation, accepted.message, interpretation, accepted.fresh),
      input.userId,
    );
  }

  async handleMessage(input: HandleMessageInput): Promise<AgentTurnResult> {
    const accepted = await this.accept(input);
    if ("reply" in accepted) {
      this.log("info", "agent.message.duplicate", {
        conversationId: accepted.conversation.id,
        messageId: accepted.message.id,
      });
      return this.duplicateResult(accepted.conversation, accepted.message, accepted.reply);
    }

    const { conversation, message } = accepted;
    const interpretation = await this.interpret(conversation, message);
    if (!interpretation) {
      return {
        conversationId: conversation.id,
        messageId: message.id,
        duplicate: false,
        response: TROUBLE_RESPONSE,
      };
    }
    return this.route(
      await this.complete(conversation, message, interpretation, accepted.fresh),
      input.userId,
    );
  }

  /**
   * A selected option is handled entirely from stored state, in one short transaction, without the
   * interpreter: lookup, verification and application are all deterministic.
   */
  async handleChoice(input: ChoiceInput): Promise<AgentTurnResult> {
    return this.route(await this.applyChoiceTurn(input), input.userId);
  }

  private applyChoiceTurn(input: ChoiceInput): Promise<AgentTurnResult> {
    return this.unitOfWork.transaction(async (repositories) => {
      const conversation = await repositories.conversations.getOrCreateByExternalId({
        id: createId(),
        userId: input.userId,
        channel: input.channel,
        status: "ACTIVE",
        externalConversationId: input.externalConversationId,
      });
      if (conversation.userId !== input.userId) {
        throw new ConversationAccessError("this conversation belongs to another user");
      }
      await repositories.conversations.lockForUpdate(conversation.id);

      if (input.externalMessageId) {
        const seen = await repositories.messages.findByExternalId(
          conversation.id,
          input.externalMessageId,
        );
        const reply = seen && (await repositories.messages.findReply(conversation.id, seen.id));
        if (seen && reply) return this.duplicateResult(conversation, seen, reply);
      }

      const { active, verdict } = await this.coordinator.verifyChoice(
        repositories,
        conversation,
        input.optionId,
      );
      const { message } = await repositories.messages.append({
        id: createId(),
        conversationId: conversation.id,
        role: "USER",
        content: verdict.ok ? `Selected: ${verdict.choice.label}` : "Selected an option",
        ...(input.externalMessageId && { externalMessageId: input.externalMessageId }),
        metadata: { kind: "CHOICE" },
      });
      const applied = await this.coordinator.applyChoice(
        repositories,
        conversation,
        active,
        verdict,
      );
      return this.finish(repositories, conversation, message, applied);
    });
  }

  /**
   * Stores the user's message, or recognises a redelivery of one already answered. No transaction:
   * the conversation lookup and the message insert are each atomic and idempotent, and ordering
   * against other work on the chat is enforced later, when the result is applied under the lock.
   */
  private async accept(
    input: HandleMessageInput,
  ): Promise<Accepted | (Accepted & { reply: Message })> {
    const repositories = this.unitOfWork.read;
    const conversation = await repositories.conversations.getOrCreateByExternalId({
      id: createId(),
      userId: input.userId,
      channel: input.channel,
      status: "ACTIVE",
      externalConversationId: input.externalConversationId,
    });
    if (conversation.userId !== input.userId) {
      throw new ConversationAccessError("this conversation belongs to another user");
    }

    const { message, created } = await repositories.messages.append({
      id: createId(),
      conversationId: conversation.id,
      role: "USER",
      content: input.content,
      ...(input.externalMessageId && { externalMessageId: input.externalMessageId }),
    });
    if (!created) {
      // A redelivery. If it was already answered, reuse that answer; if the first attempt died
      // before answering, fall through and process it now.
      const reply = await repositories.messages.findReply(conversation.id, message.id);
      if (reply) return { conversation, message, fresh: false, reply };
    }
    this.log("info", "agent.message.accepted", {
      conversationId: conversation.id,
      messageId: message.id,
      userId: input.userId,
      channel: input.channel,
    });
    return { conversation, message, fresh: created };
  }

  /** Asks the interpreter, outside any transaction. Returns undefined when it cannot be used. */
  private async interpret(
    conversation: Conversation,
    message: Message,
  ): Promise<Interpretation | undefined> {
    const context = await loadConversationContext(
      this.unitOfWork.read,
      conversation,
      this.historyLimit,
    );

    let raw: unknown;
    try {
      raw = await this.interpreter.interpret({
        message: message.content,
        history: toHistory(context.recentMessages, message.id),
        ...(context.activeIntent?.parsed && { activeIntent: context.activeIntent.parsed }),
        ...(context.pendingClarification && {
          pendingClarification: context.pendingClarification,
        }),
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof InterpreterOutputError) {
        // Unusable output is never trusted or retried: treat it as "not understood". That leaves
        // the open intent untouched and re-asks any pending question.
        this.log("warn", "agent.interpretation.invalid", {
          conversationId: conversation.id,
          messageId: message.id,
          reason: error.reason,
        });
        return { kind: "INTENT", intent: { type: "UNKNOWN" } };
      }
      // Not stored as an answer, so a redelivery of this message is processed again.
      this.log("error", "agent.interpreter.failed", {
        conversationId: conversation.id,
        messageId: message.id,
        error: error instanceof Error ? error.name : "unknown",
        kind: error instanceof Error && "kind" in error ? String(error.kind) : undefined,
      });
      return undefined;
    }

    const parsed = interpretationSchema.safeParse(raw);
    if (!parsed.success) {
      this.log("warn", "agent.interpretation.invalid", {
        conversationId: conversation.id,
        messageId: message.id,
      });
      return { kind: "INTENT", intent: { type: "UNKNOWN" } };
    }
    return parsed.data;
  }

  /** Applies an interpretation and stores the answer, serialised with other work on the chat. */
  private complete(
    conversation: Conversation,
    message: Message,
    interpretation: Interpretation | ResumeTurn,
    fresh: boolean,
  ): Promise<AgentTurnResult> {
    return this.unitOfWork.transaction(async (repositories) => {
      await repositories.conversations.lockForUpdate(conversation.id);

      // Only a redelivery can have been answered by someone else while the interpreter was running;
      // a message that was new when accepted has exactly one handler.
      if (!fresh) {
        const existing = await repositories.messages.findReply(conversation.id, message.id);
        if (existing) return this.duplicateResult(conversation, message, existing);
      }

      const applied = await this.coordinator.applyInterpretation(
        repositories,
        conversation,
        interpretation,
      );
      return this.finish(repositories, conversation, message, applied);
    });
  }

  /**
   * When the turn ended in ROUTING_REQUIRED and pricing is configured, prices the request OUTSIDE any
   * transaction, then writes the route and the answer in one short locked transaction. The
   * understood-request answer already stored stays in the history; the priced answer follows it. If
   * pricing itself breaks, the turn degrades to the ROUTING_REQUIRED answer it already had.
   */
  private async route(result: AgentTurnResult, userId: string): Promise<AgentTurnResult> {
    if (result.response.type === "BALANCE_REQUIRED" && !result.duplicate) {
      return this.resolveBalance(result, result.response, userId);
    }
    if (result.response.type === "SIDE_QUOTE_REQUIRED" && !result.duplicate) {
      return this.resolveSideQuote(result, result.response);
    }
    const routing = this.routing;
    const response = result.response;
    if (!routing || result.duplicate || response.type !== "ROUTING_REQUIRED") return result;

    try {
      const outcome = await routing.plan(response.request);
      return await this.unitOfWork.transaction(async (repositories) => {
        await repositories.conversations.lockForUpdate(result.conversationId);
        const routed = await routing.commit(repositories, outcome);
        await repositories.messages.append({
          id: createId(),
          conversationId: result.conversationId,
          role: "ASSISTANT",
          content: routed.text,
          structuredData: responseToJson(routed),
          metadata: {
            inReplyTo: result.messageId,
            intentId: response.intentId,
            stage: "ROUTED",
          },
        });
        this.log("info", "agent.turn.routed", {
          conversationId: result.conversationId,
          intentId: response.intentId,
          responseType: routed.type,
        });
        return { ...result, response: routed };
      });
    } catch (error) {
      this.log("error", "agent.routing.failed", {
        conversationId: result.conversationId,
        intentId: response.intentId,
        error: error instanceof Error ? error.name : "unknown",
      });
      return result;
    }
  }

  /**
   * Reads the wallet OUTSIDE any transaction (it is a chain read), then stores the answer next to the one already stored. Nothing
   * a model said is involved: the figures are exactly what the wallet service returned. A failed read becomes a plain error.
   */
  private async resolveBalance(
    result: AgentTurnResult,
    request: Extract<AgentResponse, { type: "BALANCE_REQUIRED" }>,
    userId: string,
  ): Promise<AgentTurnResult> {
    let response: AgentResponse;
    try {
      const read = await this.balances?.read(userId);
      if (!read) {
        response = {
          type: "ERROR",
          code: "FEATURE_NOT_AVAILABLE",
          text: "Balance checks aren't available yet.",
        };
      } else if (read === "NO_WALLET") {
        response = {
          type: "ERROR",
          code: "WALLET_SETUP_REQUIRED",
          text: "You need to set up your Kaada wallet first.",
        };
      } else {
        // The balances are what the wallet service returned (zero balances are not listed). Nothing is estimated or filled in.
        const wanted = request.asset?.trim();
        const held = wanted
          ? read.lines.filter((line) => line.symbol.toLowerCase() === wanted.toLowerCase())
          : read.lines;
        if (read.lines.length === 0) {
          response = {
            type: "BALANCE_RESULT",
            lines: [],
            empty: true,
            text: "Your wallet is empty right now. Want to add some funds?",
          };
        } else if (wanted && held.length === 0) {
          response = {
            type: "BALANCE_RESULT",
            lines: [],
            missingAsset: wanted.toUpperCase(),
            text: `You don't have any ${wanted.toUpperCase()} in your Kaada wallet yet.\n\nWant to fund it?`,
          };
        } else {
          response = {
            type: "BALANCE_RESULT",
            lines: held,
            text: `Your balance:\n${held.map((line) => `• ${line.display} ${line.symbol}`).join("\n")}`,
          };
        }
      }
    } catch (error) {
      const reason: BalanceFailureReason =
        error instanceof BalanceReadError ? error.reason : "BALANCE_UNAVAILABLE";
      this.log("error", "agent.balance.failed", {
        conversationId: result.conversationId,
        reason,
        ...(error instanceof BalanceReadError && error.detail && { detail: error.detail }),
        error: error instanceof Error ? error.name : "unknown",
        ...((error as { cause?: { name?: string } } | null)?.cause?.name && {
          cause: (error as { cause: { name: string } }).cause.name,
        }),
      });
      response = {
        type: "ERROR",
        code: "BALANCE_UNAVAILABLE",
        text: "I couldn't read your balance right now. Please try again in a moment.",
      };
    }
    await this.unitOfWork.transaction(async (repositories) => {
      await repositories.conversations.lockForUpdate(result.conversationId);
      await repositories.messages.append({
        id: createId(),
        conversationId: result.conversationId,
        role: "ASSISTANT",
        content: response.text,
        structuredData: responseToJson(response),
        metadata: {
          inReplyTo: result.messageId,
          stage: "BALANCE",
          ...(result.resume && { resume: resumeToJson(result.resume) }),
        },
      });
    });
    return { ...result, response };
  }

  /**
   * Prices a rate question asked beside an open payment. Outside any transaction; nothing is stored but the answer, so the
   * payment in progress (its intent, revision, route and authorization) is exactly as it was.
   */
  private async resolveSideQuote(
    result: AgentTurnResult,
    pending: Extract<AgentResponse, { type: "SIDE_QUOTE_REQUIRED" }>,
  ): Promise<AgentTurnResult> {
    let response: AgentResponse;
    try {
      response = this.routing
        ? await this.routing.quoteOnly(pending.request)
        : { type: "ERROR", code: "FEATURE_NOT_AVAILABLE", text: "Rates aren't available yet." };
    } catch (error) {
      this.log("error", "agent.side_quote.failed", {
        conversationId: result.conversationId,
        error: error instanceof Error ? error.name : "unknown",
      });
      response = {
        type: "ERROR",
        code: "ROUTING_UNAVAILABLE",
        text: "I couldn't check that rate right now. Please try again in a moment.",
      };
    }
    await this.unitOfWork.transaction(async (repositories) => {
      await repositories.conversations.lockForUpdate(result.conversationId);
      await repositories.messages.append({
        id: createId(),
        conversationId: result.conversationId,
        role: "ASSISTANT",
        content: response.text,
        structuredData: responseToJson(response),
        metadata: {
          inReplyTo: result.messageId,
          stage: "SIDE_QUOTE",
          ...(result.resume && { resume: resumeToJson(result.resume) }),
        },
      });
    });
    return { ...result, response };
  }

  /**
   * The payment still open in this chat, if any (display facts only). Lets a message about funding offer to carry on with the
   * payment once the wallet has money, without the channel knowing anything about intents. Read only.
   */
  async openPaymentResume(input: {
    userId: string;
    channel: ChannelType;
    externalConversationId: string;
  }): Promise<ResumeInfo | undefined> {
    const repositories = this.unitOfWork.read;
    const conversation = await repositories.conversations.getOrCreateByExternalId({
      id: createId(),
      userId: input.userId,
      channel: input.channel,
      status: "ACTIVE",
      externalConversationId: input.externalConversationId,
    });
    if (conversation.userId !== input.userId) return undefined;
    return this.coordinator.openPaymentResume(repositories, conversation.userId, conversation.id);
  }

  /** The last few turns of a conversation (oldest first), for the conversation layer's tone. Read only. */
  async recentTurns(
    conversationId: string,
    excludeMessageId: string,
    limit = 6,
  ): Promise<ConversationTurn[]> {
    const messages = await this.unitOfWork.read.messages.listRecent(conversationId, limit + 2);
    return toHistory(messages, excludeMessageId).slice(-limit);
  }

  /** Stores the assistant's answer and describes the turn. */
  private async finish(
    repositories: AgentRepositories,
    conversation: Conversation,
    message: Message,
    applied: Applied,
  ): Promise<AgentTurnResult> {
    await repositories.messages.append({
      id: createId(),
      conversationId: conversation.id,
      role: "ASSISTANT",
      content: applied.response.text,
      structuredData: responseToJson(applied.response),
      metadata: {
        inReplyTo: message.id,
        ...(applied.intentId && { intentId: applied.intentId }),
        ...(applied.resume && { resume: resumeToJson(applied.resume) }),
      },
    });

    this.log("info", "agent.turn.completed", {
      conversationId: conversation.id,
      messageId: message.id,
      intentId: applied.intentId,
      responseType: applied.response.type,
      mergeKind: applied.mergeKind,
    });
    return {
      conversationId: conversation.id,
      messageId: message.id,
      duplicate: false,
      response: applied.response,
      ...(applied.intentId && { intentId: applied.intentId }),
      ...(applied.supersededIntentId && { supersededIntentId: applied.supersededIntentId }),
      ...(applied.corrected && { corrected: applied.corrected }),
      ...(applied.resume && { resume: applied.resume }),
    };
  }

  private duplicateResult(
    conversation: Conversation,
    message: Message,
    reply: Message,
  ): AgentTurnResult {
    const intentId = reply.metadata?.["intentId"];
    const resume = resumeFromJson(reply.metadata?.["resume"]);
    return {
      conversationId: conversation.id,
      messageId: message.id,
      duplicate: true,
      response: responseFromStored(reply.structuredData, reply.content),
      ...(typeof intentId === "string" && { intentId }),
      ...(resume && { resume }),
    };
  }
}
