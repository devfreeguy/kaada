import type { ChannelType, MessageRole } from "../conversations/index.js";
import type { PaymentConfirmation } from "../execution/index.js";
import type { AgentIntent } from "../intents/index.js";
import type { FxQuote, QuoteRequest } from "../quotes/index.js";
import type { RampRequest, RampSessionResult } from "./ramp.js";

/*
 * Ports implemented by adapters in @kaada/providers (and channel packages). Contracts speak only
 * domain types: provider DTOs, SDK clients and webhook payloads stay inside the adapter.
 */

export const PROVIDER_EXECUTION_STATUSES = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;
export type ProviderExecutionStatus = (typeof PROVIDER_EXECUTION_STATUSES)[number];

export interface FxExecutionContext {
  executionId: string;
  userId: string;
  idempotencyKey: string;
}

export interface FxExecutionResult {
  /** The provider reference for the execution; pass it back to `status`. */
  providerExecutionId: string;
  status: ProviderExecutionStatus;
}

export interface FxExecutionStatus {
  status: ProviderExecutionStatus;
  failureReason?: string;
}

export interface FxProvider {
  /** Matches Provider.slug, e.g. "textile". */
  readonly id: string;
  /** Whether this provider can price the request. Must not throw for unsupported pairs. */
  supports(request: QuoteRequest): Promise<boolean>;
  quote(request: QuoteRequest): Promise<FxQuote>;
  execute(quote: FxQuote, context: FxExecutionContext): Promise<FxExecutionResult>;
  status(providerExecutionId: string): Promise<FxExecutionStatus>;
}

export interface RampProvider {
  readonly id: string;
  supports(request: RampRequest): Promise<boolean>;
  createOnRamp(request: RampRequest): Promise<RampSessionResult>;
  createOffRamp(request: RampRequest): Promise<RampSessionResult>;
}

export interface ConversationTurn {
  role: Extract<MessageRole, "USER" | "ASSISTANT">;
  content: string;
}

export interface IntentExtractionInput {
  text: string;
  /** Recent turns, oldest first, so follow-ups like "to Maria" can complete an earlier request. */
  history: ConversationTurn[];
  now: Date;
}

export interface ResponseGenerationInput {
  /** Instructions for tone and content. */
  instruction: string;
  history: ConversationTurn[];
}

export interface LlmProvider {
  /** Returns a possibly incomplete intent; implementations validate it before returning. */
  extractIntent(input: IntentExtractionInput): Promise<AgentIntent>;
  generateResponse(input: ResponseGenerationInput): Promise<string>;
}

export interface IncomingMessage {
  channel: ChannelType;
  externalConversationId: string;
  externalMessageId?: string;
  /** The channel id of the sender; maps to Identity.externalId. */
  externalUserId: string;
  username?: string;
  text: string;
  receivedAt: Date;
}

export interface ChannelTarget {
  externalConversationId: string;
}

export interface OutgoingMessage {
  text: string;
}

export interface ChannelAdapter {
  readonly channel: ChannelType;
  /** Converts a raw webhook payload; null for payloads that are not user messages. */
  parseIncoming(payload: unknown): Promise<IncomingMessage | null>;
  sendMessage(target: ChannelTarget, message: OutgoingMessage): Promise<void>;
  sendConfirmation(target: ChannelTarget, confirmation: PaymentConfirmation): Promise<void>;
}
