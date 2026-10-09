import {
  createId,
  defaultCountryDirectory,
  isTransactionalIntent,
  mergeAgentIntent,
} from "@kaada/domain";
import type {
  AgentCommand,
  AgentIntent,
  ChannelType,
  Conversation,
  CountryDirectory,
  Intent,
  Interpretation,
  Message,
} from "@kaada/domain";
import { interpretationSchema } from "@kaada/schemas";

import { loadConversationContext, toHistory } from "../conversations/context.js";
import { assessIntent } from "../intents/assessment.js";
import { buildIntentState, ensureRecipientRecord } from "../intents/intent-state.js";
import type { AgentResponse } from "../responses/agent-response.js";
import { toClarificationResponse } from "../responses/clarifications.js";
import { responseFromStored, responseToJson } from "../responses/serialize.js";
import { routingRequiredResponse } from "../responses/summaries.js";
import { ConversationAccessError } from "./errors.js";
import { InterpreterOutputError } from "./interpreter.js";
import type { IntentInterpreter } from "./interpreter.js";
import type { AgentLog, AgentRepositories, AgentUnitOfWork } from "./ports.js";
import { noopLog } from "./ports.js";
import { createDefaultResolvers } from "./resolvers.js";
import type { AgentResolvers } from "./resolvers.js";

export interface HandleMessageInput {
  userId: string;
  channel: ChannelType;
  /** The channel's own chat id; the same chat always maps to the same conversation. */
  externalConversationId: string;
  /** The channel's own message id. When present, redelivered messages are recognised and ignored. */
  externalMessageId?: string;
  content: string;
}

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
  /** How many earlier messages the interpreter sees as context. */
  historyLimit?: number;
}

const TROUBLE_RESPONSE: AgentResponse = {
  type: "MESSAGE",
  text: "I couldn't understand that request right now. Please try again.",
};

const HELP_TEXT =
  'I can help you send money, convert between currencies, and get quotes. For example: "Send $20 to Daniel" or "How much would 50 USDT give me in Brazil?". Say "cancel" any time to stop what we\'re doing.';

interface Accepted {
  conversation: Conversation;
  message: Message;
}

interface Applied {
  response: AgentResponse;
  intentId?: string;
  supersededIntentId?: string;
  mergeKind: string;
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
  private readonly createResolvers: (repositories: AgentRepositories) => AgentResolvers;
  private readonly countries: CountryDirectory;
  private readonly log: AgentLog;
  private readonly now: () => Date;
  private readonly historyLimit: number;

  constructor(deps: AgentServiceDeps) {
    this.unitOfWork = deps.unitOfWork;
    this.interpreter = deps.interpreter;
    this.createResolvers = deps.createResolvers ?? createDefaultResolvers;
    this.countries = deps.countries ?? defaultCountryDirectory;
    this.log = deps.log ?? noopLog;
    this.now = deps.now ?? (() => new Date());
    this.historyLimit = deps.historyLimit ?? 12;
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
    return this.complete(conversation, message, interpretation);
  }

