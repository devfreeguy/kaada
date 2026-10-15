import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { OutboundAction, OutboundChannelMessage } from "../src/core/channels/types.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, createHarness, intent } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

const TELEGRAM_ID = "424242";
const usd = (value: string) => ({ value, currencyOrAsset: "USD", mode: "EXACT_INPUT" as const });
const toDaniel = { type: "SAVED_BENEFICIARY" as const, value: "Daniel" };

interface Options {
  agent?: { handle(input: never): Promise<AgentTurnResult> } | null;
  wallet?: boolean;
  linked?: boolean;
}

function build(options: Options = {}) {
  const h = createHarness();
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  if (options.linked !== false) {
    h.world.addIdentity({
      id: createId(),
      userId: SENDER,
      type: "TELEGRAM",
      externalId: TELEGRAM_ID,
    });
  }
  const links = { setup: 0, authorization: [] as string[] };
  const service = new ChannelMessageService({
    adapters: new Map([["TELEGRAM", adapter]]),
    identities: new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: h.world.repositories.identities,
    }),
    actions: new ChannelActionService(stores.channelActions),
    inboundEvents: stores.inboundEvents,
    statuses: stores.channelPaymentStatuses,
    agent: options.agent === undefined ? h.agent : options.agent,
    links: {
      setupLink: (userId) => {
        links.setup += 1;
        return Promise.resolve(`https://app.kaada.test/setup/TOKEN-${userId.slice(0, 4)}`);
      },
      authorizationLink: ({ sessionId }) => {
        links.authorization.push(sessionId);
        return Promise.resolve(`https://app.kaada.test/authorize/TOKEN-${sessionId.slice(0, 4)}`);
      },
    },
    wallets: { hasActiveWallet: () => Promise.resolve(options.wallet ?? true) },
    facts: {
      read: () =>
        Promise.resolve({
          session: { status: "PENDING" as const, expiresAt: new Date(Date.now() + 300_000) },
          authorized: false,
          plan: null,
        }),
    },
  });
  return { h, stores, adapter, service, links };
}

const urlActions = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "OPEN_URL" }> => a.type === "OPEN_URL",
  );
const buttons = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "ACTION" }> => a.type === "ACTION",
  );

let counter = 0;
const event = () => `evt-${String(++counter)}`;

const authorizationResponse = (sessionId: string): AgentResponse => ({
  type: "AUTHORIZATION_REQUIRED",
  text: "ready",
  intentId: randomUUID(),
  revision: 1,
  routeId: randomUUID(),
  authorizationSessionId: sessionId,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  summary: {
    amountMode: "EXACT_INPUT",
    recipient: "Daniel",
    senderSpends: { amount: "20000000", assetId: "a", symbol: "USDT", display: "20.00 USDT" },
    maximumSpend: { amount: "20000000", assetId: "a", symbol: "USDT", display: "20.00 USDT" },
    recipientReceives: { amount: "100", assetId: "b", symbol: "wBRL", display: "102.30 wBRL" },
    minimumReceive: { amount: "99", assetId: "b", symbol: "wBRL", display: "101.50 wBRL" },
  },
  fees: [{ amount: "100000", assetId: "a", symbol: "USDT", display: "0.10 USDT" }],
  slippageBps: 50,
  indicative: true,
});

const scriptedAgent = (response: AgentResponse) => {
  const calls: unknown[] = [];
  return {
    calls,
    handle: (input: unknown): Promise<AgentTurnResult> => {
      calls.push(input);
      return Promise.resolve({
        conversationId: randomUUID(),
        messageId: randomUUID(),
        duplicate: false,
        response,
      });
    },
  };
};

