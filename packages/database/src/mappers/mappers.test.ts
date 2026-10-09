import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createMoney, isKaadaError } from "@kaada/domain";
import type { Intent } from "@kaada/domain";

import type {
  Intent as IntentRow,
  Quote as QuoteRow,
  Route as RouteRow,
  RouteStep as RouteStepRow,
  Transaction as TransactionRow,
} from "../generated/prisma/client.js";
import { toExecution, toTransaction } from "./execution.js";
import { intentCreateData, intentUpdateData, toIntent } from "./intent.js";
import { quoteCreateData, routeCreateData, toQuote, toRoute } from "./quote-route.js";
import { DataIntegrityError, jsonInput, toStorableJson } from "./support.js";

const now = new Date("2026-01-01T00:00:00Z");
const [usd, brl, userId, conversationId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

const intentRow = (overrides: Partial<IntentRow> = {}): IntentRow => ({
  id: randomUUID(),
  userId,
  conversationId,
  type: "SEND",
  status: "DRAFT",
  amount: null,
  amountMode: null,
  sourceAssetId: null,
  destinationAssetId: null,
  recipientId: null,
  destinationCountry: null,
  normalizedData: {},
  constraints: null,
  missingFields: null,
  preferredSourceAssetId: null,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe("intent mapper", () => {
  it("maps a fresh draft: empty normalizedData means nothing extracted yet", () => {
    const intent = toIntent(intentRow());
    assert.equal(intent.parsed, undefined);
    assert.deepEqual(intent.missingFields, []);
    assert.ok(
      !("amount" in intent) && !("constraints" in intent),
      "absent values are omitted, not undefined",
    );
  });

  it("derives the amount asset from the mode", () => {
    const exactInput = toIntent(
      intentRow({
        amount: "2050",
        amountMode: "EXACT_INPUT",
        sourceAssetId: usd,
        destinationAssetId: brl,
      }),
    );
    assert.deepEqual(exactInput.amount, { money: createMoney("2050", usd), mode: "EXACT_INPUT" });
    const exactOutput = toIntent(
      intentRow({
        amount: "200000",
        amountMode: "EXACT_OUTPUT",
        sourceAssetId: usd,
        destinationAssetId: brl,
      }),
    );
    assert.deepEqual(exactOutput.amount, {
      money: createMoney("200000", brl),
      mode: "EXACT_OUTPUT",
    });
  });

  it("rejects stored amounts that cannot be interpreted", () => {
    assert.throws(() => toIntent(intentRow({ amount: "5" })), DataIntegrityError);
    assert.throws(
      () => toIntent(intentRow({ amount: "5", amountMode: "EXACT_INPUT" })),
      DataIntegrityError,
    );
    assert.throws(
      () => toIntent(intentRow({ amount: "5", amountMode: "EXACT_OUTPUT", sourceAssetId: usd })),
      DataIntegrityError,
    );
    assert.throws(() =>
      toIntent(intentRow({ amount: "5.5", amountMode: "EXACT_INPUT", sourceAssetId: usd })),
    );
  });

  it("keeps unresolved human amounts inside parsed, never as canonical money", () => {
    const intent = toIntent(
      intentRow({
        normalizedData: {
          type: "SEND",
          amount: { value: "20.50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        },
        missingFields: ["RECIPIENT"],
      }),
    );
    assert.equal(intent.parsed?.type === "SEND" && intent.parsed.amount?.value, "20.50");
    assert.equal(intent.amount, undefined);
    assert.deepEqual(intent.missingFields, ["RECIPIENT"]);
  });

  it("rejects normalizedData that is invalid or disagrees with the row type", () => {
    assert.throws(
      () =>
        toIntent(
          intentRow({
            normalizedData: { type: "SEND", amount: { value: "1e3", currencyOrAsset: "USD" } },
          }),
        ),
      DataIntegrityError,
    );
    assert.throws(
      () => toIntent(intentRow({ normalizedData: { type: "SEND", surprise: true } })),
      DataIntegrityError,
    );
    assert.throws(
      () => toIntent(intentRow({ normalizedData: { type: "HELP" } })),
      DataIntegrityError,
    );
    assert.throws(
      () => toIntent(intentRow({ missingFields: ["NOT_A_FIELD"] })),
      DataIntegrityError,
    );
  });

  it("writes canonical columns and JSON-safe data from a domain intent", () => {
    const intent: Intent = {
      id: randomUUID(),
      userId,
      conversationId,
      type: "SEND",
      status: "RESOLVED",
      amount: { money: createMoney("2050", usd), mode: "EXACT_INPUT" },
      sourceAssetId: usd,
      destinationAssetId: brl,
      parsed: {
        type: "SEND",
        amount: { value: "20.50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      },
      constraints: { maxSlippageBps: 50 },
      missingFields: ["RECIPIENT"],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const data = intentCreateData(intent);
    assert.equal(data.amount, "2050");
    assert.equal(data.amountMode, "EXACT_INPUT");
    assert.equal(data.recipientId, null);
    assert.deepEqual(data.constraints, { maxSlippageBps: 50 });
    assert.deepEqual(data.missingFields, ["RECIPIENT"]);
    assert.deepEqual(data.normalizedData, intent.parsed);
  });

  it("refuses an amount whose asset does not match its mode", () => {
    const intent: Intent = {
      id: randomUUID(),
      userId,
      conversationId,
      type: "SEND",
      status: "RESOLVED",
      amount: { money: createMoney("2050", brl), mode: "EXACT_INPUT" },
      sourceAssetId: usd,
      destinationAssetId: brl,
      missingFields: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    assert.throws(
      () => intentCreateData(intent),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
  });

  it("clears absent optional values on update instead of leaving stale ones", () => {
    const data = intentUpdateData({ status: "DRAFT", missingFields: [], revision: 1 });
    assert.equal(data.amount, null);
    assert.equal(data.sourceAssetId, null);
    assert.equal(typeof data.constraints, "object", "DbNull sentinel for a cleared Json column");
  });
});

describe("quote mapper", () => {
  const row = (overrides: Partial<QuoteRow> = {}): QuoteRow => ({
    id: randomUUID(),
    intentId: randomUUID(),
    intentRevision: 1,
    providerId: randomUUID(),
    inputAssetId: usd,
    outputAssetId: brl,
    inputAmount: "2000",
    outputAmount: "10000",
    feeAmount: null,
    feeAssetId: null,
    slippageBps: null,
    providerQuoteId: null,
    expiresAt: null,
    rawProviderData: null,
    createdAt: now,
    ...overrides,
  });

  it("combines amount and asset into Money and pairs the fee", () => {
    const quote = toQuote(row({ feeAmount: "15", feeAssetId: usd, slippageBps: 25 }));
    assert.deepEqual(quote.input, createMoney("2000", usd));
    assert.deepEqual(quote.output, createMoney("10000", brl));
    assert.deepEqual(quote.fee, createMoney("15", usd));
    assert.equal(quote.slippageBps, 25);
    assert.ok(!("fee" in toQuote(row())));
  });

  it("rejects a fee amount without a fee asset, and vice versa", () => {
    assert.throws(() => toQuote(row({ feeAmount: "15" })), DataIntegrityError);
    assert.throws(() => toQuote(row({ feeAssetId: usd })), DataIntegrityError);
  });

  it("round-trips through create data, keeping raw provider data as plain JSON", () => {
    const quote = toQuote(
      row({ feeAmount: "15", feeAssetId: usd, rawProviderData: { pool: "x", n: [1, 2] } }),
    );
    const data = quoteCreateData(quote);
    assert.equal(data.inputAmount, "2000");
    assert.equal(data.feeAmount, "15");
    assert.deepEqual(data.rawProviderData, { pool: "x", n: [1, 2] });
  });
});

describe("route mapper", () => {
  const routeId = randomUUID();
  const stepRow = (position: number, from: string, to: string): RouteStepRow => ({
    id: randomUUID(),
    routeId,
    position,
    type: "SWAP",
    providerId: null,
    inputAssetId: from,
    outputAssetId: to,
    inputAmount: "10",
    outputAmount: "9",
    quoteId: null,
    metadata: null,
    createdAt: now,
  });
  const routeRow: RouteRow = {
    id: routeId,
    intentId: randomUUID(),
    intentRevision: 1,
    status: "VALID",
    inputAssetId: usd,
    outputAssetId: brl,
    estimatedInput: "10",
    estimatedOutput: "9",
    totalFeeAmount: null,
    totalFeeAssetId: null,
    expiresAt: null,
    createdAt: now,
  };

  it("orders steps by position regardless of row order", () => {
    const route = toRoute({ ...routeRow, steps: [stepRow(1, "mid", brl), stepRow(0, usd, "mid")] });
    assert.deepEqual(
      route.steps.map((s) => s.position),
      [0, 1],
    );
    assert.deepEqual(route.input, createMoney("10", usd));
  });

  it("builds an atomic nested write for route and steps", () => {
    const route = toRoute({ ...routeRow, steps: [stepRow(0, usd, brl)] });
    const { createdAt: _c, ...newRoute } = route;
    const data = routeCreateData({
      ...newRoute,
      steps: route.steps.map(({ createdAt: _s, ...step }) => step),
    });
    const created = (data.steps?.create ?? []) as unknown[];
    assert.equal(created.length, 1);
    assert.equal(data.estimatedInput, "10");
  });
});

describe("transaction and execution mappers", () => {
  const txRow = (overrides: Partial<TransactionRow> = {}): TransactionRow => ({
    id: randomUUID(),
    executionId: randomUUID(),
    type: "TRANSFER",
    status: "CREATED",
    chainId: 42220,
    hash: null,
    fromAddress: null,
    toAddress: null,
    assetId: null,
    amount: null,
    gasAmount: null,
    gasAssetId: null,
    nonce: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });

  it("keeps amounts, gas and nonce as exact strings beyond Number precision", () => {
    const tx = toTransaction(
      txRow({
        amount: "1500000000000000000",
        gasAmount: "9007199254740993",
        nonce: "18446744073709551615",
      }),
    );
    assert.equal(tx.amount, "1500000000000000000");
    assert.equal(tx.gasAmount, "9007199254740993");
    assert.equal(tx.nonce, "18446744073709551615");
    assert.ok(!("hash" in tx));
  });

  it("rejects non-canonical stored amounts", () => {
    assert.throws(() => toTransaction(txRow({ amount: "1.5" })));
    assert.throws(() => toTransaction(txRow({ nonce: "007" })));
  });

  it("maps an execution with only the timestamps that exist", () => {
    const execution = toExecution({
      id: randomUUID(),
      intentId: randomUUID(),
      routeId: randomUUID(),
      userId,
      status: "CONFIRMED",
      idempotencyKey: "k1",
      confirmedAt: now,
      startedAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      failureMessage: null,
      metadata: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(execution.confirmedAt, now);
    assert.ok(!("startedAt" in execution));
  });
});

describe("JSON support", () => {
  it("round-trips dates to ISO strings and drops undefined, rejecting unsafe values", () => {
    assert.deepEqual(
      toStorableJson({ at: new Date("2026-01-01T00:00:00Z"), skip: undefined, n: 1 }, "x"),
      {
        at: "2026-01-01T00:00:00.000Z",
        n: 1,
      },
    );
    assert.throws(() => toStorableJson({ big: 10n }, "x"), DataIntegrityError);
    assert.equal(jsonInput(undefined, "x"), undefined);
    assert.equal(jsonInput(null, "x"), undefined);
  });
});
