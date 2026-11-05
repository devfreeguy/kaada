import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Interpretation } from "@kaada/domain";

import { FallbackIntentInterpreter } from "../src/core/agent/fallback-interpreter.js";
import {
  InterpreterOutputError,
  InterpreterUnavailableError,
} from "../src/core/agent/interpreter.js";
import type { IntentInterpreter, InterpretationInput } from "../src/core/agent/interpreter.js";

const INPUT: InterpretationInput = {
  message: "send 20 dollars to Daniel",
  history: [],
  now: new Date("2026-01-01T00:00:00Z"),
};

const reading = (type: "SEND" | "QUOTE"): Interpretation => ({
  kind: "INTENT",
  intent: type === "SEND" ? { type: "SEND" } : { type: "QUOTE" },
});

/** An interpreter that answers, or throws whatever it was given, and counts its calls. */
function provider(result: Interpretation | Error): IntentInterpreter & { calls: number } {
  const stub = {
    calls: 0,
    interpret(): Promise<Interpretation> {
      stub.calls += 1;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return stub;
}

function recorder() {
  const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  return {
    lines,
    log: (level: string, event: string, fields: Record<string, unknown>) =>
      void lines.push({ level, event, fields }),
  };
}

describe("the fallback chain: order and stopping", () => {
  it("uses the first provider and never calls the rest", async () => {
    const first = provider(reading("SEND"));
    const second = provider(reading("QUOTE"));
    const { log, lines } = recorder();

    const result = await new FallbackIntentInterpreter(
      [
        { name: "anthropic", interpreter: first },
        { name: "groq", interpreter: second },
      ],
      log,
    ).interpret(INPUT);

    assert.deepEqual(result, reading("SEND"));
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 0, "a working provider ends the chain");
    assert.deepEqual(lines, [], "the ordinary path is silent");
  });

  it("moves to the next provider when one is rate limited, and says so", async () => {
    const first = provider(new InterpreterUnavailableError("RATE_LIMITED"));
    const second = provider(reading("SEND"));
    const { log, lines } = recorder();

    const result = await new FallbackIntentInterpreter(
      [
        { name: "groq", interpreter: first },
        { name: "anthropic", interpreter: second },
      ],
      log,
    ).interpret(INPUT);

    assert.deepEqual(result, reading("SEND"));
    assert.equal(second.calls, 1);

    // A switch is never silent: a different model read the person's message than the one it was drilled against.
    const failed = lines.find((line) => line.event === "agent.interpreter.fallback.failed");
    assert.equal(failed?.fields["provider"], "groq");
    assert.equal(failed?.fields["kind"], "RATE_LIMITED");
    assert.equal(failed?.fields["next"], "anthropic");

    const served = lines.find((line) => line.event === "agent.interpreter.fallback.served");
    assert.equal(served?.fields["provider"], "anthropic");
    assert.equal(served?.fields["position"], 1);
  });

  it("walks the whole chain in order", async () => {
    const calls: string[] = [];
    const failing = (name: string): IntentInterpreter => ({
      interpret: () => {
        calls.push(name);
        return Promise.reject(new InterpreterUnavailableError("UNAVAILABLE"));
      },
    });
    const working: IntentInterpreter = {
      interpret: () => {
        calls.push("gemini");
        return Promise.resolve(reading("QUOTE"));
      },
    };

    await new FallbackIntentInterpreter([
      { name: "anthropic", interpreter: failing("anthropic") },
      { name: "cerebras", interpreter: failing("cerebras") },
      { name: "groq", interpreter: failing("groq") },
      { name: "gemini", interpreter: working },
    ]).interpret(INPUT);

    assert.deepEqual(calls, ["anthropic", "cerebras", "groq", "gemini"], "best first, least last");
  });

  it("reports unavailable when every provider is down", async () => {
    const chain = new FallbackIntentInterpreter([
      { name: "groq", interpreter: provider(new InterpreterUnavailableError("RATE_LIMITED")) },
      { name: "anthropic", interpreter: provider(new InterpreterUnavailableError("TIMEOUT")) },
    ]);
    await assert.rejects(
      chain.interpret(INPUT),
      (error: unknown) => error instanceof InterpreterUnavailableError && error.kind === "TIMEOUT",
      "the last failure is what the caller is told about",
    );
  });
});

describe("the fallback chain: what it refuses to fall back from", () => {
  // The model ANSWERED; its answer was unusable. The agent already handles that by treating the message as not
  // understood and re-asking. Asking a second provider would add a call's latency to every malformed generation and
  // hide the prompt fault behind whichever model tolerates it — the faults the drilling exists to find.
  it("does not try the next provider when the model answered with something unusable", async () => {
    const first = provider(new InterpreterOutputError("WIRE_SCHEMA"));
    const second = provider(reading("SEND"));

    await assert.rejects(
      new FallbackIntentInterpreter([
        { name: "groq", interpreter: first },
        { name: "anthropic", interpreter: second },
      ]).interpret(INPUT),
      (error: unknown) => error instanceof InterpreterOutputError,
    );
    assert.equal(second.calls, 0, "unusable output is not an availability problem");
  });

  it("logs a bad key at error level, because a rate limit heals and a bad key does not", async () => {
    const { log, lines } = recorder();
    await new FallbackIntentInterpreter(
      [
        { name: "anthropic", interpreter: provider(new InterpreterUnavailableError("AUTH")) },
        { name: "groq", interpreter: provider(reading("SEND")) },
      ],
      log,
    ).interpret(INPUT);

    const failed = lines.find((line) => line.event === "agent.interpreter.fallback.failed");
    assert.equal(failed?.level, "error", "a misconfigured key must not be quietly paid for by the next provider");
    assert.equal(failed?.fields["kind"], "AUTH");
  });

  it("refuses to be built with no providers at all", () => {
    assert.throws(() => new FallbackIntentInterpreter([]), /at least one provider/);
  });

  it("names its providers in order, for the startup line", () => {
    const chain = new FallbackIntentInterpreter([
      { name: "anthropic", interpreter: provider(reading("SEND")) },
      { name: "groq", interpreter: provider(reading("SEND")) },
    ]);
    assert.deepEqual(chain.providers, ["anthropic", "groq"]);
  });

  it("carries no key, endpoint or message into its logs", async () => {
    const { log, lines } = recorder();
    await new FallbackIntentInterpreter(
      [
        { name: "groq", interpreter: provider(new InterpreterUnavailableError("RATE_LIMITED")) },
        { name: "anthropic", interpreter: provider(reading("SEND")) },
      ],
      log,
    ).interpret({ ...INPUT, message: "send 20 dollars to SecretName" });

    const serialised = JSON.stringify(lines);
    assert.ok(!serialised.includes("SecretName"), "the person's message never reaches a log line");
    assert.ok(!serialised.includes("api.groq.com"), "no endpoint");
    assert.ok(!/sk-|gsk_|csk-/.test(serialised), "no key material");
  });
});
