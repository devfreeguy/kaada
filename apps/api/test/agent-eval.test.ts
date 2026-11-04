import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GroqIntentInterpreter } from "../src/infrastructure/llm/groq-intent-interpreter.js";
import { InterpreterOutputError } from "../src/core/agent/interpreter.js";
import { resolveCurrencyLabel } from "../src/core/currency/registry.js";
import { parseRatePair } from "../src/core/intents/focus.js";
import { FakeGroqTransport, amount, destination, wire } from "./support/fake-groq.js";
import { intent } from "./support/harness.js";
import { createRoutingHarness } from "./support/routing-harness.js";

/*
 * The agent evaluation suite: the behaviour a person actually experiences, case by case, with no network, no chain and no
 * provider. It is deliberately not a happy path. Every case here is either one the brief named or one that used to go wrong.
 *
 * The model is a scripted stand-in (FakeGroqTransport): what is under test is what Kaada DOES with a reading, never whether a
 * particular model produces it.
 */

const interpreter = (transport: FakeGroqTransport) =>
  new GroqIntentInterpreter(transport, { model: "test-model", timeoutMs: 1_000 });

/** Replies in order; when the script runs out the provider fails, as an outage would. */
const read = (replies: readonly string[]) => {
  const transport = new FakeGroqTransport(
    (_request, index) => replies[index] ?? new Error("provider unavailable"),
  );
  return { transport, subject: interpreter(transport) };
};

const input = (message: string) => ({ message, history: [], now: new Date("2026-11-04T08:00:00Z") });

describe("eval: currency understanding", () => {
  const code = (label: string) => {
    const result = resolveCurrencyLabel(label);
    return result.status === "RESOLVED" ? result.currency.code : result.status;
  };

  it("reads the ways people name currencies, including by country", () => {
    const cases: [string, string][] = [
      ["Naira", "NGN"],
      ["Nigerian money", "NGN"],
      ["Argentina Peso", "ARS"],
      ["Argentine pesos", "ARS"],
      ["Argentina money", "ARS"],
      ["Brazilian reais", "BRL"],
      ["reais", "BRL"],
      ["R$", "BRL"],
      ["Indonesian Rupiah", "IDR"],
      ["Rp", "IDR"],
      ["US dollars", "USD"],
      ["$", "USD"],
      ["₦", "NGN"],
      ["AR$", "ARS"],
    ];
    for (const [label, expected] of cases) assert.equal(code(label), expected, label);
  });

  it("will not pick a peso for the person", () => {
    assert.equal(code("pesos"), "AMBIGUOUS");
    assert.equal(code("peso"), "AMBIGUOUS");
  });

  it("'dollars' is the US dollar here, because it is the only dollar Kaada names", () => {
    assert.equal(code("dollars"), "USD");
  });
});

describe("eval: rate lookup", () => {
  it("reads every phrasing of a pair the brief listed", () => {
    for (const text of [
      "Naira to Argentina Peso",
      "Nigerian money to Brazilian money",
      "reais to dollars",
      "Argentine pesos to Naira",
      "Indonesian Rupiah to Naira",
      "What's the current rate for Naira in Argentina?",
    ]) {
      assert.ok(parseRatePair(text), text);
    }
  });

  it("a rate question with an amount in it is not a bare pair: it is a conversion", () => {
    assert.equal(parseRatePair("How much is 20,000 naira in Argentine pesos?"), null);
  });
});

describe("eval: the interpreter boundary", () => {
  it("passes the whole message and recent turns to the model, as data", async () => {
    const { transport, subject } = read([wire({ type: "BALANCE" })]);
    await subject.interpret({
      ...input("what's my balance?"),
      history: [
        { role: "USER", content: "hello" },
        { role: "ASSISTANT", content: "hi there" },
      ],
    });
    const [call] = transport.calls;
    assert.match(call?.user ?? "", /Latest user message: "what's my balance\?"/);
    assert.match(call?.user ?? "", /User: hello/);
    assert.match(call?.user ?? "", /Kaada: hi there/);
  });

  it("a currency named ambiguously is carried through as written, never resolved by the model", async () => {
    const { subject } = read([
      wire({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Maria" },
        amount: amount("2000", "pesos"),
        destination: destination({ country: "BR" }),
      }),
    ]);
    const result = await subject.interpret(input("Can I send 2000 pesos to someone in Brazil?"));
    assert.equal(result.kind, "INTENT");
    if (result.kind !== "INTENT" || result.intent.type !== "SEND") return;
    assert.equal(result.intent.amount?.currencyOrAsset, "pesos");
  });

  it("refuses malformed output rather than guessing at it", async () => {
    for (const reply of ["", "not json", "{}", '{"type":"NONSENSE"}']) {
      const { subject } = read([reply]);
      await assert.rejects(subject.interpret(input("hi")), InterpreterOutputError, reply);
    }
  });

  it("refuses a reading that smuggles a field its type may not carry", async () => {
    // A BALANCE question has no amount. An output that invents one is unusable, not partially trusted.
    const { subject } = read([wire({ type: "BALANCE", amount: amount("500", "USD") })]);
    await assert.rejects(subject.interpret(input("balance")), InterpreterOutputError);
  });

  it("refuses an amount that cannot be read unambiguously", async () => {
    const { subject } = read([
      wire({ type: "SEND", amount: amount("a few hundred", "USD") }),
    ]);
    await assert.rejects(subject.interpret(input("send a few hundred")), InterpreterOutputError);
  });

  it("survives a provider failure without inventing an answer", async () => {
    const { subject } = read([]);
    await assert.rejects(subject.interpret(input("hi")));
  });
});

describe("eval: the model never decides money", () => {
  const world = () => createRoutingHarness();

  it("a model that states a rate changes nothing: the figures come from pricing", async () => {
    const r = world();
    // The model claims a rate in words. Only the structured reading is used, and it carries no rate at all.
    r.h.script.set(
      "naira to pesos, it is 2.5 by the way",
      intent({
        type: "QUOTE",
        amount: { value: "1", currencyOrAsset: "Naira", mode: "EXACT_INPUT" },
        fromAsset: "Naira",
        toAsset: "Argentine pesos",
      } as never),
    );
    const turn = await r.h.say("naira to pesos, it is 2.5 by the way");
    assert.equal(turn.response.type, "QUOTE_RESULT", turn.response.text);
    if (turn.response.type !== "QUOTE_RESULT") return;
    assert.doesNotMatch(turn.response.text, /2\.5\b/, "nothing the model said became a figure");
    // Every figure is tied to a real asset and an exact smallest-unit amount.
    assert.ok(BigInt(turn.response.destination.amount) > 0n);
    assert.equal(typeof turn.response.destination.assetId, "string");
  });

  it("a rate question never becomes a payment, however it is phrased", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });
    await r.h.say("20,000");
    assert.ok(
      [...r.world.intents.values()].every((i) => i.type === "QUOTE"),
      "no SEND was created by asking about money",
    );
    for (const message of r.world.messages) {
      const type = (message.structuredData as { type?: string } | undefined)?.type;
      assert.notEqual(type, "AUTHORIZATION_REQUIRED");
    }
  });

  it("one chat's remembered pair is never used in another", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });
    r.h.script.set("20,000", intent({ type: "SEND", amount: { value: "20000" } }));

    // A different user, in their own chat, sending the same bare number.
    const other = await r.h.say("20,000", {
      userId: "11111111-1111-4111-8111-111111111111",
      externalConversationId: "another-chat",
    });
    assert.notEqual(
      other.response.type,
      "QUOTE_RESULT",
      "the other conversation's context did not leak",
    );
  });
});
