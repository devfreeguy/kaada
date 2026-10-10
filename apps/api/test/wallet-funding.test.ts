import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { intent } from "./support/harness.js";
import { joao, setup } from "./support/payment-world.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";

/*
 * Balance-aware routing against MOCK / TEST price fixtures and a fake wallet. Nothing here reads a
 * chain or calls a provider. The mock prices 1 USDT = 5.42 wBRL, so 500 wBRL costs 92.26015 USDT
 * (at most 92.306281 after slippage); via USDC it costs more.
 */

const USDT = 10n ** 6n;

function errorOf(response: AgentResponse): { code: string; text: string } {
  assert.equal(response.type, "ERROR", JSON.stringify(response));
  if (response.type !== "ERROR") throw new Error("unreachable");
  return response;
}

function ready(response: AgentResponse) {
  assert.equal(response.type, "PAYMENT_READY", JSON.stringify(response));
  if (response.type !== "PAYMENT_READY") throw new Error("unreachable");
  return response;
}

describe("a payment needs a wallet; a quote does not", () => {
  it("a PAYMENT without an active wallet asks for setup and prices nothing", async () => {
    const w = setup();
    w.port.address = null;
    const turn = await w.r.h.say("pay 500 brl");
    assert.deepEqual(errorOf(turn.response), {
      type: "ERROR",
      code: "WALLET_SETUP_REQUIRED",
      text: "You need to set up your Kaada wallet first.",
    });
    assert.equal(w.priced.length, 0);
    assert.equal(w.port.reads, 0);
    assert.equal(w.r.world.routes.size, 0);
  });

  it("a QUOTE works without a wallet and never touches one", async () => {
    const w = setup();
    w.port.address = null;
    const turn = await w.r.h.say("quote");
    assert.equal(turn.response.type, "QUOTE_RESULT", JSON.stringify(turn.response));
    assert.equal(w.port.lookups, 0, "the wallet was not even looked up");
    assert.equal(w.port.reads, 0);
  });

  it("the setup answer carries no link or token: the channel asks for one when it renders the button", async () => {
    const w = setup();
    w.port.address = null;
    const turn = await w.r.h.say("pay 500 brl");
    assert.deepEqual(Object.keys(turn.response).sort(), ["code", "text", "type"]);
  });
});

