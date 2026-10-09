import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type {
  ClarificationRequiredResponse,
  RoutingRequiredResponse,
} from "../src/core/responses/agent-response.js";
import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { createHarness, intent, SENDER } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

const usd = (value: string) => ({ value, currencyOrAsset: "USD", mode: "EXACT_INPUT" as const });
const toDaniel = { type: "SAVED_BENEFICIARY" as const, value: "Daniel" };

function saveContact(h: Harness, displayName: string, identifier: string, country = "BR") {
  return h.world.addRecipient({
    id: randomUUID(),
    ownerUserId: SENDER,
    type: "SAVED_BENEFICIARY",
    displayName,
    identifier,
    destinationCountry: country,
  });
}

function twoDaniels(h: Harness) {
  const okafor = saveContact(h, "Daniel Okafor", "daniel_o");
  const silva = saveContact(h, "Daniel Silva", "daniel_s");
  return { okafor, silva };
}

function question(turn: AgentTurnResult): ClarificationRequiredResponse {
  assert.equal(turn.response.type, "CLARIFICATION_REQUIRED", JSON.stringify(turn.response));
  if (turn.response.type !== "CLARIFICATION_REQUIRED") throw new Error("unreachable");
  return turn.response;
}

function routing(turn: AgentTurnResult): RoutingRequiredResponse {
  assert.equal(turn.response.type, "ROUTING_REQUIRED", JSON.stringify(turn.response));
  if (turn.response.type !== "ROUTING_REQUIRED") throw new Error("unreachable");
  return turn.response;
}

/** "Send $20 to Daniel" with two Daniels: returns the question that offers them. */
async function askWhichDaniel(h: Harness) {
  h.script.set(
    "send $20 to daniel",
    intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
  );
  const turn = await h.say("send $20 to daniel");
  return { turn, asked: question(turn) };
}

