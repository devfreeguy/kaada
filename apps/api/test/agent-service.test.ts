import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createMoney } from "@kaada/domain";

import { ConversationAccessError } from "../src/core/agent/errors.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import { createHarness, intent, SENDER } from "./support/harness.js";

const usd = (value: string, mode?: "EXACT_INPUT" | "EXACT_OUTPUT") => ({
  value,
  currencyOrAsset: "USD",
  ...(mode && { mode }),
});

function addDaniel(h: ReturnType<typeof createHarness>) {
  return h.world.addUser({ id: randomUUID(), username: "daniel", displayName: "Daniel" });
}

const openIntents = (h: ReturnType<typeof createHarness>) =>
  [...h.world.intents.values()].filter((i) =>
    ["DRAFT", "AWAITING_DETAILS", "RESOLVED", "QUOTING", "AWAITING_CONFIRMATION"].includes(
      i.status,
    ),
  );

describe("conversations and messages", () => {
  it("creates a conversation for a new chat and stores both sides of the turn", async () => {
    const h = createHarness();
    h.script.set("hi", intent({ type: "HELP" }));
    const turn = await h.say("hi");

    assert.equal(h.world.conversations.size, 1);
    const conversation = h.world.conversations.get(turn.conversationId);
    assert.equal(conversation?.userId, SENDER);
    assert.equal(conversation?.channel, "TELEGRAM");
    assert.deepEqual(
      h.world.messages.map((m) => m.role),
      ["USER", "ASSISTANT"],
    );
    assert.equal(h.world.messages[1]?.metadata?.["inReplyTo"], turn.messageId);
    assert.equal(turn.duplicate, false);
  });

  it("reuses the conversation for the same chat and separates different chats", async () => {
    const h = createHarness();
    const first = await h.say("a");
    const second = await h.say("b");
    const other = await h.say("c", { externalConversationId: "another-chat" });
    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(other.conversationId, first.conversationId);
    assert.equal(h.world.conversations.size, 2);
  });

  it("refuses to use a conversation that belongs to someone else", async () => {
    const h = createHarness();
    await h.say("a");
    const intruder = h.world.addUser({ id: randomUUID() });
    await assert.rejects(h.say("b", { userId: intruder.id }), ConversationAccessError);
  });

  it("answers a redelivered message with the original answer and changes nothing", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    const first = await h.say("send $20", { externalMessageId: "m-1" });
    const messagesBefore = h.world.messages.length;
    const again = await h.say("send $20", { externalMessageId: "m-1" });

    assert.equal(again.duplicate, true);
    assert.deepEqual(again.response, first.response);
    assert.equal(again.intentId, first.intentId);
    assert.equal(h.world.messages.length, messagesBefore);
    assert.equal(h.world.intents.size, 1);
    assert.equal(h.interpreter.calls.length, 1, "the interpreter is not asked twice");
  });

  it("handles two simultaneous deliveries of the same message exactly once", async () => {
    const h = createHarness({ delayMs: () => 20 });
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    const [a, b] = await Promise.all([
      h.say("send $20", { externalMessageId: "m-1" }),
      h.say("send $20", { externalMessageId: "m-1" }),
    ]);

    assert.equal(h.world.intents.size, 1);
    assert.equal(h.world.messages.filter((m) => m.role === "ASSISTANT").length, 1);
    assert.equal(h.world.messages.filter((m) => m.role === "USER").length, 1);
    assert.deepEqual([a.duplicate, b.duplicate].sort(), [false, true]);
    assert.deepEqual(a.response, b.response);
  });
});

