import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { activeFocus, parseBareAmount, parseRatePair } from "../src/core/intents/focus.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, intent } from "./support/harness.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };

function world(): RoutingHarness {
  const r = createRoutingHarness();
  r.h.script.set(
    "send joao 20",
    intent({
      type: "SEND",
      recipient: joao,
      amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      sourceAsset: "USDT",
    }),
  );
  r.h.script.set("send to joao", intent({ type: "SEND", recipient: joao }));
  // A bare "20" read on its own (what a language model would do with a fragment): a payment with only an amount.
  r.h.script.set("20", intent({ type: "SEND", amount: { value: "20" } }));
  return r;
}

const focusOf = async (r: RoutingHarness, turn: { conversationId: string }) =>
  (await r.world.repositories.conversations.findById(turn.conversationId))?.metadata?.["focus"] as
    { kind: string; intentId?: string; intentRevision?: number } | undefined;
const intentsOf = (r: RoutingHarness) => [...r.world.intents.values()];

describe("the pair parser (no model needed)", () => {
  it("reads the ways people write a pair, and nothing that is not one", () => {
    for (const text of [
      "wARS to USDT",
      "wARS/USDT",
      "wARS -> USDT",
      "wARS → USDT",
      "wARS-USDT",
      "WARS usdt",
      "rate of wARS to USDT?",
    ]) {
      assert.deepEqual(parseRatePair(text)?.to.toUpperCase(), "USDT", text);
    }
    assert.deepEqual(parseRatePair("USDT cNGN"), { from: "USDT", to: "cNGN", explicit: false });
    assert.equal(parseRatePair("wARS/USDT")?.explicit, true);
    for (const text of ["20", "send Daniel $20", "hello there friend", "USDT", ""]) {
      assert.equal(parseRatePair(text), null, text);
    }
    assert.equal(parseBareAmount("20"), "20");
    assert.equal(parseBareAmount("10k"), "10000");
    assert.equal(parseBareAmount("20 usdt"), undefined);
  });
});

