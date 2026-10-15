import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import {
  classifyAction,
  classifyInbound,
  classifyText,
  progressText,
} from "../src/core/channels/latency.js";
import type { ChannelCommand } from "../src/core/channels/types.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { describeProgress } from "../src/core/channels/payment-status.js";
import type { CapabilityFlags } from "../src/core/conversation/capabilities.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import type { ConversationWriter } from "../src/core/conversation/presenter.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, createHarness } from "./support/harness.js";

const FLAGS: CapabilityFlags = { send: true, rates: true, balance: true };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SRC = join(new URL("../src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const greeting: AgentResponse = { type: "CHAT", topic: "GREETING", text: "plain" };
const cancelled: AgentResponse = { type: "CANCELLED", text: "Okay, I've cancelled that." };

interface Options {
  agentDelayMs?: number;
  agentFails?: boolean;
  response?: AgentResponse;
  /** How long before a contextual status may appear (the production default is 1.5 s). */
  statusAfterMs?: number;
  withWriter?: boolean;
  drafts?: boolean;
  onboarding?: boolean;
}

/** The whole chat path with a controllable agent, a recording adapter and short timings. */
function build(options: Options = {}) {
  const h = createHarness();
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  adapter.draftsEnabled = options.drafts ?? false;
  const calls = { agent: 0, write: 0, stream: 0 };
  const writer: ConversationWriter | null = options.withWriter
    ? {
        write: () => {
          calls.write += 1;
          return Promise.reject(new Error("model unavailable in this test"));
        },
        stream: () => {
          calls.stream += 1;
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => Promise.resolve({ done: true as const, value: undefined }),
            }),
          };
        },
      }
    : null;
  const service = new ChannelMessageService({
    adapters: new Map([["TELEGRAM", adapter]]),
    identities: new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: h.world.repositories.identities,
    }),
    actions: new ChannelActionService(stores.channelActions),
    inboundEvents: stores.inboundEvents,
    statuses: stores.channelPaymentStatuses,
    agent: {
      handle: async (): Promise<AgentTurnResult> => {
        calls.agent += 1;
        await sleep(options.agentDelayMs ?? 0);
        if (options.agentFails) throw new Error("the agent failed");
        return {
          conversationId: randomUUID(),
          messageId: randomUUID(),
          duplicate: false,
          response: options.response ?? greeting,
        };
      },
    },
    conversation: new ConversationPresenter({ writer, flags: FLAGS, timeoutMs: 1_000 }),
    ...(options.onboarding && {
      onboarding: {
        track: () => Promise.resolve(),
        observe: () => Promise.resolve(),
        claimAnnouncements: () => Promise.resolve([]),
        markDelivered: () => Promise.resolve(),
        release: () => Promise.resolve(),
        stateOf: () =>
          Promise.resolve({
            step: "COMPLETE",
            facts: { walletReady: true, pinConfigured: true, recoveryConfigured: null },
          }),
      } as never,
    }),
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
    activity: { typingEveryMs: 20, statusAfterMs: options.statusAfterMs ?? 80 },
  });
  return { adapter, service, calls };
}

let n = 0;
const say = (text: string, eventId = `sl-${String(++n)}`) => inbound({ eventId, text });
const command = (name: ChannelCommand) => inbound({ eventId: `sl-${String(++n)}`, command: name });
const kinds = (adapter: FakeAdapter) => adapter.log.map((entry) => entry.kind);
const typings = (adapter: FakeAdapter) => adapter.log.filter((entry) => entry.kind === "typing");
const sends = (adapter: FakeAdapter) => adapter.log.filter((entry) => entry.kind === "send");

