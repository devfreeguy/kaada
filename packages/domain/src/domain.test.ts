import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { KAADA_ERROR_CODES, KaadaError, isKaadaError } from "./errors/index.js";
import { createId, isUuid } from "./ids/index.js";
import { findMissingFields } from "./intents/index.js";
import type { AgentIntent } from "./intents/index.js";
import { createMoney } from "./money/index.js";
import { assertNotExpired, assertSlippageWithin, isExpired } from "./policies/index.js";
import { validateQuoteRequest } from "./quotes/index.js";
import type { QuoteRequest } from "./quotes/index.js";
import { validatePaymentRoute } from "./routing/index.js";
import type { PaymentRoute, RouteStep } from "./routing/index.js";

describe("ids", () => {
  it("creates distinct UUIDv4 values", () => {
    const a = createId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, createId());
    assert.equal(isUuid(a), true);
    assert.equal(isUuid("nope"), false);
  });
});

describe("KaadaError", () => {
  it("carries a code and details and is detectable", () => {
    const error = new KaadaError("QUOTE_EXPIRED", "late", { details: { quoteId: "q" } });
    assert.equal(error.code, "QUOTE_EXPIRED");
    assert.equal(error.name, "KaadaError");
    assert.deepEqual(error.details, { quoteId: "q" });
    assert.equal(isKaadaError(error), true);
    assert.equal(isKaadaError(error, "QUOTE_EXPIRED"), true);
    assert.equal(isKaadaError(error, "INVALID_INTENT"), false);
    assert.equal(isKaadaError(new Error("x")), false);
  });

  it("defines the agreed set of codes", () => {
    assert.equal(KAADA_ERROR_CODES.length, 29);
    assert.equal(new Set(KAADA_ERROR_CODES).size, 29);
  });
});

