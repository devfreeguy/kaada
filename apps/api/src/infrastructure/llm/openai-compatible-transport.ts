import { GroqTransportError } from "./groq-transport.js";
import type {
  GroqChatRequest,
  GroqChatResult,
  GroqRateLimitScope,
  GroqTransport,
} from "./groq-transport.js";
import { reasoningOptionsFor } from "./groq-sdk-transport.js";

export interface OpenAiCompatibleTransportOptions {
  apiKey: string;
  /** The API root, as the provider documents it: "https://api.cerebras.ai/v1", "https://openrouter.ai/api/v1". */
  baseUrl: string;
  /** Replaces the global fetch; used by tests to run without a network. */
  fetch?: typeof globalThis.fetch;
}

const RATE_LIMIT_SCOPES: readonly GroqRateLimitScope[] = ["TPD", "TPM", "RPD", "RPM"];

/** Which quota a 429 names, from the closed set only; nothing is copied out of the provider's message. */
function rateLimitScope(message: string): GroqRateLimitScope | undefined {
  return RATE_LIMIT_SCOPES.find((scope) => new RegExp(`\\b${scope}\\b`).test(message));
}

function toTransportError(status: number, body: string): GroqTransportError {
  let message = "";
  let code: unknown;
  try {
    const parsed: unknown = JSON.parse(body);
    const error: unknown =
      parsed !== null && typeof parsed === "object"
        ? Object.fromEntries(Object.entries(parsed))["error"]
        : undefined;
    if (error !== null && typeof error === "object") {
      const fields = Object.fromEntries(Object.entries(error));
      message = typeof fields["message"] === "string" ? fields["message"] : "";
      code = fields["code"];
    }
  } catch {
    /* a provider that does not answer in JSON tells us only its status */
  }

  if (status === 429) return new GroqTransportError("RATE_LIMITED", status, rateLimitScope(message));
  if (status === 408) return new GroqTransportError("TIMEOUT", status);
  if (status === 401 || status === 403) return new GroqTransportError("AUTH", status);
  if (status >= 500) return new GroqTransportError("UNAVAILABLE", status);
  // The model generated something the schema rejected: unusable output, not an outage.
  if (status === 400 && code === "json_validate_failed") {
    return new GroqTransportError("INVALID_OUTPUT", status);
  }
  return new GroqTransportError("BAD_REQUEST", status);
}

/** Reads a number off the usage object without trusting its shape. */
function tokenCount(usage: unknown, key: string): number | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const value: unknown = Object.fromEntries(Object.entries(usage))[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Chat completions for any provider that serves the OpenAI protocol: Cerebras, OpenRouter, Google's compatibility
 * endpoint, and others.
 *
 * WHY THIS IS NOT THE GROQ SDK WITH A DIFFERENT baseURL
 *
 * That was the first attempt and it cannot work. The Groq SDK hardcodes `/openai/v1/chat/completions` as the path, so a
 * base of "https://api.cerebras.ai/v1" is requested as ".../v1/openai/v1/chat/completions" — and no value of the base
 * makes that correct for a provider whose path is "/v1/chat/completions". Every call returned 400, on every provider
 * except Groq itself, whose own endpoint is the one the SDK was built for. The fallback chain hid it: Cerebras failed
 * every turn of a drill wave and Groq quietly answered all of them.
 *
 * The request is one POST of JSON, so it is written directly rather than through another provider's client. Errors are
 * reduced to the same kinds the rest of Kaada already understands, and the body — which echoes the request and may
 * carry an organisation identifier — is read for the quota name and then dropped.
 */
export function createOpenAiCompatibleTransport(
  options: OpenAiCompatibleTransportOptions,
): GroqTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const url = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    async chat(request: GroqChatRequest): Promise<GroqChatResult> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: request.model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            temperature: request.temperature ?? 0,
            max_completion_tokens: request.maxCompletionTokens,
            response_format: {
              type: "json_schema",
              json_schema: { name: request.schemaName, strict: true, schema: request.schema },
            },
            ...reasoningOptionsFor(request.model),
          }),
        });
      } catch (error) {
        throw new GroqTransportError(
          error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE",
        );
      } finally {
        clearTimeout(timer);
      }

      const body = await response.text();
      if (!response.ok) throw toTransportError(response.status, body);

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new GroqTransportError("UNAVAILABLE");
      }
      const fields =
        payload !== null && typeof payload === "object"
          ? Object.fromEntries(Object.entries(payload))
          : {};
      const choices: unknown = fields["choices"];
      const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
      const message: unknown =
        first !== null && typeof first === "object"
          ? Object.fromEntries(Object.entries(first))["message"]
          : undefined;
      const content: unknown =
        message !== null && typeof message === "object"
          ? Object.fromEntries(Object.entries(message))["content"]
          : undefined;
      const usage: unknown = fields["usage"];
      const promptTokens = tokenCount(usage, "prompt_tokens");
      const completionTokens = tokenCount(usage, "completion_tokens");
      const totalTokens = tokenCount(usage, "total_tokens");

      return {
        content: typeof content === "string" && content.length > 0 ? content : null,
        model: typeof fields["model"] === "string" ? fields["model"] : request.model,
        usage: {
          ...(promptTokens !== undefined && { promptTokens }),
          ...(completionTokens !== undefined && { completionTokens }),
          ...(totalTokens !== undefined && { totalTokens }),
        },
      };
    },
  };
}
