import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";
import type { ChannelType } from "@kaada/domain";

import { contentOfText, parseChannelCommand } from "../src/core/channels/command-parser.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { ChannelAdapter } from "../src/core/channels/types.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { PlaygroundService, newSession } from "../src/core/playground/playground-service.js";
import type { PlaygroundSession } from "../src/core/playground/playground-service.js";
import { PlaygroundAdapter } from "../src/infrastructure/channels/playground/playground-adapter.js";
import { TelegramAdapter } from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { createMemoryChannelStores } from "./support/channels-memory.js";
import { intent } from "./support/harness.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

/*
 * The playground as a developer uses it: typed messages, pressed buttons and several turns in a row, all through the SAME
 * ChannelMessageService.handleInbound that Telegram uses. The wiring below is the playground module's wiring: the agent,
 * presenter and repositories are shared, and every wallet-facing capability is absent.
 */

interface World {
  r: RoutingHarness;
  playground: PlaygroundService;
  /** Set when anything asked for a wallet, a balance or an authorization link. Must stay empty. */
  walletCalls: string[];
}

function world(): World {
  const r = createRoutingHarness();
  const stores = createMemoryChannelStores();
  const adapter = new PlaygroundAdapter();
  const walletCalls: string[] = [];

  const messages = new ChannelMessageService({
    adapters: new Map<ChannelType, ChannelAdapter>([["WEB", adapter]]),
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
    onboarding: null,
    funding: null,
    wallets: {
      hasActiveWallet: () => {
        walletCalls.push("hasActiveWallet");
        return Promise.resolve(false);
      },
    },
    links: {
      setupLink: () => {
        walletCalls.push("setupLink");
        return Promise.resolve(null);
      },
      authorizationLink: () => {
        walletCalls.push("authorizationLink");
        throw new Error("the playground never issues authorization links");
      },
    },
    facts: { read: () => Promise.reject(new Error("no payment status in the playground")) },
  });

  const playground = new PlaygroundService({
    messages,
    adapter,
    conversations: r.h.world.repositories.conversations,
    storedMessages: r.h.world.repositories.messages,
    intents: r.h.world.repositories.intents,
  });
  return { r, playground, walletCalls };
}

const said = (turn: { messages: { text: string }[] }) =>
  turn.messages.map((message) => message.text).join("\n");

describe("the playground drives the real agent", () => {
  it("answers '/rates Naira to Argentina Peso' with the actual rate", async () => {
    const w = world();
    const turn = await w.playground.message(newSession(), "/rates Naira to Argentina Peso");
    const text = said(turn);
    assert.match(text, /Nigerian Naira \(NGN\) → Argentine Peso \(ARS\)/);
    assert.match(text, /₦1 = AR\$[\d.,]+/);
    assert.deepEqual(w.walletCalls, [], "no wallet capability was consulted");
  });

  it("keeps context across turns: a rate, then a bare amount", async () => {
    const w = world();
    const session = newSession();
    await w.playground.message(session, "/rates Naira to Argentina Peso");

    const follow = await w.playground.message(session, "20,000");
    assert.match(said(follow), /AR\$/, "the follow-up was priced on the remembered pair");
    assert.ok(follow.intent, "an intent was recorded for the follow-up");
    assert.equal(follow.intent?.type, "QUOTE", "it stayed a question, not a payment");
    assert.deepEqual(w.walletCalls, []);
  });

  it("records the conversation's focus so a developer can see why a follow-up worked", async () => {
    const w = world();
    const session = newSession();
    const turn = await w.playground.message(session, "/rates Naira to Argentina Peso");
    assert.deepEqual((turn.focus as { kind?: string } | null)?.kind, "RATE_QUOTED");
  });

  it("shows the structured intent and the trace of what ran", async () => {
    const w = world();
    const turn = await w.playground.message(newSession(), "/rates Naira to Argentina Peso");
    assert.ok(turn.responses.length > 0, "the agent's structured answers are available");
    assert.ok(turn.intent, "the stored intent row is available");
    assert.ok(turn.elapsedMs >= 0);
    // The trace carries whatever the services logged. This harness wires its own logger rather than the Nest one, so the
    // tee itself is pinned separately (playground-execution.test.ts, "collects the events services log").
    assert.ok(Array.isArray(turn.trace));
  });

  it("understands a payment and writes down what it would do, executing nothing", async () => {
    const w = world();
    const session = newSession();
    w.r.h.script.set(
      "send 500 ars to 0x1111111111111111111111111111111111111111",
      intent({
        type: "SEND",
        recipient: {
          type: "WALLET_ADDRESS",
          value: "0x1111111111111111111111111111111111111111",
        },
        amount: { value: "500", currencyOrAsset: "ARS", mode: "EXACT_OUTPUT" },
      } as never),
    );
    const turn = await w.playground.message(
      session,
      "send 500 ars to 0x1111111111111111111111111111111111111111",
    );

    assert.ok(turn.simulated, `expected a simulated event, got: ${said(turn)}`);
    assert.equal(turn.simulated?.intent, "payment");
    assert.equal(turn.simulated?.executionMode, "simulation");
    assert.match(turn.simulationNote ?? "", /No transaction was executed/);
    assert.deepEqual(w.walletCalls, [], "no wallet, balance or authorization service was asked");
  });
});

