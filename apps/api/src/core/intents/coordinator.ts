import {
  buildRoutingRequest,
  createId,
  isTransactionalIntent,
  mergeAgentIntent,
  withoutSourcePreference,
} from "@kaada/domain";
import type {
  AgentCommand,
  AgentIntent,
  Conversation,
  CountryDirectory,
  Intent,
  Interpretation,
  RecipientReference,
  ResolvedRecipient,
} from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";
import type { AgentResolvers } from "../agent/resolvers.js";
import type {
  AgentErrorCode,
  AgentResponse,
  ClarificationOption,
  ClarificationRequiredResponse,
} from "../responses/agent-response.js";
import { toClarificationResponse } from "../responses/clarifications.js";
import type { Clarification } from "../responses/clarifications.js";
import { routingRequiredResponse, summarizeIntent } from "../responses/summaries.js";
import { resolvedFromStored } from "../recipients/recipient-resolver.js";
import { assessIntent } from "./assessment.js";
import type { TransactionalIntent } from "./assessment.js";
import { applyAssetChoice, toStoredValue, verifyChoice } from "./choices.js";
import type { ChoiceRejection, ChoiceVerdict } from "./choices.js";
import { commitIntent } from "./intent-commit.js";
import type { OnIntentRevised } from "./intent-commit.js";
import { buildIntentState, ensureRecipientRecord } from "./intent-state.js";

export interface Applied {
  response: AgentResponse;
  intentId?: string;
  supersededIntentId?: string;
  /** For logs: how the turn related to the intent in progress. */
  mergeKind: string;
}

export interface CoordinatorDeps {
  createResolvers: (repositories: AgentRepositories) => AgentResolvers;
  countries: CountryDirectory;
  now: () => Date;
  onRevised: OnIntentRevised;
  /** How long a question's options can be selected. */
  choiceTtlMs: number;
}

const HELP_TEXT =
  'I can help you send money, convert between currencies, and get quotes. For example: "Send $20 to Daniel" or "How much would 50 USDT give me in Brazil?". Say "cancel" any time to stop what we\'re doing.';

const REJECTION: Record<ChoiceRejection, { code: AgentErrorCode; text: string }> = {
  UNKNOWN: {
    code: "CHOICE_UNKNOWN",
    text: "I don't recognise that option. Please tell me what you'd like to do.",
  },
  EXPIRED: {
    code: "CHOICE_EXPIRED",
    text: "That option has expired. Please tell me again what you'd like to do.",
  },
  ALREADY_USED: { code: "CHOICE_ALREADY_USED", text: "That option has already been used." },
  STALE: {
    code: "CHOICE_STALE",
    text: "That option is out of date because the request changed. Please use the latest question.",
  },
};

function sameReference(a: RecipientReference | undefined, b: RecipientReference | undefined) {
  return (
    a !== undefined &&
    b !== undefined &&
    a.type === b.type &&
    a.value.trim().toLowerCase() === b.value.trim().toLowerCase()
  );
}

interface AdvanceArgs {
  conversation: Conversation;
  /** The operation to work with, already merged with what was known. */
  parsed: TransactionalIntent;
  /** The open intent being updated; undefined starts a new one. */
  target: Intent | undefined;
  /** An open intent to retire because this turn started a different operation. */
  supersede?: Intent | undefined;
  /** A recipient already decided for this reference (selected from a list). */
  recipientOverride?: ResolvedRecipient;
  prefix?: string;
  /** Re-present where the intent stands without writing to it (an unclear message changed nothing). */
  restate?: boolean;
  mergeKind: string;
}

/**
 * Everything that changes an intent goes through `advance`: assess, commit (the one place the
 * revision moves), then answer with either the next question or the routing handoff. Interpreted
 * text and selected options differ only in how they arrive at `parsed`.
 */
export class IntentCoordinator {
  constructor(private readonly deps: CoordinatorDeps) {}

