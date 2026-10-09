import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConversationContext, toHistory } from "../src/core/conversations/context.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import { clarificationText } from "../src/core/responses/clarifications.js";
import type { Clarification } from "../src/core/responses/clarifications.js";
import { PAYMENT_STAGES, nextPaymentStage } from "../src/core/responses/payment-stage.js";
import { responseFromStored, responseToJson } from "../src/core/responses/serialize.js";
import { createHarness, intent } from "./support/harness.js";

const ask = (overrides: Partial<Clarification>): string =>
  clarificationText({ operation: "SEND", field: "RECIPIENT", reason: "MISSING", ...overrides });

describe("clarification wording", () => {
  it("is deterministic for each known question", () => {
    assert.equal(ask({}), "Who would you like to send it to?");
    assert.equal(ask({ field: "AMOUNT" }), "How much would you like to send?");
    assert.equal(
      ask({ field: "AMOUNT", operation: "CONVERT" }),
      "How much would you like to convert?",
    );
    assert.equal(
      ask({ field: "AMOUNT", operation: "QUOTE" }),
      "How much would you like to get a quote for?",
    );
    assert.equal(ask({ field: "DESTINATION" }), "Which currency or country should they receive?");
    assert.equal(
      ask({ field: "RECIPIENT", reason: "AMBIGUOUS", subject: "Daniel" }),
      "I found more than one Daniel. Which one do you mean?",
    );
    assert.match(
      ask({ field: "SOURCE_ASSET", reason: "NOT_FOUND", subject: "XYZ" }),
      /don't support XYZ/,
    );
    assert.match(
      ask({ field: "SOURCE_ASSET", reason: "AMBIGUOUS", subject: "USDC" }),
      /USDC matches more than one/,
    );
    assert.match(
      ask({ field: "AMOUNT", reason: "INVALID", subject: "USD", decimals: 2 }),
      /USD supports up to 2 decimal/,
    );
    assert.match(ask({ reason: "NOT_FOUND", detail: "INVALID_FORMAT" }), /valid wallet address/);
    assert.match(
      ask({ reason: "NOT_FOUND", detail: "UNSUPPORTED_TYPE" }),
      /can't look up that kind of contact/,
    );
  });
});

describe("payment stages (future boundary)", () => {
  it("only allows the strict path and never skips authorization", () => {
    assert.deepEqual(
      [...PAYMENT_STAGES],
      ["ROUTING_REQUIRED", "PAYMENT_READY", "AUTHORIZATION_REQUIRED", "AUTHORIZED", "EXECUTING"],
    );
    assert.equal(nextPaymentStage("ROUTING_REQUIRED"), "PAYMENT_READY");
    assert.equal(nextPaymentStage("PAYMENT_READY"), "AUTHORIZATION_REQUIRED");
    assert.equal(nextPaymentStage("AUTHORIZATION_REQUIRED"), "AUTHORIZED");
    assert.equal(nextPaymentStage("AUTHORIZED"), "EXECUTING");
    assert.equal(nextPaymentStage("EXECUTING"), undefined);
  });
});

describe("response storage", () => {
  it("round-trips responses through the stored JSON form", () => {
    const response: AgentResponse = {
      type: "CLARIFICATION_REQUIRED",
      text: "Who?",
      intentId: "i",
      field: "RECIPIENT",
      reason: "AMBIGUOUS",
      options: [{ id: "1", label: "Daniel Lee" }],
    };
    assert.deepEqual(responseFromStored(responseToJson(response), "x"), response);
  });

  it("falls back to the stored text when the data is missing or unrecognised", () => {
    assert.deepEqual(responseFromStored(undefined, "hello"), { type: "MESSAGE", text: "hello" });
    assert.deepEqual(responseFromStored({ type: "SOMETHING_NEW" }, "hello"), {
      type: "MESSAGE",
      text: "hello",
    });
  });
});

describe("conversation context", () => {
  it("assembles the active intent, pending question and history from stored state", async () => {
    const h = createHarness();
    h.script.set(
      "send $20",
      intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
    );
    const turn = await h.say("send $20");
    const conversation = h.world.conversations.get(turn.conversationId);
    assert.ok(conversation);

    const context = await loadConversationContext(h.world.repositories, conversation, 10);
    assert.equal(context.activeIntent?.id, turn.intentId);
    assert.equal(context.pendingClarification, "RECIPIENT");
    assert.deepEqual(
      toHistory(context.recentMessages, "none").map((t) => t.role),
      ["USER", "ASSISTANT"],
    );
    assert.deepEqual(
      toHistory(context.recentMessages, context.recentMessages[0]?.id ?? "").map((t) => t.role),
      ["ASSISTANT"],
    );
  });

  it("has no active intent once the operation is terminal", async () => {
    const h = createHarness();
    h.script.set(
      "send $20",
      intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
    );
    h.script.set("cancel", { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" });
    await h.say("send $20");
    const turn = await h.say("cancel");
    const conversation = h.world.conversations.get(turn.conversationId);
    assert.ok(conversation);
    const context = await loadConversationContext(h.world.repositories, conversation, 10);
    assert.equal(context.activeIntent, undefined);
    assert.equal(context.pendingClarification, undefined);
  });
});

describe("agent core boundaries", () => {
  const coreDir = fileURLToPath(new URL("../src/core/", import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("is free of framework, ORM, provider, blockchain and network dependencies", () => {
    const forbidden = [
      /@nestjs\//,
      /@prisma\//,
      /@kaada\/database/,
      /@kaada\/providers/,
      /@kaada\/blockchain/,
      /\bfetch\s*\(/,
      /node:https?/,
      /\bprocess\.env\b/,
    ];
    for (const file of sources(coreDir)) {
      const code = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        assert.ok(!pattern.test(code), `${file} matches ${pattern}`);
      }
    }
  });
});