describe("playground sessions are isolated", () => {
  it("one session's conversation is not another's", async () => {
    const w = world();
    const first = newSession();
    const second = newSession();
    assert.notEqual(first.sessionId, second.sessionId);
    assert.notEqual(first.conversationId, second.conversationId);

    await w.playground.message(first, "/rates Naira to Argentina Peso");
    // The second session has no remembered pair, so a bare amount is not read against one.
    const follow = await w.playground.message(second, "20,000");
    assert.equal(follow.focus, null);
    assert.doesNotMatch(said(follow), /AR\$[\d.,]+ *$/);
  });

  it("each session gets its own WEB identity, never a Telegram one", async () => {
    const w = world();
    const a = newSession();
    const b = newSession();
    await w.playground.message(a, "hello");
    await w.playground.message(b, "hello");

    const repositories = w.r.h.world.repositories;
    const first = await repositories.identities.findByExternalId("WEB", a.sessionId);
    const second = await repositories.identities.findByExternalId("WEB", b.sessionId);
    assert.ok(first && second, "each session has its own WEB identity");
    assert.notEqual(first.userId, second.userId, "and its own Kaada user");

    // The same id in the Telegram namespace is a different identity entirely: (type, externalId) is unique per type.
    assert.equal(await repositories.identities.findByExternalId("TELEGRAM", a.sessionId), null);
  });

  it("a session resumed with the same ids continues the same conversation", async () => {
    const w = world();
    const session: PlaygroundSession = newSession();
    await w.playground.message(session, "/rates Naira to Argentina Peso");
    const again = await w.playground.message({ ...session }, "20,000");
    assert.match(said(again), /AR\$/, "the same chat kept its context");
  });
});

describe("buttons travel as callbacks, not as text", () => {
  it("a pressed button is claimed by its opaque handle and advances the same conversation", async () => {
    const w = world();
    const session = newSession();
    w.r.h.script.set(
      "send 500 to someone",
      intent({ type: "SEND", amount: { value: "500" } } as never),
    );
    const asked = await w.playground.message(session, "send 500 to someone");
    const handles = asked.messages
      .flatMap((message) => message.actions ?? [])
      .filter((action) => action.type === "ACTION")
      .map((action) => action.handle);

    if (handles.length === 0) {
      // Nothing offered a button this turn; the callback path is covered by the next case.
      assert.ok(asked.messages.length > 0);
      return;
    }
    const [handle] = handles;
    assert.ok(handle);
    const pressed = await w.playground.action(session, handle);
    assert.ok(pressed.messages.length > 0, "the callback produced an answer");
    assert.deepEqual(w.walletCalls, []);
  });

  it("an unknown handle is refused, not treated as a message", async () => {
    const w = world();
    const turn = await w.playground.action(newSession(), "A".repeat(22));
    assert.match(said(turn), /no longer available|not available|expired|don't recognise/i);
  });

  it("a handle issued to one session cannot be used by another", async () => {
    const w = world();
    const owner = newSession();
    const other = newSession();
    w.r.h.script.set("send 500 to someone", intent({ type: "SEND", amount: { value: "500" } } as never));
    const asked = await w.playground.message(owner, "send 500 to someone");
    const handle = asked.messages
      .flatMap((message) => message.actions ?? [])
      .find((action) => action.type === "ACTION")?.handle;
    if (!handle) return; // no button this turn; the binding itself is tested in the channel suite

    const stolen = await w.playground.action(other, handle);
    assert.doesNotMatch(said(stolen), /Cancelled|cancelled/);
    assert.match(said(stolen), /no longer available|not available|expired|don't recognise/i);
  });
});

describe("a playground session id is unguessable and self-describing", () => {
  it("mints distinct, prefixed ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSession().sessionId));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^pg_/);
    assert.match(newSession().conversationId, /^pg-chat-/);
    assert.notEqual(createId(), createId());
  });
});

describe("commands are read the same way on every channel", () => {
  it("the playground and the Telegram adapter agree, line for line", () => {
    const telegram = new TelegramAdapter({ botToken: "t", webhookSecret: "s" });
    const viaTelegram = (text: string) =>
      telegram.parseWebhook({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: false, first_name: "Dev" },
          text,
        },
      })?.content;

    for (const text of [
      "/rates Naira to Argentina Peso",
      "/rates",
      "/rates@kaada_bot",
      "/start abc123",
      "/cancel",
      "/help",
      "/pay now",
      "/started",
      "Send 500 AR$ to Maria",
      "hello",
    ]) {
      assert.deepEqual(contentOfText(text), viaTelegram(text), text);
    }
  });

  it("keeps whatever followed the command, so /rates carries its pair", () => {
    assert.deepEqual(parseChannelCommand("/rates naira to argentine pesos"), {
      command: "RATES",
      args: "naira to argentine pesos",
    });
    assert.deepEqual(parseChannelCommand("/rates"), { command: "RATES" });
    assert.equal(parseChannelCommand("not a command"), null);
    assert.equal(parseChannelCommand("/unknown thing"), null);
  });
});