  /** Applies what the interpreter read from a message. */
  async applyInterpretation(
    repositories: AgentRepositories,
    conversation: Conversation,
    interpretation: Interpretation,
  ): Promise<Applied> {
    const active = await repositories.intents.findOpenByConversation(conversation.id);

    if (interpretation.kind === "COMMAND") {
      return this.applyCommand(repositories, conversation, interpretation.command, active);
    }

    const merged = mergeAgentIntent(active?.parsed, interpretation.intent);
    if (merged.kind === "SIDE_REQUEST") {
      return this.applySideRequest(repositories, conversation, merged.intent, active);
    }
    if (!isTransactionalIntent(merged.intent)) {
      throw new Error("a non-transactional intent cannot start an operation");
    }
    const merging = merged.kind === "MERGED";
    return this.advance(repositories, {
      conversation,
      parsed: merged.intent,
      target: merging ? (active ?? undefined) : undefined,
      supersede: merging ? undefined : (active ?? undefined),
      mergeKind: merged.kind,
    });
  }

  /** Checks an option against server state. Nothing is changed. */
  async verifyChoice(
    repositories: AgentRepositories,
    conversation: Conversation,
    optionId: string,
  ): Promise<{ active: Intent | null; verdict: ChoiceVerdict }> {
    const active = await repositories.intents.findOpenByConversation(conversation.id);
    const verdict = await verifyChoice(repositories, {
      optionId,
      conversationId: conversation.id,
      active,
      now: this.deps.now(),
    });
    return { active, verdict };
  }

  /**
   * Applies a verified option: claims it (single use), turns its stored value into the same kind of
   * update an interpreted message would make, and continues exactly like one. No interpreter is
   * involved, and nothing the client sent is read other than the id.
   */
  async applyChoice(
    repositories: AgentRepositories,
    conversation: Conversation,
    active: Intent | null,
    verdict: ChoiceVerdict,
  ): Promise<Applied> {
    const mergeKind = "CHOICE";
    if (!verdict.ok) return this.rejected(verdict.rejection, mergeKind);
    if (!active?.parsed || !isTransactionalIntent(active.parsed)) {
      return this.rejected("STALE", mergeKind);
    }

    const { value, choice } = verdict;
    let parsed: TransactionalIntent | undefined;
    let recipientOverride: ResolvedRecipient | undefined;
    if (value.kind === "RECIPIENT") {
      if (active.parsed.type !== "SEND") return this.rejected("STALE", mergeKind);
      parsed = active.parsed;
      recipientOverride = value.recipient;
    } else {
      parsed = applyAssetChoice(active.parsed, value.target, value.assetId);
    }
    if (!parsed) return this.rejected("STALE", mergeKind);

    // Claimed last, so a rejected option is never used up, and atomically, so of two concurrent
    // selections exactly one wins.
    const claimed = await repositories.clarifications.markUsed(choice.id, this.deps.now());
    if (!claimed) return this.rejected("ALREADY_USED", mergeKind);

    return this.advance(repositories, {
      conversation,
      parsed,
      target: active,
      ...(recipientOverride && { recipientOverride }),
      mergeKind,
    });
  }

  rejected(rejection: ChoiceRejection, mergeKind: string): Applied {
    const { code, text } = REJECTION[rejection];
    return { response: { type: "ERROR", code, text }, mergeKind };
  }

  private async advance(repositories: AgentRepositories, args: AdvanceArgs): Promise<Applied> {
    const { conversation, parsed, target, supersede } = args;

    if (supersede) {
      await repositories.intents.save({ ...supersede, status: "CANCELLED", missingFields: [] });
    }

    const recipientOverride =
      args.recipientOverride ?? (await this.reusableRecipient(repositories, parsed, target));
    const resolvers = this.deps.createResolvers(repositories);
    const assessment = await assessIntent(parsed, {
      userId: conversation.userId,
      assets: resolvers.assets,
      recipients: resolvers.recipients,
      countries: this.deps.countries,
      ...(recipientOverride && { resolvedRecipient: recipientOverride }),
    });
    const recipientId = assessment.facts.recipient
      ? await ensureRecipientRecord(repositories, conversation.userId, assessment.facts.recipient)
      : undefined;

    const saved =
      args.restate && target
        ? target
        : (
            await commitIntent(repositories, {
              previous: target ?? null,
              state: buildIntentState({
                id: target?.id ?? createId(),
                userId: conversation.userId,
                conversationId: conversation.id,
                parsed,
                assessment,
                recipientId,
              }),
              onRevised: this.deps.onRevised,
            })
          ).intent;

    const base = {
      intentId: saved.id,
      mergeKind: args.mergeKind,
      ...(supersede && { supersededIntentId: supersede.id }),
    };

    if (assessment.status === "NEEDS_INFO") {
      const [first] = assessment.clarifications;
      if (!first) throw new Error("an intent that needs information must have a question");
      return {
        ...base,
        response: await this.ask(repositories, conversation, saved, first, args.prefix),
      };
    }

    const summary = summarizeIntent(parsed, assessment.facts);
    const recipient = assessment.facts.recipient;
    const request = buildRoutingRequest(
      saved,
      recipient && recipientId
        ? {
            id: recipientId,
            ...(recipient.linkedUserId && { linkedUserId: recipient.linkedUserId }),
            ...(recipient.displayName && { displayName: recipient.displayName }),
            ...(recipient.walletAddress && { walletAddress: recipient.walletAddress }),
          }
        : undefined,
    );
    if (!summary || !request) throw new Error("a ready intent must have an amount");
    return { ...base, response: routingRequiredResponse(summary, saved, request) };
  }