describe("what Kaada is doing decides what the person sees", () => {
  it("classifies commands, buttons and messages before anything is shown", () => {
    const plan = (text: string) => classifyText(text);
    // Answered from stored state: nothing is shown.
    for (const name of ["START", "HELP", "CANCEL", "FUND", "WALLET", "RATES"] as const) {
      assert.deepEqual(classifyInbound({ kind: "COMMAND", command: name }), {
        class: "INSTANT_DETERMINISTIC",
        typing: false,
      });
    }
    assert.equal(classifyInbound({ kind: "ACTION", handle: "h" }).class, "INSTANT_DETERMINISTIC");
    assert.equal(classifyInbound({ kind: "ACTION", handle: "h" }).typing, false);
    // Real work, each with its own task.
    assert.deepEqual(classifyInbound({ kind: "COMMAND", command: "BALANCE" }), {
      class: "PROVIDER_LOOKUP",
      typing: true,
      progress: "BALANCE",
    });
    assert.equal(plan("What's today's USDT/cNGN rate?").progress, "RATE");
    assert.equal(plan("wARS to USDT").progress, "RATE");
    assert.equal(plan("how much do I have?").progress, "BALANCE");
    assert.equal(plan("Send Daniel 20 USDT").class, "ROUTING_OR_FINANCIAL_COMPUTATION");
    assert.equal(plan("Send Daniel 20 USDT").progress, "PAYMENT");
    assert.equal(plan("find him for me please").progress, "RECIPIENT");
    // Conversation: typing only, never a status.
    for (const text of [
      "Hi",
      "What's up?",
      "How are you?",
      "tell me about stablecoins",
      "back to home",
    ]) {
      assert.deepEqual(plan(text), { class: "FAST_CONVERSATIONAL", typing: true }, text);
    }
  });

  it("a pressed button shows nothing unless it starts real work", () => {
    assert.equal(classifyAction("CANCEL").typing, false);
    assert.equal(classifyAction("SUGGESTION", "FUND_WALLET").typing, false);
    assert.equal(classifyAction("SUGGESTION", "CHECK_BALANCE").progress, "BALANCE");
    assert.equal(classifyAction("CONTINUE_PAYMENT").progress, "ROUTE");
    assert.equal(classifyAction("SELECT_OPTION").progress, "ROUTE");
  });

  it("every status names its task; none is generic", () => {
    assert.equal(progressText("RATE", "x"), "Let me check that rate for you 👀");
    assert.equal(progressText("BALANCE", "x"), "Checking your wallet…");
    assert.equal(progressText("RECIPIENT", "x"), "Let me find them.");
    assert.equal(progressText("PAYMENT", "x"), "Got you. Let me work that out.");
    assert.equal(progressText("ROUTE", "x"), "Let me work out the best route.");
  });

  it('no generic "working on it" loader remains anywhere in the source', () => {
    const banned = /\b(?:working on (?:it|that)|one moment|hang on|please wait|just a sec)\b/i;
    const walk = (folder: string): string[] =>
      readdirSync(folder, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? walk(join(folder, entry.name))
          : entry.name.endsWith(".ts")
            ? [join(folder, entry.name)]
            : [],
      );
    for (const file of walk(SRC)) {
      assert.doesNotMatch(readFileSync(file, "utf8"), banned, file);
    }
  });
});

describe("instant interactions show nothing", () => {
  it("/start answers at once: no typing, no loader, and the model is never asked", async () => {
    const { adapter, service, calls } = build({ withWriter: true, agentDelayMs: 300 });
    await service.handleInbound(command("START"));
    assert.deepEqual(kinds(adapter), ["send"]);
    assert.equal(calls.agent, 0);
    assert.equal(calls.write + calls.stream, 0);
  });

  it("/start for a known person uses fixed wording and never waits on the model", async () => {
    const { adapter, service, calls } = build({ withWriter: true, onboarding: true });
    await service.handleInbound(command("START"));
    assert.deepEqual(kinds(adapter), ["send"]);
    assert.equal(
      calls.write + calls.stream,
      0,
      "the model is not involved in the first impression",
    );
    assert.ok((adapter.sent[0]?.text ?? "").length > 0);
  });

  it("/cancel is answered at once, even if the work behind it were slow: no typing, no loader", async () => {
    const { adapter, service, calls } = build({
      response: cancelled,
      withWriter: true,
      agentDelayMs: 300,
    });
    await service.handleInbound(command("CANCEL"));
    assert.deepEqual(kinds(adapter), ["send"]);
    assert.equal(calls.write + calls.stream, 0, "no model for a cancellation");
    assert.match(adapter.sent[0]?.text ?? "", /cancel/i);
  });

  it("a button that no longer exists is answered at once with nothing shown", async () => {
    const { adapter, service } = build();
    await service.handleInbound(inbound({ eventId: `sl-${String(++n)}`, action: "gone" }));
    assert.ok(!kinds(adapter).includes("typing"));
    assert.equal(sends(adapter).length, 1);
  });
});

