import type { ConversationTurn } from "@kaada/domain";

import type { OnboardingFacts, OnboardingStep } from "../onboarding/state.js";
import type { ResumeInfo } from "../responses/agent-response.js";
import { resumeLine } from "./resume.js";
import { FUNDING_NONE } from "./funding.js";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { presentAgentResponse } from "../channels/presenter.js";
import type { PresentedMessage } from "../channels/presenter.js";
import type { AgentResponse } from "../responses/agent-response.js";
import type { CapabilityFlags, SuggestionId } from "./capabilities.js";
import { buildResponseContext } from "./context.js";
import { fallbackParts, joinParts, resultFallback } from "./fallbacks.js";
import type { FallbackFacts, ReplyParts } from "./fallbacks.js";
import { buildConversationPrompt } from "./prompt.js";
import type { ConversationPrompt } from "./prompt.js";
import { screenText, validateReply, validateStreamedText } from "./reply.js";
import { STATE_MODE, STREAMABLE_STATES, deriveResponseState } from "./states.js";
import type { PresentationMode, ResponseState } from "./states.js";
import { STATE_INSTRUCTIONS } from "./instructions.js";
import { MAX_SUGGESTIONS, suggestionPolicy } from "./suggestions.js";

/**
 * The model behind the presenter. It receives a prompt and the suggestion allowlist and returns the model's raw JSON; it never
 * sees the database and has no tools. Absent (or failing, or slow) means the deterministic wording is used.
 */
export interface ConversationWriter {
  write(prompt: ConversationPrompt, allowedSuggestions: readonly SuggestionId[]): Promise<unknown>;
  /**
   * Optional: the same reply as plain text, as it is generated. Used only for conversational states, and every chunk is screened
   * before anything is shown. Absent: the reply is generated whole, as before.
   */
  stream?(
    prompt: ConversationPrompt,
    allowedSuggestions: readonly SuggestionId[],
  ): AsyncIterable<string>;
}

/** Where a partly written reply is shown while the rest is still being generated. The channel decides how (and how often). */
export interface DraftSink {
  push(text: string): void;
}

export interface PresentationInput {
  /** The Agent Core's trusted answer. */
  response: AgentResponse;
  /** The Agent Core's statement that this message changed details it already had. */
  corrected?: readonly string[] | undefined;
  /** What the person wrote (or the label of the button they pressed). Untrusted. */
  userMessage: string;
  history: readonly ConversationTurn[];
  /** Makes variation and caching stable: the stored id of the message being answered. */
  seed: string;
  firstName?: string | undefined;
  now: Date;
  /** Where the person is in onboarding, when known: while incomplete, payments are not offered or suggested. */
  onboardingStep?: OnboardingStep | undefined;
  /** A payment is still open behind this answer (a side question): the reply ends by offering to carry on with it. */
  resume?: ResumeInfo | undefined;
  /** If given, conversational wording is shown here as it is generated (see STREAMABLE_STATES). Never for facts. */
  draft?: DraftSink | undefined;
}

/** What the person is being told about their setup, and why now. */
export interface OnboardingPresentationInput {
  state:
    | "ONBOARDING_WALLET_NEEDED"
    | "ONBOARDING_PIN_NEEDED"
    | "ONBOARDING_RECOVERY_NEEDED"
    | "ONBOARDING_COMPLETE"
    | "RETURNING_USER";
  /** JUST_CREATED (it just happened), RESUMING (they came back mid-setup), CHECK_IN (they asked if they are done). */
  context: "JUST_CREATED" | "RESUMING" | "CHECK_IN";
  facts: OnboardingFacts;
  userMessage: string;
  history: readonly ConversationTurn[];
  seed: string;
  firstName?: string | undefined;
  /** Fixed wording only: no model call, however the state is normally worded. /start uses it so it is always instant. */
  instant?: boolean;
}

/** The slice of a request the model-phrasing step needs. */
interface PhraseInput {
  userMessage: string;
  history: readonly ConversationTurn[];
  seed: string;
  firstName?: string | undefined;
  missingFields?: string[];
  /** The reply is followed by the application's "continue the payment?" line, so it must not end with a question of its own. */
  resuming?: boolean;
}

export interface ConversationPresenterDeps {
  writer: ConversationWriter | null;
  flags: CapabilityFlags;
  /** The longest the person waits for the model before the deterministic wording is used. */
  timeoutMs?: number;
  log?: AgentLog;
}

