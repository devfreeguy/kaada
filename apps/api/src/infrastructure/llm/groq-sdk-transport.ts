import Groq, { APIConnectionTimeoutError, APIError } from "groq-sdk";
import type { ClientOptions } from "groq-sdk";

import { GroqTransportError } from "./groq-transport.js";
import type { GroqChatRequest, GroqChatResult, GroqTransport } from "./groq-transport.js";

/** Reasoning models need explicit settings to answer quickly and without returning their reasoning. */
export function reasoningOptionsFor(
  model: string,
):
  | { reasoning_effort: "low"; include_reasoning: false }
  | { reasoning_effort: "none" }
  | Record<string, never> {
  if (model.startsWith("openai/gpt-oss")) {
    return { reasoning_effort: "low", include_reasoning: false };
  }
  if (model.startsWith("qwen/qwen3")) return { reasoning_effort: "none" };
  return {};
}

export interface GroqSdkTransportOptions {
  apiKey: string;
  /**
   * Retries the SDK may make for connection errors, 408, 409, 429 and 5xx (honouring retry-after).
   * Default 1, so one logical call is at most two HTTP attempts.
   */
  maxRetries?: number;
  /** Replaces the global fetch; used by tests to run without a network. */
  fetch?: ClientOptions["fetch"];
}

/** Reads a token count from the SDK's usage object without trusting its static type. */
function tokenCount(usage: unknown, key: string): number | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const value: unknown = Object.fromEntries(Object.entries(usage))[key];
  return typeof value === "number" ? value : undefined;
}

/** True when Groq says the model's generation did not satisfy the schema. Reads the body defensively. */
function isSchemaRejection(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(body));
  const inner: unknown = record["error"];
  const code: unknown =
    inner !== null && typeof inner === "object"
      ? Object.fromEntries(Object.entries(inner))["code"]
      : record["code"];
  return code === "json_validate_failed";
}

function toTransportError(error: unknown): GroqTransportError {
  if (error instanceof APIConnectionTimeoutError) return new GroqTransportError("TIMEOUT");
  if (error instanceof APIError) {
    // The SDK types the status loosely; only a real number counts.
    const status = typeof error.status === "number" ? error.status : undefined;
    if (status === undefined) return new GroqTransportError("UNAVAILABLE");
    if (status === 429) return new GroqTransportError("RATE_LIMITED", status);
    if (status === 408) return new GroqTransportError("TIMEOUT", status);
    if (status === 401 || status === 403) return new GroqTransportError("AUTH", status);
    if (status >= 500) return new GroqTransportError("UNAVAILABLE", status);
    if (status === 400 && isSchemaRejection(error.error)) {
      return new GroqTransportError("INVALID_OUTPUT", status);
    }
    return new GroqTransportError("BAD_REQUEST", status);
  }
  return new GroqTransportError("UNAVAILABLE");
}

/**
 * Groq chat completions with strict structured output. One call, temperature 0, bounded tokens,
 * no tools, no streaming. Errors are reduced to a kind; the original error (which may echo request
 * details) is dropped.
 */
export function createGroqSdkTransport(options: GroqSdkTransportOptions): GroqTransport {
  const client = new Groq({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 1,
    ...(options.fetch && { fetch: options.fetch }),
  });

  return {
    async chat(request: GroqChatRequest): Promise<GroqChatResult> {
      try {
        const completion = await client.chat.completions.create(
          {
            model: request.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            temperature: 0,
            max_completion_tokens: request.maxCompletionTokens,
            response_format: {
              type: "json_schema",
              json_schema: { name: request.schemaName, strict: true, schema: request.schema },
            },
            ...reasoningOptionsFor(request.model),
          },
          { timeout: request.timeoutMs },
        );
        const usage: unknown = completion.usage;
        const promptTokens = tokenCount(usage, "prompt_tokens");
        const completionTokens = tokenCount(usage, "completion_tokens");
        const totalTokens = tokenCount(usage, "total_tokens");
        return {
          content: completion.choices[0]?.message.content ?? null,
          model: completion.model,
          usage: {
            ...(promptTokens !== undefined && { promptTokens }),
            ...(completionTokens !== undefined && { completionTokens }),
            ...(totalTokens !== undefined && { totalTokens }),
          },
        };
      } catch (error) {
        throw toTransportError(error);
      }
    },
  };
}
