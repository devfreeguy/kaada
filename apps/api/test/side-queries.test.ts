import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { OutboundAction, OutboundChannelMessage } from "../src/core/channels/types.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { WalletFundingResolver } from "../src/core/routing/funding-resolver.js";
import type { AuthorizationGate } from "../src/core/routing/routing-service.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, intent } from "./support/harness.js";
import { FakePort, USDT } from "./support/payment-world.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };

/** A payment ready for its PIN, the way the real flow ends: priced, with an authorization session begun. */
function world() {
  const begins: { intentId: string; routeId: string; intentRevision: number }[] = [];
  const gate: AuthorizationGate = {
    begin: (_repositories, input) => {
      begins.push({
        intentId: input.intentId,
        routeId: input.routeId,
        intentRevision: input.intentRevision,
      });
      return Promise.resolve({
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 300_000),
      });
    },
    routeReplaced: () => Promise.resolve(),
  };
  const balanceReads: string[] = [];
  const port = new FakePort();
  const r = createRoutingHarness({
    funding: (registry) => new WalletFundingResolver({ wallet: port, assets: registry }),
    authorization: () => gate,
    balances: {
      read: (userId) => {
        balanceReads.push(userId);
        return Promise.resolve({ lines: [{ symbol: "USDT", display: "42.18" }] });
      },
    },
  });
  port.held.set(r.h.assets.USDT.id, 1000n * USDT);
  // The payment: exactly 20 USD, paid in USDT, to João.
  r.h.script.set(
    "send",
    intent({
      type: "SEND",
      recipient: joao,
      amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      sourceAsset: "USDT",
    }),
  );
  r.h.script.set(
    "correct",
    intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
  );
  r.h.script.set(
    "rate",
    intent({
      type: "QUOTE",
      amount: { value: "1", currencyOrAsset: "USDT", mode: "EXACT_INPUT" },
      fromAsset: "USDT",
      toAsset: "cNGN",
    }),
  );
  r.h.script.set("balance", intent({ type: "BALANCE" }));
  r.h.script.set("help", intent({ type: "HELP", topic: "CAPABILITIES" }));
  return { r, begins, balanceReads };
}

const baseOf = (turn: { conversationId: string }) => ({
  userId: SENDER,
  channel: "TELEGRAM" as const,
  externalConversationId: "chat-1",
  ...(turn.conversationId && {}),
});

async function payment(r: RoutingHarness) {
  const turn = await r.h.say("send");
  assert.ok(
    turn.response.type === "AUTHORIZATION_REQUIRED" || turn.response.type === "PAYMENT_READY",
    JSON.stringify(turn.response),
  );
  assert.ok(turn.intentId);
  return { turn, intentId: turn.intentId };
}

const intentsOf = (r: RoutingHarness) => [...r.world.intents.values()];
const routesOf = (r: RoutingHarness, intentId: string) =>
  r.world.repositories.routes.listByIntent(intentId);

const continuePayment = (r: RoutingHarness, intentId: string, id = "continue-1") =>
  r.h.agent.handle({
    kind: "COMMAND",
    ...baseOf({ conversationId: "x" }),
    command: "CONTINUE_PAYMENT",
    resumeIntentId: intentId,
    externalMessageId: id,
  });

