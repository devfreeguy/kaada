import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  agentIntentSchema,
  fxQuoteSchema,
  llmIntentJsonSchema,
  llmIntentOutputSchema,
  moneySchema,
  paymentConfirmationSchema,
  quoteRequestSchema,
  recipientReferenceSchema,
} from "./index.js";

const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, true, JSON.stringify(value));
const bad = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  assert.equal(schema.safeParse(value).success, false, JSON.stringify(value));

describe("agentIntentSchema", () => {
  it("accepts a complete SEND", () => {
    ok(agentIntentSchema, {
      type: "SEND",
      recipient: { type: "USERNAME", value: "maria" },
      amount: { value: "20.50", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      sourceAsset: "USDT",
      destination: { country: "BR", currency: "BRL" },
      constraints: { maxSlippageBps: 100, routePreference: "CHEAPEST" },
    });
  });

  it("accepts an incomplete SEND without inventing a recipient", () => {
    const parsed = agentIntentSchema.parse({
      type: "SEND",
      amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
    });
    assert.equal(parsed.type, "SEND");
    assert.ok(!("recipient" in parsed));
  });

  it("accepts the bare minimum for every intent type", () => {
    for (const type of [
      "SEND",
      "CONVERT",
      "QUOTE",
      "BALANCE",
      "TRANSACTION_STATUS",
      "HELP",
      "UNKNOWN",
    ]) {
      ok(agentIntentSchema, { type });
    }
  });

  it("models EXACT_INPUT and EXACT_OUTPUT, and allows the mode to be unstated", () => {
    ok(agentIntentSchema, {
      type: "SEND",
      amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
    });
    ok(agentIntentSchema, {
      type: "SEND",
      amount: { value: "2000", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
    });
    ok(agentIntentSchema, { type: "SEND", amount: { value: "2000", currencyOrAsset: "BRL" } });
    bad(agentIntentSchema, {
      type: "SEND",
      amount: { value: "20", currencyOrAsset: "USD", mode: "ABOUT" },
    });
  });

  it("accepts CONVERT and QUOTE", () => {
    ok(agentIntentSchema, {
      type: "CONVERT",
      amount: { value: "100", currencyOrAsset: "USDC" },
      fromAsset: "USDC",
      toAsset: "cNGN",
    });
    ok(agentIntentSchema, {
      type: "QUOTE",
      amount: { value: "50", currencyOrAsset: "USDT", mode: "EXACT_INPUT" },
      fromAsset: "USDT",
      destination: { country: "br" },
    });
  });

  it("normalises country codes to upper case and rejects bad ones", () => {
    const parsed = agentIntentSchema.parse({ type: "QUOTE", destination: { country: "br" } });
    assert.equal(parsed.type === "QUOTE" && parsed.destination?.country, "BR");
    bad(agentIntentSchema, { type: "QUOTE", destination: { country: "BRA" } });
    bad(agentIntentSchema, { type: "QUOTE", destination: { country: "B1" } });
  });

  it("rejects malformed human amounts", () => {
    for (const value of ["", "-5", "+5", "1e3", "1,000", ".5", "5.", "abc", "00", "NaN"]) {
      bad(agentIntentSchema, { type: "SEND", amount: { value, currencyOrAsset: "USD" } });
    }
    bad(agentIntentSchema, { type: "SEND", amount: { value: 20, currencyOrAsset: "USD" } });
    bad(agentIntentSchema, { type: "SEND", amount: { value: "20", currencyOrAsset: "" } });
    bad(agentIntentSchema, { type: "SEND", amount: { value: "20" } });
  });

  it("rejects unknown keys at every level", () => {
    bad(agentIntentSchema, { type: "SEND", extra: 1 });
    bad(agentIntentSchema, {
      type: "SEND",
      amount: { value: "1", currencyOrAsset: "USD", note: "x" },
    });
    bad(agentIntentSchema, { type: "SEND", recipient: { type: "USERNAME", value: "m", id: "x" } });
    bad(agentIntentSchema, { type: "SEND", constraints: { maxSlippageBps: 1, urgent: true } });
  });

  it("rejects unknown or missing types and out-of-range constraints", () => {
    bad(agentIntentSchema, { type: "TRANSFER" });
    bad(agentIntentSchema, {});
    bad(agentIntentSchema, null);
    bad(agentIntentSchema, { type: "SEND", constraints: { maxSlippageBps: 10_001 } });
    bad(agentIntentSchema, { type: "SEND", constraints: { maxSlippageBps: 1.5 } });
    bad(agentIntentSchema, { type: "SEND", constraints: { routePreference: "FANCY" } });
  });

  it("is what the LLM output schema validates", () => {
    assert.equal(llmIntentOutputSchema, agentIntentSchema);
    const jsonSchema = llmIntentJsonSchema();
    assert.equal(typeof jsonSchema, "object");
    assert.ok(JSON.stringify(jsonSchema).includes("TRANSACTION_STATUS"));
  });
});

describe("recipientReferenceSchema", () => {
  it("supports every planned recipient style", () => {
    for (const type of [
      "KAADA_USER",
      "USERNAME",
      "TELEGRAM_USER",
      "PHONE_NUMBER",
      "WALLET_ADDRESS",
      "SAVED_BENEFICIARY",
      "EXTERNAL_PAYMENT_ADDRESS",
    ]) {
      ok(recipientReferenceSchema, { type, value: "x" });
    }
  });

  it("rejects empty values and unknown types", () => {
    bad(recipientReferenceSchema, { type: "USERNAME", value: "  " });
    bad(recipientReferenceSchema, { type: "EMAIL", value: "a@b.c" });
  });
});

describe("moneySchema", () => {
  const assetId = randomUUID();

  it("requires canonical smallest-unit amounts and a UUID asset", () => {
    ok(moneySchema, { amount: "2050", assetId });
    ok(moneySchema, { amount: "0", assetId });
    for (const amount of ["20.50", "-1", "0005", "", "1e3", 20])
      bad(moneySchema, { amount, assetId });
    bad(moneySchema, { amount: "1", assetId: "not-a-uuid" });
    bad(moneySchema, { amount: "1", assetId, extra: true });
  });
});

describe("quoteRequestSchema", () => {
  const input = randomUUID();
  const output = randomUUID();
  const base = { userId: randomUUID(), inputAssetId: input, outputAssetId: output };

  it("EXACT_INPUT requires the amount in the input asset", () => {
    ok(quoteRequestSchema, {
      ...base,
      mode: "EXACT_INPUT",
      amount: { amount: "2000", assetId: input },
    });
    bad(quoteRequestSchema, {
      ...base,
      mode: "EXACT_INPUT",
      amount: { amount: "2000", assetId: output },
    });
  });

  it("EXACT_OUTPUT requires the amount in the output asset", () => {
    ok(quoteRequestSchema, {
      ...base,
      mode: "EXACT_OUTPUT",
      amount: { amount: "200000", assetId: output },
    });
    bad(quoteRequestSchema, {
      ...base,
      mode: "EXACT_OUTPUT",
      amount: { amount: "200000", assetId: input },
    });
  });

  it("rejects zero amounts and unknown keys, accepts constraints", () => {
    bad(quoteRequestSchema, {
      ...base,
      mode: "EXACT_INPUT",
      amount: { amount: "0", assetId: input },
    });
    bad(quoteRequestSchema, {
      ...base,
      mode: "EXACT_INPUT",
      amount: { amount: "1", assetId: input },
      x: 1,
    });
    ok(quoteRequestSchema, {
      ...base,
      mode: "EXACT_INPUT",
      amount: { amount: "1", assetId: input },
      constraints: { maxSlippageBps: 50, routePreference: "CHEAPEST" },
    });
  });
});

describe("provider and confirmation schemas", () => {
  const asset = randomUUID();
  const money = { amount: "100", assetId: asset };

  it("validates a normalised FX quote and accepts ISO dates", () => {
    const parsed = fxQuoteSchema.parse({
      id: randomUUID(),
      provider: "textile",
      input: money,
      output: { amount: "99", assetId: randomUUID() },
      slippageBps: 25,
      expiresAt: "2026-01-01T00:00:00Z",
      metadata: { pool: "a", nested: { n: 1 } },
    });
    assert.ok(parsed.expiresAt instanceof Date);
    bad(fxQuoteSchema, {
      id: randomUUID(),
      provider: "textile",
      input: { amount: "1.5", assetId: asset },
      output: money,
    });
    bad(fxQuoteSchema, {
      id: randomUUID(),
      provider: "textile",
      input: money,
      output: money,
      rawDto: {},
    });
  });

  it("validates a payment confirmation", () => {
    const route = {
      id: randomUUID(),
      intentId: randomUUID(),
      status: "VALID",
      input: money,
      output: money,
      steps: [
        {
          id: randomUUID(),
          routeId: randomUUID(),
          position: 0,
          type: "SWAP",
          input: money,
          output: money,
          createdAt: new Date(),
        },
      ],
      createdAt: new Date(),
    };
    ok(paymentConfirmationSchema, {
      operation: "SEND",
      senderSpends: money,
      recipientReceives: money,
      recipient: { reference: { type: "USERNAME", value: "maria" } },
      fees: [money],
      route,
    });
    bad(paymentConfirmationSchema, {
      operation: "BALANCE",
      senderSpends: money,
      recipientReceives: money,
      fees: [],
      route,
    });
  });
});
