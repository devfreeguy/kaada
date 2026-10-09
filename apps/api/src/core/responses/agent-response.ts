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

/** An amount for display, with the exact smallest-unit value and asset it came from. */
export interface MoneyView {
  amount: string;
  assetId: string;
  symbol: string;
  /** Human text such as "92.25 USDT". Never used for arithmetic. */
  display: string;
}

/** The path of a route, in order. Empty hops mean a plain transfer (same asset on both sides). */
export interface RouteSummary {
  hops: { provider: string; from: string; to: string }[];
}

/**
 * Routing found a priced route for a PAYMENT. This is NOT an authorization: it is the summary a later
 * step will ask the user to approve, bound to `routeId` and `revision`. Nothing has been spent or sent.
 *
 * EXACT_INPUT:  the sender spends exactly `senderSpends.expected`; the recipient receives about
 *               `recipientReceives.expected` and at least `min` after slippage.
 * EXACT_OUTPUT: the recipient receives exactly `expected`; the sender spends about `expected` and at
 *               most `senderSpends.max` after slippage.
 */
export interface PaymentReadyResponse {
  type: "PAYMENT_READY";
  text: string;
  intentId: string;
  revision: number;
  routeId: string;
  senderSpends: { expected: MoneyView; max: MoneyView };
  recipientReceives: { expected: MoneyView; min: MoneyView };
  /** Fees per asset; different assets are never added together. */
  fees: MoneyView[];
  slippageBps: number;
  /** ISO time after which the prices are no longer valid. */
  expiresAt: string;
  recipient?: string;
  route: RouteSummary;
  /** True when the prices came from the development mock provider and are not real. */
  mock?: boolean;
}

/** The informational answer to a QUOTE request. It can never be authorized or executed. */
export interface QuoteResultResponse {
  type: "QUOTE_RESULT";
  text: string;
  intentId: string;
  revision: number;
  routeId: string;
  source: MoneyView;
  destination: MoneyView;
  fees: MoneyView[];
  slippageBps: number;
  expiresAt: string;
  route: RouteSummary;
  mock?: boolean;
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
  | "FEATURE_NOT_AVAILABLE"
  /** The settlement assets or providers needed are not supported (see `text`). */
  | "ROUTING_UNSUPPORTED"
  /** Assets are supported but no priced route exists. */
  | "NO_ROUTE"
  /** Pricing providers could not be reached or gave no usable quote. */
  | "ROUTING_UNAVAILABLE"
  /** The request changed while it was being priced; the prices were discarded. */
  | "ROUTING_STALE";

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
  | PaymentReadyResponse
  | QuoteResultResponse
  | AuthorizationRequiredResponse
  | CancelledResponse
  | ErrorResponse;
