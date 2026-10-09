import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CELO_CHAIN_ID,
  createFxProviderDirectory,
  createMoney,
  createRoutePlanner,
  assertRouteUsable,
} from "@kaada/domain";
import type {
  CandidateResult,
  RoutingCandidateSet,
  RoutingRequest,
  RoutePlanResult,
} from "@kaada/domain";

import { MockFxProvider } from "../src/infrastructure/fx/mock-fx-provider.js";
import type { MockPairFixture } from "../src/infrastructure/fx/mock-fx-provider.js";
import type {
  AgentResponse,
  PaymentReadyResponse,
  QuoteResultResponse,
} from "../src/core/responses/agent-response.js";
import { intent } from "./support/harness.js";
import { RFQ, createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

/*
 * Routing against MOCK / TEST fixtures only: 1 USDT = 5.42 wBRL, fee 1 bps of the input (USDC -> USDT:
 * 2 bps), slippage 5 bps per step, quotes valid for 30 seconds. No real price or provider is involved.
 */

const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };

function paymentReady(response: AgentResponse): PaymentReadyResponse {
  assert.equal(response.type, "PAYMENT_READY", JSON.stringify(response));
  if (response.type !== "PAYMENT_READY") throw new Error("unreachable");
  return response;
}

function quoteResult(response: AgentResponse): QuoteResultResponse {
  assert.equal(response.type, "QUOTE_RESULT", JSON.stringify(response));
  if (response.type !== "QUOTE_RESULT") throw new Error("unreachable");
  return response;
}

/** Scripts "<verb> ..." so the interpreter returns a SEND to João. */
function script(r: RoutingHarness) {
  const amount = (
    value: string,
    currencyOrAsset: string,
    mode: "EXACT_INPUT" | "EXACT_OUTPUT",
  ) => ({
    value,
    currencyOrAsset,
    mode,
  });
  r.h.script.set(
    "exact output",
    intent({ type: "SEND", recipient: joao, amount: amount("500", "BRL", "EXACT_OUTPUT") }),
  );
  r.h.script.set(
    "exact output using usdt",
    intent({
      type: "SEND",
      recipient: joao,
      amount: amount("500", "BRL", "EXACT_OUTPUT"),
      sourceAsset: "USDT",
    }),
  );
  r.h.script.set(
    "exact output using usdc",
    intent({
      type: "SEND",
      recipient: joao,
      amount: amount("500", "BRL", "EXACT_OUTPUT"),
      sourceAsset: "USDC",
    }),
  );
  r.h.script.set(
    "exact input using usdt",
    intent({
      type: "SEND",
      recipient: joao,
      amount: amount("20", "USD", "EXACT_INPUT"),
      sourceAsset: "USDT",
    }),
  );
  r.h.script.set(
    "exact input using usdc",
    intent({
      type: "SEND",
      recipient: joao,
      amount: amount("20", "USD", "EXACT_INPUT"),
      sourceAsset: "USDC",
    }),
  );
  r.h.script.set(
    "exact input",
    intent({ type: "SEND", recipient: joao, amount: amount("20", "USD", "EXACT_INPUT") }),
  );
  r.h.script.set(
    "make it 40",
    intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
  );
  r.h.script.set(
    "quote",
    intent({
      type: "QUOTE",
      amount: amount("50", "USDT", "EXACT_INPUT"),
      fromAsset: "USDT",
      destination: { country: "BR" },
    }),
  );
}

function setup(options: Parameters<typeof createRoutingHarness>[0] = {}) {
  const r = createRoutingHarness(options);
  script(r);
  return r;
}

const USDT_UNITS = 10n ** 6n;

