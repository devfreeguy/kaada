import {
  buildRoutingRequest,
  createId,
  isChatTopic,
  isTransactionalIntent,
  mergeAgentIntent,
  withoutSourcePreference,
} from "@kaada/domain";
import type {
  AgentCommand,
  AgentIntent,
  Conversation,
  ConversationFocus,
  CountryDirectory,
  Intent,
  Interpretation,
  RecipientReference,
  ResolvedRecipient,
} from "@kaada/domain";

import type { AgentRepositories } from "../agent/ports.js";
import { chatFallbackText } from "../conversation/fallbacks.js";
import type { AgentResolvers } from "../agent/resolvers.js";
import type {
  AgentErrorCode,
  ResumeInfo,
  AgentResponse,
  ClarificationOption,
  ClarificationRequiredResponse,
} from "../responses/agent-response.js";
import { toClarificationResponse } from "../responses/clarifications.js";
import type { Clarification } from "../responses/clarifications.js";
import { routingRequiredResponse, summarizeIntent } from "../responses/summaries.js";
import { resolvedFromStored } from "../recipients/recipient-resolver.js";
import { findActiveIntent } from "./active-intent.js";
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
  /** The payment that was open while a side question was answered (see ResumeInfo). */
  resume?: ResumeInfo;
  /**
   * What the conversation is waiting to be told after this turn. Absent means nothing: the turn answered whatever was pending, so
   * the focus is cleared. Set only when Kaada has just asked a question whose answer must be read first as that answer.
   */
  focus?: ConversationFocus | null;
  /** Details of the operation in progress that this message CHANGED (not merely supplied): "AMOUNT", "RECIPIENT"... */
  corrected?: string[];
}

export interface CoordinatorDeps {
  createResolvers: (repositories: AgentRepositories) => AgentResolvers;
  countries: CountryDirectory;
  now: () => Date;
  onRevised: OnIntentRevised;
  /** How long a question's options can be selected. */
  choiceTtlMs: number;
  /** Whether balances can be read; when not, a balance question honestly says it is not available. */
  balancesEnabled?: boolean;
  /** Whether a price question can be answered (a pricing provider exists). Needed to answer one beside an open payment. */
  sideQuotesEnabled?: boolean;
}

/** "Continue" on a saved payment: resume THAT intent from stored state, with no interpretation. */
export interface ResumeTurn {
  kind: "RESUME";
  /** The payment the button belonged to. Absent: whatever payment is open. */
  intentId?: string;
}

/** What was understood so far, for the tone of the next question. Display strings only, never used to decide anything. */
function knownFacts(
  facts: { display: { amount?: string; recipient?: string; country?: string } },
  parsed: TransactionalIntent,
): Record<string, string> {
  const { amount, recipient, country } = facts.display;
  // Before a currency is known there is no formatted amount, but the number the person typed is still theirs to hear back.
  const typed = parsed.amount?.value;
  return {
    ...(recipient && { recipient }),
    ...((amount ?? typed) && { amount: (amount ?? typed) as string }),
    ...(country && { country }),
  };
}