describe("a question beside an open payment", () => {
  it("a rate question is answered with the provider's price and the payment is left alone", async () => {
    const { r } = world();
    const { intentId } = await payment(r);
    const before = intentsOf(r).find((i) => i.id === intentId);
    const routesBefore = (await routesOf(r, intentId)).length;

    const turn = await r.h.say("rate");
    assert.equal(turn.response.type, "QUOTE_RESULT");
    if (turn.response.type !== "QUOTE_RESULT") return;
    assert.equal(turn.response.side, true);
    assert.match(turn.response.text, /\$1 currently gives approximately ₦1,499\.85/);
    assert.equal(turn.response.destination.symbol, "cNGN");
    assert.deepEqual(turn.resume, {
      intentId,
      revision: 1,
      operation: "SEND",
      recipient: "João Silva",
      amount: "$20",
      pending: false,
    });

    const after = intentsOf(r).find((i) => i.id === intentId);
    assert.equal(after?.status, before?.status);
    assert.equal(after?.revision, 1);
    assert.equal((await routesOf(r, intentId)).length, routesBefore, "no route written or retired");
  });

  it("a balance question is answered from the wallet and the payment is left alone", async () => {
    const { r, balanceReads } = world();
    const { intentId } = await payment(r);
    const turn = await r.h.say("balance");
    assert.equal(turn.response.type, "BALANCE_RESULT");
    assert.equal(turn.response.text, "Your balance:\n• 42.18 USDT");
    assert.equal(turn.resume?.intentId, intentId);
    assert.deepEqual(balanceReads, [SENDER]);
    assert.equal(intentsOf(r).find((i) => i.id === intentId)?.status, "RESOLVED");
  });

  it("a 'what can you do?' question is answered and the payment is left alone", async () => {
    const { r } = world();
    const { intentId } = await payment(r);
    const turn = await r.h.say("help");
    assert.equal(turn.response.type, "CHAT");
    assert.equal(turn.resume?.intentId, intentId);
    assert.equal(intentsOf(r).find((i) => i.id === intentId)?.revision, 1);
  });

  it("the payment survives all three, and nothing else is created: no second payment, route or authorization", async () => {
    const { r, begins } = world();
    const { intentId } = await payment(r);
    const authorizations = begins.length;
    const routes = (await routesOf(r, intentId)).length;
    const interpretations = r.h.interpreterCalls;
    for (const text of ["rate", "balance", "help", "rate"]) await r.h.say(text);

    const all = intentsOf(r);
    assert.equal(all.length, 1, "still the one payment");
    assert.equal(all[0]?.id, intentId);
    assert.equal(all[0]?.status, "RESOLVED");
    assert.equal(all[0]?.revision, 1);
    assert.equal((await routesOf(r, intentId)).length, routes);
    assert.equal(begins.length, authorizations, "a side question never creates an authorization");
    assert.equal(
      r.h.interpreterCalls,
      interpretations + 4,
      "one interpretation per typed question, none extra",
    );
    assert.deepEqual(
      begins.map((b) => b.intentId),
      [intentId],
    );
  });

  it("an explicit correction after a side question still revises the payment", async () => {
    const { r } = world();
    const { intentId } = await payment(r);
    await r.h.say("rate");
    const corrected = await r.h.say("correct");
    assert.equal(corrected.intentId, intentId, "the same payment, revised");
    assert.deepEqual(corrected.corrected, ["AMOUNT"]);
    const stored = intentsOf(r).find((i) => i.id === intentId);
    assert.equal(stored?.revision, 2);
    assert.equal(intentsOf(r).length, 1);
  });

  it("'cancel' still cancels the open payment", async () => {
    const { r } = world();
    const { intentId } = await payment(r);
    await r.h.say("rate");
    const cancelled = await r.h.agent.handle({
      kind: "COMMAND",
      ...baseOf({ conversationId: "x" }),
      command: "CANCEL_ACTIVE_INTENT",
      externalMessageId: "cancel-1",
    });
    assert.equal(cancelled.response.type, "CANCELLED");
    assert.equal(intentsOf(r).find((i) => i.id === intentId)?.status, "CANCELLED");
  });
});

describe("Continue", () => {
  it("resumes the SAME payment and revision from stored state, with no interpretation", async () => {
    const { r } = world();
    const { turn: original, intentId } = await payment(r);
    await r.h.say("rate");
    const interpretations = r.h.interpreterCalls;

    const resumed = await continuePayment(r, intentId);
    assert.equal(r.h.interpreterCalls, interpretations, "pressing Continue interprets nothing");
    assert.equal(resumed.response.type, original.response.type);
    if (
      resumed.response.type !== "AUTHORIZATION_REQUIRED" ||
      original.response.type !== "AUTHORIZATION_REQUIRED"
    ) {
      throw new Error("expected the payment to be presented again");
    }
    assert.equal(resumed.response.intentId, intentId);
    assert.equal(resumed.response.revision, 1);
    assert.equal(
      resumed.response.routeId,
      original.response.routeId,
      "the same priced route is reused",
    );
    assert.deepEqual(resumed.response.summary, original.response.summary);
    assert.equal(intentsOf(r).length, 1);
  });

  it("after the price has expired it re-prices the same payment instead of showing a stale price", async () => {
    const { r } = world();
    const { turn: original, intentId } = await payment(r);
    await r.h.say("balance");
    r.clock.advance(5 * 60_000); // far past the 30 s quote
    const resumed = await continuePayment(r, intentId);
    if (
      resumed.response.type !== "AUTHORIZATION_REQUIRED" ||
      original.response.type !== "AUTHORIZATION_REQUIRED"
    ) {
      throw new Error("expected the payment to be priced again");
    }
    assert.equal(resumed.response.intentId, intentId);
    assert.equal(resumed.response.revision, 1);
    assert.notEqual(resumed.response.routeId, original.response.routeId, "a fresh price");
  });

  it("a payment that was cancelled, or a button for another payment, is never resurrected", async () => {
    const { r } = world();
    const { intentId } = await payment(r);
    const other = await continuePayment(r, randomUUID(), "continue-other");
    assert.equal(other.response.type, "MESSAGE");
    assert.match(other.response.text, /isn't open any more/);

    await r.h.agent.handle({
      kind: "COMMAND",
      ...baseOf({ conversationId: "x" }),
      command: "CANCEL_ACTIVE_INTENT",
      externalMessageId: "cancel-2",
    });
    const stale = await continuePayment(r, intentId, "continue-late");
    assert.equal(stale.response.type, "MESSAGE");
    assert.match(stale.response.text, /isn't open any more/);
    assert.equal(intentsOf(r).find((i) => i.id === intentId)?.status, "CANCELLED");
  });

  it("pressing it twice (a redelivery) is answered from the stored first answer and changes nothing", async () => {
    const { r, begins } = world();
    const { intentId } = await payment(r);
    await continuePayment(r, intentId, "continue-dup");
    const authorizations = begins.length;
    const routes = (await routesOf(r, intentId)).length;
    const interpretations = r.h.interpreterCalls;
    const second = await continuePayment(r, intentId, "continue-dup");
    assert.equal(second.duplicate, true);
    assert.equal(begins.length, authorizations, "no second authorization");
    assert.equal((await routesOf(r, intentId)).length, routes, "no second pricing");
    assert.equal(r.h.interpreterCalls, interpretations);
    assert.equal(intentsOf(r).length, 1);
    assert.equal(intentsOf(r)[0]?.revision, 1);
  });

  it("while the payment still needs a detail, Continue asks for that detail again", async () => {
    const { r } = world();
    r.h.script.set("start", intent({ type: "SEND", recipient: joao }));
    const asked = await r.h.say("start");
    assert.equal(asked.response.type, "CLARIFICATION_REQUIRED");
    const side = await r.h.say("balance");
    assert.equal(side.resume?.pending, true);
    const resumed = await continuePayment(r, asked.intentId ?? "");
    assert.equal(resumed.response.type, "CLARIFICATION_REQUIRED");
    assert.equal(resumed.intentId, asked.intentId);
  });
});

// ───────────────────────── in the chat ─────────────────────────

function chat(r: RoutingHarness) {
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  r.h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
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
      recentTurns: (conversationId, exclude, limit) =>
        r.h.agent.recentTurns(conversationId, exclude, limit),
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
  return { adapter, service };
}

let n = 0;
const say = (text: string) => inbound({ eventId: `sq-${String(++n)}`, text });
const press = (handle: string) => inbound({ eventId: `sq-${String(++n)}`, action: handle });
const buttons = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "ACTION" }> => a.type === "ACTION",
  );