describe("exact input", () => {
  it("spends exactly the input and delivers the rounded-down output (USDT -> wBRL)", async () => {
    const r = setup();
    const turn = await r.h.say("exact input using usdt");
    const ready = paymentReady(turn.response);

    assert.equal(ready.senderSpends.expected.amount, (20n * USDT_UNITS).toString());
    assert.equal(ready.senderSpends.max.amount, ready.senderSpends.expected.amount, "never more");
    // net 19.998 USDT at 5.42 = 108.38916 wBRL; with 5 bps slippage at least 108.33496542.
    assert.equal(ready.recipientReceives.expected.amount, "108389160000000000000");
    assert.equal(ready.recipientReceives.min.display, "108.33496542 wBRL");
    assert.equal(ready.senderSpends.expected.display, "20 USDT");
    assert.deepEqual(
      ready.fees.map((f) => f.display),
      ["0.002 USDT"],
    );
    assert.equal(ready.revision, 1);
    assert.equal(ready.route.hops.length, 1);
    assert.match(ready.text, /You spend exactly 20 USDT; João Silva receives about 108.38916 wBRL/);
    assert.equal(ready.mock, true);
    assert.match(ready.text, /mock pricing/);
  });

  it("an exact-input two-hop route from USDC keeps the input exact and chains the amounts", async () => {
    const r = setup();
    const turn = await r.h.say("exact input using usdc");
    const ready = paymentReady(turn.response);
    assert.equal(ready.senderSpends.expected.display, "20 USDC");
    assert.deepEqual(
      ready.route.hops.map((h) => `${h.from}>${h.to}`),
      ["USDC>USDT", "USDT>wBRL"],
    );
    // USDC->USDT: fee 4000 (2 bps), 19.996 USDT; USDT->wBRL: fee 2000, net 19.994 * 5.42 = 108.36748.
    assert.equal(ready.recipientReceives.expected.amount, "108367480000000000000");
    assert.equal(ready.slippageBps, 10, "slippage adds up over the two steps");
    assert.deepEqual(ready.fees.map((f) => f.display).sort(), ["0.002 USDT", "0.004 USDC"].sort());
  });

  it("with no preference it maximises the output and picks the direct USDT route", async () => {
    const r = setup();
    const ready = paymentReady((await r.h.say("exact input")).response);
    assert.equal(ready.senderSpends.expected.symbol, "USDT");
    assert.equal(ready.route.hops.length, 1);
    assert.equal(ready.recipientReceives.expected.amount, "108389160000000000000");
  });
});

describe("exact output", () => {
  it("delivers exactly the output and rounds the required input up (USDT -> wBRL)", async () => {
    const r = setup();
    const ready = paymentReady((await r.h.say("exact output using usdt")).response);
    assert.equal(ready.recipientReceives.expected.display, "500 wBRL");
    assert.equal(ready.recipientReceives.min.amount, ready.recipientReceives.expected.amount);
    assert.equal(ready.senderSpends.expected.amount, "92260150");
    assert.equal(ready.senderSpends.expected.display, "92.26015 USDT");
    // 5 bps above the estimate, rounded up: 92260150 + 46131.
    assert.equal(ready.senderSpends.max.amount, "92306281");
    assert.deepEqual(
      ready.fees.map((f) => f.display),
      ["0.009227 USDT"],
    );
    assert.match(ready.text, /João Silva receives exactly 500 wBRL; estimated spend 92.26015 USDT/);
  });

  it("USDC -> USDT -> wBRL: discovers the two-hop route, exact at the end, minimal at each step", async () => {
    const r = setup();
    const ready = paymentReady((await r.h.say("exact output using usdc")).response);
    assert.deepEqual(
      ready.route.hops.map((h) => `${h.from}>${h.to}`),
      ["USDC>USDT", "USDT>wBRL"],
    );
    assert.equal(ready.recipientReceives.expected.amount, "500000000000000000000");
    assert.equal(ready.senderSpends.expected.symbol, "USDC");

    // The first step's output is exactly the second step's input: 92.26015 USDT.
    const [route] = [...r.world.routes.values()];
    const [first, second] = route?.steps ?? [];
    assert.equal(first?.output.amount, "92260150");
    assert.equal(second?.input.amount, "92260150");
    // And the USDC input is the smallest that still yields it after the 2 bps (rounded-up) fee.
    const spend = BigInt(ready.senderSpends.expected.amount);
    const net = (gross: bigint) => gross - (gross * 2n + 9_999n) / 10_000n;
    assert.ok(net(spend) >= 92260150n);
    assert.ok(net(spend - 1n) < 92260150n);
  });

  it("with no preference it minimises the source cost across funding assets", async () => {
    const r = setup();
    const outcome = await r.h.say("exact output");
    const ready = paymentReady(outcome.response);
    assert.equal(
      ready.senderSpends.expected.symbol,
      "USDT",
      "direct USDT is cheaper than via USDC",
    );
    assert.equal(ready.senderSpends.expected.amount, "92260150");
  });
});

