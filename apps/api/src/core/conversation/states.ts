import type { AgentResponse } from "../responses/agent-response.js";

/**
 * Every situation Kaada can be in when it speaks. The state is derived ONLY from the Agent Core's typed response (never by
 * reading text), so the conversation layer can phrase a reply but never decide what happened.
 */
export const RESPONSE_STATES = [
  "CASUAL_GREETING",
  "CASUAL_FINANCE_CHAT",
  "CAPABILITY_DISCOVERY",
  "FINANCIAL_QUESTION",
  "RATE_QUERY",
  /** A rate was asked for without saying which pair. Nothing is shown; the person is asked which one. */
  "RATE_PAIR_NEEDED",
  "BALANCE_QUERY",
  /** The wallet holds nothing (or none of the asked token): the answer leads to funding. */
  "BALANCE_EMPTY",
  "RECENT_TRANSACTIONS_QUERY",
  "PAYMENT_INTENT_STARTED",
  "MISSING_RECIPIENT",
  "MISSING_AMOUNT",
  "MISSING_CURRENCY",
  "AMBIGUOUS_RECIPIENT",
  "AMBIGUOUS_ASSET",
  "PAYMENT_CORRECTION",
  "PAYMENT_READY",
  "AUTHORIZATION_REQUIRED",
  "ROOT_ACTION_REQUIRED",
  "PAYMENT_PROCESSING",
  "PAYMENT_PENDING",
  "PAYMENT_COMPLETED",
  "PAYMENT_FAILED",
  "INSUFFICIENT_BALANCE",
  "NO_ROUTE",
  "QUOTE_EXPIRED",
  "CANCELLED",
  "CONVERSATION_END",
  "OUT_OF_SCOPE",
  /** First contact: the person has no wallet yet. Fixed welcome, with the secure setup button. */
  "ONBOARDING_WALLET_NEEDED",
  /** The wallet exists; the PIN is the next step. */
  "ONBOARDING_PIN_NEEDED",
  /** Only when recovery is required for onboarding (see SETTINGS.onboarding). */
  "ONBOARDING_RECOVERY_NEEDED",
  /** Everything required is done: the person can use Kaada. */
  "ONBOARDING_COMPLETE",
  /** Someone fully set up says hello again. */
  "RETURNING_USER",
  /** "How would you like to fund your wallet?" (only the methods that really exist). */
  "FUNDING_OPTIONS",
  /** The trusted funding details (address, network, supported tokens). */
  "FUNDING_INFO",
  /** Anything else the Agent Core says ("I didn't catch that", "pricing is unavailable"): its own words are used. */
  "GENERAL_MESSAGE",
] as const;
export type ResponseState = (typeof RESPONSE_STATES)[number];

/**
 * How a state is worded.
 * - MODEL_FULL:    the model may write the whole (short) reply. Nothing in it is a financial fact.
 * - MODEL_WRAPPED: the model writes a lead and a closing around a block the APPLICATION renders. The block's values are never
 *                  the model's.
 * - DETERMINISTIC: no model call. Fixed (varied by a stable seed) wording, or the Agent Core's own text. Used wherever money
 *                  may be at risk, a status is being reported, or a model would only add latency.
 */
export type PresentationMode = "MODEL_FULL" | "MODEL_WRAPPED" | "DETERMINISTIC";

export const STATE_MODE: Record<ResponseState, PresentationMode> = {
  CASUAL_GREETING: "MODEL_FULL",
  CASUAL_FINANCE_CHAT: "MODEL_FULL",
  CAPABILITY_DISCOVERY: "MODEL_FULL",
  FINANCIAL_QUESTION: "MODEL_FULL",
  OUT_OF_SCOPE: "MODEL_FULL",
  RATE_QUERY: "MODEL_WRAPPED",
  RATE_PAIR_NEEDED: "MODEL_FULL",
  BALANCE_QUERY: "MODEL_WRAPPED",
  BALANCE_EMPTY: "DETERMINISTIC",
  RECENT_TRANSACTIONS_QUERY: "DETERMINISTIC",
  PAYMENT_INTENT_STARTED: "DETERMINISTIC",
  MISSING_RECIPIENT: "MODEL_FULL",
  MISSING_AMOUNT: "MODEL_FULL",
  MISSING_CURRENCY: "MODEL_FULL",
  AMBIGUOUS_RECIPIENT: "MODEL_WRAPPED",
  AMBIGUOUS_ASSET: "MODEL_WRAPPED",
  PAYMENT_CORRECTION: "MODEL_WRAPPED",
  PAYMENT_READY: "MODEL_WRAPPED",
  AUTHORIZATION_REQUIRED: "MODEL_WRAPPED",
  ROOT_ACTION_REQUIRED: "DETERMINISTIC",
  PAYMENT_PROCESSING: "DETERMINISTIC",
  PAYMENT_PENDING: "DETERMINISTIC",
  PAYMENT_COMPLETED: "DETERMINISTIC",
  PAYMENT_FAILED: "DETERMINISTIC",
  INSUFFICIENT_BALANCE: "DETERMINISTIC",
  NO_ROUTE: "DETERMINISTIC",
  QUOTE_EXPIRED: "DETERMINISTIC",
  CANCELLED: "DETERMINISTIC",
  CONVERSATION_END: "DETERMINISTIC",
  GENERAL_MESSAGE: "DETERMINISTIC",
  ONBOARDING_WALLET_NEEDED: "DETERMINISTIC",
  ONBOARDING_PIN_NEEDED: "MODEL_FULL",
  ONBOARDING_RECOVERY_NEEDED: "MODEL_FULL",
  ONBOARDING_COMPLETE: "MODEL_FULL",
  RETURNING_USER: "MODEL_FULL",
  FUNDING_OPTIONS: "DETERMINISTIC",
  FUNDING_INFO: "DETERMINISTIC",
};