describe("structured choices: recipients", () => {
  it("offers multiple matching recipients as options with safe distinguishing info", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);

    assert.equal(asked.field, "RECIPIENT");
    assert.equal(asked.reason, "AMBIGUOUS");
    assert.deepEqual(asked.options?.map((o) => `${o.label} / ${o.description}`).sort(), [
      "Daniel Okafor / @daniel_o",
      "Daniel Silva / @daniel_s",
    ]);
    // Nothing a channel receives carries meaning: no recipient ids, only opaque option ids.
    assert.ok(JSON.stringify(asked.options).indexOf("recipientId") === -1);
  });

  it("resolves the selected option to that recipient without calling the interpreter", async () => {
    const h = createHarness();
    const { okafor } = twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    const callsBefore = h.interpreterCalls;

    const pick = asked.options?.find((o) => o.label === "Daniel Okafor");
    assert.ok(pick);
    const turn = await h.choose(pick.id);

    const ready = routing(turn);
    assert.equal(ready.request.recipient?.recipientId, okafor.id);
    assert.equal(ready.request.recipient?.displayName, "Daniel Okafor");
    assert.equal(h.interpreterCalls, callsBefore, "selecting an option never reaches the model");
    assert.equal(h.world.transactions >= 1, true);
  });

  it("rejects a fabricated option id and changes nothing", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { turn: first } = await askWhichDaniel(h);
    const before = structuredClone(h.world.intents.get(first.intentId ?? ""));

    for (const optionId of [randomUUID(), "not-an-id", "' OR 1=1 --"]) {
      const turn = await h.choose(optionId);
      assert.equal(turn.response.type, "ERROR");
      assert.equal(turn.response.type === "ERROR" && turn.response.code, "CHOICE_UNKNOWN");
    }
    assert.deepEqual(h.world.intents.get(first.intentId ?? ""), before);
  });

  it("rejects an option that belongs to another conversation", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    const optionId = asked.options?.[0]?.id ?? "";

    h.script.set("hi", intent({ type: "HELP" }));
    await h.say("hi", { externalConversationId: "chat-elsewhere" });
    const turn = await h.choose(optionId, { externalConversationId: "chat-elsewhere" });

    assert.equal(turn.response.type === "ERROR" && turn.response.code, "CHOICE_UNKNOWN");
    assert.equal(
      h.world.clarificationChoices.every((c) => c.usedAt === undefined),
      true,
      "the other conversation's option was not consumed",
    );
  });

  it("rejects an option once it has been used, including a duplicate callback", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    const optionId = asked.options?.[0]?.id ?? "";

    const first = await h.choose(optionId, { externalMessageId: "cb-1" });
    routing(first);

    // The same callback delivered again returns the original answer and changes nothing.
    const redelivered = await h.choose(optionId, { externalMessageId: "cb-1" });
    assert.equal(redelivered.duplicate, true);
    assert.equal(redelivered.response.type, "ROUTING_REQUIRED");

    // A fresh tap on a used button is refused.
    const again = await h.choose(optionId, { externalMessageId: "cb-2" });
    assert.equal(again.response.type === "ERROR" && again.response.code, "CHOICE_ALREADY_USED");
    assert.equal(h.world.intents.size, 1);
  });

  it("rejects an expired option", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    h.world.clarificationChoices.forEach((choice, index) => {
      h.world.clarificationChoices[index] = { ...choice, expiresAt: new Date(0) };
    });
    const turn = await h.choose(asked.options?.[0]?.id ?? "");
    assert.equal(turn.response.type === "ERROR" && turn.response.code, "CHOICE_EXPIRED");
  });

  it("makes options stale when the intent changes after they were offered", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    h.script.set(
      "make it 40",
      intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    );
    const next = await h.say("make it 40");
    assert.equal(question(next).field, "RECIPIENT", "still asking which Daniel, at a new revision");

    const turn = await h.choose(asked.options?.[0]?.id ?? "");
    assert.equal(turn.response.type === "ERROR" && turn.response.code, "CHOICE_STALE");

    // The options of the latest question work.
    const fresh = question(next).options?.[0]?.id ?? "";
    routing(await h.choose(fresh));
  });

  it("applies only one of two simultaneous selections of the same option", async () => {
    const h = createHarness();
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    const optionId = asked.options?.[0]?.id ?? "";
    const [a, b] = await Promise.all([h.choose(optionId), h.choose(optionId)]);
    const outcomes = [a, b].map((t) => t.response.type).sort();
    assert.deepEqual(outcomes, ["ERROR", "ROUTING_REQUIRED"]);
  });

  it("keeps a typed message and a selection consistent when they arrive together", async () => {
    const h = createHarness({ delayMs: () => 10 });
    twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    h.script.set(
      "make it 40",
      intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    );
    await Promise.all([h.say("make it 40"), h.choose(asked.options?.[0]?.id ?? "")]);

    const open = [...h.world.intents.values()].filter((i) => i.status !== "CANCELLED");
    assert.equal(open.length, 1, "one operation, not two");
    const [only] = open;
    assert.ok(only?.revision && only.revision >= 2);
    assert.equal(only.amount?.money.amount, "4000");
  });
});