describe("collecting details", () => {
  it("asks for the recipient when only an amount was given", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    const turn = await h.say("send $20");

    assert.deepEqual(turn.response, {
      type: "CLARIFICATION_REQUIRED",
      text: "Who would you like to send it to?",
      intentId: turn.intentId,
      field: "RECIPIENT",
      reason: "MISSING",
    });
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.status, "AWAITING_DETAILS");
    assert.deepEqual(stored?.missingFields, ["RECIPIENT"]);
    assert.deepEqual(stored?.amount, {
      money: createMoney("2000", h.assets.USD.id),
      mode: "EXACT_INPUT",
    });
    assert.equal(stored?.sourceAssetId, h.assets.USD.id, "USD stays the dollar, not a token");
  });

  it("asks for the amount when only a recipient was given", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "to daniel",
      intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } }),
    );
    const turn = await h.say("to daniel");
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.field, "AMOUNT");
    assert.equal(turn.response.text, "How much would you like to send?");
    assert.ok(
      h.world.intents.get(turn.intentId ?? "")?.recipientId,
      "the recipient was still resolved",
    );
  });

  it("merges a follow-up recipient into the pending SEND and keeps the amount", async () => {
    const h = createHarness();
    const daniel = addDaniel(h);
    h.script.set("send $50", intent({ type: "SEND", amount: usd("50", "EXACT_INPUT") }));
    h.script.set(
      "daniel",
      intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } }),
    );

    const first = await h.say("send $50");
    const second = await h.say("daniel");

    assert.equal(second.intentId, first.intentId, "same intent, not a new one");
    assert.equal(second.response.type, "ROUTING_REQUIRED");
    assert.equal(second.supersededIntentId, undefined);
    const stored = h.world.intents.get(first.intentId ?? "");
    assert.equal(stored?.status, "RESOLVED");
    assert.deepEqual(stored?.amount?.money, createMoney("5000", h.assets.USD.id));
    assert.equal(h.world.recipients.get(stored?.recipientId ?? "")?.linkedUserId, daniel.id);
    assert.equal(openIntents(h).length, 1);
  });

  it("applies a correction while preserving the recipient", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "send $20 to daniel",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    h.script.set(
      "actually make that $40",
      intent({ type: "SEND", amount: usd("40", "EXACT_INPUT") }),
    );

    const first = await h.say("send $20 to daniel");
    const recipientId = h.world.intents.get(first.intentId ?? "")?.recipientId;
    const second = await h.say("actually make that $40");

    assert.equal(second.intentId, first.intentId);
    const stored = h.world.intents.get(first.intentId ?? "");
    assert.deepEqual(stored?.amount?.money, createMoney("4000", h.assets.USD.id));
    assert.equal(stored?.recipientId, recipientId);
    assert.equal(stored?.status, "RESOLVED");
    assert.equal(second.response.type, "ROUTING_REQUIRED");
    assert.match(second.response.text, /40\.00 USD/);
    assert.equal(h.world.recipients.size, 1, "the recipient record is reused, not duplicated");
  });

  it("starts a new operation when the user switches, retiring the old one", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    h.script.set(
      "convert",
      intent({
        type: "CONVERT",
        amount: usd("100", "EXACT_INPUT"),
        fromAsset: "USD",
        toAsset: "NGN",
      }),
    );
    const first = await h.say("send $20");
    const second = await h.say("convert");

    assert.notEqual(second.intentId, first.intentId);
    assert.equal(second.supersededIntentId, first.intentId);
    assert.equal(h.world.intents.get(first.intentId ?? "")?.status, "CANCELLED");
    assert.equal(h.world.intents.get(second.intentId ?? "")?.type, "CONVERT");
    assert.equal(openIntents(h).length, 1, "only one active operation per conversation");
    assert.equal(second.response.type, "ROUTING_REQUIRED");
  });

  it("does not let a stale value leak from the old operation into the new one", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "send $20 to daniel",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    h.script.set("quote", intent({ type: "QUOTE" }));
    await h.say("send $20 to daniel");
    const turn = await h.say("quote");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.amount, undefined);
    assert.equal(stored?.recipientId, undefined);
    assert.equal(turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.field, "AMOUNT");
  });
});