describe("exact input affordability", () => {
  it("proceeds when the balance covers the exact input (including exactly)", async () => {
    const w = setup();
    w.fund("USDT", 20n);
    const response = ready((await w.r.h.say("spend 20 usdt")).response);
    assert.equal(response.senderSpends.expected.display, "20 USDT");
    assert.equal(w.port.reads, 1);
  });

  it("stops before pricing when the balance is one atom short", async () => {
    const w = setup();
    w.port.held.set(w.r.h.assets.USDT.id, 20n * USDT - 1n);
    const error = errorOf((await w.r.h.say("spend 20 usdt")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.match(error.text, /^You don't currently have enough USDT for this payment\./);
    assert.match(error.text, /You need 20 USDT and have 19.999999\./);
    assert.deepEqual(w.priced, [], "no provider was asked for a price");
  });

  it("an explicit USDT payment is never silently moved to USDC", async () => {
    const w = setup();
    w.fund("USDC", 1000n);
    const error = errorOf((await w.r.h.say("spend 20 usdt")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.match(error.text, /enough USDT/);
    assert.deepEqual(w.priced, []);
  });

  it("with no preference it keeps only the funded asset", async () => {
    const w = setup();
    w.fund("USDC", 25n);
    const response = ready((await w.r.h.say("spend 20")).response);
    assert.equal(response.senderSpends.expected.symbol, "USDC");
    assert.equal(response.route.hops[0]?.from, "USDC");
    assert.equal(w.priced.includes("USDC>USDT"), true);
    assert.equal(w.priced.includes("USDT>wBRL"), true, "only as the second step of the USDC route");
  });
});

describe("exact output affordability", () => {
  it("proceeds when the balance covers the most that could be spent", async () => {
    const w = setup();
    w.fund("USDT", 100n);
    const response = ready((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.equal(response.senderSpends.max.amount, "92306281");
  });

  it("previews first, then rejects when the best spend exceeds the balance", async () => {
    const w = setup();
    w.fund("USDT", 50n); // positive, but 92.26 is needed
    const error = errorOf((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.match(error.text, /up to 92.306281 USDT, but your wallet has 50 USDT/);
    assert.equal(w.priced.length > 0, true, "the unknown amount needed a preview");
    assert.equal(w.r.world.routes.size, 0, "nothing was stored for an unaffordable route");
  });

  it("is judged on the maximum after slippage, not the estimate", async () => {
    const w = setup();
    // The estimate is 92.26015 and the maximum 92.306281: this balance covers one but not the other.
    w.port.held.set(w.r.h.assets.USDT.id, 92_280_000n);
    const error = errorOf((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
  });

  it("moves to another funded source when the best route's asset falls short", async () => {
    const w = setup();
    w.fund("USDT", 50n); // not enough
    w.fund("USDC", 1000n); // enough, though the route via USDC is dearer
    const response = ready((await w.r.h.say("pay 500 brl")).response);
    assert.equal(response.senderSpends.expected.symbol, "USDC");
    assert.equal(response.recipientReceives.expected.display, "500 wBRL");
  });

  it("does not pick by balance size: the cheaper route wins when both are funded", async () => {
    const w = setup();
    w.fund("USDT", 100n);
    w.fund("USDC", 100_000n); // a far larger balance
    const response = ready((await w.r.h.say("pay 500 brl")).response);
    assert.equal(response.senderSpends.expected.symbol, "USDT");
    assert.equal(
      w.priced.some((pair) => pair.startsWith("USDC>")),
      true,
      "both funded assets were priced; price, not balance, chose",
    );
  });

  it("an explicit asset that is the only one funded elsewhere stays explicit", async () => {
    const w = setup();
    w.fund("USDC", 1000n);
    const error = errorOf((await w.r.h.say("pay 500 brl with usdt")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.match(error.text, /enough USDT/);
    assert.deepEqual(w.priced, []);
  });
});

describe("funding problems are told apart", () => {
  it("a wallet with nothing to fund the payment needs funding", async () => {
    const w = setup();
    const error = errorOf((await w.r.h.say("pay 500 brl")).response);
    assert.deepEqual(error, {
      type: "ERROR",
      code: "WALLET_NEEDS_FUNDING",
      text: "Your Kaada wallet doesn't have a supported asset to fund this payment yet.",
    });
    assert.deepEqual(w.priced, []);
  });

  it("no_makers_online stays a liquidity failure, not a balance failure", async () => {
    const w = setup({ noMakersFrom: "USDC" });
    w.fund("USDC", 1000n); // plenty of the one asset nobody will quote
    const error = errorOf((await w.r.h.say("pay 500 brl")).response);
    assert.equal(error.code, "ROUTING_UNAVAILABLE");
    assert.notEqual(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(w.priced.length > 0, true);
  });

  it("a wallet that cannot be read is a temporary routing problem, not a balance verdict", async () => {
    const w = setup();
    w.port.failReads = true;
    const error = errorOf((await w.r.h.say("pay 500 brl")).response);
    assert.equal(error.code, "ROUTING_UNAVAILABLE");
    assert.match(error.text, /couldn't check your wallet balance/);
    assert.deepEqual(w.priced, []);
  });

  it("reads balances fresh for every payment and stores none", async () => {
    const w = setup();
    w.fund("USDT", 100n);
    ready((await w.r.h.say("pay 500 brl with usdt")).response);
    const reads = w.port.reads;
    w.r.h.script.set(
      "pay 500 brl again",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
        sourceAsset: "USDT",
      }),
    );
    w.port.held.set(w.r.h.assets.USDT.id, 1n); // the chain changed
    const error = errorOf((await w.r.h.say("pay 500 brl again")).response);
    assert.equal(error.code, "INSUFFICIENT_BALANCE");
    assert.equal(w.port.reads > reads, true);
  });
});