describe("a rate question is remembered, and its answer is read as the answer", () => {
  it("asking for a rate sets the RATE_PAIR focus on the conversation", async () => {
    const r = world();
    const asked = await r.h.command("ASK_RATE_PAIR");
    assert.equal(asked.response.type, "CHAT");
    assert.equal(asked.response.type === "CHAT" && asked.response.topic, "RATE_GENERAL");
    const focus = await focusOf(r, asked);
    assert.equal(focus?.kind, "RATE_PAIR");
    assert.equal(
      activeFocus(
        (await r.world.repositories.conversations.findById(asked.conversationId))?.metadata,
        r.clock.now,
        null,
      )?.kind,
      "RATE_PAIR",
    );
  });

  it("'wARS to USDT' is a rate lookup, with no interpretation and no payment", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const before = r.h.interpreterCalls;
    const answer = await r.h.say("wARS to USDT");
    assert.equal(answer.response.type, "QUOTE_RESULT");
    assert.match(answer.response.text, /^AR\$1 currently gives approximately \$[\d.]+/);
    assert.equal(r.h.interpreterCalls, before, "no language-model call for a plain pair");
    assert.ok(
      intentsOf(r).every((i) => i.type === "QUOTE"),
      "no payment was begun",
    );
    assert.equal(await focusOf(r, answer), undefined, "answered, so the question is cleared");
  });

  it("'wARS/USDT', 'wARS -> USDT', 'USDT cNGN' and 'USDT to cNGN' are all pairs", async () => {
    const r = world();
    for (const [text, destination] of [
      ["wARS/USDT", "USDT"],
      ["wARS -> USDT", "USDT"],
      ["USDT cNGN", "cNGN"],
      ["USDT to cNGN", "cNGN"],
    ] as const) {
      await r.h.command("ASK_RATE_PAIR");
      const answer = await r.h.say(text);
      assert.equal(answer.response.type, "QUOTE_RESULT", text);
      assert.equal(
        answer.response.type === "QUOTE_RESULT" && answer.response.destination.symbol,
        destination,
        text,
      );
    }
    assert.equal(r.h.interpreterCalls, 0);
  });

  it("two ordinary words that are not assets are not mistaken for a pair", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const before = r.h.interpreterCalls;
    const turn = await r.h.say("what is up");
    assert.equal(r.h.interpreterCalls, before + 1, "read like any other message");
    assert.match(turn.response.text, /didn't catch a pair/);
    assert.doesNotMatch(turn.response.text, /I don't support/);
  });

  it("an unsupported pair says which asset is unknown and keeps asking for a pair", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const bad = await r.h.say("wXYZ to USDT");
    assert.equal(bad.response.type, "MESSAGE");
    assert.match(
      bad.response.text,
      /I don't support wXYZ yet\. Which pair would you like to check instead\?/,
    );
    assert.equal((await focusOf(r, bad))?.kind, "RATE_PAIR", "still waiting for a pair");
    assert.equal(r.h.interpreterCalls, 0);
    const good = await r.h.say("wARS to USDT");
    assert.equal(good.response.type, "QUOTE_RESULT");
  });

  it("a bare '20' while waiting for a pair does not start a payment; the question is asked again", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const fragment = await r.h.say("20");
    assert.equal(fragment.response.type, "MESSAGE");
    assert.match(fragment.response.text, /didn't catch a pair/);
    assert.equal(intentsOf(r).length, 0, "nothing was created");
    assert.equal((await focusOf(r, fragment))?.kind, "RATE_PAIR");
    const answer = await r.h.say("USDT to cNGN");
    assert.equal(answer.response.type, "QUOTE_RESULT");
  });

  it("an explicit new request overrides the question instead of being trapped by it", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const payment = await r.h.say("send joao 20");
    assert.ok(
      payment.response.type === "PAYMENT_READY" ||
        payment.response.type === "AUTHORIZATION_REQUIRED",
    );
    assert.equal(intentsOf(r).filter((i) => i.type === "SEND").length, 1);
    assert.equal(await focusOf(r, payment), undefined, "the new request replaced the question");
  });

  it("asking for a rate beside an open payment leaves that payment alone", async () => {
    const r = world();
    const payment = await r.h.say("send joao 20");
    const intentId = payment.intentId;
    await r.h.command("ASK_RATE_PAIR");
    assert.equal((await focusOf(r, payment))?.intentId, intentId);
    const answer = await r.h.say("wARS to USDT");
    assert.equal(answer.response.type, "QUOTE_RESULT");
    assert.equal(answer.response.type === "QUOTE_RESULT" && answer.response.side, true);
    assert.equal(intentsOf(r).length, 1);
    assert.equal(intentsOf(r)[0]?.status, "RESOLVED");
    assert.equal(intentsOf(r)[0]?.revision, 1);
  });
});

