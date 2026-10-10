import { createId, defaultCountryDirectory } from "@kaada/domain";
import type {
  ChannelType,
  Conversation,
  CountryDirectory,
  Interpretation,
  Message,
} from "@kaada/domain";
import { interpretationSchema } from "@kaada/schemas";

import { loadConversationContext, toHistory } from "../conversations/context.js";
import { IntentCoordinator } from "../intents/coordinator.js";
import type { Applied } from "../intents/coordinator.js";
import { composeRevisionHooks, noopOnIntentRevised } from "../intents/intent-commit.js";
import type { OnIntentRevised } from "../intents/intent-commit.js";
import {
  invalidateAuthorizationOnRevision,
  invalidateRoutesOnRevision,
} from "../routing/invalidation.js";
import type { RoutingService } from "../routing/routing-service.js";
import type { AgentResponse } from "../responses/agent-response.js";
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

/** What every channel is normalised to before it reaches the agent. */
export type IncomingAgentInput = TextInput | ChoiceInput;

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
  /** How long the options of a question stay selectable. */
  choiceTtlMs?: number;
  /** How many earlier messages the interpreter sees as context. */
  historyLimit?: number;
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
  private readonly log: AgentLog;
  private readonly now: () => Date;
  private readonly historyLimit: number;

  constructor(deps: AgentServiceDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.interpreter = deps.interpreter;
    this.log = deps.log ?? noopLog;
    this.routing = deps.routing;
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
    });
    this.historyLimit = deps.historyLimit ?? 12;
  }

  /** The single entry point: text and selected options are the only two kinds of input. */
  handle(input: IncomingAgentInput): Promise<AgentTurnResult> {
    return input.kind === "CHOICE" ? this.handleChoice(input) : this.handleMessage(input);
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
    return this.route(await this.complete(conversation, message, interpretation, accepted.fresh));
  }

  /**
   * A selected option is handled entirely from stored state, in one short transaction, without the
   * interpreter: lookup, verification and application are all deterministic.
   */
  async handleChoice(input: ChoiceInput): Promise<AgentTurnResult> {
    return this.route(await this.applyChoiceTurn(input));
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
    interpretation: Interpretation,
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
  private async route(result: AgentTurnResult): Promise<AgentTurnResult> {
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
    };
  }

  private duplicateResult(
    conversation: Conversation,
    message: Message,
    reply: Message,
  ): AgentTurnResult {
    const intentId = reply.metadata?.["intentId"];
    return {
      conversationId: conversation.id,
      messageId: message.id,
      duplicate: true,
      response: responseFromStored(reply.structuredData, reply.content),
      ...(typeof intentId === "string" && { intentId }),
    };
  }
}
