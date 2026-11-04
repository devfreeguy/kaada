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
  /** Sampling temperature. Default 0 (extraction); presentation uses a little warmth. */
  temperature?: number;
}

export interface GroqChatResult {
  /** The raw assistant message content; null when the model returned none. */
  content: string | null;
  model: string;
  usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export interface GroqTransport {
  chat(request: GroqChatRequest): Promise<GroqChatResult>;
  /**
   * The reply as plain text, chunk by chunk (no JSON schema: Groq returns a schema-constrained reply as ONE chunk, so a
   * structured reply cannot be shown as it is written). Optional.
   */
  chatStream?(request: GroqChatRequest): AsyncIterable<string>;
}

export type GroqTransportErrorKind =
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "UNAVAILABLE"
  | "AUTH"
  | "BAD_REQUEST"
  /** Groq rejected what the model generated for not matching the schema (json_validate_failed). */
  | "INVALID_OUTPUT";

/**
 * Which of Groq's quotas a 429 came from: tokens or requests, per minute or per day.
 *
 * This matters because the two behave nothing alike. A per-minute refusal clears by waiting a minute, so pacing fixes it.
 * A per-day refusal does not clear by waiting, and no pacing fixes it: the budget is simply spent. Told apart only by the
 * word "RATE_LIMITED", the two are indistinguishable, and a spent daily budget reads as a throughput problem — which is
 * exactly the wrong conclusion, and an expensive one, since the cure for it (slow down) cannot work.
 */
export type GroqRateLimitScope =
  /** Tokens per day. */
  | "TPD"
  /** Tokens per minute. */
  | "TPM"
  /** Requests per day. */
  | "RPD"
  /** Requests per minute. */
  | "RPM";

/**
 * A failed call to Groq, reduced to a kind and status. It deliberately carries no request data.
 *
 * `scope` is the sole exception, and it is safe: it is one of four compile-time constants, chosen by matching Groq's reply
 * against that closed set. Nothing is copied out of the reply, so neither the prompt nor the organisation identifier and
 * usage figures Groq includes in its message can travel with it.
 */
export class GroqTransportError extends Error {
  override readonly name = "GroqTransportError";
  constructor(
    readonly kind: GroqTransportErrorKind,
    readonly status?: number,
    readonly scope?: GroqRateLimitScope,
  ) {
    super(
      `Groq request failed: ${kind}${status === undefined ? "" : ` (${status})`}${
        scope === undefined ? "" : ` [${scope}]`
      }`,
    );
  }
}
