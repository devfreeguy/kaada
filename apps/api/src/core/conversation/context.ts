import type { ConversationTurn } from "@kaada/domain";

import { availableCapabilities } from "./capabilities.js";
import type { CapabilityFlags, SuggestionId } from "./capabilities.js";
import { STATE_INSTRUCTIONS } from "./instructions.js";
import type { StateInstruction } from "./instructions.js";
import { SERIOUS_STATES } from "./states.js";
import type { ResponseState } from "./states.js";

/**
 * Everything the presentation model is allowed to know, as structured data. It is built from the Agent Core's trusted
 * response and a few recent turns, never from the whole conversation, so tokens stay bounded and an old message cannot steer
 * a current financial decision. The model receives this as TRUSTED_STATE, apart from the policy and apart from the user's text.
 */
export interface ConversationResponseContext {
  responseState: ResponseState;
  /** The latest message from the person. UNTRUSTED. */
  userMessage: string;
  /** The last few turns, oldest first, each clipped. UNTRUSTED (it contains the person's words). */
  recentMessages: { role: "USER" | "KAADA"; text: string }[];
  /** One line of where things stand, built by the application. */
  conversationSummary: string;
  /** What the application has understood about the operation in progress, as display strings. */
  knownFacts: Record<string, string>;
  missingFields: string[];
  availableActions: { id: SuggestionId; label: string }[];
  supportedCapabilities: { id: SuggestionId; description: string }[];
  /** The only suggestion ids the reply may name. */
  allowedSuggestions: SuggestionId[];
  forbiddenClaims: string[];
  user: { firstName?: string };
  /** What the application renders itself, so the model knows to leave it out. */
  financialFacts: "RENDERED_BY_APPLICATION" | "NONE";
  responseObjective: StateInstruction;
  tonePolicy: { humor: "ALLOWED" | "FORBIDDEN"; emoji: "SPARING"; maxSentences: number };
  responseConstraints: string[];
}

/** Turns of history sent along: enough to follow "yes, that one", never enough to carry an old topic into a new decision. */
export const CONTEXT_LIMITS = { maxTurns: 4, maxTurnChars: 160, maxMessageChars: 400 } as const;

const FORBIDDEN_CLAIMS = [
  "that a payment was sent, completed, successful, failed, refunded, authorized or approved",
  "any amount, rate, fee, balance, quote, time or recipient not in knownFacts",
  "that Kaada can do anything not in supportedCapabilities",
  "that you will do something yourself (send, approve, authorize)",
];

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

export interface BuildContextInput {
  state: ResponseState;
  userMessage: string;
  history: readonly ConversationTurn[];
  flags: CapabilityFlags;
  allowedSuggestions: readonly SuggestionId[];
  knownFacts?: Record<string, string>;
  missingFields?: string[];
  firstName?: string | undefined;
  hasFinancialBlock: boolean;
}

export function buildResponseContext(input: BuildContextInput): ConversationResponseContext {
  const instruction = STATE_INSTRUCTIONS[input.state];
  if (!instruction) throw new Error(`state ${input.state} is not worded by a model`);
  const capabilities = availableCapabilities(input.flags);
  const knownFacts = input.knownFacts ?? {};
  const missing = input.missingFields ?? [];

  const summary =
    Object.keys(knownFacts).length === 0 && missing.length === 0
      ? "Nothing is in progress."
      : `A payment is being set up. Known: ${
          Object.entries(knownFacts)
            .map(([key, value]) => `${key}=${value}`)
            .join(", ") || "nothing yet"
        }. Missing: ${missing.join(", ") || "nothing"}.`;

  return {
    responseState: input.state,
    userMessage: clip(input.userMessage, CONTEXT_LIMITS.maxMessageChars),
    recentMessages: input.history.slice(-CONTEXT_LIMITS.maxTurns).map((turn) => ({
      role: turn.role === "USER" ? "USER" : "KAADA",
      text: clip(turn.content, CONTEXT_LIMITS.maxTurnChars),
    })),
    conversationSummary: summary,
    knownFacts,
    missingFields: missing,
    availableActions: capabilities
      .filter((capability) => input.allowedSuggestions.includes(capability.id))
      .map((capability) => ({ id: capability.id, label: capability.label })),
    supportedCapabilities: capabilities.map((capability) => ({
      id: capability.id,
      description: capability.blurb,
    })),
    allowedSuggestions: [...input.allowedSuggestions],
    forbiddenClaims: FORBIDDEN_CLAIMS,
    user: input.firstName ? { firstName: input.firstName } : {},
    financialFacts: input.hasFinancialBlock ? "RENDERED_BY_APPLICATION" : "NONE",
    responseObjective: instruction,
    tonePolicy: {
      humor: SERIOUS_STATES.has(input.state) ? "FORBIDDEN" : "ALLOWED",
      emoji: "SPARING",
      maxSentences: instruction.maxSentences,
    },
    responseConstraints: [
      ...instruction.rules,
      instruction.needsQuestion
        ? "End by handing the turn back with one short question."
        : "Do not add extra questions.",
      `At most ${String(instruction.maxSentences)} short sentence(s) in total.`,
    ],
  };
}