describe("/start and linking", () => {
  it("creates a Kaada user on first contact and offers the secure setup page, never a wallet in chat", async () => {
    const { h, adapter, service, links } = build({ linked: false, wallet: false });
    const before = h.world.users.size;
    const result = await service.handleInbound(
      inbound({ command: "START", eventId: event(), telegramUserId: "777", username: "newbie" }),
    );
    assert.equal(result, "PROCESSED");
    assert.equal(h.world.users.size, before + 1);
    const [setup] = urlActions(adapter.last);
    assert.equal(setup?.semantic, "OPEN_SETUP");
    assert.match(setup?.url ?? "", /^https:\/\/app\.kaada\.test\/setup\/TOKEN-/);
    assert.equal(links.setup, 1);
    assert.match(adapter.last?.text ?? "", /keys and PIN never go through this chat/);
  });

  it("welcomes a returning person with a wallet and does not send them to setup again", async () => {
    const { adapter, service, links } = build({ wallet: true });
    await service.handleInbound(inbound({ command: "START", eventId: event() }));
    assert.match(adapter.last?.text ?? "", /Welcome back/);
    assert.equal(urlActions(adapter.last).length, 0);
    assert.equal(links.setup, 0);
  });

  it("two simultaneous first messages from one Telegram account make exactly one Kaada user", async () => {
    const { h, service } = build({ linked: false, wallet: false });
    const before = h.world.users.size;
    await Promise.all([
      service.handleInbound(inbound({ command: "START", eventId: event(), telegramUserId: "888" })),
      service.handleInbound(inbound({ command: "START", eventId: event(), telegramUserId: "888" })),
    ]);
    assert.equal(h.world.users.size, before + 1);
  });

  it("keys the account on the numeric id: a changed username is the same person", async () => {
    const { h, service } = build({ linked: false, wallet: false });
    await service.handleInbound(
      inbound({ command: "START", eventId: event(), telegramUserId: "999", username: "old_name" }),
    );
    const users = h.world.users.size;
    await service.handleInbound(
      inbound({ command: "HELP", eventId: event(), telegramUserId: "999", username: "new_name" }),
    );
    assert.equal(h.world.users.size, users);
    const identity = await h.world.repositories.identities.findByExternalId("TELEGRAM", "999");
    assert.equal(identity?.username, "new_name");
  });

  it("refuses to work in a group chat", async () => {
    const { adapter, service, h } = build();
    const result = await service.handleInbound(
      inbound({ text: "send $20", eventId: event(), isPrivate: false }),
    );
    assert.equal(result, "IGNORED");
    assert.match(adapter.last?.text ?? "", /private chats/);
    assert.equal(h.interpreterCalls, 0);
  });
});

