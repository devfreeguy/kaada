import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Asset } from "../assets/index.js";
import { isKaadaError } from "../errors/index.js";
import { createMoney } from "../money/index.js";
import type { FxQuote, QuoteRequest } from "../quotes/index.js";
import { aggregateFees } from "./planned-route.js";
import type { PlannedRoute } from "./planned-route.js";
import { compareRoutes, rankRoutes } from "./route-ranking.js";
import { assertRouteUsable, validatePaymentRoute } from "./route.js";
import type { PaymentRoute, RouteStep } from "./route.js";
import { checkQuote } from "./route-planner.js";

const asset = (id: string, symbol: string, decimals: number, fiatCode: string): Asset => ({
  id,
  symbol,
  name: symbol,
  kind: "USD_STABLECOIN",
  decimals,
  chainId: 42220,
  contractAddress: `0x${id}`,
  fiatCode,
  isActive: true,
});

// USDT and USDC are both USD; wBRL is BRL (18 decimals).
const assets = new Map(
  [
    asset("usdt", "USDT", 6, "USD"),
    asset("usdc", "USDC", 6, "USD"),
    asset("wbrl", "wBRL", 18, "BRL"),
    asset("cngn", "cNGN", 6, "NGN"),
  ].map((a) => [a.id, a]),
);

function route(over: Partial<PlannedRoute> & { key: string }): PlannedRoute {
  return {
    sourceAssetId: "usdt",
    destinationAssetId: "wbrl",
    kind: "SWAP",
    hops: [],
    input: createMoney("92260150", "usdt"),
    output: createMoney("500000000000000000000", "wbrl"),
    fees: [],
    slippageBps: 5,
    ...over,
  };
}

const oneHop = { hops: [{}] as PlannedRoute["hops"] };
const twoHop = { hops: [{}, {}] as PlannedRoute["hops"] };

describe("route ranking", () => {
  it("EXACT_INPUT maximises the output", () => {
    const worse = route({ key: "a", output: createMoney("108000000000000000000", "wbrl") });
    const better = route({ key: "b", output: createMoney("108389160000000000000", "wbrl") });
    const ranked = rankRoutes([worse, better], { mode: "EXACT_INPUT", assets });
    assert.deepEqual(
      ranked.map((r) => r.key),
      ["b", "a"],
    );
  });

  it("EXACT_OUTPUT minimises the input, even across USD stablecoins at par", () => {
    const usdt = route({ key: "usdt", input: createMoney("92260150", "usdt") });
    const usdc = route({
      key: "usdc",
      sourceAssetId: "usdc",
      input: createMoney("92278606", "usdc"),
    });
    const ranked = rankRoutes([usdc, usdt], { mode: "EXACT_OUTPUT", assets });
    assert.deepEqual(
      ranked.map((r) => r.key),
      ["usdt", "usdc"],
    );
  });

  it("breaks ties on fees, then hops, then slippage, then a stable key", () => {
    const base = { mode: "EXACT_OUTPUT", assets } as const;
    const cheap = route({ key: "z", fees: [createMoney("100", "usdt")], ...oneHop });
    const dear = route({ key: "a", fees: [createMoney("900", "usdt")], ...oneHop });
    assert.ok(compareRoutes(cheap, dear, base) < 0, "lower fee first");

    const direct = route({ key: "z", ...oneHop });
    const indirect = route({ key: "a", ...twoHop });
    assert.ok(compareRoutes(direct, indirect, base) < 0, "direct beats an equal two-hop route");

    const steady = route({ key: "z", slippageBps: 3, ...oneHop });
    const loose = route({ key: "a", slippageBps: 9, ...oneHop });
    assert.ok(compareRoutes(steady, loose, base) < 0, "lower slippage first");

    const first = route({ key: "a", ...oneHop });
    const second = route({ key: "b", ...oneHop });
    assert.ok(compareRoutes(first, second, base) < 0);
    assert.deepEqual(
      rankRoutes([second, first], base).map((r) => r.key),
      rankRoutes([first, second], base).map((r) => r.key),
      "the order does not depend on input order",
    );
  });

  it("a genuinely better two-hop route beats a direct one: the first criterion is strict", () => {
    const direct = route({ key: "d", input: createMoney("92260150", "usdt"), ...oneHop });
    const cheaper = route({ key: "i", input: createMoney("92000000", "usdt"), ...twoHop });
    assert.equal(rankRoutes([direct, cheaper], { mode: "EXACT_OUTPUT", assets })[0]?.key, "i");
  });

  it("never adds fees of different assets, and does not compare them either", () => {
    const fees = aggregateFees([
      createMoney("100", "usdt"),
      createMoney("50", "usdc"),
      createMoney("25", "usdt"),
      undefined,
    ]);
    assert.deepEqual(fees, [createMoney("50", "usdc"), createMoney("125", "usdt")]);

    // A naira fee against a dollar fee is incomparable, so it does not decide the order.
    const a = route({ key: "a", fees: [createMoney("1", "cngn")], ...oneHop });
    const b = route({ key: "b", fees: [createMoney("999999999", "usdt")], ...oneHop });
    assert.ok(
      compareRoutes(a, b, { mode: "EXACT_OUTPUT", assets }) < 0,
      "falls through to the key",
    );
  });
});