describe("conversation shows typing only", () => {
  it("a casual greeting gets typing and never a status, however slow the reply is", async () => {
    const { adapter, service } = build({ agentDelayMs: 300, statusAfterMs: 80 });
    await service.handleInbound(say("How are you?"));
    assert.ok(typings(adapter).length >= 1, "typing is shown");
    assert.equal(sends(adapter).length, 1, "only the answer: nothing to 'work on'");
    assert.ok(!kinds(adapter).includes("remove"));
  });

  it("a quick lookup never flashes its status", async () => {
    const { adapter, service } = build({ agentDelayMs: 5, statusAfterMs: 1_500 });
    await service.handleInbound(say("What's today's USDT/cNGN rate?"));
    assert.equal(sends(adapter).length, 1);
    assert.ok(!kinds(adapter).includes("remove"));
  });
});

describe("real work gets a status that says what it is, only when slow", () => {
  const cases: [string, string, RegExp][] = [
    ["a rate lookup", "What's today's USDT/cNGN rate?", /^Let me check that rate for you 👀$/],
    ["a balance lookup", "What's my balance?", /^Checking your wallet…$/],
    ["preparing a payment", "Send Daniel 20 USDT", /^Got you\. Let me work that out\.$/],
    ["a recipient search", "find him for me", /^Let me find them\.$/],
  ];
  for (const [name, text, expected] of cases) {
    it(`${name}: one contextual status, removed BEFORE the answer is shown`, async () => {
      const { adapter, service } = build({ agentDelayMs: 300 });
      await service.handleInbound(say(text));
      const [status, answer] = sends(adapter);
      assert.equal(sends(adapter).length, 2, "the status, then the answer (never a cycle)");
      assert.match(status?.message?.text ?? "", expected);
      const removed = adapter.log.find((entry) => entry.kind === "remove");
      assert.equal(
        removed?.externalMessageId,
        status?.externalMessageId,
        "the status is cleaned up",
      );
      assert.ok(
        (removed?.at ?? Infinity) <= (answer?.at ?? 0),
        "it is gone before the answer appears, so it never sits above it",
      );
    });
  }

  it("/balance, which reads the wallet, shows the wallet status when slow", async () => {
    const { adapter, service } = build({ agentDelayMs: 300 });
    await service.handleInbound(command("BALANCE"));
    assert.match(sends(adapter)[0]?.message?.text ?? "", /^Checking your wallet…$/);
  });

  it("a failure or timeout removes the status and nothing is left stuck", async () => {
    const { adapter, service } = build({ agentDelayMs: 300, agentFails: true });
    await assert.rejects(
      service.handleInbound(say("What's the USDT/cNGN rate?")),
      /the agent failed/,
    );
    const status = sends(adapter)[0];
    assert.ok(status, "the status was shown while it was slow");
    assert.equal(
      adapter.log.find((entry) => entry.kind === "remove")?.externalMessageId,
      status.externalMessageId,
    );
    const typingAfter = typings(adapter).length;
    await sleep(80);
    assert.equal(typings(adapter).length, typingAfter, "typing stopped too");
  });

  it("a duplicate delivery adds no second loader", async () => {
    const { adapter, service, calls } = build({ agentDelayMs: 250 });
    const update = say("What's the USDT/cNGN rate?", "sl-dup");
    await Promise.allSettled([service.handleInbound(update), service.handleInbound(update)]);
    await service.handleInbound(update);
    assert.equal(calls.agent, 1);
    assert.equal(sends(adapter).length, 2, "one status and one answer, once");
  });
});

describe("what is financial is never streamed", () => {
  it("a balance is shown only once the application has it: the model is not asked to stream it", async () => {
    const response: AgentResponse = {
      type: "BALANCE_RESULT",
      lines: [{ symbol: "cNGN", display: "1,000" }],
      text: "Your balance:\n• 1,000 cNGN",
    };
    const { adapter, service, calls } = build({ response, withWriter: true, drafts: true });
    await service.handleInbound(say("What's my balance?"));
    assert.equal(calls.stream, 0);
    assert.equal(adapter.drafts[0]?.updates.length ?? 0, 0);
    assert.match(adapter.sent[adapter.sent.length - 1]?.text ?? "", /1,000 cNGN/);
  });
});

describe("a payment in progress is the persistent, trusted status", () => {
  it("its wording comes only from state: processing, confirming, then sent", () => {
    assert.equal(describeProgress({ state: "PROCESSING" }), "Processing your payment…");
    assert.match(describeProgress({ state: "PENDING" }), /^Confirming your payment…/);
    assert.match(describeProgress({ state: "COMPLETED" }), /✅/);
    const source = readFileSync(join(SRC, "core/channels/payment-status.ts"), "utf8");
    assert.ok(!/openDraft|\.stream\(|sendMessageDraft|progressText/.test(source));
  });
});
