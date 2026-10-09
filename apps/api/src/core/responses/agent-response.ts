import type { MissingField, PaymentConfirmation } from "@kaada/domain";

/**
 * The channel-independent result of one agent turn. Telegram, WhatsApp and web each render these
 * their own way; none of them should parse `text` to decide what to do.
 */

export type ClarificationReason = "MISSING" | "AMBIGUOUS" | "NOT_FOUND" | "INVALID";

/** A choice the user can pick from, so channels can render buttons. `id` is stable and opaque. */
export interface ClarificationOption {
  id: string;
  label: string;
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
  options?: ClarificationOption[];
}

/**
 * The intent has everything needed to plan a route. `purpose` says whether that route is for a real
 * payment or only to answer a quote question; a QUOTE never proceeds to authorization.
 */
export interface RoutingRequiredResponse {
  type: "ROUTING_REQUIRED";
  text: string;
  intentId: string;
  purpose: "PAYMENT" | "QUOTE";
}

/**
 * CONTRACT ONLY - nothing produces this in Build 4. A later build returns it once a route has been
 * priced and a payment summary exists, to ask the user to authorize that specific payment.
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

export type AgentResponse =
  | MessageResponse
  | ClarificationRequiredResponse
  | RoutingRequiredResponse
  | AuthorizationRequiredResponse
  | CancelledResponse;