describe("amount modes and assets", () => {
  it("keeps an explicit EXACT_INPUT amount on the source side", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20.50", "EXACT_INPUT"),
      }),
    );
    const turn = await h.say("m");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.deepEqual(stored?.amount, {
      money: createMoney("2050", h.assets.USD.id),
      mode: "EXACT_INPUT",
    });
    assert.equal(stored?.sourceAssetId, h.assets.USD.id);
    assert.match(turn.response.text, /you send 20\.50 USD to Daniel/);
  });

  it("puts an explicit EXACT_OUTPUT amount on the destination side", async () => {
    const h = createHarness();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "João Silva",
      identifier: "joao",
      destinationCountry: "BR",
    });
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
        destination: { country: "BR" },
      }),
    );
    const turn = await h.say("m");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.deepEqual(stored?.amount, {
      money: createMoney("50000", h.assets.BRL.id),
      mode: "EXACT_OUTPUT",
    });
    assert.equal(stored?.destinationAssetId, h.assets.BRL.id);
    assert.equal(
      stored?.sourceAssetId,
      undefined,
      "the funding token is chosen later, not guessed",
    );
    assert.equal(stored?.destinationCountry, "BR");
    assert.match(turn.response.text, /João Silva receives 500\.00 BRL/);
  });

  it("derives EXACT_OUTPUT when the amount is in the recipient's local currency", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: { value: "500", currencyOrAsset: "BRL" },
        destination: { country: "BR" },
      }),
    );
    const turn = await h.say("m");
    assert.equal(h.world.intents.get(turn.intentId ?? "")?.amount?.mode, "EXACT_OUTPUT");
  });

  it("derives EXACT_INPUT when the amount is in a different currency than the destination's", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20"),
        destination: { country: "BR" },
      }),
    );
    const turn = await h.say("m");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.amount?.mode, "EXACT_INPUT");
    assert.equal(stored?.sourceAssetId, h.assets.USD.id);
  });

  it("asks again with the precision when the amount has too many decimals", async () => {
    const h = createHarness();
    h.script.set("m", intent({ type: "SEND", amount: usd("20.505", "EXACT_INPUT") }));
    const turn = await h.say("m");
    assert.equal(turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.field, "AMOUNT");
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.reason,
      "INVALID",
    );
    assert.match(turn.response.text, /USD supports up to 2 decimal places/);
    assert.equal(
      h.world.intents.get(turn.intentId ?? "")?.amount,
      undefined,
      "nothing was rounded",
    );
  });

  it("says so when a currency is not supported, and keeps the intent open", async () => {
    const h = createHarness();
    h.script.set(
      "m",
      intent({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "XYZ", mode: "EXACT_INPUT" },
      }),
    );
    const turn = await h.say("m");
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.reason,
      "NOT_FOUND",
    );
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.field,
      "SOURCE_ASSET",
    );
    assert.match(turn.response.text, /I don't support XYZ yet/);
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.status, "AWAITING_DETAILS");
    assert.equal(stored?.amount, undefined);
  });

  it("offers the candidates when a label matches more than one asset", async () => {
    const h = createHarness();
    h.script.set(
      "m",
      intent({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "USDC", mode: "EXACT_INPUT" },
      }),
    );
    const turn = await h.say("m");
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
    if (turn.response.type !== "CLARIFICATION_REQUIRED") return;
    assert.equal(turn.response.reason, "AMBIGUOUS");
    const options = turn.response.options ?? [];
    assert.equal(options.length, 2);
    // Ids are opaque: they are not asset ids, and what they mean is stored on the server.
    assert.ok(
      options.every((o) => ![h.assets.USDC_CELO.id, h.assets.USDC_OTHER.id].includes(o.id)),
    );
    assert.equal(h.world.clarificationChoices.length, 2);
  });

  it("resolves a token by its symbol and keeps USD apart from USDT", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: { value: "10", currencyOrAsset: "USDT", mode: "EXACT_INPUT" },
      }),
    );
    const turn = await h.say("m");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.sourceAssetId, h.assets.USDT.id);
    assert.deepEqual(
      stored?.amount?.money,
      createMoney("10000000", h.assets.USDT.id),
      "6 decimals",
    );
    assert.notEqual(stored?.sourceAssetId, h.assets.USD.id);
  });

  it("treats a named funding token as a preference, never replacing the amount's currency", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20", "EXACT_INPUT"),
        sourceAsset: "USDT",
      }),
    );
    const turn = await h.say("m");
    const stored = h.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.sourceAssetId, h.assets.USD.id);
    assert.equal(stored?.parsed?.type === "SEND" && stored.parsed.sourceAsset, "USDT");
    assert.equal(turn.response.type, "ROUTING_REQUIRED");
  });

  it("asks where the money should go when the recipient implies no destination", async () => {
    const h = createHarness();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Pat",
    });
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "Pat" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    const turn = await h.say("m");
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.field,
      "DESTINATION",
    );
    assert.equal(turn.response.text, "Which currency or country should they receive?");

    h.script.set("in brazil", intent({ type: "SEND", destination: { country: "BR" } }));
    const answered = await h.say("in brazil");
    assert.equal(answered.response.type, "ROUTING_REQUIRED");
    assert.equal(answered.intentId, turn.intentId);
  });
});