describe("corrections and the resolved-intent summary", () => {
  async function readyToJoao(h: Harness) {
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    return routing(await h.say("send $20 to joão"));
  }

  it("states what was understood without any rate, fee, route or wBRL", async () => {
    const h = createHarness();
    const ready = await readyToJoao(h);
    assert.equal(ready.purpose, "PAYMENT");
    assert.match(ready.text, /you send 20\.00 USD to João Silva in Brazil/);
    const keys = Object.keys(ready.request).join(" ").toLowerCase();
    for (const forbidden of ["rate", "fee", "route", "provider", "wbrl", "quote", "fx"]) {
      assert.equal(keys.includes(forbidden), false, forbidden);
    }
    assert.equal(JSON.stringify(ready).toLowerCase().includes("wbrl"), false);
    assert.equal(ready.request.amountMode, "EXACT_INPUT");
    assert.equal(ready.request.amount.assetId, h.assets.USD.id);
    assert.equal(ready.request.sourceAssetId, h.assets.USD.id);
    assert.equal(ready.request.destinationCountry, "BR");
    assert.equal(ready.request.intentRevision, 1);
  });

  it("corrects the amount and moves the revision", async () => {
    const h = createHarness();
    const first = await readyToJoao(h);
    h.script.set(
      "actually make that $40",
      intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    );
    const next = routing(await h.say("actually make that $40"));
    assert.equal(next.intentId, first.intentId);
    assert.equal(next.request.amount.amount, "4000");
    assert.equal(next.revision, 2);
  });

  it("corrects the amount's currency (R$700) keeping the destination", async () => {
    const h = createHarness();
    await readyToJoao(h);
    h.script.set(
      "no, make it r$700",
      intent({
        type: "SEND",
        amount: { value: "700", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      }),
    );
    const next = routing(await h.say("no, make it r$700"));
    assert.equal(next.request.amountMode, "EXACT_OUTPUT");
    assert.equal(next.request.amount.assetId, h.assets.BRL.id);
    assert.equal(next.request.destinationAssetId, h.assets.BRL.id);
    assert.equal(next.request.sourceAssetId, undefined);
  });

  it("corrects the destination country and drops what belonged to the old one", async () => {
    const h = createHarness();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Maria Lopes",
      identifier: "maria",
    });
    h.script.set(
      "send $20 to maria in brazil",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "Maria" },
        amount: usd("20"),
        destination: { country: "BR", currency: "BRL" },
      }),
    );
    const first = routing(await h.say("send $20 to maria in brazil"));
    assert.equal(first.request.destinationAssetId, h.assets.BRL.id);

    h.script.set("actually argentina", intent({ type: "SEND", destination: { country: "AR" } }));
    const next = routing(await h.say("actually argentina"));
    assert.equal(next.request.destinationCountry, "AR");
    assert.notEqual(next.request.destinationAssetId, h.assets.BRL.id, "BRL belonged to Brazil");
  });

  it("clears a resolved recipient when the user says it is someone else", async () => {
    const h = createHarness();
    const { okafor } = twoDaniels(h);
    const joao = saveContact(h, "João Pereira", "joao_p");
    const { asked } = await askWhichDaniel(h);
    const chosen = asked.options?.find((o) => o.label === "Daniel Okafor");
    const first = routing(await h.choose(chosen?.id ?? ""));
    assert.equal(first.request.recipient?.recipientId, okafor.id);

    h.script.set(
      "not daniel, joão",
      intent({ type: "SEND", recipient: { type: "SAVED_BENEFICIARY", value: "João" } }),
    );
    const next = routing(await h.say("not daniel, joão"));
    assert.equal(next.request.recipient?.recipientId, joao.id);
    assert.equal(next.intentId, first.intentId);
    assert.equal(next.revision, 3);
  });

  it("remembers which Daniel was chosen when only the amount changes later", async () => {
    const h = createHarness();
    const { okafor } = twoDaniels(h);
    const { asked } = await askWhichDaniel(h);
    routing(await h.choose(asked.options?.find((o) => o.label === "Daniel Okafor")?.id ?? ""));

    h.script.set(
      "make it $40",
      intent({
        type: "SEND",
        recipient: toDaniel,
        amount: { value: "40", currencyOrAsset: "USD" },
      }),
    );
    const next = routing(await h.say("make it $40"));
    assert.equal(next.request.recipient?.recipientId, okafor.id, "no second 'which Daniel?'");
  });

  it("restating the same details does not move the revision", async () => {
    const h = createHarness();
    const first = await readyToJoao(h);
    h.script.set(
      "keep it at $20",
      intent({ type: "SEND", amount: { value: "20", currencyOrAsset: "USD" } }),
    );
    const next = routing(await h.say("keep it at $20"));
    assert.equal(next.revision, first.revision);
    assert.equal(next.intentId, first.intentId);
  });

  it("treats an unclear or non-action message as a restatement, never a change", async () => {
    const h = createHarness();
    const first = await readyToJoao(h);
    const before = structuredClone(h.world.intents.get(first.intentId));
    // "actually never mind, continue" interprets as nothing actionable.
    const next = await h.say("actually never mind, continue");
    assert.equal(next.response.type, "ROUTING_REQUIRED");
    assert.deepEqual(h.world.intents.get(first.intentId), before);
  });
});