interface Phrased {
  parts: ReplyParts;
  suggestions: SuggestionId[];
}

const CACHE_LIMIT = 256;

/** A streamed chunk failed the same screen the finished reply faces: the draft stops and the fixed wording is used. */
class StreamRefused extends Error {
  override readonly name = "StreamRefused";
  constructor(readonly reason: string) {
    super(`streamed text refused: ${reason}`);
  }
}

/**
 * The conversational presentation of an agent turn. Channel-neutral: it returns words and semantic suggestions, and never
 * markdown, buttons or provider markup.
 *
 *   FINANCIAL TRUTH (Agent Core / services)  ->  state  ->  [model phrases lead/closing, validated]  ->  PresentedMessage
 *
 * The financial block of a message (summary, rate, balance) is always rendered by the application. The model can only add a
 * lead and a closing around it, or, for non-financial states, write the short reply; everything it returns is validated, and
 * anything unexpected (or any failure) falls back to fixed wording. The model cannot create actions, claim an outcome or
 * introduce a figure.
 */
export class ConversationPresenter {
  private readonly log: AgentLog;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, Phrased>();

  constructor(private readonly deps: ConversationPresenterDeps) {
    this.log = deps.log ?? noopLog;
    this.timeoutMs = deps.timeoutMs ?? 4_000;
  }

  /** The deployment's capability flags (what Kaada can really do here). */
  get flags(): CapabilityFlags {
    return this.deps.flags;
  }

  /**
   * Until onboarding is complete nothing that needs a wallet and a PIN is offered, suggested or described as available:
   * the flags are narrowed from the trusted onboarding step, never from what the person said.
   */
  private effectiveFlags(step: OnboardingStep | undefined): CapabilityFlags {
    if (!step || step === "COMPLETE") return this.deps.flags;
    return {
      ...this.deps.flags,
      send: false,
      balance: false,
      funding: { walletTransfer: false, localCurrency: false },
    };
  }

  /** "How would you like to fund your wallet?" with exactly the funding methods that exist (none: an honest "not yet"). */
  presentFundingOptions(seed: string): PresentedMessage {
    const suggestions = suggestionPolicy("FUNDING_OPTIONS", this.deps.flags);
    if (suggestions.length === 0) return { text: FUNDING_NONE };
    const parts = fallbackParts("FUNDING_OPTIONS", { capabilities: this.deps.flags }, seed);
    return { text: joinParts(parts ?? {}, ORDER), suggestions };
  }

  /** A message about the person's setup. The facts are trusted application state; the model only phrases them. */
  async presentOnboarding(input: OnboardingPresentationInput): Promise<PresentedMessage> {
    const { state } = input;
    const step: OnboardingStep =
      state === "ONBOARDING_COMPLETE" || state === "RETURNING_USER"
        ? "COMPLETE"
        : state === "ONBOARDING_WALLET_NEEDED"
          ? "WALLET"
          : state === "ONBOARDING_PIN_NEEDED"
            ? "PIN"
            : "RECOVERY";
    const flags = this.effectiveFlags(step);
    const known: Record<string, string> = {
      context: input.context,
      walletReady: input.facts.walletReady ? "yes" : "no",
      pinConfigured: input.facts.pinConfigured ? "yes" : "no",
      pinLength: "6",
    };
    const facts: FallbackFacts = { capabilities: flags, context: input.context };
    const policy = suggestionPolicy(state, flags);
    const link: PresentedMessage["link"] =
      state === "ONBOARDING_WALLET_NEEDED"
        ? { kind: "WALLET_SETUP", label: "Set up Kaada" }
        : state === "ONBOARDING_PIN_NEEDED"
          ? {
              kind: "PIN_SETUP",
              label: input.context === "RESUMING" ? "Continue setup" : "Set up PIN",
            }
          : undefined;

    const phrased =
      STATE_MODE[state] === "DETERMINISTIC" || input.instant === true
        ? { parts: fallbackParts(state, facts, input.seed) ?? {}, suggestions: policy }
        : await this.phrase(input, state, "MODEL_FULL", known, policy, facts, flags);
    const chosen = phrased.suggestions.slice(0, MAX_SUGGESTIONS);
    return {
      text: joinParts(phrased.parts, ORDER),
      ...(link && { link }),
      ...(chosen.length > 0 && { suggestions: [...chosen] }),
    };
  }

