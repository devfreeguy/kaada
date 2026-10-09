/**
 * The narrow seam between Kaada and Groq. The interpreter talks only to this interface, so tests use
 * a fake and the SDK (and its types) never leak into the rest of the application.
 */

export interface GroqChatRequest {
  model: string;
  system: string;
  user: string;
  /** Name of the JSON schema, shown to the model. */
  schemaName: string;
  /** A JSON Schema acceptable to Groq strict structured output. */
  schema: Record<string, unknown>;
  /** Upper bound on generated tokens (including any reasoning tokens). */
  maxCompletionTokens: number;
  timeoutMs: number;
}

export interface GroqChatResult {
  /** The raw assistant message content; null when the model returned none. */
  content: string | null;
  model: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface GroqTransport {
  chat(request: GroqChatRequest): Promise<GroqChatResult>;
}

export type GroqTransportErrorKind =
  "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "AUTH" | "BAD_REQUEST";

/** A failed call to Groq, reduced to a kind and status. It deliberately carries no request data. */
export class GroqTransportError extends Error {
  override readonly name = "GroqTransportError";
  constructor(
    readonly kind: GroqTransportErrorKind,
    readonly status?: number,
  ) {
    super(`Groq request failed: ${kind}${status === undefined ? "" : ` (${status})`}`);
  }
}