describe("currency and asset behaviour", () => {
  it("never asks which stablecoin a USD amount means", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send 20 usd to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    const ready = routing(await h.say("send 20 usd to joão"));
    assert.equal(ready.request.amount.assetId, h.assets.USD.id);
    assert.notEqual(ready.request.amount.assetId, h.assets.USDT.id);
    assert.equal(ready.request.preferredSourceAssetId, undefined);
  });

  it("keeps BRL apart from a wrapped BRL token that is not supported", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send wbrl",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: { value: "100", currencyOrAsset: "wBRL", mode: "EXACT_OUTPUT" },
      }),
    );
    const asked = question(await h.say("send wbrl"));
    assert.equal(asked.reason, "NOT_FOUND");
    assert.equal(asked.options, undefined, "wBRL is not silently turned into BRL");
  });

  it("asks for the currency when it is missing and takes the reply as the amount's currency", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send 20 to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: { value: "20" },
      }),
    );
    const asked = question(await h.say("send 20 to joão"));
    assert.equal(asked.field, "CURRENCY");

    h.script.set(
      "usd",
      intent({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    const ready = routing(await h.say("usd"));
    assert.equal(ready.request.amount.assetId, h.assets.USD.id);
    assert.equal(ready.request.amount.amount, "2000");
  });

  it("offers an ambiguous token as options and applies the selected asset", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send 20 usdc",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: { value: "20", currencyOrAsset: "USDC", mode: "EXACT_INPUT" },
      }),
    );
    const asked = question(await h.say("send 20 usdc"));
    assert.equal(asked.options?.length, 2);
    const callsBefore = h.interpreterCalls;
    const ready = routing(await h.choose(asked.options?.[0]?.id ?? ""));
    assert.ok(
      [h.assets.USDC_CELO.id, h.assets.USDC_OTHER.id].includes(ready.request.amount.assetId),
    );
    assert.equal(h.interpreterCalls, callsBefore);
  });

  it("preserves exact input and exact output as stated", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "exact in",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    assert.equal(routing(await h.say("exact in")).request.amountMode, "EXACT_INPUT");

    const other = createHarness();
    saveContact(other, "João Silva", "joao");
    other.script.set(
      "exact out",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      }),
    );
    assert.equal(routing(await other.say("exact out")).request.amountMode, "EXACT_OUTPUT");
  });
});

describe("source-asset preference", () => {
  async function twenty(h: Harness) {
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    return routing(await h.say("send $20 to joão"));
  }

  it("adds a preference without replacing the amount, and it survives persistence", async () => {
    const h = createHarness();
    const first = await twenty(h);
    h.script.set("use usdt.", intent({ type: "SEND", sourceAsset: "USDT" }));
    const next = routing(await h.say("use usdt."));

    assert.equal(next.request.amount.assetId, h.assets.USD.id, "still 20 USD");
    assert.equal(next.request.amount.amount, "2000");
    assert.equal(next.request.preferredSourceAssetId, h.assets.USDT.id);
    assert.equal(next.revision, first.revision + 1);
    assert.equal(h.world.intents.get(first.intentId)?.preferredSourceAssetId, h.assets.USDT.id);
    assert.match(next.text, /paying with USDT/);
  });

  it("replaces the preference with a selected token", async () => {
    const h = createHarness();
    await twenty(h);
    h.script.set("use usdt.", intent({ type: "SEND", sourceAsset: "USDT" }));
    await h.say("use usdt.");
    h.script.set("no, use usdc", intent({ type: "SEND", sourceAsset: "USDC" }));
    const asked = question(await h.say("no, use usdc"));
    assert.equal(asked.options?.length, 2);
    const next = routing(await h.choose(asked.options?.[0]?.id ?? ""));
    assert.ok(
      [h.assets.USDC_CELO.id, h.assets.USDC_OTHER.id].includes(
        next.request.preferredSourceAssetId ?? "",
      ),
    );
    assert.equal(next.request.amount.assetId, h.assets.USD.id);
  });

  it("removes the preference on request, and leaves things alone when told not to change", async () => {
    const h = createHarness();
    await twenty(h);
    h.script.set("use usdt.", intent({ type: "SEND", sourceAsset: "USDT" }));
    await h.say("use usdt.");
    h.script.set("don't use usdt", { kind: "COMMAND", command: "REMOVE_SOURCE_PREFERENCE" });
    const removed = routing(await h.say("don't use usdt"));
    assert.equal(removed.request.preferredSourceAssetId, undefined);
    assert.equal(removed.request.amount.amount, "2000");

    // "Don't cancel it" reads as nothing actionable: the operation is untouched.
    const kept = await h.say("don't cancel it");
    assert.equal(kept.response.type, "ROUTING_REQUIRED");
    assert.equal(kept.intentId, removed.intentId);
  });
});