describe("answers to a payment's own questions", () => {
  it("a bare amount answers the missing amount, and a bare currency answers the missing currency", async () => {
    const r = world();
    const asked = await r.h.say("send to joao");
    assert.equal(asked.response.type, "CLARIFICATION_REQUIRED");
    const before = r.h.interpreterCalls;

    const amount = await r.h.say("20");
    assert.equal(amount.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(
      amount.response.type === "CLARIFICATION_REQUIRED" && amount.response.field,
      "CURRENCY",
    );
    assert.equal(amount.intentId, asked.intentId, "the same payment");

    const currency = await r.h.say("USDT");
    assert.ok(
      currency.response.type === "PAYMENT_READY" ||
        currency.response.type === "AUTHORIZATION_REQUIRED",
      JSON.stringify(currency.response),
    );
    assert.equal(currency.intentId, asked.intentId);
    assert.equal(r.h.interpreterCalls, before, "neither answer needed a language model");
    assert.equal(intentsOf(r).length, 1);
  });

  it("something that is not an amount or a known currency still reaches the interpreter", async () => {
    const r = world();
    await r.h.say("send to joao");
    const before = r.h.interpreterCalls;
    await r.h.say("actually forget it");
    assert.equal(r.h.interpreterCalls, before + 1);
  });
});

describe("the focus has a lifecycle", () => {
  it("cancel clears it", async () => {
    const r = world();
    const asked = await r.h.command("ASK_RATE_PAIR");
    assert.equal((await focusOf(r, asked))?.kind, "RATE_PAIR");
    const cancelled = await r.h.command("CANCEL_ACTIVE_INTENT");
    assert.equal(await focusOf(r, cancelled), undefined);
    // and a pair afterwards is no longer read as an answer: it goes to the interpreter like any other message
    const before = r.h.interpreterCalls;
    await r.h.say("wARS to USDT");
    assert.equal(r.h.interpreterCalls, before + 1);
  });

  it("is ignored when the payment it was asked beside has changed, or when it is old", async () => {
    const r = world();
    const payment = await r.h.say("send joao 20");
    const conversations = r.world.repositories.conversations;
    const intentId = payment.intentId ?? "";

    await conversations.setFocus(payment.conversationId, {
      kind: "RATE_PAIR",
      setAt: r.clock.now.toISOString(),
      intentId,
      intentRevision: 99, // the payment is at revision 1: this question belongs to a situation that no longer exists
    });
    let before = r.h.interpreterCalls;
    const stale = await r.h.say("wARS to USDT");
    assert.equal(r.h.interpreterCalls, before + 1, "not read as an answer");
    assert.notEqual(stale.response.type, "QUOTE_RESULT");

    await conversations.setFocus(payment.conversationId, {
      kind: "RATE_PAIR",
      setAt: new Date(r.clock.now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
    });
    before = r.h.interpreterCalls;
    await r.h.say("wARS to USDT");
    assert.equal(r.h.interpreterCalls, before + 1, "a two-hour-old question has lapsed");
  });

  it("an answer delivered twice (a Telegram retry) is consumed once", async () => {
    const r = world();
    await r.h.command("ASK_RATE_PAIR");
    const first = await r.h.say("wARS to USDT", { externalMessageId: "tg-100" });
    const again = await r.h.say("wARS to USDT", { externalMessageId: "tg-100" });
    assert.equal(first.duplicate, false);
    assert.equal(again.duplicate, true);
    assert.equal(intentsOf(r).filter((i) => i.type === "QUOTE").length, 1);
    assert.equal(r.h.interpreterCalls, 0);
  });
});

describe("in the chat: Today's rates, then the pair", () => {
  it("/rates asks which pair, and 'wARS to USDT' is answered with the rate (no payment)", async () => {
    const r = createRoutingHarness();
    const stores = createMemoryChannelStores();
    const adapter = new FakeAdapter();
    r.h.world.addIdentity({
      id: createId(),
      userId: SENDER,
      type: "TELEGRAM",
      externalId: "424242",
    });
    const service = new ChannelMessageService({
      adapters: new Map([["TELEGRAM", adapter]]),
      identities: new ChannelIdentityService({
        users: r.h.world.repositories.users,
        identities: r.h.world.repositories.identities,
      }),
      actions: new ChannelActionService(stores.channelActions),
      inboundEvents: stores.inboundEvents,
      statuses: stores.channelPaymentStatuses,
      agent: {
        handle: (input): Promise<AgentTurnResult> => r.h.agent.handle(input),
        recentTurns: (id, exclude, limit) => r.h.agent.recentTurns(id, exclude, limit),
      },
      conversation: new ConversationPresenter({
        writer: null,
        flags: { send: true, rates: true, balance: true },
      }),
      links: {
        setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
        authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
      },
      wallets: { hasActiveWallet: () => Promise.resolve(true) },
      facts: { read: () => Promise.reject(new Error("unused")) },
    });

    await service.handleInbound(inbound({ eventId: `fc-${randomUUID()}`, command: "RATES" }));
    assert.match(adapter.last?.text ?? "", /Which rate/i);
    await service.handleInbound(inbound({ eventId: `fc-${randomUUID()}`, text: "wARS to USDT" }));
    assert.match(adapter.last?.text ?? "", /AR\$1 currently gives approximately \$[\d.]+/);
    assert.ok(intentsOf(r).every((i) => i.type === "QUOTE"));
    assert.equal(r.h.interpreterCalls, 0, "no model call anywhere in this exchange");
  });
});