/**
 * States whose reply is conversational wording only (no figure, status or financial fact), so it may be shown as it is being
 * written. Everything else (summaries, rates, balances, payment progress) appears only once the application has the real values.
 */
export const STREAMABLE_STATES: ReadonlySet<ResponseState> = new Set([
  "CASUAL_GREETING",
  "CASUAL_FINANCE_CHAT",
  "CAPABILITY_DISCOVERY",
  "FINANCIAL_QUESTION",
  "OUT_OF_SCOPE",
  "RATE_PAIR_NEEDED",
  "MISSING_RECIPIENT",
  "MISSING_AMOUNT",
  "MISSING_CURRENCY",
]);

/** States where money may be at risk or an outcome is being reported: no jokes, no lightness. */
export const SERIOUS_STATES: ReadonlySet<ResponseState> = new Set([
  "ONBOARDING_WALLET_NEEDED",
  "ONBOARDING_PIN_NEEDED",
  "ONBOARDING_RECOVERY_NEEDED",
  "PAYMENT_READY",
  "AUTHORIZATION_REQUIRED",
  "PAYMENT_CORRECTION",
  "ROOT_ACTION_REQUIRED",
  "PAYMENT_PROCESSING",
  "PAYMENT_PENDING",
  "PAYMENT_FAILED",
  "INSUFFICIENT_BALANCE",
  "NO_ROUTE",
  "QUOTE_EXPIRED",
  "AMBIGUOUS_RECIPIENT",
  "AMBIGUOUS_ASSET",
]);

const ASSET_FIELDS = new Set(["CURRENCY", "SOURCE_ASSET", "DESTINATION_ASSET"]);

/** The state of one agent turn. `corrected` is the Agent Core's own statement that this message changed a known detail. */
export function deriveResponseState(turn: {
  response: AgentResponse;
  corrected?: readonly string[] | undefined;
}): ResponseState {
  const { response } = turn;
  const corrected = (turn.corrected?.length ?? 0) > 0;
  switch (response.type) {
    case "CHAT":
      switch (response.topic) {
        case "GREETING":
          return "CASUAL_GREETING";
        case "SMALL_TALK":
          return "CASUAL_FINANCE_CHAT";
        case "FAREWELL":
          return "CONVERSATION_END";
        case "CAPABILITIES":
          return "CAPABILITY_DISCOVERY";
        case "FINANCE_QUESTION":
          return "FINANCIAL_QUESTION";
        case "FUNDING":
          return "FUNDING_OPTIONS";
        case "OUT_OF_SCOPE":
          return "OUT_OF_SCOPE";
        case "RATE_GENERAL":
          return "RATE_PAIR_NEEDED";
      }
      return "GENERAL_MESSAGE";
    case "CLARIFICATION_REQUIRED":
      if (corrected) return "PAYMENT_CORRECTION";
      if (response.reason === "AMBIGUOUS") {
        if (response.field === "RECIPIENT") return "AMBIGUOUS_RECIPIENT";
        if (ASSET_FIELDS.has(response.field)) return "AMBIGUOUS_ASSET";
      }
      if (response.reason === "MISSING") {
        if (response.field === "AMOUNT") return "MISSING_AMOUNT";
        if (response.field === "CURRENCY") return "MISSING_CURRENCY";
        if (response.field === "RECIPIENT") return "MISSING_RECIPIENT";
      }
      return "PAYMENT_INTENT_STARTED";
    case "ROUTING_REQUIRED":
      return corrected ? "PAYMENT_CORRECTION" : "PAYMENT_INTENT_STARTED";
    case "AUTHORIZATION_REQUIRED":
      return corrected ? "PAYMENT_CORRECTION" : "AUTHORIZATION_REQUIRED";
    case "PAYMENT_READY":
      return corrected ? "PAYMENT_CORRECTION" : "PAYMENT_READY";
    case "QUOTE_RESULT":
    case "SIDE_QUOTE_REQUIRED":
      return "RATE_QUERY";
    case "BALANCE_RESULT":
      return response.empty || response.missingAsset ? "BALANCE_EMPTY" : "BALANCE_QUERY";
    case "BALANCE_REQUIRED":
      return "BALANCE_QUERY";
    case "CANCELLED":
      return "CANCELLED";
    case "MESSAGE":
      return "GENERAL_MESSAGE";
    case "ERROR":
      switch (response.code) {
        case "INSUFFICIENT_BALANCE":
        case "WALLET_NEEDS_FUNDING":
          return "INSUFFICIENT_BALANCE";
        case "NO_ROUTE":
        case "ROUTING_UNSUPPORTED":
          return "NO_ROUTE";
        case "ROUTING_STALE":
          return "QUOTE_EXPIRED";
        default:
          return "GENERAL_MESSAGE";
      }
  }
}
