import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createGroqSdkTransport,
  reasoningOptionsFor,
} from "../src/infrastructure/llm/groq-sdk-transport.js";
import { GroqTransportError } from "../src/infrastructure/llm/groq-transport.js";
import type { GroqChatRequest } from "../src/infrastructure/llm/groq-transport.js";

const API_KEY = "gsk_test_key_do_not_leak";

const request: GroqChatRequest = {
  model: "openai/gpt-oss-20b",
  system: "SYSTEM PROMPT",
  user: "USER PROMPT",
  schemaName: "kaada_interpretation",
  schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  maxCompletionTokens: 512,
  timeoutMs: 5000,
};

const completion = (content: string | null) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "openai/gpt-oss-20b",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { prompt_tokens: 410, completion_tokens: 35, total_tokens: 445 },
});

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that replays the given responses in order and records what it was sent. */
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const seen: Seen[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const index = seen.length;
    seen.push({
      url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<
        string,
        unknown
      >,
    });
    const respond = responses[Math.min(index, responses.length - 1)];
    if (!respond) throw new Error("no response scripted");
    return respond();
  };
  return { fetch, seen };
}

const json =
  (status: number, body: unknown, headers: Record<string, string> = {}) =>
  () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

describe("Groq SDK transport: the request", () => {
  it("sends one deterministic, bounded, schema-constrained call with no tools", async () => {
    const { fetch, seen } = fakeFetch([json(200, completion('{"type":"HELP"}'))]);
    const result = await createGroqSdkTransport({ apiKey: API_KEY, fetch }).chat(request);

    assert.equal(seen.length, 1);
    const [call] = seen;
    assert.match(call?.url ?? "", /\/chat\/completions$/);
    assert.equal(call?.headers.get("authorization"), `Bearer ${API_KEY}`);

    const body = call?.body ?? {};
    assert.equal(body["model"], "openai/gpt-oss-20b");
    assert.equal(body["temperature"], 0);
    assert.equal(body["max_completion_tokens"], 512);
    assert.equal(body["reasoning_effort"], "low");
    assert.equal(body["include_reasoning"], false);
    assert.deepEqual(body["messages"], [
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);
    assert.deepEqual(body["response_format"], {
      type: "json_schema",
      json_schema: { name: "kaada_interpretation", strict: true, schema: request.schema },
    });
    for (const forbidden of ["tools", "tool_choice", "stream", "functions"]) {
      assert.ok(!(forbidden in body), `${forbidden} must not be sent`);
    }
    assert.ok(!JSON.stringify(body).includes(API_KEY), "the key travels only in the header");

    assert.equal(result.content, '{"type":"HELP"}');
    assert.deepEqual(result.usage, { promptTokens: 410, completionTokens: 35, totalTokens: 445 });
  });

  it("returns null content untouched so the caller can treat it as empty", async () => {
    const { fetch } = fakeFetch([json(200, completion(null))]);
    const result = await createGroqSdkTransport({ apiKey: API_KEY, fetch }).chat(request);
    assert.equal(result.content, null);
  });

  it("only sends reasoning settings to models that have them", () => {
    assert.deepEqual(reasoningOptionsFor("openai/gpt-oss-20b"), {
      reasoning_effort: "low",
      include_reasoning: false,
    });
    assert.deepEqual(reasoningOptionsFor("openai/gpt-oss-120b"), {
      reasoning_effort: "low",
      include_reasoning: false,
    });
    assert.deepEqual(reasoningOptionsFor("qwen/qwen3.8-27b"), { reasoning_effort: "none" });
    assert.deepEqual(reasoningOptionsFor("some/other-model"), {});
  });

  it("omits reasoning settings for an unrelated model", async () => {
    const { fetch, seen } = fakeFetch([json(200, completion("{}"))]);
    await createGroqSdkTransport({ apiKey: API_KEY, fetch }).chat({
      ...request,
      model: "some/other",
    });
    assert.ok(!("reasoning_effort" in (seen[0]?.body ?? {})));
  });
});

describe("Groq SDK transport: failures and retries", () => {
  const kindOf = async (
    responses: (() => Response | Promise<Response>)[],
    overrides: Partial<GroqChatRequest> = {},
  ) => {
    const { fetch, seen } = fakeFetch(responses);
    const error = await createGroqSdkTransport({ apiKey: API_KEY, fetch })
      .chat({ ...request, ...overrides })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(
      error instanceof GroqTransportError,
      `expected a GroqTransportError, got ${String(error)}`,
    );
    return { kind: error.kind, status: error.status, calls: seen.length, error };
  };

  const rateLimited = json(429, { error: { message: "rate limited" } }, { "retry-after-ms": "1" });

  it("retries a rate limit once, then reports it", async () => {
    const result = await kindOf([rateLimited]);
    assert.deepEqual([result.kind, result.status, result.calls], ["RATE_LIMITED", 429, 2]);
  });

  it("recovers when the single retry succeeds", async () => {
    const { fetch, seen } = fakeFetch([rateLimited, json(200, completion('{"type":"HELP"}'))]);
    const result = await createGroqSdkTransport({ apiKey: API_KEY, fetch }).chat(request);
    assert.equal(result.content, '{"type":"HELP"}');
    assert.equal(seen.length, 2);
  });

  it("retries a server error once, then reports the outage", async () => {
    const result = await kindOf([
      json(503, { error: { message: "overloaded" } }, { "retry-after-ms": "1" }),
    ]);
    assert.deepEqual([result.kind, result.status, result.calls], ["UNAVAILABLE", 503, 2]);
  });

  it("does not retry authentication or bad-request errors", async () => {
    assert.deepEqual(
      Object.values(await kindOf([json(401, { error: { message: "bad key" } })])).slice(0, 3),
      ["AUTH", 401, 1],
    );
    assert.deepEqual(
      Object.values(
        await kindOf([json(400, { error: { message: "model does not support schema" } })]),
      ).slice(0, 3),
      ["BAD_REQUEST", 400, 1],
    );
  });

  it("tells a schema rejection by Groq apart from other bad requests, without keeping the generation", async () => {
    const rejection = json(400, {
      error: {
        message: "Generated JSON does not match the expected schema.",
        type: "invalid_request_error",
        code: "json_validate_failed",
        failed_generation: '{"type":"SEND","recipient":{"value":"PrivateName"}}',
      },
    });
    const result = await kindOf([rejection]);
    assert.deepEqual([result.kind, result.status, result.calls], ["INVALID_OUTPUT", 400, 1]);
    const text = `${result.error.message} ${JSON.stringify(result.error)}`;
    assert.ok(!text.includes("PrivateName"), "the model's output is not carried in the error");
  });

  it("reports a timeout without waiting beyond the configured budget plus one retry", async () => {
    let calls = 0;
    // Like a real fetch, a hung request ends when the SDK aborts it at the timeout.
    const hung = (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        );
      });
    const started = Date.now();
    const error = await createGroqSdkTransport({ apiKey: API_KEY, fetch: hung })
      .chat({ ...request, timeoutMs: 40 })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(error instanceof GroqTransportError);
    assert.equal(error.kind, "TIMEOUT");
    assert.equal(calls, 2, "one attempt plus one retry");
    assert.ok(Date.now() - started < 3000);
  });

  it("reports a network failure as unavailable", async () => {
    const down = () => Promise.reject(new TypeError("fetch failed"));
    const result = await kindOf([down]);
    assert.equal(result.kind, "UNAVAILABLE");
  });

  it("never carries the API key or the prompts in an error", async () => {
    const { error } = await kindOf([json(401, { error: { message: `bad key ${API_KEY}` } })]);
    const text = `${error.message} ${JSON.stringify(error)} ${String(error.stack)}`;
    assert.ok(!text.includes(API_KEY));
    assert.ok(!text.includes("USER PROMPT") && !text.includes("SYSTEM PROMPT"));
  });
});
