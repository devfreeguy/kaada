import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GroqTransportError } from "../src/infrastructure/llm/groq-transport.js";
import type { GroqChatRequest } from "../src/infrastructure/llm/groq-transport.js";
import { createOpenAiCompatibleTransport } from "../src/infrastructure/llm/openai-compatible-transport.js";

const request: GroqChatRequest = {
  model: "gpt-oss-120b",
  system: "Extract the money intent.",
  user: "send 20 dollars to Daniel",
  schemaName: "agent_interpretation",
  schema: { type: "object", additionalProperties: false, properties: {}, required: [] },
  maxCompletionTokens: 512,
  timeoutMs: 8000,
};

const completion = (content: string | null) => ({
  model: "gpt-oss-120b",
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 2100, completion_tokens: 60, total_tokens: 2160 },
});

/** The transport is only ever given a string url and a string body, so the fake reads them as such. */
const asUrl = (url: string | URL | Request): string =>
  typeof url === "string" ? url : url instanceof URL ? url.href : url.url;

const asBody = (body: unknown): Record<string, unknown> =>
  typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {};

/** A fetch that records the URL and body it was given, and replies with whatever it was scripted. */
function fakeFetch(status: number, body: unknown) {
  const seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl: typeof globalThis.fetch = (url, init) => {
    seen.push({
      url: asUrl(url),
      body: asBody(init?.body),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetchImpl, seen };
}

describe("OpenAI-compatible transport: the endpoint it calls", () => {
  // The bug this transport exists for: the Groq SDK hardcodes "/openai/v1/chat/completions", so pointing it at another
  // provider produced ".../v1/openai/v1/chat/completions" and a 400 on every single call — invisible behind a fallback
  // chain that quietly let the next provider answer.
  it("posts to <baseUrl>/chat/completions and nothing else", async () => {
    const { fetchImpl, seen } = fakeFetch(200, completion('{"type":"HELP"}'));
    await createOpenAiCompatibleTransport({
      apiKey: "secret-key",
      baseUrl: "https://api.cerebras.ai/v1",
      fetch: fetchImpl,
    }).chat(request);

    assert.equal(seen[0]?.url, "https://api.cerebras.ai/v1/chat/completions");
    assert.doesNotMatch(seen[0]?.url ?? "", /openai\/v1/, "no provider's path is assumed");
  });

  it("tolerates a trailing slash on the base url", async () => {
    const { fetchImpl, seen } = fakeFetch(200, completion('{"type":"HELP"}'));
    await createOpenAiCompatibleTransport({
      apiKey: "k",
      baseUrl: "https://openrouter.ai/api/v1/",
      fetch: fetchImpl,
    }).chat(request);
    assert.equal(seen[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
  });

  it("sends the strict schema and the key, and reports the usage", async () => {
    const { fetchImpl, seen } = fakeFetch(200, completion('{"type":"HELP"}'));
    const result = await createOpenAiCompatibleTransport({
      apiKey: "secret-key",
      baseUrl: "https://api.cerebras.ai/v1",
      fetch: fetchImpl,
    }).chat(request);

    const body = seen[0]?.body ?? {};
    const format = body["response_format"] as { json_schema?: { strict?: boolean; name?: string } };
    assert.equal(format.json_schema?.strict, true, "the schema is enforced, not suggested");
    assert.equal(format.json_schema?.name, "agent_interpretation");
    assert.equal(seen[0]?.headers["authorization"], "Bearer secret-key");
    assert.equal(result.content, '{"type":"HELP"}');
    assert.deepEqual(result.usage, {
      promptTokens: 2100,
      completionTokens: 60,
      totalTokens: 2160,
    });
  });
});

describe("OpenAI-compatible transport: failures", () => {
  const kindOf = async (status: number, body: unknown) => {
    const { fetchImpl } = fakeFetch(status, body);
    const error = await createOpenAiCompatibleTransport({
      apiKey: "k",
      baseUrl: "https://api.cerebras.ai/v1",
      fetch: fetchImpl,
    })
      .chat(request)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(error instanceof GroqTransportError, `expected a GroqTransportError, got ${String(error)}`);
    return error;
  };

  it("names the exhausted quota on a 429, as the Groq transport does", async () => {
    const error = await kindOf(429, {
      error: { message: "Rate limit reached on tokens per day (TPD): Limit 200000, Used 199999." },
    });
    assert.equal(error.kind, "RATE_LIMITED");
    assert.equal(error.scope, "TPD");
  });

  it("carries no organisation identifier or usage figures out of the provider's message", async () => {
    const error = await kindOf(429, {
      error: { message: "Rate limit for organization `org_01secret` (TPD): Limit 200000, Used 198283." },
    });
    const serialised = `${error.message} ${JSON.stringify(error)}`;
    assert.ok(!serialised.includes("org_01secret"));
    assert.ok(!serialised.includes("198283"));
  });

  it("tells a schema rejection apart from a plain bad request", async () => {
    assert.equal((await kindOf(400, { error: { code: "json_validate_failed" } })).kind, "INVALID_OUTPUT");
    assert.equal((await kindOf(400, { error: { message: "bad model" } })).kind, "BAD_REQUEST");
  });

  it("maps auth and outage statuses", async () => {
    assert.equal((await kindOf(401, { error: { message: "bad key" } })).kind, "AUTH");
    assert.equal((await kindOf(503, { error: { message: "high demand" } })).kind, "UNAVAILABLE");
  });

  it("never carries the API key in an error", async () => {
    const { fetchImpl } = fakeFetch(401, { error: { message: "no" } });
    const error = await createOpenAiCompatibleTransport({
      apiKey: "csk-super-secret",
      baseUrl: "https://api.cerebras.ai/v1",
      fetch: fetchImpl,
    })
      .chat(request)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(!JSON.stringify(error).includes("csk-super-secret"));
    assert.ok(!String((error as Error).message).includes("csk-super-secret"));
  });
});