describe("operations that do not execute", () => {
  it("a QUOTE only ever asks for routing for a quote and a choice cannot make it a payment", async () => {
    const h = createHarness();
    h.script.set(
      "how much would 50 usdc give me in brazil",
      intent({
        type: "QUOTE",
        amount: { value: "50", currencyOrAsset: "USDC", mode: "EXACT_INPUT" },
        fromAsset: "USDC",
        destination: { country: "BR" },
      }),
    );
    // USDC is ambiguous both as the amount's currency and as the asset to convert from.
    let turn = await h.say("how much would 50 usdc give me in brazil");
    for (
      let answers = 0;
      turn.response.type === "CLARIFICATION_REQUIRED" && answers < 3;
      answers++
    ) {
      turn = await h.choose(turn.response.options?.[0]?.id ?? "");
    }
    const next = routing(turn);
    assert.equal(next.purpose, "QUOTE");
    assert.equal(next.request.operation, "QUOTE");
    assert.equal(h.world.intents.get(next.intentId)?.type, "QUOTE");
    for (const message of h.world.messages) {
      assert.notEqual(
        (message.structuredData as { type?: string } | undefined)?.type,
        "AUTHORIZATION_REQUIRED",
      );
    }
  });

  it("answers BALANCE and TRANSACTION_STATUS with a structured unsupported response", async () => {
    const h = createHarness();
    h.script.set("balance", intent({ type: "BALANCE" }));
    h.script.set("status", intent({ type: "TRANSACTION_STATUS" }));
    for (const message of ["balance", "status"]) {
      const turn = await h.say(message);
      assert.equal(turn.response.type, "ERROR");
      assert.equal(turn.response.type === "ERROR" && turn.response.code, "FEATURE_NOT_AVAILABLE");
    }
    assert.equal(h.world.intents.size, 0);
  });

  it("a different operation supersedes the intent in progress", async () => {
    const h = createHarness();
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    const first = routing(await h.say("send $20 to joão"));
    h.script.set(
      "convert",
      intent({
        type: "CONVERT",
        amount: { value: "50", currencyOrAsset: "USDT", mode: "EXACT_INPUT" },
        fromAsset: "USDT",
        toAsset: "USD",
      }),
    );
    const turn = await h.say("convert");
    assert.equal(turn.supersededIntentId, first.intentId);
    assert.equal(h.world.intents.get(first.intentId)?.status, "CANCELLED");
  });

  it("invalidates derived state when a ready intent is edited, through the single hook", async () => {
    const seen: { intentId: string; revision: number; previous: number }[] = [];
    const h = createHarness({
      onIntentRevised: (_repositories, revised, previous) => {
        seen.push({ intentId: revised.id, revision: revised.revision, previous });
        return Promise.resolve();
      },
    });
    saveContact(h, "João Silva", "joao");
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "João" },
        amount: usd("20"),
      }),
    );
    const first = routing(await h.say("send $20 to joão"));
    assert.deepEqual(seen, [], "creating an intent revises nothing");

    h.script.set(
      "make it 30",
      intent({ type: "SEND", amount: { value: "30", currencyOrAsset: "USD" } }),
    );
    const next = routing(await h.say("make it 30"));
    assert.equal(next.revision, 2);
    assert.deepEqual(seen, [{ intentId: first.intentId, revision: 2, previous: 1 }]);
    assert.equal(h.world.intents.get(first.intentId)?.status, "RESOLVED");
  });
});