describe("recipients", () => {
  it("asks which one when the name matches several saved contacts", async () => {
    const h = createHarness();
    for (const name of ["Daniel Souza", "Daniel Lee"]) {
      h.world.addRecipient({
        id: randomUUID(),
        ownerUserId: SENDER,
        type: "SAVED_BENEFICIARY",
        displayName: name,
      });
    }
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    const turn = await h.say("m");
    assert.equal(turn.response.text, "I found more than one Daniel. Which one do you mean?");
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.reason,
      "AMBIGUOUS",
    );
    assert.deepEqual(
      turn.response.type === "CLARIFICATION_REQUIRED" &&
        turn.response.options?.map((o) => o.label).sort(),
      ["Daniel Lee", "Daniel Souza"],
    );
    assert.equal(h.world.intents.get(turn.intentId ?? "")?.recipientId, undefined);
  });

  it("completes the intent once the user picks one of the ambiguous contacts", async () => {
    const h = createHarness();
    for (const name of ["Daniel Souza", "Daniel Lee"]) {
      h.world.addRecipient({
        id: randomUUID(),
        ownerUserId: SENDER,
        type: "SAVED_BENEFICIARY",
        displayName: name,
        destinationCountry: "BR",
      });
    }
    h.script.set(
      "first",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    h.script.set(
      "souza",
      intent({ type: "SEND", recipient: { type: "SAVED_BENEFICIARY", value: "Daniel Souza" } }),
    );
    const first = await h.say("first");
    const second = await h.say("souza");
    assert.equal(second.intentId, first.intentId);
    assert.equal(second.response.type, "ROUTING_REQUIRED");
  });

  it("says when the recipient cannot be found", async () => {
    const h = createHarness();
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "nobody" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    const turn = await h.say("m");
    assert.equal(
      turn.response.type === "CLARIFICATION_REQUIRED" && turn.response.reason,
      "NOT_FOUND",
    );
    assert.match(turn.response.text, /I couldn't find nobody/);
  });

  it("clears a previously resolved recipient when the new one cannot be resolved", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "a",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    h.script.set("b", intent({ type: "SEND", recipient: { type: "USERNAME", value: "ghost" } }));
    const first = await h.say("a");
    assert.ok(h.world.intents.get(first.intentId ?? "")?.recipientId);
    await h.say("b");
    assert.equal(h.world.intents.get(first.intentId ?? "")?.recipientId, undefined);
  });
});