describe("conversation continuity through the real Agent Core", () => {
  it("A: a complete request reaches the agent as plain text and is answered", async () => {
    const { h, adapter, service } = build();
    h.script.set(
      "send daniel $20",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel",
      identifier: "daniel",
      destinationCountry: "BR",
    });
    await service.handleInbound(inbound({ text: "send daniel $20", eventId: event() }));
    assert.equal(h.interpreterCalls, 1);
    assert.ok(adapter.sent.length >= 1);
    assert.ok(adapter.log.some((entry) => entry.kind === "typing"));
  });

  it("C: a number without a currency asks which currency, and the answer continues the SAME intent", async () => {
    const { h, adapter, service } = build();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel",
      identifier: "daniel",
      destinationCountry: "BR",
    });
    h.script.set(
      "send 20 to daniel",
      intent({ type: "SEND", recipient: toDaniel, amount: { value: "20" } }),
    );
    h.script.set(
      "usdt",
      intent({
        type: "SEND",
        amount: { value: "20", currencyOrAsset: "USDT", mode: "EXACT_INPUT" },
      }),
    );
    await service.handleInbound(inbound({ text: "send 20 to daniel", eventId: event() }));
    assert.equal(adapter.last?.text, "What currency is the 20 in?");
    const intents = h.world.intents.size;
    await service.handleInbound(inbound({ text: "usdt", eventId: event() }));
    assert.equal(
      h.world.intents.size,
      intents,
      "the answer continued the open intent, not a new one",
    );
    assert.doesNotMatch(adapter.last?.text ?? "", /What currency/);
  });

  it("D: a recipient with no amount asks how much", async () => {
    const { h, adapter, service } = build();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel",
      identifier: "daniel",
      destinationCountry: "BR",
    });
    h.script.set("send daniel", intent({ type: "SEND", recipient: toDaniel }));
    await service.handleInbound(inbound({ text: "send daniel", eventId: event() }));
    assert.equal(adapter.last?.text, "How much would you like to send?");
  });

  const twoDaniels = (h: Harness) => {
    for (const [name, handle] of [
      ["Daniel Okafor", "daniel_o"],
      ["Daniel Silva", "daniel_s"],
    ] as const) {
      h.world.addRecipient({
        id: randomUUID(),
        ownerUserId: SENDER,
        type: "SAVED_BENEFICIARY",
        displayName: name,
        identifier: handle,
        destinationCountry: "BR",
      });
    }
  };

  it("E: an ambiguous recipient becomes buttons, and tapping one resolves it WITHOUT the language model", async () => {
    const { h, adapter, service } = build();
    twoDaniels(h);
    h.script.set(
      "send $20 to daniel",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    await service.handleInbound(inbound({ text: "send $20 to daniel", eventId: event() }));
    const choices = buttons(adapter.last).filter((a) => a.semantic === "SELECT_OPTION");
    assert.equal(choices.length, 2);
    assert.deepEqual(choices.map((c) => c.label).sort(), ["Daniel Okafor", "Daniel Silva"]);
    assert.ok(buttons(adapter.last).some((a) => a.semantic === "CANCEL"));
    for (const choice of choices) assert.match(choice.handle, /^[A-Za-z0-9_-]{22}$/);

    const callsBefore = h.interpreterCalls;
    await service.handleInbound(inbound({ action: choices[1]?.handle ?? "", eventId: event() }));
    assert.equal(h.interpreterCalls, callsBefore, "a button choice never calls the interpreter");
    assert.notEqual(adapter.last?.text, "Which Daniel?");
  });

  it("G: a correction after a request revises the same intent", async () => {
    const { h, adapter, service } = build();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel",
      identifier: "daniel",
      destinationCountry: "BR",
    });
    h.script.set(
      "send daniel $20",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    h.script.set("actually make that $30", intent({ type: "SEND", amount: usd("30") }));
    await service.handleInbound(inbound({ text: "send daniel $20", eventId: event() }));
    await service.handleInbound(inbound({ text: "actually make that $30", eventId: event() }));
    const open = [...h.world.intents.values()].filter((i) => i.status !== "CANCELLED");
    assert.equal(open.length, 1);
    assert.equal(open[0]?.revision, 2);
    assert.ok(adapter.sent.length >= 2);
  });

  it("cancels from the Cancel button and from /cancel, both without the interpreter", async () => {
    const { h, adapter, service } = build();
    twoDaniels(h);
    h.script.set(
      "send $20 to daniel",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    await service.handleInbound(inbound({ text: "send $20 to daniel", eventId: event() }));
    const cancel = buttons(adapter.last).find((a) => a.semantic === "CANCEL");
    const calls = h.interpreterCalls;
    await service.handleInbound(inbound({ action: cancel?.handle ?? "", eventId: event() }));
    assert.equal(h.interpreterCalls, calls);
    assert.equal([...h.world.intents.values()].filter((i) => i.status === "CANCELLED").length, 1);
    assert.match(adapter.last?.text ?? "", /cancel|stopped|dropped/i);

    h.script.set(
      "send $20 to daniel again",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    await service.handleInbound(inbound({ text: "send $20 to daniel again", eventId: event() }));
    await service.handleInbound(inbound({ command: "CANCEL", eventId: event() }));
    assert.equal([...h.world.intents.values()].filter((i) => i.status === "CANCELLED").length, 2);
  });
});

describe("buttons are bound to the person who was shown them", () => {
  async function withButtons() {
    const ctx = build();
    ctx.h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel A",
      identifier: "daniel_a",
      destinationCountry: "BR",
    });
    ctx.h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel B",
      identifier: "daniel_b",
      destinationCountry: "BR",
    });
    ctx.h.script.set(
      "send $20 to daniel",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    await ctx.service.handleInbound(inbound({ text: "send $20 to daniel", eventId: event() }));
    const choice = buttons(ctx.adapter.last).find((a) => a.semantic === "SELECT_OPTION");
    return { ...ctx, handle: choice?.handle ?? "" };
  }

  it("another Telegram account cannot use someone else's button", async () => {
    const { adapter, service, handle, h } = await withButtons();
    h.world.addIdentity({
      id: createId(),
      userId: createId(),
      type: "TELEGRAM",
      externalId: "555",
    });
    const intentsBefore = [...h.world.intents.values()].map((i) => i.status).join();
    await service.handleInbound(
      inbound({ action: handle, eventId: event(), telegramUserId: "555" }),
    );
    assert.match(adapter.last?.text ?? "", /no longer available/);
    assert.equal([...h.world.intents.values()].map((i) => i.status).join(), intentsBefore);
  });

  it("a button works once: repeated and concurrent presses apply it a single time", async () => {
    const { adapter, service, handle, h } = await withButtons();
    const results = await Promise.all([
      service.handleInbound(inbound({ action: handle, eventId: event() })),
      service.handleInbound(inbound({ action: handle, eventId: event() })),
      service.handleInbound(inbound({ action: handle, eventId: event() })),
    ]);
    assert.equal(results.filter((r) => r === "PROCESSED").length, 3);
    assert.equal(adapter.sent.filter((m) => /already used/.test(m.text)).length, 2);
    const answers = h.world.messages.filter(
      (m) => m.role === "USER" && m.metadata?.["kind"] === "CHOICE",
    );
    assert.equal(answers.length, 1, "the agent applied the choice once");
  });

  it("an unknown or malformed handle changes nothing", async () => {
    const { adapter, service } = build();
    await service.handleInbound(inbound({ action: "A".repeat(22), eventId: event() }));
    assert.match(adapter.last?.text ?? "", /no longer available/);
  });
});

