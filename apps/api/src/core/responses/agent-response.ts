import type { AmountMode, MissingField, PaymentConfirmation, RoutingRequest } from "@kaada/domain";

/**
 * The channel-independent result of one agent turn. Telegram, WhatsApp and web each render these
 * their own way; none of them should parse `text` to decide what to do, and none of them is known
 * to this model.
 */

export type ClarificationReason = "MISSING" | "AMBIGUOUS" | "NOT_FOUND" | "INVALID";

/**
 * A selectable answer, as a channel sees it: an opaque id and something to show. What the option
 * means is held by the server and looked up when the id comes back. The id is the only thing a
 * channel returns, and returning it proves nothing by itself.
 */
export interface ClarificationOption {
  id: string;
  label: string;
  /** A short line that tells similar options apart ("@daniel_o"). Never a private identifier. */
  description?: string;
}

export interface MessageResponse {
  type: "MESSAGE";
  text: string;
}

export interface ClarificationRequiredResponse {
  type: "CLARIFICATION_REQUIRED";
  text: string;
  intentId: string;
  field: MissingField;
  reason: ClarificationReason;
  /** When present, the user may answer by picking one of these instead of typing. */
  options?: ClarificationOption[];
}

/** What was understood, in terms a channel can show without parsing text. No prices, no routes. */
export interface IntentSummary {
  operation: "SEND" | "CONVERT" | "QUOTE";
  recipient?: string;
  /** The fixed side, formatted for people, and which side that is. */
  amount: { display: string; mode: AmountMode };
  /** "Use USDT": an explicit funding preference, shown separately from the amount. */
  preferredSourceAsset?: string;
  destination?: { code: string; label: string };
}

/**
 * The intent has everything needed to plan a route. `purpose` says whether that route is for a real
 * payment or only to answer a quote question; a QUOTE never proceeds to authorization.
 *
 * `request` is the hand-off for route planning: it states what the user wants and nothing a provider
 * decided (no rate, fee, route or provider). It is valid only for `revision`; if the intent changes,
 * a new ROUTING_REQUIRED supersedes it.
 */
export interface RoutingRequiredResponse {
  type: "ROUTING_REQUIRED";
  text: string;
  intentId: string;
  purpose: "PAYMENT" | "QUOTE";
  revision: number;
  summary: IntentSummary;
  request: RoutingRequest;
}

/**
 * CONTRACT ONLY - nothing produces this yet. A later build returns it once a route has been priced
 * and a payment summary exists, to ask the user to authorize that specific payment.
 */
export interface AuthorizationRequiredResponse {
  type: "AUTHORIZATION_REQUIRED";
  text: string;
  intentId: string;
  /** What the user is being asked to approve. */
  confirmation: PaymentConfirmation;
}

export interface CancelledResponse {
  type: "CANCELLED";
  text: string;
  intentId?: string;
}

export type AgentErrorCode =
  | "CHOICE_UNKNOWN"
  | "CHOICE_EXPIRED"
  | "CHOICE_ALREADY_USED"
  | "CHOICE_STALE"
  | "FEATURE_NOT_AVAILABLE";

/** The request cannot be honoured, and nothing was changed. Not an exception: a normal outcome. */
export interface ErrorResponse {
  type: "ERROR";
  code: AgentErrorCode;
  text: string;
}

export type AgentResponse =
  | MessageResponse
  | ClarificationRequiredResponse
  | RoutingRequiredResponse
  | AuthorizationRequiredResponse
  | CancelledResponse
  | ErrorResponse;