describe("findMissingFields", () => {
  it("reports what a partial SEND lacks, without inventing anything", () => {
    assert.deepEqual(
      findMissingFields({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
      ["RECIPIENT"],
    );
    assert.deepEqual(findMissingFields({ type: "SEND" }), ["AMOUNT", "RECIPIENT"]);
    assert.deepEqual(
      findMissingFields({
        type: "SEND",
        recipient: { type: "USERNAME", value: "maria" },
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
      [],
    );
  });

  it("covers CONVERT and QUOTE", () => {
    assert.deepEqual(findMissingFields({ type: "CONVERT" }), [
      "AMOUNT",
      "SOURCE_ASSET",
      "DESTINATION_ASSET",
    ]);
    assert.deepEqual(findMissingFields({ type: "QUOTE" }), [
      "AMOUNT",
      "SOURCE_ASSET",
      "DESTINATION",
    ]);
    assert.deepEqual(
      findMissingFields({
        type: "QUOTE",
        amount: { value: "50", currencyOrAsset: "USDT" },
        fromAsset: "USDT",
        destination: { country: "BR" },
      }),
      [],
    );
  });

  it("lets the amount's currency name the fixed side of a CONVERT or QUOTE", () => {
    const amount = { value: "100", currencyOrAsset: "USDC" } as const;
    // Input fixed (default): the amount is the source, only the target is needed.
    assert.deepEqual(findMissingFields({ type: "CONVERT", amount }), ["DESTINATION_ASSET"]);
    assert.deepEqual(findMissingFields({ type: "QUOTE", amount }), ["DESTINATION"]);
    // Output fixed: the amount is the target, only the source is needed.
    const exactOutput = { ...amount, mode: "EXACT_OUTPUT" } as const;
    assert.deepEqual(findMissingFields({ type: "CONVERT", amount: exactOutput }), ["SOURCE_ASSET"]);
    assert.deepEqual(findMissingFields({ type: "QUOTE", amount: exactOutput }), ["SOURCE_ASSET"]);
  });

  it("asks for the currency when a number has none, for every operation", () => {
    const amount = { value: "20" };
    assert.deepEqual(
      findMissingFields({ type: "SEND", amount, recipient: { type: "USERNAME", value: "daniel" } }),
      ["CURRENCY"],
    );
    assert.deepEqual(findMissingFields({ type: "SEND", amount }), ["CURRENCY", "RECIPIENT"]);
    assert.deepEqual(findMissingFields({ type: "CONVERT", amount, toAsset: "wBRL" }), [
      "CURRENCY",
      "SOURCE_ASSET",
    ]);
    assert.deepEqual(
      findMissingFields({
        type: "QUOTE",
        amount,
        fromAsset: "USDT",
        destination: { country: "BR" },
      }),
      ["CURRENCY"],
    );
    assert.deepEqual(
      findMissingFields({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "USD" },
        recipient: { type: "USERNAME", value: "daniel" },
      }),
      [],
    );
  });

  it("needs nothing for informational intents", () => {
    const informational: AgentIntent[] = [
      { type: "BALANCE" },
      { type: "TRANSACTION_STATUS" },
      { type: "HELP" },
      { type: "UNKNOWN" },
    ];
    for (const intent of informational) assert.deepEqual(findMissingFields(intent), []);
  });
});

describe("validateQuoteRequest", () => {
  const base: QuoteRequest = {
    userId: "u",
    inputAssetId: "usd",
    outputAssetId: "brl",
    amount: createMoney("2000", "usd"),
    mode: "EXACT_INPUT",
  };

  it("EXACT_INPUT fixes the input asset; EXACT_OUTPUT fixes the output asset", () => {
    assert.doesNotThrow(() => validateQuoteRequest(base));
    assert.doesNotThrow(() =>
      validateQuoteRequest({ ...base, mode: "EXACT_OUTPUT", amount: createMoney("200000", "brl") }),
    );
  });

  it("rejects an amount denominated in the wrong side's asset", () => {
    assert.throws(
      () => validateQuoteRequest({ ...base, mode: "EXACT_OUTPUT" }),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
    assert.throws(
      () => validateQuoteRequest({ ...base, amount: createMoney("1", "brl") }),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
  });

  it("rejects a zero amount", () => {
    assert.throws(
      () => validateQuoteRequest({ ...base, amount: createMoney("0", "usd") }),
      (e) => isKaadaError(e, "INVALID_AMOUNT"),
    );
  });
});

describe("validatePaymentRoute", () => {
  const step = (position: number, from: string, to: string): RouteStep => ({
    id: `s${position}`,
    routeId: "r",
    position,
    type: "SWAP",
    input: createMoney("10", from),
    output: createMoney("9", to),
    createdAt: new Date(0),
  });
  const route = (steps: RouteStep[], output = "c"): PaymentRoute => ({
    id: "r",
    intentId: "i",
    intentRevision: 1,
    status: "CREATED",
    input: createMoney("10", "a"),
    output: createMoney("9", output),
    steps,
    createdAt: new Date(0),
  });

  it("accepts a contiguous route regardless of step order in the array", () => {
    assert.doesNotThrow(() => validatePaymentRoute(route([step(0, "a", "b"), step(1, "b", "c")])));
    assert.doesNotThrow(() => validatePaymentRoute(route([step(1, "b", "c"), step(0, "a", "b")])));
  });

  it("rejects empty, broken and non-spanning routes", () => {
    assert.throws(
      () => validatePaymentRoute(route([])),
      (e) => isKaadaError(e, "NO_ROUTE_AVAILABLE"),
    );
    assert.throws(
      () => validatePaymentRoute(route([step(0, "a", "b"), step(1, "x", "c")])),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
    assert.throws(
      () => validatePaymentRoute(route([step(0, "a", "b")], "c")),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
  });
});

describe("quote policies", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("treats expiry as inclusive and absence as no limit", () => {
    assert.equal(isExpired(undefined, now), false);
    assert.equal(isExpired(new Date(now.getTime() + 1), now), false);
    assert.equal(isExpired(now, now), true);
    assert.throws(
      () => assertNotExpired(new Date(0), now),
      (e) => isKaadaError(e, "QUOTE_EXPIRED"),
    );
    assert.doesNotThrow(() => assertNotExpired(undefined, now));
  });

  it("enforces the slippage ceiling only when both values exist", () => {
    assert.doesNotThrow(() => assertSlippageWithin(50, 50));
    assert.doesNotThrow(() => assertSlippageWithin(undefined, 50));
    assert.doesNotThrow(() => assertSlippageWithin(500, undefined));
    assert.throws(
      () => assertSlippageWithin(51, 50),
      (e) => isKaadaError(e, "SLIPPAGE_EXCEEDED"),
    );
  });
});
