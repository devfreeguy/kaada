import Anthropic from "@anthropic-ai/sdk";
import type { ClientOptions } from "@anthropic-ai/sdk";

import { GroqTransportError } from "./groq-transport.js";
import type { GroqChatRequest, GroqChatResult, GroqTransport } from "./groq-transport.js";

export interface AnthropicTransportOptions {
  apiKey: string;
  /** Retries the SDK may make for 408, 409, 429 and 5xx. Default 1: one logical call is at most two HTTP attempts. */
  maxRetries?: number;
  /** Replaces the global fetch; used by tests to run without a network. */
  fetch?: ClientOptions["fetch"];
}

function toTransportError(error: unknown): GroqTransportError {
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    if (status === undefined) return new GroqTransportError("UNAVAILABLE");
    if (status === 429) return new GroqTransportError("RATE_LIMITED", status, "TPM");
    if (status === 408) return new GroqTransportError("TIMEOUT", status);
    if (status === 401 || status === 403) return new GroqTransportError("AUTH", status);
    if (status >= 500) return new GroqTransportError("UNAVAILABLE", status);
    return new GroqTransportError("BAD_REQUEST", status);
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new GroqTransportError("TIMEOUT");
  }
  return new GroqTransportError("UNAVAILABLE");
}

/**
 * Claude behind the same seam the rest of Kaada talks to.
 *
 * The shape is the Groq transport's because the application has exactly one idea of what a model call is — a system
 * prompt, a message, a schema the answer must satisfy, a token ceiling and a timeout. Claude reaches that through a
 * different protocol: the schema goes in `output_config.format` rather than a `response_format`, the system prompt is
 * its own top-level field rather than a message, and the answer arrives as content blocks. All of that is translated
 * here so nothing above this file knows which provider answered.
 *
 * Two deliberate choices. Thinking is left off: this is extraction against a fixed schema under a conversational
 * latency budget, not a reasoning task, and a thinking budget would add seconds and tokens to every turn. And a
 * `refusal` stop reason is reported as its own kind rather than as empty output — Claude declining to answer is a fact
 * about the request, and calling it an outage would send the fallback chain hunting for a provider that will say yes.
 */
export function createAnthropicTransport(options: AnthropicTransportOptions): GroqTransport {
  const client = new Anthropic({
    apiKey: options.apiKey,
    maxRetries: options.maxRetries ?? 1,
    ...(options.fetch && { fetch: options.fetch }),
  });

  return {
    async chat(request: GroqChatRequest): Promise<GroqChatResult> {
      try {
        const response = await client.messages.create(
          {
            model: request.model,
            max_tokens: request.maxCompletionTokens,
            system: request.system,
            messages: [{ role: "user", content: request.user }],
            // Claude's JSON format takes the schema alone; the schema's name, which Groq shows the model, has no
            // counterpart here and is simply not sent.
            output_config: {
              format: { type: "json_schema", schema: request.schema },
            },
          },
          { timeout: request.timeoutMs },
        );

        // Claude declined to answer. That is a fact about the request, not an outage: reported as unusable output, so
        // the turn becomes "I didn't understand that" rather than the same message being shopped around every provider
        // in the chain until one agrees to answer it.
        if (response.stop_reason === "refusal") {
          throw new GroqTransportError("INVALID_OUTPUT", 200);
        }

        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("");

        return {
          content: text.length > 0 ? text : null,
          model: response.model,
          usage: {
            promptTokens: response.usage.input_tokens,
            completionTokens: response.usage.output_tokens,
            totalTokens: response.usage.input_tokens + response.usage.output_tokens,
          },
        };
      } catch (error) {
        if (error instanceof GroqTransportError) throw error;
        throw toTransportError(error);
      }
    },
  };
}