  /**
   * The recipient already resolved for this same reference, read back from storage, so a later change
   * to something else (the amount) cannot reopen a choice the user already made or re-run the lookup.
   */
  private async reusableRecipient(
    repositories: AgentRepositories,
    parsed: TransactionalIntent,
    target: Intent | undefined,
  ): Promise<ResolvedRecipient | undefined> {
    if (parsed.type !== "SEND" || !parsed.recipient || !target?.recipientId) return undefined;
    const previous = target.parsed;
    if (previous?.type !== "SEND" || !sameReference(previous.recipient, parsed.recipient)) {
      return undefined;
    }
    const stored = await repositories.recipients.findById(target.recipientId);
    return stored ? resolvedFromStored(parsed.recipient, stored) : undefined;
  }

  /** Stores the options of a question (one group per asking) and builds the response. */
  private async ask(
    repositories: AgentRepositories,
    conversation: Conversation,
    intent: Intent,
    clarification: Clarification,
    prefix = "",
  ): Promise<ClarificationRequiredResponse> {
    const drafts = clarification.choices ?? [];
    let options: ClarificationOption[] = [];
    if (drafts.length > 0) {
      const groupId = createId();
      const expiresAt = new Date(this.deps.now().getTime() + this.deps.choiceTtlMs);
      const stored = await repositories.clarifications.issue(
        drafts.map((draft) => ({
          id: createId(),
          groupId,
          conversationId: conversation.id,
          intentId: intent.id,
          revision: intent.revision,
          field: clarification.field,
          label: draft.label,
          ...(draft.description && { description: draft.description }),
          value: toStoredValue(draft.value),
          expiresAt,
        })),
      );
      options = stored.map((row) => ({
        id: row.id,
        label: row.label,
        ...(row.description && { description: row.description }),
      }));
    }
    return toClarificationResponse(clarification, intent.id, options, prefix);
  }

  private async applyCommand(
    repositories: AgentRepositories,
    conversation: Conversation,
    command: AgentCommand,
    active: Intent | null,
  ): Promise<Applied> {
    const mergeKind = command;

    if (command === "REMOVE_SOURCE_PREFERENCE") {
      if (!active?.parsed || !isTransactionalIntent(active.parsed)) {
        return {
          response: { type: "MESSAGE", text: "There's nothing to change right now." },
          mergeKind,
        };
      }
      const parsed = withoutSourcePreference(active.parsed);
      if (!isTransactionalIntent(parsed))
        throw new Error("removing a preference keeps the operation");
      return this.advance(repositories, { conversation, parsed, target: active, mergeKind });
    }

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
        mergeKind,
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
      mergeKind,
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
          response: {
            type: "ERROR",
            code: "FEATURE_NOT_AVAILABLE",
            text: "Balance checks aren't available yet.",
          },
          mergeKind,
        };

      case "TRANSACTION_STATUS":
        return {
          response: {
            type: "ERROR",
            code: "FEATURE_NOT_AVAILABLE",
            text: "Looking up transaction status isn't available yet.",
          },
          mergeKind,
        };

      default: {
        // Not understood. Restate where the operation stands: the pending question again, or the
        // routing handoff if it was already complete. Nothing about the operation changes.
        if (active?.parsed && isTransactionalIntent(active.parsed)) {
          const restated = await this.advance(repositories, {
            conversation,
            parsed: active.parsed,
            target: active,
            prefix: "Sorry, I didn't catch that. ",
            restate: true,
            mergeKind,
          });
          return restated;
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