describe("in the chat", () => {
  it("answers the rate, names the open payment, and offers Continue and Cancel (nothing else)", async () => {
    const { r } = world();
    const { adapter, service } = chat(r);
    await service.handleInbound(say("send"));
    await service.handleInbound(say("rate"));
    const text = adapter.last?.text ?? "";
    assert.match(text, /\$1 currently gives approximately ₦1,499\.85/);
    assert.match(text, /You were sending \$20 to João Silva\. Want to continue\?/);
    assert.deepEqual(
      buttons(adapter.last).map((a) => [a.semantic, a.label]),
      [
        ["CONTINUE_PAYMENT", "▶️ Continue"],
        ["CANCEL", "❌ Cancel"],
      ],
    );
    assert.doesNotMatch(text, /Want to send some\?/, "no competing question");
  });

  it("the Continue button resumes the payment, and a second press is refused as already used", async () => {
    const { r, begins } = world();
    const { adapter, service } = chat(r);
    await service.handleInbound(say("send"));
    await service.handleInbound(say("balance"));
    const button = buttons(adapter.last).find((a) => a.semantic === "CONTINUE_PAYMENT");
    assert.ok(button);
    const interpretations = r.h.interpreterCalls;

    await service.handleInbound(press(button.handle));
    assert.match(adapter.last?.text ?? "", /You spend exactly/);
    assert.ok(
      (adapter.last?.actions ?? []).some((a) => a.type === "OPEN_URL"),
      "the secure authorize button",
    );
    assert.equal(r.h.interpreterCalls, interpretations, "no interpretation to press Continue");
    const authorizations = begins.length;

    const count = adapter.sent.length;
    await service.handleInbound(press(button.handle));
    assert.equal(adapter.last?.text, "That button was already used.");
    assert.equal(adapter.sent.length, count + 1);
    assert.equal(begins.length, authorizations, "the second press changed nothing");
    assert.equal(intentsOf(r).length, 1);
  });

  it("Continue after the payment was cancelled says so, and does not bring it back", async () => {
    const { r } = world();
    const { adapter, service } = chat(r);
    await service.handleInbound(say("send"));
    await service.handleInbound(say("help"));
    const keep = buttons(adapter.last).find((a) => a.semantic === "CONTINUE_PAYMENT");
    const cancel = buttons(adapter.last).find((a) => a.semantic === "CANCEL");
    assert.ok(keep && cancel);
    await service.handleInbound(press(cancel.handle));
    await service.handleInbound(press(keep.handle));
    assert.match(adapter.last?.text ?? "", /isn't open any more/);
    assert.equal(intentsOf(r)[0]?.status, "CANCELLED");
  });
});