  async present(input: PresentationInput): Promise<PresentedMessage> {
    const { response } = input;
    const flags = this.effectiveFlags(input.onboardingStep);
    const state = deriveResponseState({ response, corrected: input.corrected });
    const base = presentAgentResponse(response, input.now);
    const mode: PresentationMode = response.type === "CHAT" ? "MODEL_FULL" : STATE_MODE[state];
    const known: Record<string, string> = {
      ...(response.type === "CLARIFICATION_REQUIRED" ? (response.known ?? {}) : {}),
      ...(input.onboardingStep && { onboardingStep: input.onboardingStep }),
    };
    const facts: FallbackFacts = {
      capabilities: flags,
      recipient: known["recipient"],
      amount: known["amount"],
    };
    const policy = suggestionPolicy(state, flags);

    const resume = input.resume;
    if (mode === "DETERMINISTIC") {
      const parts = fallbackParts(state, facts, input.seed);
      return this.finish(base, parts ? joinParts(parts, ORDER) : base.text, policy, resume);
    }

    const streams =
      mode === "MODEL_FULL" &&
      !resume &&
      STREAMABLE_STATES.has(state) &&
      input.draft !== undefined &&
      this.deps.writer?.stream !== undefined;
    const phrase = streams
      ? this.phraseStreaming.bind(this, input.draft as DraftSink)
      : this.phrase.bind(this);
    const phrased = await phrase(
      {
        userMessage: input.userMessage,
        history: input.history,
        seed: input.seed,
        firstName: input.firstName,
        ...(resume && { resuming: true }),
        ...(response.type === "CLARIFICATION_REQUIRED" && { missingFields: [response.field] }),
      },
      state,
      mode,
      known,
      policy,
      facts,
      flags,
    );
    // With a payment waiting, the reply is just the answer: no hand-back question and no "want to send some?" of its own.
    const order: (keyof ReplyParts)[] = resume ? ["acknowledgement", "body"] : ORDER;
    if (mode === "MODEL_FULL") {
      const text = joinParts(phrased.parts, order);
      return this.finish(base, text.length > 0 ? text : base.text, phrased.suggestions, resume);
    }
    const text = [
      phrased.parts.acknowledgement,
      base.text,
      resume ? undefined : phrased.parts.closing,
    ]
      .filter((piece): piece is string => typeof piece === "string" && piece.trim().length > 0)
      .join("\n\n");
    return this.finish(base, text, phrased.suggestions, resume);
  }

  private finish(
    base: PresentedMessage,
    text: string,
    suggestions: readonly SuggestionId[],
    resume?: ResumeInfo,
  ): PresentedMessage {
    if (resume) {
      // The open payment is what the person should do something about: Continue or Cancel, nothing else competes with it.
      return {
        ...base,
        text: `${text}\n\n${resumeLine(resume)}`,
        resume: { intentId: resume.intentId, revision: resume.revision },
        cancellable: true,
      };
    }
    const chosen = suggestions.slice(0, MAX_SUGGESTIONS);
    return { ...base, text, ...(chosen.length > 0 && { suggestions: [...chosen] }) };
  }

