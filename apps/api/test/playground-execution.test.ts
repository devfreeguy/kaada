import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildSimulatedExecution, describeSimulation } from "../src/core/playground/execution-intent.js";
import { collectTrace, playgroundTurn, recordTrace, redactFields } from "../src/core/channels/trace.js";
import { PlaygroundAdapter } from "../src/infrastructure/channels/playground/playground-adapter.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import type { Intent } from "@kaada/domain";
import { setup } from "./support/payment-world.js";

/*
 * The playground's execution boundary.
 *
 * The question these tests answer is not "does a payment work?" but "can a payment conversation run all the way to a priced
 * answer WITHOUT any wallet, balance, authorization, signing or execution service being asked anything?". The wallet port in
 * this world counts every lookup and every balance read, so the answer is a number, not an opinion.
 */

const payment = (response: AgentResponse) => {
  assert.equal(response.type, "PAYMENT_READY", JSON.stringify(response));
  if (response.type !== "PAYMENT_READY") throw new Error("unreachable");
  return response;
};

describe("a playground turn never reaches a wallet", () => {
  it("prices a payment for a session that has no wallet, consulting none", async () => {
    const w = setup();
    w.port.address = null; // exactly a playground session: no wallet, and none will ever be made

    const { result: turn } = await collectTrace(() => w.r.h.say("pay 500 brl"), {
      playground: true,
    });

    const ready = payment(turn.response);
    assert.ok(BigInt(ready.senderSpends.expected.amount) > 0n, "it was really priced");
    assert.equal(w.port.lookups, 0, "no wallet was looked up");
    assert.equal(w.port.reads, 0, "no balance was read");
    assert.ok(w.priced.length > 0, "the provider priced the route, as a quote would");
  });

  it("opens no authorization session, so nothing can lead to a PIN page", async () => {
    const w = setup({ authorize: true });
    w.port.address = null;
    const { result: turn } = await collectTrace(() => w.r.h.say("pay 500 brl"), {
      playground: true,
    });
    assert.notEqual(turn.response.type, "AUTHORIZATION_REQUIRED");
    // No stored answer anywhere in the chat offers one either.
    for (const message of w.r.world.messages) {
      const type = (message.structuredData as { type?: string } | undefined)?.type;
      assert.notEqual(type, "AUTHORIZATION_REQUIRED");
    }
    assert.equal(w.port.lookups, 0, "and no wallet was consulted on the way");
  });

  it("the very same payment outside the playground does ask for a wallet", async () => {
    const w = setup();
    w.port.address = null;
    const turn = await w.r.h.say("pay 500 brl");
    assert.equal(turn.response.type, "ERROR");
    if (turn.response.type !== "ERROR") return;
    assert.equal(turn.response.code, "WALLET_SETUP_REQUIRED");
    assert.ok(w.port.lookups > 0, "the real path does consult the wallet");
  });

  it("collects the events services log, and nothing from outside the turn", async () => {
    recordTrace("info", "before.the.turn", { ignored: true });
    const { events } = await collectTrace(
      () => {
        recordTrace("info", "agent.turn.completed", { responseType: "QUOTE_RESULT" });
        recordTrace("warn", "routing.slow", { ms: 12 });
        return Promise.resolve();
      },
      { playground: true },
    );
    assert.deepEqual(
      events.map((event) => event.event),
      ["agent.turn.completed", "routing.slow"],
    );
    assert.equal(events[0]?.fields["responseType"], "QUOTE_RESULT");
    assert.ok((events[0]?.atMs ?? -1) >= 0, "each event is stamped against the turn");
    // Outside a collected turn it is a no-op, so production pays nothing for it.
    recordTrace("info", "after.the.turn", {});
  });

  it("the flag belongs to the turn and leaks nowhere", async () => {
    assert.equal(playgroundTurn(), false);
    await collectTrace(
      () => {
        assert.equal(playgroundTurn(), true);
        return Promise.resolve();
      },
      { playground: true },
    );
    assert.equal(playgroundTurn(), false);
    // A collected turn that is NOT a playground turn (nothing sets it today) stays off.
    await collectTrace(() => {
      assert.equal(playgroundTurn(), false);
      return Promise.resolve();
    });
  });
});