/** Which already-known details a merged intent changed. Only used to tell a correction from an answer. */
function correctedFields(previous: AgentIntent | undefined, next: AgentIntent): string[] {
  if (!previous || previous.type !== next.type || !isTransactionalIntent(next)) return [];
  const before = previous as TransactionalIntent;
  const changed: string[] = [];
  if (before.amount?.value !== undefined && before.amount.value !== next.amount?.value) {
    changed.push("AMOUNT");
  }
  const oldCurrency = before.amount?.currencyOrAsset?.toLowerCase();
  if (oldCurrency !== undefined && oldCurrency !== next.amount?.currencyOrAsset?.toLowerCase()) {
    changed.push("CURRENCY");
  }
  if (
    before.type === "SEND" &&
    next.type === "SEND" &&
    before.recipient !== undefined &&
    !sameReference(before.recipient, next.recipient)
  ) {
    changed.push("RECIPIENT");
  }
  return changed;
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

/** How long after a payment "him" or "her" still means the person it was for. */
const PREVIOUS_RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const PRONOUN =
  /^(?:him|her|them|he|she|they|that (?:person|guy|man|woman|one)|the same (?:person|guy|man|woman|one)|same (?:person|guy|man|woman|one)|again)$/i;
const isPronoun = (value: string): boolean => PRONOUN.test(value.trim().replace(/^to\s+/i, ""));

/** What a still-open payment needs, for matching a deposit against it. Display and comparison only. */
export interface OpenPaymentNeeds {
  resume: ResumeInfo;
  /** When the payment last moved. Progress older than the conversation window is never picked back up. */
  lastActiveAt: Date;
  /** The token the wallet pays with and how much (smallest units), when the payment fixes it. */
  required?: { symbol: string; assetId: string; amount: string };
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
    interpretation: Interpretation | ResumeTurn,
  ): Promise<Applied> {
    const active = await findActiveIntent(repositories, conversation.id);

    if (interpretation.kind === "RESUME") {
      return this.resumePayment(repositories, conversation, active, interpretation.intentId);
    }
    if (interpretation.kind === "COMMAND") {
      return this.applyCommand(repositories, conversation, interpretation.command, active);
    }

    // A price question beside an open payment is a SIDE question: the payment is not revised, replaced or cancelled by it.
    if (
      interpretation.intent.type === "QUOTE" &&
      active?.parsed &&
      (active.parsed.type === "SEND" || active.parsed.type === "CONVERT")
    ) {
      return this.applySideQuote(repositories, conversation, interpretation.intent, active);
    }

    const intent = await this.withPreviousRecipient(
      repositories,
      conversation,
      interpretation.intent,
    );
    const merged = mergeAgentIntent(active?.parsed, intent);
    if (merged.kind === "SIDE_REQUEST") {
      const answered = await this.applySideRequest(
        repositories,
        conversation,
        merged.intent,
        active,
      );
      return this.withResume(repositories, conversation, active, merged.intent, answered);
    }
    if (!isTransactionalIntent(merged.intent)) {
      throw new Error("a non-transactional intent cannot start an operation");
    }
    const merging = merged.kind === "MERGED";
    const applied = await this.advance(repositories, {
      conversation,
      parsed: merged.intent,
      target: merging ? (active ?? undefined) : undefined,
      supersede: merging ? undefined : (active ?? undefined),
      mergeKind: merged.kind,
    });
    const corrected = merging ? correctedFields(active?.parsed, merged.intent) : [];
    return corrected.length > 0 ? { ...applied, corrected } : applied;
  }

  /**
   * "Send him 0.3 CELO": a pronoun names whoever this chat was just paying. The model reports it as the word itself; here it
   * becomes that person's own reference (resolved again like any name, so their wallet is read fresh), or, when this chat has
   * nobody to point at, nothing at all, and the usual "who is it for?" question is asked. It is never a guess that stays hidden:
   * the payment summary names the recipient before anything can be authorized.
   */
  private async withPreviousRecipient(
    repositories: AgentRepositories,
    conversation: Conversation,
    intent: AgentIntent,
  ): Promise<AgentIntent> {
    if (intent.type !== "SEND" || !intent.recipient || !isPronoun(intent.recipient.value)) {
      return intent;
    }
    const cutoff = this.deps.now().getTime() - PREVIOUS_RECIPIENT_WINDOW_MS;
    const recent = await repositories.intents.listRecentByConversation(conversation.id, 10);
    const previous = recent.find(
      (earlier) =>
        earlier.updatedAt.getTime() >= cutoff &&
        earlier.parsed?.type === "SEND" &&
        earlier.parsed.recipient !== undefined &&
        !isPronoun(earlier.parsed.recipient.value),
    );
    const { recipient: _pronoun, ...rest } = intent;
    if (previous?.parsed?.type !== "SEND" || !previous.parsed.recipient) return rest;
    return { ...rest, recipient: previous.parsed.recipient };
  }

  // ───────────────────────────────── side questions ─────────────────────────────────

  /**
   * The payment that is open, in display terms, so a side answer can offer to carry on. Read only: it re-reads what was stored,
   * and never changes the intent.
   */
  /** The payment open in a conversation, in display terms (see ResumeInfo). Read only. */
  async openPaymentResume(
    repositories: AgentRepositories,
    userId: string,
    conversationId: string,
  ): Promise<ResumeInfo | undefined> {
    const active = await findActiveIntent(repositories, conversationId);
    return this.resumeOf(repositories, { userId }, active);
  }

  /**
   * The payment still open in a chat, with what it needs from the wallet, so a deposit can be matched against it. Only a
   * payment that is ready to price counts (one still missing a detail was never "short of funds"), and only when the amount is
   * fixed on the side the wallet pays (EXACT_INPUT). Read only; nothing is resurrected, advanced or priced.
   */
  async openPaymentNeeds(
    repositories: AgentRepositories,
    userId: string,
    conversationId: string,
  ): Promise<OpenPaymentNeeds | undefined> {
    const active = await findActiveIntent(repositories, conversationId);
    const resume = await this.resumeOf(repositories, { userId }, active);
    if (!active || !resume || resume.pending) return undefined;
    const needs: OpenPaymentNeeds = { resume, lastActiveAt: active.updatedAt };
    if (active.amount?.mode === "EXACT_INPUT" && active.sourceAssetId) {
      const resolved = await this.deps
        .createResolvers(repositories)
        .assets.resolve(active.sourceAssetId);
      if (resolved.status === "RESOLVED") {
        needs.required = {
          symbol: resolved.asset.symbol,
          assetId: resolved.asset.id,
          amount: active.amount.money.amount,
        };
      }
    }
    return needs;
  }

  private async resumeOf(
    repositories: AgentRepositories,
    conversation: Pick<Conversation, "userId">,
    active: Intent | null,
  ): Promise<ResumeInfo | undefined> {
    const parsed = active?.parsed;
    if (!active || !parsed || !isTransactionalIntent(parsed) || parsed.type === "QUOTE") {
      return undefined;
    }
    const recipientOverride = await this.reusableRecipient(repositories, parsed, active);
    const resolvers = this.deps.createResolvers(repositories);
    const assessment = await assessIntent(parsed, {
      userId: conversation.userId,
      assets: resolvers.assets,
      recipients: resolvers.recipients,
      countries: this.deps.countries,
      ...(recipientOverride && { resolvedRecipient: recipientOverride }),
    });
    const { amount, recipient } = assessment.facts.display;
    return {
      intentId: active.id,
      revision: active.revision,
      operation: parsed.type,
      ...(recipient && { recipient }),
      ...(amount && { amount }),
      pending: assessment.status === "NEEDS_INFO",
    };
  }

  /**
   * The currency of an amount nobody named: the person's home currency. Order of precedence is (1) the current message, (2) the
   * payment in progress, (3) home, (4) ask: steps 1 and 2 have already filled `currencyOrAsset`, so only a still-empty one is
   * defaulted, and with no home currency it stays empty and the usual question is asked. Only a payment is defaulted.
   */
  private async withHomeCurrency(
    repositories: AgentRepositories,
    userId: string,
    parsed: TransactionalIntent,
  ): Promise<TransactionalIntent> {
    if (parsed.type !== "SEND" || !parsed.amount || parsed.amount.currencyOrAsset) return parsed;
    const home = (await repositories.users.findById(userId))?.homeCurrency;
    if (!home) return parsed;
    return { ...parsed, amount: { ...parsed.amount, currencyOrAsset: home } };
  }

  /** Greetings, help and balance questions answered while a payment is open say which payment is still waiting. */
  private async withResume(
    repositories: AgentRepositories,
    conversation: Conversation,
    active: Intent | null,
    intent: AgentIntent,
    applied: Applied,
  ): Promise<Applied> {
    const isSide =
      (intent.type === "HELP" &&
        !(
          isChatTopic(intent.topic) &&
          (intent.topic === "FAREWELL" || intent.topic === "RATE_GENERAL")
        )) ||
      intent.type === "BALANCE";
    if (!isSide) return applied;
    const resume = await this.resumeOf(repositories, conversation, active);
    return resume ? { ...applied, resume } : applied;
  }

  /**
   * A rate question beside an open payment. The payment is left exactly as it was (no revision, no new intent, no route, no
   * authorization); the price is asked for afterwards, outside the transaction, and nothing about it is stored.
   */
  private async applySideQuote(
    repositories: AgentRepositories,
    conversation: Conversation,
    quote: Extract<AgentIntent, { type: "QUOTE" }>,
    active: Intent,
  ): Promise<Applied> {
    const mergeKind = "SIDE_QUOTE";
    const resume = await this.resumeOf(repositories, conversation, active);
    const answer = (response: AgentResponse): Applied => ({
      response,
      mergeKind,
      ...(resume && { resume }),
    });
    if (!this.deps.sideQuotesEnabled) {
      return answer({
        type: "ERROR",
        code: "FEATURE_NOT_AVAILABLE",
        text: "Rates aren't available yet.",
      });
    }
    const askForPair = answer({
      type: "MESSAGE",
      text: "Which pair should I check? Tell me both sides, like “USDT to cNGN”.",
    });
    const resolvers = this.deps.createResolvers(repositories);
    const assessment = await assessIntent(quote, {
      userId: conversation.userId,
      assets: resolvers.assets,
      recipients: resolvers.recipients,
      countries: this.deps.countries,
    });
    if (assessment.status !== "READY") return askForPair;
    const now = this.deps.now();
    const state = buildIntentState({
      id: createId(),
      userId: conversation.userId,
      conversationId: conversation.id,
      parsed: quote,
      assessment,
      recipientId: undefined,
    });
    const request = buildRoutingRequest({ ...state, createdAt: now, updatedAt: now });
    if (!request) return askForPair;
    return answer({
      type: "SIDE_QUOTE_REQUIRED",
      text: "Let me check that rate for you 👀",
      request,
    });
  }

  /**
   * "Continue" under a side answer. It restates the payment that is open, from stored state, exactly as the person left it:
   * the same intent and revision, asking again for whatever it was waiting for, or priced again if it was ready (an expired
   * price is re-priced, never reused). If that payment is gone (cancelled, expired, replaced) nothing is resurrected.
   */
  private async resumePayment(
    repositories: AgentRepositories,
    conversation: Conversation,
    active: Intent | null,
    intentId: string | undefined,
  ): Promise<Applied> {
    const parsed = active?.parsed;
    if (
      !active ||
      !parsed ||
      !isTransactionalIntent(parsed) ||
      parsed.type === "QUOTE" ||
      (intentId !== undefined && active.id !== intentId)
    ) {
      return {
        response: {
          type: "MESSAGE",
          text: "That payment isn't open any more. Tell me what you'd like to do.",
        },
        mergeKind: "RESUME_STALE",
      };
    }
    return this.advance(repositories, {
      conversation,
      parsed,
      target: active,
      restate: true,
      mergeKind: "RESUME",
    });
  }

  /** Checks an option against server state. Nothing is changed. */
  async verifyChoice(
    repositories: AgentRepositories,
    conversation: Conversation,
    optionId: string,
  ): Promise<{ active: Intent | null; verdict: ChoiceVerdict }> {
    const active = await findActiveIntent(repositories, conversation.id);
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
    // An amount with no currency is in the person's home currency, unless a currency was named in this message or already
    // established by the payment being changed (both are already in `parsed` by now, so they win).
    const parsedWithHome = await this.withHomeCurrency(repositories, conversation.userId, parsed);
    const assessment = await assessIntent(parsedWithHome, {
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
                parsed: parsedWithHome,
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
        response: {
          ...(await this.ask(repositories, conversation, saved, first, args.prefix)),
          known: knownFacts(assessment.facts, parsed),
        },
      };
    }

    const summary = summarizeIntent(parsedWithHome, assessment.facts);
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
        // A conversational turn names its topic; a plain "help" does not and keeps the capability summary.
        if (isChatTopic(intent.topic)) {
          return {
            response: { type: "CHAT", topic: intent.topic, text: chatFallbackText(intent.topic) },
            mergeKind,
            // "Which rate should I check?" is a question: the next message is first read as the pair that answers it.
            ...(intent.topic === "RATE_GENERAL" && {
              focus: {
                kind: "RATE_PAIR" as const,
                setAt: this.deps.now().toISOString(),
                ...(active && { intentId: active.id, intentRevision: active.revision }),
              },
            }),
          };
        }
        return { response: { type: "MESSAGE", text: HELP_TEXT }, mergeKind };

      case "BALANCE":
        if (this.deps.balancesEnabled) {
          return {
            response: {
              type: "BALANCE_REQUIRED",
              text: "Checking your wallet…",
              ...(intent.asset && { asset: intent.asset }),
            },
            mergeKind,
          };
        }
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