describe("quote checks", () => {
  const now = new Date("2026-10-09T12:00:00Z");
  const request: QuoteRequest = {
    userId: "u",
    inputAssetId: "usdt",
    outputAssetId: "wbrl",
    amount: createMoney("20000000", "usdt"),
    mode: "EXACT_INPUT",
  };
  const quote = (over: Partial<FxQuote> = {}): FxQuote => ({
    id: "q",
    provider: "p",
    input: createMoney("20000000", "usdt"),
    output: createMoney("108389160000000000000", "wbrl"),
    slippageBps: 5,
    expiresAt: new Date(now.getTime() + 30_000),
    ...over,
  });

  it("accepts a well-formed quote", () => {
    assert.equal(checkQuote(quote(), request, now, undefined), undefined);
  });

  it("rejects an expired quote, one without an expiry, and one at the exact expiry instant", () => {
    assert.match(
      checkQuote(quote({ expiresAt: new Date(now.getTime() - 1) }), request, now, undefined) ?? "",
      /expired/,
    );
    assert.match(
      checkQuote(quote({ expiresAt: new Date(now.getTime()) }), request, now, undefined) ?? "",
      /expired/,
    );
    const { expiresAt: _omitted, ...withoutExpiry } = quote();
    assert.match(checkQuote(withoutExpiry, request, now, undefined) ?? "", /expiry/);
  });

  it("holds EXACT_INPUT to the exact input and EXACT_OUTPUT to the exact output", () => {
    assert.match(
      checkQuote(quote({ input: createMoney("20000001", "usdt") }), request, now, undefined) ?? "",
      /exactly the requested input/,
    );
    const exactOutput: QuoteRequest = {
      ...request,
      mode: "EXACT_OUTPUT",
      amount: createMoney("500000000000000000000", "wbrl"),
    };
    assert.match(
      checkQuote(quote(), exactOutput, now, undefined) ?? "",
      /exactly the requested output/,
    );
  });

  it("rejects wrong assets, zero amounts and slippage above the limit", () => {
    assert.match(
      checkQuote(quote({ output: createMoney("1", "usdc") }), request, now, undefined) ?? "",
      /assets/,
    );
    assert.match(
      checkQuote(quote({ output: createMoney("0", "wbrl") }), request, now, undefined) ?? "",
      /zero/,
    );
    assert.match(checkQuote(quote(), request, now, 4) ?? "", /slippage/);
    assert.equal(checkQuote(quote(), request, now, 5), undefined);
  });
});

describe("route usability", () => {
  const stored = (over: Partial<PaymentRoute> = {}): PaymentRoute => ({
    id: "r",
    intentId: "i",
    intentRevision: 2,
    status: "VALID",
    input: createMoney("10", "usdt"),
    output: createMoney("9", "wbrl"),
    expiresAt: new Date("2026-10-09T12:00:30Z"),
    steps: [],
    createdAt: new Date(0),
    ...over,
  });
  const now = new Date("2026-10-09T12:00:00Z");

  it("accepts a valid route for its own revision", () => {
    assert.doesNotThrow(() => assertRouteUsable(stored(), { intentRevision: 2, now }));
  });

  it("rejects another revision, an invalidated route and an expired one", () => {
    assert.throws(
      () => assertRouteUsable(stored(), { intentRevision: 3, now }),
      (error) => isKaadaError(error, "NO_ROUTE_AVAILABLE"),
    );
    assert.throws(
      () => assertRouteUsable(stored({ status: "INVALID" }), { intentRevision: 2, now }),
      (error) => isKaadaError(error, "NO_ROUTE_AVAILABLE"),
    );
    assert.throws(
      () =>
        assertRouteUsable(stored(), { intentRevision: 2, now: new Date("2026-10-09T12:00:30Z") }),
      (error) => isKaadaError(error, "QUOTE_EXPIRED"),
    );
  });

  it("validatePaymentRoute rejects a route that revisits an asset", () => {
    const step = (position: number, from: string, to: string): RouteStep => ({
      id: `s${position}`,
      routeId: "r",
      position,
      type: "SWAP",
      input: createMoney("10", from),
      output: createMoney("9", to),
      createdAt: new Date(0),
    });
    const cycle = {
      id: "r",
      input: createMoney("10", "a"),
      output: createMoney("9", "c"),
      steps: [step(0, "a", "b"), step(1, "b", "a"), step(2, "a", "c")],
    };
    assert.throws(
      () => validatePaymentRoute(cycle),
      (error) => isKaadaError(error, "ASSET_MISMATCH"),
    );
    // A single transfer keeps its asset and is fine.
    assert.doesNotThrow(() =>
      validatePaymentRoute({
        id: "r",
        input: createMoney("10", "a"),
        output: createMoney("10", "a"),
        steps: [{ position: 0, input: createMoney("10", "a"), output: createMoney("10", "a") }],
      }),
    );
  });
});