describe("the simulated execution event", () => {
  const storedIntent = (over: Partial<Intent> = {}): Intent =>
    ({
      id: "intent-1",
      userId: "u",
      conversationId: "c",
      type: "SEND",
      status: "RESOLVED",
      revision: 2,
      missingFields: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });

  it("describes what a priced payment WOULD do, from the route the application really found", async () => {
    const w = setup();
    w.port.address = null;
    const { result: turn } = await collectTrace(() => w.r.h.say("pay 500 brl"), {
      playground: true,
    });
    const ready = payment(turn.response);
    const stored = [...w.r.world.intents.values()].at(-1);
    assert.ok(stored);

    const event = buildSimulatedExecution(stored, ready);
    assert.ok(event);
    assert.equal(event.intent, "payment");
    assert.equal(event.executionMode, "simulation");
    assert.equal(event.intentId, stored.id);
    // The figures are the provider's, in exact smallest units, not a round number invented here.
    assert.equal(event.senderSpends?.value, ready.senderSpends.expected.amount);
    assert.equal(event.recipientReceives?.value, ready.recipientReceives.expected.amount);
    const transfer = event.operations.find((operation) => operation.type === "transfer");
    assert.ok(transfer, "a payment always ends in a transfer");
    // A swap appears only when the route really has one.
    assert.equal(
      event.operations.filter((operation) => operation.type === "swap").length,
      ready.route.hops.length,
    );
  });

  it("says what is missing rather than inventing a route, when nothing was priced", () => {
    const event = buildSimulatedExecution(
      storedIntent({ missingFields: ["RECIPIENT"] }),
      { type: "MESSAGE", text: "Who is it for?" },
    );
    assert.ok(event);
    assert.deepEqual(event.operations, []);
    assert.match(event.note ?? "", /not priced.*RECIPIENT/);
    assert.equal(event.senderSpends, undefined, "no amount is invented");
  });

  it("is not produced for a turn that is not a payment or a conversion", () => {
    assert.equal(
      buildSimulatedExecution(storedIntent({ type: "QUOTE" }), {
        type: "MESSAGE",
        text: "x",
      }),
      null,
    );
  });

  it("never says a transaction happened", () => {
    const text = describeSimulation({
      intent: "payment",
      executionMode: "simulation",
      intentId: "i",
      revision: 1,
      targetCurrency: "wBRL",
      operations: [
        { type: "swap", from: "USDT", to: "wBRL" },
        {
          type: "transfer",
          amount: { value: "1", assetId: "a", decimals: 2, display: "R$500" },
          recipient: "João",
        },
      ],
    });
    assert.match(text, /No transaction was executed/);
    assert.doesNotMatch(text, /sent|completed|done|success/i);
  });
});

describe("the debug trace hides what must never be shown", () => {
  it("redacts credentials by field name, whatever the value is", () => {
    const safe = redactFields({
      botToken: "123:abc",
      apiKey: "gsk_live_secret",
      pin: "123456",
      recoveryCode: "aaa-bbb",
      privateKey: "0xdeadbeef",
      signature: "0xsig",
      mnemonic: "word word word",
      conversationId: "c-1",
      intentId: "i-1",
    });
    for (const name of [
      "botToken",
      "apiKey",
      "pin",
      "recoveryCode",
      "privateKey",
      "signature",
      "mnemonic",
    ]) {
      assert.equal(safe[name], "[redacted]", name);
    }
    assert.equal(safe["conversationId"], "c-1", "identifiers are still useful and still shown");
    assert.equal(safe["intentId"], "i-1");
  });

  it("redacts inside nested structures and clips very long values", () => {
    const safe = redactFields({ provider: { apiKey: "secret", name: "textile" } });
    const provider = safe["provider"] as Record<string, unknown>;
    assert.equal(provider["apiKey"], "[redacted]");
    assert.equal(provider["name"], "textile");
    const long = redactFields({ text: "x".repeat(5_000) });
    assert.ok(String(long["text"]).length < 1_000);
  });
});

describe("the playground adapter is a translator, not a channel", () => {
  it("collects what Kaada said and hands it over once", async () => {
    const adapter = new PlaygroundAdapter();
    assert.equal(adapter.channel, "WEB");
    await adapter.send({ externalConversationId: "chat" }, { text: "first" });
    await adapter.send({ externalConversationId: "chat" }, { text: "second" });
    assert.deepEqual(
      adapter.drain("chat").map((message) => message.text),
      ["first", "second"],
    );
    assert.deepEqual(adapter.drain("chat"), [], "draining empties the chat");
  });

  it("keeps chats apart", async () => {
    const adapter = new PlaygroundAdapter();
    await adapter.send({ externalConversationId: "a" }, { text: "for a" });
    assert.deepEqual(adapter.drain("b"), []);
    assert.equal(adapter.drain("a").length, 1);
  });

  it("refuses every webhook: it is not reachable from the internet", () => {
    const adapter = new PlaygroundAdapter();
    assert.equal(adapter.verifyWebhook(), false);
    assert.equal(adapter.parseWebhook(), null);
  });
});