describe("planning graph", () => {
  async function plan(
    r: RoutingHarness,
    over: Partial<RoutingRequest> = {},
  ): Promise<{ candidates: CandidateResult; result?: RoutePlanResult; set?: RoutingCandidateSet }> {
    const request: RoutingRequest = {
      intentId: "intent-x",
      intentRevision: 1,
      userId: "u",
      operation: "SEND",
      purpose: "PAYMENT",
      amount: createMoney("50000", r.h.assets.BRL.id),
      amountMode: "EXACT_OUTPUT",
      destinationAssetId: r.h.assets.BRL.id,
      destinationCountry: "BR",
      ...over,
    };
    const candidates = await r.candidates.resolve(request);
    if (candidates.status !== "READY") return { candidates };
    return {
      candidates,
      set: candidates.set,
      result: await r.planner.plan(request, candidates.set),
    };
  }

  it("never revisits an asset and never uses more than two hops", async () => {
    // A graph with a cycle (USDT <-> USDC) and a three-step way round (USDC -> USDT -> cNGN -> wBRL).
    const fixtures: MockPairFixture[] = [
      {
        input: "USDT",
        output: "wBRL",
        rate: { numerator: 542n, denominator: 100n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "USDT",
        output: "USDC",
        rate: { numerator: 1n, denominator: 1n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "USDC",
        output: "USDT",
        rate: { numerator: 1n, denominator: 1n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "USDC",
        output: "wBRL",
        rate: { numerator: 540n, denominator: 100n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "USDT",
        output: "cNGN",
        rate: { numerator: 1500n, denominator: 1n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "cNGN",
        output: "wBRL",
        rate: { numerator: 1n, denominator: 300n },
        feeBps: 1,
        slippageBps: 5,
      },
    ];
    const r = setup({ fixtures });
    const { result } = await plan(r, {
      amountMode: "EXACT_INPUT",
      amount: createMoney("2000", r.h.assets.USD.id),
    });
    assert.equal(result?.status, "SUCCESS");
    if (result?.status !== "SUCCESS") return;
    for (const route of result.routes) {
      const path = [route.sourceAssetId, ...route.hops.map((h) => h.output.assetId)];
      assert.equal(new Set(path).size, path.length, "no asset repeats");
      assert.ok(route.hops.length <= 2, "at most two FX hops");
    }
    // USDT -> cNGN -> wBRL is a legitimate two-hop route from USDT; a 3-hop USDC route is not offered.
    assert.ok(result.routes.some((route) => route.hops.length === 2));
  });

  it("offers no route when the only way is more than two hops", async () => {
    const fixtures: MockPairFixture[] = [
      {
        input: "USDC",
        output: "USDT",
        rate: { numerator: 1n, denominator: 1n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "USDT",
        output: "cNGN",
        rate: { numerator: 1500n, denominator: 1n },
        feeBps: 1,
        slippageBps: 5,
      },
      {
        input: "cNGN",
        output: "wBRL",
        rate: { numerator: 1n, denominator: 300n },
        feeBps: 1,
        slippageBps: 5,
      },
    ];
    const r = setup({ fixtures });
    const { candidates } = await plan(r, { preferredSourceAssetId: r.h.assets.USDC_CELO.id });
    assert.equal(candidates.status, "UNSUPPORTED");
    assert.equal(candidates.status === "UNSUPPORTED" && candidates.code, "NO_PROVIDER_FOR_PAIR");
  });

  it("a direct route wins a tie against an equal two-hop route", async () => {
    const free = (
      input: string,
      output: string,
      numerator: bigint,
      denominator: bigint,
    ): MockPairFixture => ({
      input,
      output,
      rate: { numerator, denominator },
      feeBps: 0,
      slippageBps: 5,
    });
    const r = setup({
      fixtures: [
        free("USDT", "wBRL", 542n, 100n),
        free("USDT", "USDC", 1n, 1n),
        free("USDC", "wBRL", 542n, 100n),
      ],
    });
    const { result } = await plan(r, {
      amountMode: "EXACT_INPUT",
      amount: createMoney("2000", r.h.assets.USD.id),
      preferredSourceAssetId: r.h.assets.USDT.id,
    });
    assert.equal(result?.status, "SUCCESS");
    if (result?.status !== "SUCCESS") return;
    const lengths = result.routes.map((route) => route.hops.length);
    assert.deepEqual(lengths, [1, 2], "both exist; the direct one ranks first");
    assert.equal(result.routes[0]?.output.amount, result.routes[1]?.output.amount, "a true tie");
  });

  it("ranks EXACT_INPUT by output and EXACT_OUTPUT by input, then falls back deterministically", async () => {
    const r = setup();
    const input = await plan(r, {
      amountMode: "EXACT_INPUT",
      amount: createMoney("2000", r.h.assets.USD.id),
    });
    assert.equal(input.result?.status, "SUCCESS");
    if (input.result?.status === "SUCCESS") {
      const outputs = input.result.routes.map((route) => BigInt(route.output.amount));
      assert.deepEqual(
        [...outputs].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
        outputs,
      );
    }
    const output = await plan(r);
    assert.equal(output.result?.status, "SUCCESS");
    if (output.result?.status === "SUCCESS") {
      const inputs = output.result.routes.map((route) => BigInt(route.input.amount));
      assert.deepEqual(
        [...inputs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        inputs,
      );
      const again = await plan(r);
      assert.deepEqual(
        again.result?.status === "SUCCESS" && again.result.routes.map((route) => route.key),
        output.result.routes.map((route) => route.key),
        "the same inputs give the same order",
      );
    }
  });

  it("a candidate set for another revision is refused", async () => {
    const r = setup();
    const request: RoutingRequest = {
      intentId: "intent-x",
      intentRevision: 1,
      userId: "u",
      operation: "SEND",
      purpose: "PAYMENT",
      amount: createMoney("50000", r.h.assets.BRL.id),
      amountMode: "EXACT_OUTPUT",
      destinationAssetId: r.h.assets.BRL.id,
      destinationCountry: "BR",
    };
    const found = await r.candidates.resolve(request);
    assert.equal(found.status, "READY");
    if (found.status !== "READY") return;
    const result = await r.planner.plan({ ...request, intentRevision: 2 }, found.set);
    assert.deepEqual(
      [result.status, result.status === "NO_ROUTE" && result.reason],
      ["NO_ROUTE", "REVISION_MISMATCH"],
    );
  });

  it("falls back to another provider when one fails, and reports a provider failure when all do", async () => {
    const r = setup();
    const alt = r.world.addProvider({ slug: "alt", name: "Alternative (test)" });
    r.allow(r.h.assets.USDT, r.tokens.wBRL, RFQ, alt.id);
    const second = new MockFxProvider({
      assets: r.registry,
      now: () => r.clock.now,
      id: "mock-alt",
    });
    const planner = createRoutePlanner({
      assets: r.registry,
      capabilities: r.capabilityRegistry,
      fx: createFxProviderDirectory([
        { capabilityProvider: "textile", provider: r.mock },
        { capabilityProvider: "alt", provider: second },
      ]),
      now: () => r.clock.now,
    });
    const request: RoutingRequest = {
      intentId: "intent-x",
      intentRevision: 1,
      userId: "u",
      operation: "SEND",
      purpose: "PAYMENT",
      amount: createMoney("50000", r.h.assets.BRL.id),
      amountMode: "EXACT_OUTPUT",
      destinationAssetId: r.h.assets.BRL.id,
      destinationCountry: "BR",
      preferredSourceAssetId: r.h.assets.USDT.id,
    };
    const found = await r.candidates.resolve(request);
    assert.equal(found.status, "READY");
    if (found.status !== "READY") return;

    r.mock.setFailure("USDT", "wBRL", "UNAVAILABLE");
    const fellBack = await planner.plan(request, found.set);
    assert.equal(fellBack.status, "SUCCESS");
    if (fellBack.status === "SUCCESS") {
      assert.deepEqual(
        fellBack.routes.map((route) => route.hops[0]?.providerId),
        ["mock-alt"],
      );
      assert.equal(fellBack.failures.length, 1, "the failure is recorded, not hidden");
    }

    second.setFailure("USDT", "wBRL", "UNAVAILABLE");
    const allDown = await planner.plan(request, found.set);
    assert.equal(allDown.status, "PROVIDER_UNAVAILABLE");

    second.setFailure("USDT", "wBRL", "ERROR");
    r.mock.setFailure("USDT", "wBRL", "ERROR");
    assert.equal((await planner.plan(request, found.set)).status, "QUOTE_FAILED");
  });

  it("rejects quotes that arrive already expired", async () => {
    const r = setup({ mockClockSkewMs: 60_000 }); // the mock's 30 s quotes are a minute old on arrival
    const turn = await r.h.say("exact output using usdt");
    assert.equal(turn.response.type, "ERROR");
    assert.equal(turn.response.type === "ERROR" && turn.response.code, "ROUTING_UNAVAILABLE");
    assert.equal(r.world.routes.size, 0, "nothing expired was stored");
    assert.equal(r.world.quotes.length, 0);
  });
});

describe("provider capabilities are enforced", () => {
  it("an unsupported pair is reported without a route", async () => {
    const r = setup();
    r.h.script.set(
      "mexico",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        destination: { country: "MX" },
      }),
    );
    const turn = await r.h.say("mexico");
    assert.equal(turn.response.type, "ERROR");
    assert.equal(turn.response.type === "ERROR" && turn.response.code, "ROUTING_UNSUPPORTED");
    assert.equal(r.world.routes.size, 0);
    // wMXN exists as an asset but nothing says Textile (or anyone) can price it.
    assert.equal(r.mock.requests.length, 0, "no provider was even asked");
  });

  it("ignores a disabled capability and needs the capability for the amount mode", async () => {
    const r = setup();
    for (const row of r.world.capabilities) {
      if (row.capability === "EXACT_OUTPUT") row.isActive = false;
    }
    const exactOutput = await r.h.say("exact output using usdt");
    assert.equal(exactOutput.response.type, "ERROR");
    assert.equal(
      exactOutput.response.type === "ERROR" && exactOutput.response.code,
      "ROUTING_UNSUPPORTED",
    );

    // EXACT_INPUT still works: the capabilities are distinct.
    const r2 = setup();
    for (const row of r2.world.capabilities) {
      if (row.capability === "EXACT_OUTPUT") row.isActive = false;
    }
    paymentReady((await r2.h.say("exact input using usdt")).response);
  });

  it("a request limited to less slippage than the provider quotes is refused", async () => {
    const r = setup();
    r.h.script.set(
      "tight",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
        constraints: { maxSlippageBps: 4 },
      }),
    );
    const refused = await r.h.say("tight");
    assert.equal(refused.response.type, "ERROR");

    const loose = setup();
    loose.h.script.set(
      "loose",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
        constraints: { maxSlippageBps: 5 },
      }),
    );
    paymentReady((await loose.h.say("loose")).response);
  });

  it("makes no assumption about what the user holds", async () => {
    const r = setup();
    const ready = paymentReady((await r.h.say("exact output")).response);
    assert.equal(JSON.stringify(ready).toLowerCase().includes("balance"), false);
    // Both funding assets were candidates; the choice was by price alone.
    const requested = new Set(r.mock.requests.map((q) => q.inputAssetId));
    assert.ok(requested.has(r.h.assets.USDT.id));
    assert.ok(requested.has(r.h.assets.USDC_CELO.id));
  });
});

describe("quote versus payment", () => {
  it("a QUOTE returns QUOTE_RESULT, informational only", async () => {
    const r = setup();
    const turn = await r.h.say("quote");
    const quote = quoteResult(turn.response);
    assert.equal(quote.source.display, "50 USDT");
    // net 49.995 USDT at 5.42 = 270.97290 wBRL
    assert.equal(quote.destination.display, "270.9729 wBRL");
    assert.match(quote.text, /50 USDT currently gives approximately 270.9729 wBRL/);
    assert.match(quote.text, /Nothing was sent/);
    for (const message of r.world.messages) {
      const type = (message.structuredData as { type?: string } | undefined)?.type;
      assert.notEqual(type, "AUTHORIZATION_REQUIRED");
      assert.notEqual(type, "PAYMENT_READY");
    }
  });

  it("a PAYMENT returns PAYMENT_READY and executes nothing", async () => {
    const r = setup();
    const turn = await r.h.say("exact output using usdt");
    paymentReady(turn.response);
    for (const message of r.world.messages) {
      assert.notEqual(
        (message.structuredData as { type?: string } | undefined)?.type,
        "AUTHORIZATION_REQUIRED",
      );
    }
    const intentRow = [...r.world.intents.values()][0];
    assert.equal(intentRow?.status, "RESOLVED", "not authorized, not executing");
  });

  it("keeps the understood-request answer and then the priced answer in the history", async () => {
    const r = setup();
    await r.h.say("exact output using usdt");
    const types = r.world.messages
      .filter((m) => m.role === "ASSISTANT")
      .map((m) => (m.structuredData as { type: string }).type);
    assert.deepEqual(types, ["ROUTING_REQUIRED", "PAYMENT_READY"]);
  });
});

describe("persistence, reuse and revisions", () => {
  it("persists the quote, route and steps bound to the intent revision", async () => {
    const r = setup();
    const ready = paymentReady((await r.h.say("exact output using usdc")).response);
    const [route] = [...r.world.routes.values()];
    assert.equal(route?.id, ready.routeId);
    assert.equal(route?.intentRevision, 1);
    assert.equal(route?.status, "VALID");
    assert.equal(route?.steps.length, 2);
    assert.equal(r.world.quotes.length, 2);
    assert.ok(r.world.quotes.every((q) => q.intentRevision === 1 && q.expiresAt));
    assert.deepEqual(
      route?.steps.map((s) => s.quoteId),
      r.world.quotes.map((q) => q.id),
    );
    // Fees in different assets are not added into one total.
    assert.equal(route?.totalFee, undefined);
    assert.equal(
      r.world.quotes.every((q) => q.rawProviderData?.["mock"] === true),
      true,
    );
  });

  it("a single-asset fee is stored as the route's total fee", async () => {
    const r = setup();
    await r.h.say("exact output using usdt");
    const [route] = [...r.world.routes.values()];
    assert.equal(route?.totalFee?.amount, "9227");
  });

  it("reuses the stored route inside the same revision while its quotes are valid, then re-quotes", async () => {
    const r = setup();
    await r.h.say("exact output using usdt");
    const [first] = [...r.world.routes.values()];
    const intentId = first?.intentId ?? "";
    const request = {
      intentId,
      intentRevision: 1,
      userId: "u",
      operation: "SEND" as const,
      purpose: "PAYMENT" as const,
      amount: createMoney("50000", r.h.assets.BRL.id),
      amountMode: "EXACT_OUTPUT" as const,
    };

    const again = await r.routing.plan(request);
    assert.equal(again.status, "REUSED");
    assert.equal(r.world.routes.size, 1);
    assert.equal(r.world.quotes.length, 1, "no new quote was requested");

    r.clock.advance(31_000); // past the 30 s expiry
    const refreshed = await r.routing.plan(request);
    assert.notEqual(refreshed.status, "REUSED", "an expired route is never reused");
  });

  it("an edit to the intent invalidates the old route and binds a new one to the new revision", async () => {
    const r = setup();
    const first = paymentReady((await r.h.say("exact input using usdt")).response);
    const second = paymentReady((await r.h.say("make it 40")).response);

    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    assert.notEqual(second.routeId, first.routeId);
    assert.equal(second.senderSpends.expected.display, "40 USDT");

    const old = r.world.routes.get(first.routeId);
    assert.equal(old?.status, "INVALID", "the old route is retired, not deleted");
    assert.ok(old);
    assert.equal(r.world.routes.get(second.routeId)?.status, "VALID");
    assert.throws(
      () => assertRouteUsable(old, { intentRevision: 2, now: r.clock.now }),
      /another intent revision|no longer valid/,
    );
    // Quotes are immutable history: the old one is still there, untouched, tied to revision 1.
    const oldQuote = r.world.quotes.find((q) => q.intentRevision === 1);
    assert.equal(oldQuote?.input.amount, (20n * USDT_UNITS).toString());
  });

  it("discards prices when the intent moved on while they were being fetched", async () => {
    const r = setup();
    const first = paymentReady((await r.h.say("exact input using usdt")).response);
    const intentId = first.intentId;
    const request: RoutingRequest = {
      intentId,
      intentRevision: 1,
      userId: "u",
      operation: "SEND",
      purpose: "PAYMENT",
      amount: createMoney("2000", r.h.assets.USD.id),
      amountMode: "EXACT_INPUT",
      sourceAssetId: r.h.assets.USD.id,
      preferredSourceAssetId: r.h.assets.USDT.id,
      destinationCountry: "BR",
    };
    r.clock.advance(31_000);
    const outcome = await r.routing.plan(request); // priced for revision 1
    await r.h.say("make it 40"); // the intent is now at revision 2
    const response = await r.routing.commit(r.world.repositories, outcome);
    assert.equal(response.type, "ERROR");
    assert.equal(response.type === "ERROR" && response.code, "ROUTING_STALE");
    assert.equal(
      [...r.world.routes.values()].filter(
        (route) => route.intentRevision === 1 && route.status === "VALID",
      ).length,
      0,
    );
  });
});

describe("chain guard", () => {
  it("every stored route is on Celo and its steps connect", async () => {
    const r = setup();
    await r.h.say("exact output using usdc");
    for (const route of r.world.routes.values()) {
      for (const asset of [route.input, route.output]) {
        assert.equal((await r.registry.getById(asset.assetId))?.chainId, CELO_CHAIN_ID);
      }
      const [a, b] = route.steps;
      assert.equal(a?.output.assetId, b?.input.assetId);
    }
  });
});