  /** The parts of the reply: the model's if it produced a valid one, the deterministic wording otherwise. */
  private async phrase(
    input: PhraseInput,
    state: ResponseState,
    mode: Exclude<PresentationMode, "DETERMINISTIC">,
    known: Record<string, string>,
    policy: SuggestionId[],
    facts: FallbackFacts,
    flags: CapabilityFlags,
  ): Promise<Phrased> {
    const fallback = (): Phrased => ({
      parts:
        state === "RATE_QUERY" && mode === "MODEL_WRAPPED"
          ? resultFallback("RATE_QUERY", facts, input.seed)
          : state === "BALANCE_QUERY"
            ? resultFallback("BALANCE_QUERY", facts, input.seed)
            : (fallbackParts(state, facts, input.seed) ?? {}),
      suggestions: policy,
    });

    const key = `${input.seed}:${state}:${input.resuming ? "resume" : "plain"}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const instruction = STATE_INSTRUCTIONS[state];
    const writer = this.deps.writer;
    if (!writer || !instruction) return this.remember(key, fallback(), state, "NO_MODEL");

    try {
      const context = buildResponseContext({
        state,
        userMessage: input.userMessage,
        history: input.history,
        flags,
        allowedSuggestions: policy,
        knownFacts: known,
        ...(input.missingFields && { missingFields: input.missingFields }),
        firstName: input.firstName,
        hasFinancialBlock: mode === "MODEL_WRAPPED",
      });
      const raw = await this.withTimeout(writer.write(buildConversationPrompt(context), policy));
      const checked = validateReply(raw, {
        mode,
        state,
        flags,
        allowedSuggestions: policy,
        knownFactValues: Object.values(known),
        needsQuestion: instruction.needsQuestion && !input.resuming,
      });
      if (!checked.ok) return this.remember(key, fallback(), state, checked.reason);
      return this.remember(
        key,
        {
          parts: checked.parts,
          suggestions: checked.suggestions.length > 0 ? checked.suggestions : policy,
        },
        state,
        undefined,
      );
    } catch (error) {
      return this.remember(key, fallback(), state, error instanceof Error ? error.name : "ERROR");
    }
  }

  /**
   * The reply, shown while it is written. The text is plain (no JSON), and each chunk is screened up to its last complete word
   * with the same checks as the finished reply, so nothing the final check would refuse is ever shown. On any refusal, error or
   * timeout the draft stops and the fixed wording is used. Suggestions come from the server's policy, never from the stream.
   */
  private async phraseStreaming(
    draft: DraftSink,
    input: PhraseInput,
    state: ResponseState,
    mode: Exclude<PresentationMode, "DETERMINISTIC">,
    known: Record<string, string>,
    policy: SuggestionId[],
    facts: FallbackFacts,
    flags: CapabilityFlags,
  ): Promise<Phrased> {
    const fallback = (): Phrased => ({
      parts: fallbackParts(state, facts, input.seed) ?? {},
      suggestions: policy,
    });
    const key = `${input.seed}:${state}:plain`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const instruction = STATE_INSTRUCTIONS[state];
    const writer = this.deps.writer;
    if (!writer?.stream || !instruction) return this.remember(key, fallback(), state, "NO_MODEL");

    const context = {
      mode,
      state,
      flags,
      allowedSuggestions: policy,
      knownFactValues: Object.values(known),
      needsQuestion: instruction.needsQuestion,
    };
    const stop = { requested: false };
    const consume = async (): Promise<string> => {
      const prompt = buildConversationPrompt(
        buildResponseContext({
          state,
          userMessage: input.userMessage,
          history: input.history,
          flags,
          allowedSuggestions: policy,
          knownFacts: known,
          ...(input.missingFields && { missingFields: input.missingFields }),
          firstName: input.firstName,
          hasFinancialBlock: false,
        }),
        "TEXT",
      );
      let text = "";
      for await (const delta of writer.stream?.(prompt, policy) ?? []) {
        if (stop.requested) break;
        text += delta;
        // Only whole words are screened and shown: "2" is not yet "20", and a half-written word proves nothing.
        const safe = text
          .slice(0, Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n")) + 1)
          .trimEnd();
        if (safe.length === 0) continue;
        const refused = screenText(safe, context);
        if (refused) throw new StreamRefused(refused);
        draft.push(safe);
      }
      return text;
    };
    try {
      const text = await this.withTimeout(consume());
      const checked = validateStreamedText(text.trim(), context);
      if (!checked.ok) return this.remember(key, fallback(), state, checked.reason);
      return this.remember(key, { parts: checked.parts, suggestions: policy }, state, undefined);
    } catch (error) {
      stop.requested = true;
      const reason =
        error instanceof StreamRefused
          ? error.reason
          : error instanceof Error
            ? error.name
            : "ERROR";
      return this.remember(key, fallback(), state, reason);
    }
  }

  private remember(
    key: string,
    phrased: Phrased,
    state: ResponseState,
    fallbackReason: string | undefined,
  ): Phrased {
    this.log(fallbackReason ? "warn" : "info", "conversation.presented", {
      state,
      source: fallbackReason ? "FALLBACK" : "MODEL",
      ...(fallbackReason && { reason: fallbackReason }),
    });
    // Only a successful model reply is remembered: a transient failure must not pin the plain wording to this message.
    if (!fallbackReason || fallbackReason === "NO_MODEL") {
      if (this.cache.size >= CACHE_LIMIT) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, phrased);
    }
    return phrased;
  }

  private withTimeout<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("the presentation model did not answer in time");
        error.name = "PresentationTimeout";
        reject(error);
      }, this.timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}

const ORDER: (keyof ReplyParts)[] = ["acknowledgement", "body", "question", "closing"];