describe("non-executing and conversational intents", () => {
  it("answers a QUOTE with a routing request that can never lead to authorization", async () => {
    const h = createHarness();
    h.script.set(
      "m",
      intent({
        type: "QUOTE",
        amount: usd("50", "EXACT_INPUT"),
        fromAsset: "USD",
        destination: { country: "BR" },
      }),
    );
    const turn = await h.say("m");
    assert.equal(turn.response.type, "ROUTING_REQUIRED");
    assert.equal(turn.response.type === "ROUTING_REQUIRED" && turn.response.purpose, "QUOTE");
    assert.match(turn.response.text, /Nothing will be sent/);
    assert.equal(h.world.intents.get(turn.intentId ?? "")?.type, "QUOTE");
  });

  it("marks a ready SEND as RESOLVED with a PAYMENT routing request - no quote, no execution", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set(
      "m",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "daniel" },
        amount: usd("20", "EXACT_INPUT"),
      }),
    );
    const turn = await h.say("m");
    assert.equal(turn.response.type === "ROUTING_REQUIRED" && turn.response.purpose, "PAYMENT");
    assert.equal(h.world.intents.get(turn.intentId ?? "")?.status, "RESOLVED");
  });

  it("explains what it can do for HELP and unavailable features, without touching the active intent", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    h.script.set("help", intent({ type: "HELP" }));
    h.script.set("balance", intent({ type: "BALANCE" }));
    h.script.set("status", intent({ type: "TRANSACTION_STATUS" }));
    const first = await h.say("send $20");
    const before = structuredClone(h.world.intents.get(first.intentId ?? ""));

    for (const message of ["help", "balance", "status"]) {
      const turn = await h.say(message);
      assert.equal(turn.response.type, message === "help" ? "MESSAGE" : "ERROR", message);
      if (turn.response.type === "ERROR") assert.equal(turn.response.code, "FEATURE_NOT_AVAILABLE");
      assert.equal(turn.intentId, undefined);
    }
    assert.deepEqual(h.world.intents.get(first.intentId ?? "")?.parsed, before?.parsed);
    assert.equal(h.world.intents.get(first.intentId ?? "")?.status, "AWAITING_DETAILS");
    assert.equal(h.world.intents.size, 1);
  });

  it("re-asks the pending question when it does not understand a message", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    const first = await h.say("send $20");
    const turn = await h.say("blah blah");
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(
      turn.response.text,
      "Sorry, I didn't catch that. Who would you like to send it to?",
    );
    assert.equal(turn.intentId, first.intentId);
  });

  it("falls back to a plain message when unsure and nothing is pending", async () => {
    const h = createHarness();
    const turn = await h.say("blah blah");
    assert.equal(turn.response.type, "MESSAGE");
    assert.match(turn.response.text, /didn't understand/);
    assert.equal(h.world.intents.size, 0);
  });
});

describe("cancelling", () => {
  it("cancels the active intent, keeps the history, and clears the pending question", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    h.script.set("cancel that", { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" });
    const first = await h.say("send $20");
    const messagesBefore = h.world.messages.length;
    const turn = await h.say("cancel that");

    assert.deepEqual(turn.response, {
      type: "CANCELLED",
      intentId: first.intentId,
      text: "Okay, I've cancelled that.",
    });
    const stored = h.world.intents.get(first.intentId ?? "");
    assert.equal(stored?.status, "CANCELLED");
    assert.deepEqual(stored?.missingFields, []);
    assert.equal(h.world.messages.length, messagesBefore + 2, "history is kept");
    assert.equal(openIntents(h).length, 0);
  });

  it("says there is nothing to cancel when no operation is open", async () => {
    const h = createHarness();
    h.script.set("cancel", { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" });
    const turn = await h.say("cancel");
    assert.deepEqual(turn.response, {
      type: "MESSAGE",
      text: "There's nothing to cancel right now.",
    });
  });

  it("starts over: cancels what is open and invites a fresh request", async () => {
    const h = createHarness();
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    h.script.set("start over", { kind: "COMMAND", command: "START_OVER" });
    await h.say("send $20");
    const turn = await h.say("start over");
    assert.equal(turn.response.type, "CANCELLED");
    assert.match(turn.response.text, /start over/);
    assert.equal(openIntents(h).length, 0);
  });

  it("begins a brand-new intent after a cancellation instead of merging into the cancelled one", async () => {
    const h = createHarness();
    addDaniel(h);
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    h.script.set("cancel", { kind: "COMMAND", command: "CANCEL_ACTIVE_INTENT" });
    h.script.set(
      "daniel",
      intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } }),
    );
    const first = await h.say("send $20");
    await h.say("cancel");
    const turn = await h.say("daniel");
    assert.notEqual(turn.intentId, first.intentId);
    assert.equal(
      h.world.intents.get(turn.intentId ?? "")?.amount,
      undefined,
      "the cancelled amount is gone",
    );
  });
});

