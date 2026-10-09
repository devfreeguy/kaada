import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defaultCountryDirectory } from "../assets/countries.js";
import type { AgentIntent, SendIntent } from "./agent-intent.js";
import { isTransactionalIntent, mergeAgentIntent } from "./merge.js";

const send = (fields: Omit<SendIntent, "type"> = {}): SendIntent => ({ type: "SEND", ...fields });
const usd = (value: string, mode?: "EXACT_INPUT" | "EXACT_OUTPUT") => ({
  value,
  currencyOrAsset: "USD",
  ...(mode && { mode }),
});

describe("mergeAgentIntent", () => {
  it("starts a new intent when nothing is active", () => {
    const incoming = send({ amount: usd("20", "EXACT_INPUT") });
    assert.deepEqual(mergeAgentIntent(undefined, incoming), { kind: "NEW", intent: incoming });
  });

  it("adds the recipient to an existing amount and keeps both", () => {
    const outcome = mergeAgentIntent(
      send({ amount: usd("50", "EXACT_INPUT") }),
      send({ recipient: { type: "USERNAME", value: "Daniel" } }),
    );
    assert.equal(outcome.kind, "MERGED");
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      amount: usd("50", "EXACT_INPUT"),
      recipient: { type: "USERNAME", value: "Daniel" },
    });
  });

  it("applies a correction: new amount wins, recipient is preserved", () => {
    const outcome = mergeAgentIntent(
      send({ recipient: { type: "USERNAME", value: "Daniel" }, amount: usd("20", "EXACT_INPUT") }),
      send({ amount: usd("40", "EXACT_INPUT") }),
    );
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      recipient: { type: "USERNAME", value: "Daniel" },
      amount: usd("40", "EXACT_INPUT"),
    });
  });

  it("keeps the earlier mode for a same-currency amount that does not restate it", () => {
    const outcome = mergeAgentIntent(
      send({ amount: usd("20", "EXACT_OUTPUT") }),
      send({ amount: usd("40") }),
    );
    assert.deepEqual(outcome.intent, { type: "SEND", amount: usd("40", "EXACT_OUTPUT") });
  });

  it("lets a currency-less amount keep the earlier currency and mode ('make it 40')", () => {
    const outcome = mergeAgentIntent(
      send({ amount: usd("20", "EXACT_INPUT") }),
      send({ amount: { value: "40" } }),
    );
    assert.deepEqual(outcome.intent, { type: "SEND", amount: usd("40", "EXACT_INPUT") });
  });

  it("completes an amount whose currency was missing once the currency arrives", () => {
    const outcome = mergeAgentIntent(
      send({ amount: { value: "20" }, recipient: { type: "USERNAME", value: "Daniel" } }),
      send({ amount: { value: "20", currencyOrAsset: "USD" } }),
    );
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      amount: { value: "20", currencyOrAsset: "USD" },
      recipient: { type: "USERNAME", value: "Daniel" },
    });
  });

  it("does not carry the mode across a currency change", () => {
    const outcome = mergeAgentIntent(
      send({ amount: usd("20", "EXACT_OUTPUT") }),
      send({ amount: { value: "40", currencyOrAsset: "EUR" } }),
    );
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      amount: { value: "40", currencyOrAsset: "EUR" },
    });
  });

  it("replaces a recipient and merges destination and constraints field by field", () => {
    const outcome = mergeAgentIntent(
      send({
        recipient: { type: "USERNAME", value: "Daniel" },
        destination: { country: "BR" },
        constraints: { maxSlippageBps: 50 },
      }),
      send({
        recipient: { type: "USERNAME", value: "Maria" },
        destination: { currency: "BRL" },
        constraints: { routePreference: "CHEAPEST" },
      }),
    );
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      recipient: { type: "USERNAME", value: "Maria" },
      destination: { country: "BR", currency: "BRL" },
      constraints: { maxSlippageBps: 50, routePreference: "CHEAPEST" },
    });
  });

  it("ignores explicitly undefined fields instead of erasing earlier values", () => {
    const outcome = mergeAgentIntent(
      send({ amount: usd("20", "EXACT_INPUT"), recipient: { type: "USERNAME", value: "Daniel" } }),
      send({ recipient: undefined, amount: undefined }),
    );
    assert.deepEqual(outcome.intent, {
      type: "SEND",
      amount: usd("20", "EXACT_INPUT"),
      recipient: { type: "USERNAME", value: "Daniel" },
    });
  });

  it("merges CONVERT and QUOTE intents of the same type", () => {
    const convert = mergeAgentIntent(
      { type: "CONVERT", fromAsset: "USDC" },
      { type: "CONVERT", toAsset: "cNGN", amount: { value: "100", currencyOrAsset: "USDC" } },
    );
    assert.deepEqual(convert.intent, {
      type: "CONVERT",
      fromAsset: "USDC",
      toAsset: "cNGN",
      amount: { value: "100", currencyOrAsset: "USDC" },
    });
    const quote = mergeAgentIntent(
      { type: "QUOTE", amount: { value: "50", currencyOrAsset: "USDT" } },
      { type: "QUOTE", destination: { country: "BR" } },
    );
    assert.deepEqual(quote.intent, {
      type: "QUOTE",
      amount: { value: "50", currencyOrAsset: "USDT" },
      destination: { country: "BR" },
    });
  });

  it("starts fresh when the operation changes, never inheriting old fields", () => {
    const active = send({
      amount: usd("20", "EXACT_INPUT"),
      recipient: { type: "USERNAME", value: "Daniel" },
    });
    const incoming: AgentIntent = { type: "CONVERT", fromAsset: "USDC" };
    assert.deepEqual(mergeAgentIntent(active, incoming), { kind: "REPLACED", intent: incoming });
    const quote: AgentIntent = { type: "QUOTE" };
    assert.equal(mergeAgentIntent(active, quote).kind, "REPLACED");
  });

  it("leaves the active intent alone for informational requests", () => {
    const active = send({ amount: usd("20") });
    for (const type of ["HELP", "BALANCE", "TRANSACTION_STATUS", "UNKNOWN"] as const) {
      assert.equal(mergeAgentIntent(active, { type }).kind, "SIDE_REQUEST", type);
    }
    assert.equal(mergeAgentIntent(undefined, { type: "HELP" }).kind, "SIDE_REQUEST");
  });

  it("does not mutate its inputs", () => {
    const active = send({ amount: usd("20", "EXACT_INPUT") });
    const incoming = send({ amount: usd("40") });
    const before = structuredClone([active, incoming]);
    mergeAgentIntent(active, incoming);
    assert.deepEqual([active, incoming], before);
  });

  it("classifies transactional intents", () => {
    assert.equal(isTransactionalIntent({ type: "SEND" }), true);
    assert.equal(isTransactionalIntent({ type: "QUOTE" }), true);
    assert.equal(isTransactionalIntent({ type: "HELP" }), false);
  });
});

describe("defaultCountryDirectory", () => {
  it("normalises names and codes", () => {
    assert.equal(defaultCountryDirectory.normalize("Brazil"), "BR");
    assert.equal(defaultCountryDirectory.normalize(" brasil "), "BR");
    assert.equal(defaultCountryDirectory.normalize("br"), "BR");
    assert.equal(defaultCountryDirectory.normalize("Argentina"), "AR");
    assert.equal(defaultCountryDirectory.normalize("pe"), "PE", "unknown ISO codes pass through");
    assert.equal(defaultCountryDirectory.normalize("Atlantis"), undefined);
    assert.equal(defaultCountryDirectory.normalize(""), undefined);
  });

  it("maps corridor countries to their currency", () => {
    assert.equal(defaultCountryDirectory.currencyOf("BR"), "BRL");
    assert.equal(defaultCountryDirectory.currencyOf("ng"), "NGN");
    assert.equal(defaultCountryDirectory.currencyOf("PE"), undefined);
  });
});
