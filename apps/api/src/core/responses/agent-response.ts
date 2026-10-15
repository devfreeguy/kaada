import type { AmountMode, ChatTopic, MissingField, RoutingRequest } from "@kaada/domain";

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
  /** What the application has understood so far, as display strings ("recipient": "Daniel", "amount": "20"). */
  known?: Record<string, string>;
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
 * What a person is asked to authorize with their PIN, in channel-neutral terms. Every figure is the
 * same number the authorization will bind: the maximum spend and the minimum receive are the limits a
 * later execution may not cross.
 */
export interface AuthorizationSummary {
  amountMode: AmountMode;
  recipient?: string;
  /** The estimated spend (EXACT_INPUT: exactly this). */
  senderSpends: MoneyView;
  /** The most that may leave the wallet. */
  maximumSpend: MoneyView;
  /** The estimated amount received (EXACT_OUTPUT: exactly this). */
  recipientReceives: MoneyView;
  /** The least the recipient receives. */
  minimumReceive: MoneyView;
}

/**
 * A priced PAYMENT is ready and now needs the person's PIN. This replaces PAYMENT_READY whenever a
 * wallet is configured. It carries a REFERENCE to the authorization session, never a link or token:
 * those are bearer secrets, and this response is stored in the conversation history. The channel asks
 * for a link (AuthorizationSessionService.issueLink) when it renders its "Authorize payment" button.
 * The price is indicative; a firm price is only requested after authorization.
 */
export interface AuthorizationRequiredResponse {
  type: "AUTHORIZATION_REQUIRED";
  text: string;
  intentId: string;
  revision: number;
  routeId: string;
  authorizationSessionId: string;
  /** ISO time after which the session (and so the PIN screen) can no longer be used. */
  expiresAt: string;
  summary: AuthorizationSummary;
  fees: MoneyView[];
  slippageBps: number;
  /** True when the prices came from the development mock provider and are not real. */
  mock?: boolean;
  indicative?: boolean;
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
  /** True when the price is indicative (not a firm, reserved quote). */
  indicative?: boolean;
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
  indicative?: boolean;
  /** Priced beside an open payment: nothing was stored, and the ids here describe no stored intent or route. */
  side?: boolean;
}

/**
 * A conversational turn (a greeting, thanks, "what can you do?", an off-topic question). It carries NO financial data: `text`
 * is only the plain fallback wording, and the conversation layer may phrase the reply itself. Nothing about any operation in
 * progress changes.
 */
export interface ChatResponse {
  type: "CHAT";
  topic: ChatTopic;
  text: string;
}

/** The person asked for their balance; the agent reads it (outside any transaction) and answers with BALANCE_RESULT. */
export interface BalanceRequiredResponse {
  type: "BALANCE_REQUIRED";
  text: string;
  /** A token the person named ("my USDT balance"), as written. Used only to filter what is shown. */
  asset?: string;
}

/** What the wallet holds of the supported tokens, read fresh from the chain. `text` is the deterministic block. */
export interface BalanceResultResponse {
  type: "BALANCE_RESULT";
  text: string;
  lines: {
    symbol: string;
    display: string;
    fiatCode?: string;
    decimals?: number;
    amount?: string;
  }[];
  /** The wallet holds none of the supported tokens: the answer leads to funding, not to a dead end. */
  empty?: boolean;
  /** The person asked about this token and holds none of it. */
  missingAsset?: string;
}

/**
 * A price question asked BESIDE an open payment ("what's the USDT to cNGN rate?"). It is priced without writing anything, so the
 * payment in progress is untouched. The agent prices it outside any transaction and answers with QUOTE_RESULT (side: true).
 */
export interface SideQuoteRequiredResponse {
  type: "SIDE_QUOTE_REQUIRED";
  text: string;
  request: RoutingRequest;
}

/**
 * The payment that was open when a side question was answered, in display terms, so the conversation can offer to carry on. It is
 * trusted application state (read from the stored intent), never taken from the question or from a model. Pressing "Continue"
 * resumes THIS intent; nothing about it changed while the question was answered.
 */
export interface ResumeInfo {
  intentId: string;
  revision: number;
  operation: "SEND" | "CONVERT";
  recipient?: string;
  amount?: string;
  /** True when the payment still lacks a detail (resuming asks for it again) rather than being ready to price. */
  pending: boolean;
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
  | "ROUTING_STALE"
  /** A payment needs a Kaada wallet and the user has not set one up yet. */
  | "WALLET_SETUP_REQUIRED"
  /** The wallet holds none of the supported assets that could fund this payment. */
  | "WALLET_NEEDS_FUNDING"
  /** The balance could not be read right now. */
  | "BALANCE_UNAVAILABLE"
  /** The money is there but the wallet lacks the little CELO that pays the network fee for this transfer. */
  | "GAS_FUNDING_REQUIRED"
  /** The wallet holds some of the funding asset, but not enough for this payment. */
  | "INSUFFICIENT_BALANCE";

/** The request cannot be honoured, and nothing was changed. Not an exception: a normal outcome. */
export interface ErrorResponse {
  type: "ERROR";
  code: AgentErrorCode;
  text: string;
  /** The token a balance error is about, when there is one ("You're short on USDT"). */
  asset?: string;
}

export type AgentResponse =
  | MessageResponse
  | ClarificationRequiredResponse
  | RoutingRequiredResponse
  | PaymentReadyResponse
  | QuoteResultResponse
  | AuthorizationRequiredResponse
  | CancelledResponse
  | ChatResponse
  | BalanceRequiredResponse
  | BalanceResultResponse
  | SideQuoteRequiredResponse
  | ErrorResponse;