  /** Stores the user's message, or recognises a redelivery of one already answered. */
  private accept(input: HandleMessageInput): Promise<Accepted | (Accepted & { reply: Message })> {
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
        if (reply) return { conversation, message, reply };
      }
      this.log("info", "agent.message.accepted", {
        conversationId: conversation.id,
        messageId: message.id,
        userId: input.userId,
        channel: input.channel,
      });
      return { conversation, message };
    });
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
  ): Promise<AgentTurnResult> {
    return this.unitOfWork.transaction(async (repositories) => {
      await repositories.conversations.lockForUpdate(conversation.id);

      // A concurrent redelivery may have finished while the interpreter was running.
      const existing = await repositories.messages.findReply(conversation.id, message.id);
      if (existing) return this.duplicateResult(conversation, message, existing);

      const applied = await this.apply(repositories, conversation, interpretation);

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
    });
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

  private async apply(
    repositories: AgentRepositories,
    conversation: Conversation,
    interpretation: Interpretation,
  ): Promise<Applied> {
    const active = await repositories.intents.findOpenByConversation(conversation.id);

    if (interpretation.kind === "COMMAND") {
      return this.applyCommand(repositories, interpretation.command, active);
    }

    const merged = mergeAgentIntent(active?.parsed, interpretation.intent);
    if (merged.kind === "SIDE_REQUEST") {
      return this.applySideRequest(repositories, conversation, merged.intent, active);
    }
    if (!isTransactionalIntent(merged.intent)) {
      throw new Error("a non-transactional intent cannot start an operation");
    }
    const parsed = merged.intent;

    // One active operation per conversation: anything that is not a merge retires the old one.
    let supersededIntentId: string | undefined;
    if (active && merged.kind !== "MERGED") {
      await repositories.intents.save({ ...active, status: "CANCELLED", missingFields: [] });
      supersededIntentId = active.id;
    }

    const resolvers = this.createResolvers(repositories);
    const assessment = await assessIntent(parsed, {
      userId: conversation.userId,
      assets: resolvers.assets,
      recipients: resolvers.recipients,
      countries: this.countries,
    });
    const recipientId = assessment.facts.recipient
      ? await ensureRecipientRecord(repositories, conversation.userId, assessment.facts.recipient)
      : undefined;

    const target = merged.kind === "MERGED" ? active : undefined;
    const state = buildIntentState({
      id: target?.id ?? createId(),
      userId: conversation.userId,
      conversationId: conversation.id,
      parsed,
      assessment,
      recipientId,
    });
    // Any change returns the intent to RESOLVED or AWAITING_DETAILS, so a price or route computed
    // for an earlier version of the details can never be treated as current.
    const saved = target
      ? await repositories.intents.save({
          ...state,
          createdAt: target.createdAt,
          updatedAt: target.updatedAt,
        })
      : await repositories.intents.create(state);

    const [firstQuestion] = assessment.status === "NEEDS_INFO" ? assessment.clarifications : [];
    const response: AgentResponse = firstQuestion
      ? toClarificationResponse(firstQuestion, saved.id)
      : routingRequiredResponse(parsed, assessment.facts, saved.id);

    return {
      response,
      intentId: saved.id,
      ...(supersededIntentId && { supersededIntentId }),
      mergeKind: merged.kind,
    };
  }

  private async applyCommand(
    repositories: AgentRepositories,
    command: AgentCommand,
    active: Intent | null,
  ): Promise<Applied> {
    if (active) {
      await repositories.intents.save({ ...active, status: "CANCELLED", missingFields: [] });
    }
    const startOver = command === "START_OVER";

    if (!active) {
      return {
        response: {
          type: "MESSAGE",
          text: startOver
            ? "Sure. What would you like to do?"
            : "There's nothing to cancel right now.",
        },
        mergeKind: command,
      };
    }
    return {
      response: {
        type: "CANCELLED",
        intentId: active.id,
        text: startOver
          ? "Okay, let's start over. What would you like to do?"
          : "Okay, I've cancelled that.",
      },
      intentId: active.id,
      mergeKind: command,
    };
  }

  /** Informational requests never change the operation in progress. */
  private async applySideRequest(
    repositories: AgentRepositories,
    conversation: Conversation,
    intent: AgentIntent,
    active: Intent | null,
  ): Promise<Applied> {
    const mergeKind = "SIDE_REQUEST";
    switch (intent.type) {
      case "HELP":
        return { response: { type: "MESSAGE", text: HELP_TEXT }, mergeKind };

      case "BALANCE":
        return {
          response: { type: "MESSAGE", text: "Balance checks aren't available yet." },
          mergeKind,
        };

      case "TRANSACTION_STATUS":
        return {
          response: { type: "MESSAGE", text: "Looking up transaction status isn't available yet." },
          mergeKind,
        };

      default: {
        // Not understood. If we were waiting on an answer, ask the same question again.
        if (
          active?.parsed &&
          active.status === "AWAITING_DETAILS" &&
          isTransactionalIntent(active.parsed)
        ) {
          const resolvers = this.createResolvers(repositories);
          const assessment = await assessIntent(active.parsed, {
            userId: conversation.userId,
            assets: resolvers.assets,
            recipients: resolvers.recipients,
            countries: this.countries,
          });
          const [question] = assessment.status === "NEEDS_INFO" ? assessment.clarifications : [];
          if (question) {
            return {
              response: toClarificationResponse(
                question,
                active.id,
                "Sorry, I didn't catch that. ",
              ),
              intentId: active.id,
              mergeKind,
            };
          }
        }
        return {
          response: {
            type: "MESSAGE",
            text: 'Sorry, I didn\'t understand that. I can help you send money, convert currencies, or get a quote. Say "help" to see examples.',
          },
          mergeKind,
        };
      }
    }
  }
}
