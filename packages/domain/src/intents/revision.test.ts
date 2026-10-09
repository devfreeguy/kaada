import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMoney } from "../money/index.js";
import type { Intent } from "./intent.js";
import { buildRoutingRequest } from "./routing-request.js";
import { hasFinancialChange } from "./revision.js";

const base: Intent = {
  id: "i",
  userId: "u",
  conversationId: "c",
  type: "SEND",
  status: "RESOLVED",
  amount: { money: createMoney("2000", "usd"), mode: "EXACT_INPUT" },
  sourceAssetId: "usd",
  recipientId: "r",
  destinationCountry: "BR",
  missingFields: [],
  revision: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe("hasFinancialChange", () => {
  it("is false for a new intent, a restatement, or a status-only change", () => {
    assert.equal(hasFinancialChange(undefined, base), false);
    assert.equal(hasFinancialChange(base, { ...base }), false);
    const asking: Intent = { ...base, status: "AWAITING_DETAILS", missingFields: ["RECIPIENT"] };
    assert.equal(hasFinancialChange(base, asking), false);
  });

  it("is true for amount, mode, assets, preference, recipient, country or constraints", () => {
    const changed: Partial<Intent>[] = [
      { amount: { money: createMoney("4000", "usd"), mode: "EXACT_INPUT" } },
      { amount: { money: createMoney("2000", "usd"), mode: "EXACT_OUTPUT" } },
      { sourceAssetId: "usdt" },
      { destinationAssetId: "brl" },
      { preferredSourceAssetId: "usdt" },
      { recipientId: "r2" },
      { destinationCountry: "AR" },
      { constraints: { maxSlippageBps: 50 } },
    ];
    for (const change of changed) {
      assert.equal(hasFinancialChange(base, { ...base, ...change }), true, JSON.stringify(change));
    }
  });
});

describe("buildRoutingRequest", () => {
  it("states only what the user said or the system resolved", () => {
    const request = buildRoutingRequest(
      { ...base, preferredSourceAssetId: "usdt", revision: 3 },
      { id: "r", displayName: "João" },
    );
    assert.deepEqual(request, {
      intentId: "i",
      intentRevision: 3,
      userId: "u",
      operation: "SEND",
      purpose: "PAYMENT",
      amount: { amount: "2000", assetId: "usd" },
      amountMode: "EXACT_INPUT",
      sourceAssetId: "usd",
      preferredSourceAssetId: "usdt",
      recipient: { recipientId: "r", displayName: "João" },
      destinationCountry: "BR",
    });
  });

  it("marks a QUOTE as a quote and returns nothing without an amount or an operation to route", () => {
    assert.equal(buildRoutingRequest({ ...base, type: "QUOTE" })?.purpose, "QUOTE");
    const { amount: _amount, ...withoutAmount } = base;
    assert.equal(buildRoutingRequest(withoutAmount), undefined);
    assert.equal(buildRoutingRequest({ ...base, type: "HELP" }), undefined);
  });
});