describe("robustness", () => {
  it("never runs the interpreter inside a database transaction", async () => {
    const h = createHarness({ delayMs: () => 5 });
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
    await h.say("send $20");
    assert.deepEqual(h.openTransactionDuringInterpret, [false]);
    assert.equal(h.world.transactions, 1, "accepting is transaction-free; only applying is atomic");
  });

  it("serialises simultaneous messages so the active intent is never corrupted", async () => {
    for (const slowOne of ["send $20", "to daniel"] as const) {
      const h = createHarness({ delayMs: (input) => (input.message === slowOne ? 30 : 0) });
      addDaniel(h);
      h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));
      h.script.set(
        "to daniel",
        intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } }),
      );

      await Promise.all([h.say("send $20"), h.say("to daniel")]);

      const open = openIntents(h);
      assert.equal(open.length, 1, `one active intent (slow: ${slowOne})`);
      assert.equal(open[0]?.status, "RESOLVED");
      assert.deepEqual(open[0]?.amount?.money, createMoney("2000", h.assets.USD.id));
      assert.ok(open[0]?.recipientId);
    }
  });

  it("does not store an answer when the interpreter fails, so a redelivery is retried", async () => {
    const h = createHarness();
    let failures = 1;
    const original = h.interpreter.interpret.bind(h.interpreter);
    h.interpreter.interpret = (input) => {
      if (failures-- > 0) return Promise.reject(new Error("provider down"));
      return original(input);
    };
    h.script.set("send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") }));

    const failed = await h.say("send $20", { externalMessageId: "m-1" });
    assert.equal(failed.response.type, "MESSAGE");
    assert.equal(h.world.messages.filter((m) => m.role === "ASSISTANT").length, 0);

    const retried = await h.say("send $20", { externalMessageId: "m-1" });
    assert.equal(retried.duplicate, false);
    assert.equal(retried.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(
      h.world.messages.filter((m) => m.role === "USER").length,
      1,
      "the message is not stored twice",
    );
  });

  it("treats an invalid interpretation as UNKNOWN instead of trusting it", async () => {
    const h = createHarness();
    h.script.set("m", {
      kind: "INTENT",
      intent: { type: "SEND", amount: { value: "1e9", currencyOrAsset: "USD" } },
    });
    const turn = await h.say("m");
    assert.equal(turn.response.type, "MESSAGE");
    assert.equal(h.world.intents.size, 0);
    assert.ok(h.logs.some((l) => l.event === "agent.interpretation.invalid"));
  });

  it("only ever produces responses that cannot move money, and logs identifiers only", async () => {
    const h = createHarness();
    addDaniel(h);
    const seen: AgentResponse["type"][] = [];
    const messages = [
      ["send $20", intent({ type: "SEND", amount: usd("20", "EXACT_INPUT") })],
      ["daniel", intent({ type: "SEND", recipient: { type: "USERNAME", value: "daniel" } })],
      ["quote", intent({ type: "QUOTE", amount: usd("5"), fromAsset: "USD", toAsset: "NGN" })],
    ] as const;
    for (const [text, interpretation] of messages) {
      h.script.set(text, interpretation);
      seen.push((await h.say(text)).response.type);
    }
    assert.ok(!seen.includes("AUTHORIZATION_REQUIRED"));
    for (const intentRow of h.world.intents.values()) {
      assert.ok(!["EXECUTING", "COMPLETED"].includes(intentRow.status));
    }
    for (const entry of h.logs) {
      const serialised = JSON.stringify(entry.fields);
      assert.ok(
        !serialised.includes("$20") && !("content" in entry.fields),
        "message content is not logged",
      );
    }
  });
});