describe("the secure authorization flow", () => {
  it("shows the summary with an 'Authorize payment' link to the secure page and tracks the payment", async () => {
    const sessionId = randomUUID();
    const agent = scriptedAgent(authorizationResponse(sessionId));
    const { adapter, service, links, stores } = build({ agent });
    await service.handleInbound(inbound({ text: "send daniel $20", eventId: event() }));

    const text = adapter.last?.text ?? "";
    assert.match(text, /Payment to Daniel/);
    assert.match(text, /You spend exactly: 20\.00 USDT/);
    assert.match(text, /about 102\.30 wBRL, at least 101\.50 wBRL/);
    assert.match(text, /Fees: 0\.10 USDT/);
    assert.match(text, /6-digit PIN on a secure Kaada page\. Never type it in this chat/);

    const [authorize] = urlActions(adapter.last);
    assert.equal(authorize?.semantic, "OPEN_AUTHORIZATION");
    assert.equal(authorize?.label, "Authorize payment");
    assert.match(authorize?.url ?? "", /^https:\/\/app\.kaada\.test\/authorize\//);
    assert.deepEqual(links.authorization, [sessionId]);

    const tracked = [...stores.statuses.values()];
    assert.equal(tracked.length, 1);
    assert.equal(tracked[0]?.authorizationSessionId, sessionId);
    assert.equal(tracked[0]?.lastState, "AWAITING_AUTHORIZATION");
    assert.ok(tracked[0]?.externalSummaryMessageId);
  });

  it("an exact-output payment states the exact amount received and the most that can be spent", async () => {
    const response = authorizationResponse(randomUUID());
    if (response.type !== "AUTHORIZATION_REQUIRED") throw new Error("unreachable");
    response.summary = {
      ...response.summary,
      amountMode: "EXACT_OUTPUT",
      recipientReceives: { amount: "1", assetId: "b", symbol: "BRL", display: "R$500.00" },
      senderSpends: { amount: "1", assetId: "a", symbol: "USDT", display: "92.25 USDT" },
      maximumSpend: { amount: "1", assetId: "a", symbol: "USDT", display: "93.00 USDT" },
    };
    const { adapter, service } = build({ agent: scriptedAgent(response) });
    await service.handleInbound(inbound({ text: "send joão exactly R$500", eventId: event() }));
    assert.match(adapter.last?.text ?? "", /They receive exactly: R\$500\.00/);
    assert.match(adapter.last?.text ?? "", /about 92\.25 USDT, never more than 93\.00 USDT/);
  });

  it("never carries a PIN, token or credential in any button, and never stores a PIN-like message", async () => {
    const sessionId = randomUUID();
    const { adapter, service, stores, h } = build({
      agent: scriptedAgent(authorizationResponse(sessionId)),
    });
    await service.handleInbound(inbound({ text: "send daniel $20", eventId: event() }));
    for (const action of adapter.last?.actions ?? []) {
      if (action.type === "ACTION") {
        assert.match(action.handle, /^[A-Za-z0-9_-]{22}$/);
        const stored = stores.actions.get(action.handle);
        assert.deepEqual(
          Object.keys(stored?.payload ?? {}).filter((k) => /pin|token|secret|claim/i.test(k)),
          [],
        );
      }
    }
    // A six-digit message is the PIN being typed into the wrong place: it is removed and never reaches the agent.
    const callsBefore = h.interpreterCalls;
    const messagesBefore = h.world.messages.length;
    await service.handleInbound(
      inbound({ text: "123456", eventId: event(), messageId: "pin-msg" }),
    );
    assert.ok(
      adapter.log.some((entry) => entry.kind === "remove" && entry.externalMessageId === "pin-msg"),
    );
    assert.match(adapter.last?.text ?? "", /Never type your PIN here/);
    assert.equal(h.interpreterCalls, callsBefore);
    assert.equal(h.world.messages.length, messagesBefore, "the digits were not stored");
  });

  it("a missing wallet offers the secure setup page instead of an error code", async () => {
    const { adapter, service } = build({
      agent: scriptedAgent({ type: "ERROR", code: "WALLET_SETUP_REQUIRED", text: "x" }),
    });
    await service.handleInbound(inbound({ text: "send daniel $20", eventId: event() }));
    assert.equal(urlActions(adapter.last)[0]?.semantic, "OPEN_SETUP");
    assert.doesNotMatch(adapter.last?.text ?? "", /WALLET_SETUP_REQUIRED/);
  });

  it("translates failures into plain sentences", async () => {
    const cases: [AgentResponse, RegExp][] = [
      [{ type: "ERROR", code: "NO_ROUTE", text: "internal" }, /can't find an available route/],
      [{ type: "ERROR", code: "ROUTING_UNAVAILABLE", text: "internal" }, /temporarily unavailable/],
      [{ type: "ERROR", code: "CHOICE_EXPIRED", text: "internal" }, /no longer available/],
      [
        {
          type: "ERROR",
          code: "INSUFFICIENT_BALANCE",
          text: "You don't have enough USDT for this payment.",
        },
        /You don't have enough USDT for this payment/,
      ],
      [
        { type: "ERROR", code: "WALLET_NEEDS_FUNDING", text: "internal" },
        /don't have a supported balance for this payment yet/,
      ],
    ];
    for (const [response, expected] of cases) {
      const { adapter, service } = build({ agent: scriptedAgent(response) });
      await service.handleInbound(inbound({ text: "send", eventId: event() }));
      assert.match(adapter.last?.text ?? "", expected);
      assert.doesNotMatch(adapter.last?.text ?? "", /internal/);
    }
  });
});

describe("webhook idempotency", () => {
  it("handles one Telegram update once, however often it is delivered (even at the same time)", async () => {
    const { h, adapter, service } = build();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "Daniel",
      identifier: "daniel",
      destinationCountry: "BR",
    });
    h.script.set(
      "send daniel $20",
      intent({ type: "SEND", recipient: toDaniel, amount: usd("20") }),
    );
    const message = inbound({
      text: "send daniel $20",
      eventId: "same-update",
      messageId: "same-msg",
    });
    const results = await Promise.all([
      service.handleInbound(message),
      service.handleInbound(message),
      service.handleInbound(message),
    ]);
    assert.equal(results.filter((r) => r === "PROCESSED").length, 1);
    assert.equal(h.interpreterCalls, 1, "the language model was called once");
    assert.equal(h.world.intents.size, 1);
    assert.equal(adapter.sent.length, 1, "the person was answered once");
    assert.equal(await service.handleInbound(message), "DUPLICATE");
    assert.equal(adapter.sent.length, 1);
  });

  it("a failed delivery releases the claim, so the provider's retry is processed", async () => {
    const agent = scriptedAgent({ type: "MESSAGE", text: "hello" });
    const { adapter, service } = build({ agent });
    adapter.failNextSend = true;
    const message = inbound({ text: "hi", eventId: "retry-me" });
    await assert.rejects(service.handleInbound(message), /provider down/);
    assert.equal(await service.handleInbound(message), "PROCESSED");
    assert.equal(adapter.sent.length, 1);
  });

  it("a stale claim from a dead worker is taken over", async () => {
    const { stores, service, adapter } = build({
      agent: scriptedAgent({ type: "MESSAGE", text: "hi" }),
    });
    stores.events.set("TELEGRAM:old", {
      status: "RECEIVED",
      receivedAt: new Date(Date.now() - 10 * 60_000),
    });
    assert.equal(await service.handleInbound(inbound({ text: "x", eventId: "old" })), "PROCESSED");
    assert.equal(adapter.sent.length, 1);
    stores.events.set("TELEGRAM:busy", { status: "RECEIVED", receivedAt: new Date() });
    assert.equal(
      await service.handleInbound(inbound({ text: "x", eventId: "busy" })),
      "IN_PROGRESS",
    );
  });
});

describe("when no interpreter is configured", () => {
  it("says so politely and still handles /start and /help", async () => {
    const { adapter, service } = build({ agent: null });
    await service.handleInbound(inbound({ text: "send $20", eventId: event() }));
    assert.match(adapter.last?.text ?? "", /can't take requests yet/);
    await service.handleInbound(inbound({ command: "HELP", eventId: event() }));
    assert.match(adapter.last?.text ?? "", /Send Daniel \$20/);
  });
});
