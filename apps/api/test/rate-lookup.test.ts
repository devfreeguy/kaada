import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildRateAnswer } from "../src/core/routing/rate-answer.js";
import type { MoneyView } from "../src/core/responses/agent-response.js";
import { intent } from "./support/harness.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

/*
 * The rate path, from the words a person types to the figures that come back.
 *
 * The screenshot that prompted this work ended with "/rates Naira to Argentina Peso" being answered with "Which currency pair
 * would you like to see?". Two separate faults caused it: the command threw away everything typed after it, and the pair
 * parser could only read single-word labels. Both are covered here.
 */

const money = (over: Partial<MoneyView> = {}): MoneyView => ({
  amount: "1000000",
  assetId: "a",
  symbol: "USDT",
  decimals: 6,
  display: "$1",
  ...over,
});

describe("the words of a rate answer", () => {
  it("states the pair and the rate itself, and offers rather than demands an amount", () => {
    const text = buildRateAnswer({
      source: money({ symbol: "cNGN", decimals: 6, display: "₦1" }),
      destination: money({
        amount: "600000000000000",
        symbol: "wARS",
        decimals: 18,
        display: "AR$0.00",
      }),
      sourceCurrency: "NGN",
      destinationCurrency: "ARS",
      indicative: true,
    });
    assert.match(text, /Nigerian Naira \(NGN\) → Argentine Peso \(ARS\)/);
    assert.match(text, /^₦1 = AR\$0\.0006$/m, "the rate at useful precision, not a rounded amount");
    assert.match(text, /indicative/i);
    assert.match(text, /Want me to work out a specific amount\?/);
    assert.doesNotMatch(text, /Fees/, "a one-unit probe's fee says nothing about a real payment");
  });

  it("never calls an indicative rate a firm quote, and says so plainly", () => {
    const indicative = buildRateAnswer({
      source: money(),
      destination: money({ symbol: "wBRL", decimals: 18, display: "R$5.42" }),
      sourceCurrency: "USD",
      destinationCurrency: "BRL",
      indicative: true,
    });
    assert.match(indicative, /locked in when you confirm/i);
    assert.doesNotMatch(indicative, /firm quote|reserved|guaranteed/i);
  });

  it("labels development mock pricing loudest of all", () => {
    const text = buildRateAnswer({
      source: money(),
      destination: money({ display: "R$5.42" }),
      mock: true,
      indicative: true,
    });
    assert.match(text, /not a real rate/i);
    assert.doesNotMatch(text, /Live/);
  });

  it("says when money cannot actually move along the pair, instead of implying it can", () => {
    const text = buildRateAnswer({
      source: money(),
      destination: money({ display: "R$5.42" }),
      routeAvailable: false,
    });
    assert.match(text, /can't move money along this pair right now/i);
  });

  it("omits the offer when the person already named an amount", () => {
    const text = buildRateAnswer({
      source: money(),
      destination: money({ display: "R$5.42" }),
      amountAsked: true,
    });
    assert.doesNotMatch(text, /Want me to work out/);
  });

  it("falls back to the two amounts when a rate cannot be derived, rather than inventing one", () => {
    const text = buildRateAnswer({
      source: money({ amount: "0", display: "$0" }),
      destination: money({ display: "R$5.42" }),
    });
    assert.match(text, /\$0 currently gives R\$5\.42/);
  });
});

describe("/rates with the pair typed in", () => {
  const world = (): RoutingHarness => createRoutingHarness();

  it("answers '/rates Naira to Argentina Peso' with a rate, and asks nothing", async () => {
    const r = world();
    const before = r.h.interpreterCalls;
    const turn = await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });

    assert.equal(turn.response.type, "QUOTE_RESULT", turn.response.text);
    assert.match(turn.response.text, /Nigerian Naira \(NGN\) → Argentine Peso \(ARS\)/);
    assert.match(turn.response.text, /₦1 = AR\$[\d.,]+/);
    assert.doesNotMatch(turn.response.text, /Which (currency )?pair/i);
    assert.equal(
      r.h.interpreterCalls,
      before,
      "a pair of currency names needs no language model at all",
    );
  });

  it("reads the long way of saying it too", async () => {
    const r = world();
    const turn = await r.h.command("ASK_RATE_PAIR", {
      rateText: "What's the rate of Nigerian money to Argentina money?",
    });
    assert.equal(turn.response.type, "QUOTE_RESULT", turn.response.text);
    assert.match(turn.response.text, /₦1 = AR\$[\d.,]+/);
  });

  it("still asks which pair when /rates is sent on its own", async () => {
    const r = world();
    const turn = await r.h.command("ASK_RATE_PAIR");
    assert.match(turn.response.text, /which .*pair|which rate/i);
  });

  it("a rate question starts no payment and spends nothing", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });
    assert.ok(
      [...r.world.intents.values()].every((intent) => intent.type === "QUOTE"),
      "only a quote was recorded",
    );
    for (const message of r.world.messages) {
      const type = (message.structuredData as { type?: string } | undefined)?.type;
      assert.notEqual(type, "AUTHORIZATION_REQUIRED");
      assert.notEqual(type, "PAYMENT_READY");
    }
  });
});

describe("following up on a rate with just an amount", () => {
  const world = (): RoutingHarness => createRoutingHarness();

  it("'20000' after a Naira-to-pesos rate means ₦20,000 in pesos, not a new payment", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });
    const before = r.h.interpreterCalls;

    const turn = await r.h.say("20,000");
    assert.equal(turn.response.type, "QUOTE_RESULT", turn.response.text);
    if (turn.response.type !== "QUOTE_RESULT") return;
    assert.equal(turn.response.source.symbol, "cNGN", "the amount is in the currency just quoted");
    assert.equal(turn.response.destination.symbol, "wARS");
    assert.equal(turn.response.source.amount, "20000000000", "₦20,000 at six decimals");
    assert.equal(r.h.interpreterCalls, before, "a bare amount needs no language model");
    assert.ok(
      [...r.world.intents.values()].every((intent) => intent.type === "QUOTE"),
      "no payment was begun: nobody has been named to pay",
    );
  });

  it("a message that is not just an amount is read normally, so a new request is never trapped", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });
    r.h.script.set("what's my balance", intent({ type: "BALANCE" }));
    const turn = await r.h.say("what's my balance");
    assert.notEqual(turn.response.type, "QUOTE_RESULT");
  });

  it("the remembered pair expires, and is never read from another conversation", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR", { rateText: "Naira to Argentina Peso" });

    // Another chat (a different conversation row) knows nothing about it.
    r.h.script.set("20,000", intent({ type: "SEND", amount: { value: "20000" } }));
    const elsewhere = await r.h.say("20,000", { externalConversationId: "other-chat" });
    assert.notEqual(elsewhere.response.type, "QUOTE_RESULT");
  });
});
