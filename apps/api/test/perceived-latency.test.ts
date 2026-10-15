import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { CapabilityFlags } from "../src/core/conversation/capabilities.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import type { ConversationWriter } from "../src/core/conversation/presenter.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import {
  TelegramAdapter,
  TelegramApiError,
  TelegramDraft,
} from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, createHarness } from "./support/harness.js";

const FLAGS: CapabilityFlags = { send: true, rates: true, balance: true };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const greeting: AgentResponse = { type: "CHAT", topic: "GREETING", text: "plain" };

interface Options {
  agentDelayMs?: number;
  /** How long before the temporary status shows (generous where the test is about it NOT showing). */
  slowAfterMs?: number;
  agentFails?: boolean;
  response?: AgentResponse;
  writer?: ConversationWriter | null;
  drafts?: boolean;
}

/** The whole chat path with a controllable agent, a recording adapter and short timings. */
function build(options: Options = {}) {
  const h = createHarness();
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  adapter.draftsEnabled = options.drafts ?? false;
  let agentCalls = 0;
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
        agentCalls += 1;
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
    conversation: new ConversationPresenter({
      writer: options.writer ?? null,
      flags: FLAGS,
      timeoutMs: 1_000,
    }),
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
    // Short timings: the behaviour is the same, the test does not wait for real seconds.
    activity: { typingEveryMs: 20, statusAfterMs: options.slowAfterMs ?? 80 },
  });
  return { adapter, service, agentCalls: () => agentCalls };
}

let n = 0;
const say = (text = "hi", eventId = `pl-${String(++n)}`) => inbound({ eventId, text });
const kinds = (adapter: FakeAdapter) => adapter.log.map((entry) => entry.kind);
const finalText = (adapter: FakeAdapter) => adapter.sent[adapter.sent.length - 1]?.text ?? "";

/** A model that streams `chunks` as plain text, `gapMs` apart. */
function streamingWriter(chunks: string[], gapMs = 0, failAfter?: number): ConversationWriter {
  return {
    write: () => Promise.reject(new Error("the structured reply is not used when streaming")),
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        for (const [index, chunk] of chunks.entries()) {
          if (failAfter !== undefined && index === failAfter) throw new Error("stream broke");
          if (gapMs) await sleep(gapMs);
          yield chunk;
        }
      },
    }),
  };
}

describe("immediate feedback", () => {
  it("typing starts the moment the message is ours, before the work is done, and is renewed while it lasts", async () => {
    const { adapter, service } = build({ agentDelayMs: 100 });
    const started = Date.now();
    await service.handleInbound(say());
    const typing = adapter.log.filter((entry) => entry.kind === "typing");
    assert.ok(typing.length >= 3, `typing was renewed while waiting (${String(typing.length)})`);
    assert.ok((typing[0]?.at ?? Infinity) - started < 250, "the first typing signal is immediate");
    const reply = adapter.log.find((entry) => entry.kind === "send");
    assert.ok((typing[0]?.at ?? 0) < (reply?.at ?? 0), "typing came before the reply");
  });

  it("a fast reply is just sent: no pointless loader flashes up", async () => {
    const { adapter, service } = build({ agentDelayMs: 5, slowAfterMs: 1_500 });
    await service.handleInbound(say());
    assert.equal(adapter.sent.length, 1, "only the answer");
    assert.ok(!kinds(adapter).includes("remove"), "nothing to take away again");
  });

  it("a slow reply gets ONE temporary status, which is removed when the answer arrives", async () => {
    const { adapter, service } = build({ agentDelayMs: 300 });
    await service.handleInbound(say("what's the USDT to NGN rate?"));
    const sends = adapter.log.filter((entry) => entry.kind === "send");
    assert.equal(sends.length, 2, "the status, then the answer (never a cycle of statuses)");
    assert.match(sends[0]?.message?.text ?? "", /Let me check that rate for you 👀/);
    const removed = adapter.log.find((entry) => entry.kind === "remove");
    assert.equal(
      removed?.externalMessageId,
      sends[0]?.externalMessageId,
      "the status is cleaned up",
    );
    assert.ok((removed?.at ?? Infinity) <= (sends[1]?.at ?? 0), "gone before the answer is shown");
  });

  it("typing stops when the work ends, even if it failed, and no status is left behind", async () => {
    const { adapter, service } = build({ agentDelayMs: 150, agentFails: true });
    await assert.rejects(
      service.handleInbound(say("what's the USDT to NGN rate?")),
      /the agent failed/,
    );
    const sends = adapter.log.filter((entry) => entry.kind === "send");
    assert.equal(sends.length, 1, "the slow-status appeared once");
    assert.ok(
      adapter.log.some((entry) => entry.kind === "remove"),
      "and was removed again",
    );
    const typingAfter = adapter.log.filter((entry) => entry.kind === "typing").length;
    await sleep(100);
    assert.equal(
      adapter.log.filter((entry) => entry.kind === "typing").length,
      typingAfter,
      "no more typing after the failure",
    );
  });

  it("a duplicate delivery shows no activity and starts nothing", async () => {
    const { adapter, service, agentCalls } = build({ agentDelayMs: 40, drafts: true });
    const update = say("hi", "pl-dup");
    await Promise.allSettled([service.handleInbound(update), service.handleInbound(update)]);
    await service.handleInbound(update);
    assert.equal(agentCalls(), 1);
    assert.equal(adapter.sent.length, 1);
    assert.ok(adapter.drafts.length <= 1, "never two streams for one message");
  });
});

describe("a conversational reply streams, and ends as the final message", () => {
  it("shows partial text as it is written, never a different text from the final one", async () => {
    const chunks = ["Hey 👋 ", "What can ", "I help you ", "with today? ", "I can send money."];
    const { adapter, service } = build({
      drafts: true,
      slowAfterMs: 3_000,
      writer: streamingWriter(chunks, 30),
    });
    await service.handleInbound(say());
    const draft = adapter.drafts[0];
    assert.ok(draft && draft.updates.length > 0, "something was shown while it was written");
    const final = finalText(adapter);
    for (const shown of draft.updates) {
      assert.ok(final.startsWith(shown), `"${shown}" is the start of the final reply`);
    }
    assert.ok(draft.closed, "the draft is closed");
    assert.equal(adapter.sent.length, 1, "no temporary status: the text itself is the activity");
    assert.match(final, /^Hey 👋 What can I help you with today\?/);
  });

  it("a reply that streams for longer than the slow threshold still gets no extra status", async () => {
    const { adapter, service } = build({
      drafts: true,
      slowAfterMs: 3_000,
      writer: streamingWriter(["Hey ", "there! ", "What ", "do ", "you ", "need? "], 40),
    });
    await service.handleInbound(say());
    assert.equal(adapter.sent.length, 1);
    assert.ok(!kinds(adapter).includes("remove"));
  });

  it("no figure, outcome or secret ever reaches the draft: a streamed chunk that fails the screen stops the stream", async () => {
    for (const bad of [
      ["Sure, ", "you can ", "send ", "5000 ", "USDT ", "now."],
      ["Your ", "payment ", "succeeded ", "already. "],
      ["Visit ", "https://evil.example ", "now? "],
    ]) {
      const { adapter, service } = build({
        drafts: true,
        slowAfterMs: 3_000,
        writer: streamingWriter(bad, 5),
      });
      await service.handleInbound(say());
      const everything = (adapter.drafts[0]?.updates ?? []).join(" | ");
      assert.doesNotMatch(everything, /5000|succeeded|https?:/, `never shown: ${bad.join("")}`);
      assert.ok(adapter.drafts[0]?.closed);
      assert.doesNotMatch(finalText(adapter), /5000|succeeded|https?:/);
      assert.ok(finalText(adapter).length > 0, "the person still gets a reply (the fixed wording)");
    }
  });

  it("a stream that breaks midway is cleaned up and the fixed wording is sent", async () => {
    const { adapter, service } = build({
      drafts: true,
      slowAfterMs: 3_000,
      writer: streamingWriter(["Hey ", "there! ", "What ", "now? "], 10, 2),
    });
    await service.handleInbound(say());
    assert.ok(adapter.drafts[0]?.closed);
    assert.equal(adapter.sent.length, 1);
    assert.match(finalText(adapter), /^(Hey|Hi)/, "the deterministic greeting");
    assert.ok(!kinds(adapter).includes("remove"));
  });

  it("a channel without drafts is unaffected: the reply appears whole", async () => {
    const { adapter, service } = build({
      drafts: false,
      writer: streamingWriter(["Hey ", "there! ", "What ", "do ", "you ", "need? "]),
    });
    await service.handleInbound(say());
    assert.equal(adapter.drafts.length, 0);
    assert.equal(adapter.sent.length, 1);
  });

  it("nothing financial is streamed: rates, balances, summaries and statuses appear only once the application has them", async () => {
    let streamed = 0;
    const writer: ConversationWriter = {
      write: () =>
        Promise.resolve({
          acknowledgement: "Here's the latest I've got 💱",
          body: null,
          question: null,
          closing: null,
          suggestedActionIds: [],
        }),
      stream: () => {
        streamed += 1;
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => Promise.resolve({ done: true as const, value: undefined }),
          }),
        };
      },
    };
    const rate: AgentResponse = {
      type: "QUOTE_RESULT",
      text: "1 USDT currently gives approximately 1499.85 cNGN.",
      intentId: randomUUID(),
      revision: 1,
      routeId: randomUUID(),
      source: { amount: "1", assetId: "a", symbol: "USDT", display: "1 USDT" },
      destination: { amount: "1", assetId: "b", symbol: "cNGN", display: "1499.85 cNGN" },
      fees: [],
      slippageBps: 0,
      expiresAt: new Date().toISOString(),
      route: { hops: [] },
    };
    const { adapter, service } = build({ drafts: true, writer, response: rate });
    await service.handleInbound(say());
    assert.equal(streamed, 0, "the writer was never asked to stream a financial answer");
    assert.equal(adapter.drafts[0]?.updates.length ?? 0, 0);
    assert.match(finalText(adapter), /1499\.85 cNGN/);
  });

  it("payment progress stays on the deterministic status-message path: no drafts, no streaming", () => {
    const status = readFileSync(
      new URL("../src/core/channels/payment-status.ts", import.meta.url),
      "utf8",
    );
    assert.ok(!/openDraft|stream\(|sendMessageDraft/.test(status));
    const execution = readFileSync(
      new URL("../src/core/execution/runner.ts", import.meta.url),
      "utf8",
    );
    assert.ok(!/openDraft|sendMessageDraft/.test(execution));
  });
});

describe("Telegram's live draft", () => {
  it("coalesces rapid updates, never exceeds its limits, and ends with the latest text", async () => {
    const sent: string[] = [];
    const draft = new TelegramDraft(
      (text) => {
        sent.push(text);
        return Promise.resolve();
      },
      { minIntervalMs: 40, maxUpdates: 5 },
    );
    const started = Date.now();
    for (let i = 1; i <= 200; i += 1) {
      draft.update(`word ${"x".repeat(i)}`);
      await sleep(1);
    }
    await sleep(120);
    await draft.close();
    const elapsed = Date.now() - started;
    assert.ok(sent.length <= 5, `at most 5 updates (${String(sent.length)})`);
    assert.ok(sent.length <= Math.ceil(elapsed / 40) + 1, "never faster than the interval");
    assert.ok(sent.length < 200, "a fast generator cannot flood the channel");
  });

  it("stops quietly after a flood-wait or any error, and close() cancels what is pending", async () => {
    let calls = 0;
    const flooded = new TelegramDraft(
      () => {
        calls += 1;
        return Promise.reject(
          new TelegramApiError("sendMessageDraft", 429, "Too Many Requests", 3),
        );
      },
      { minIntervalMs: 5, maxUpdates: 24 },
    );
    flooded.update("a");
    await sleep(30);
    flooded.update("ab");
    flooded.update("abc");
    await sleep(40);
    await flooded.close();
    assert.equal(calls, 1, "no further attempts after a 429");

    let pending = 0;
    const closed = new TelegramDraft(
      () => {
        pending += 1;
        return Promise.resolve();
      },
      { minIntervalMs: 200, maxUpdates: 24 },
    );
    closed.update("one");
    await sleep(5);
    closed.update("two");
    await closed.close();
    await sleep(250);
    assert.ok(pending <= 1, "the pending update was cancelled by close()");
  });

  it("uses sendMessageDraft with ONE draft id and the private chat, and sendChatAction for typing", async () => {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    const adapter = new TelegramAdapter({
      botToken: "1:TOKEN",
      draftIntervalMs: 5,
      fetch: ((url: string, init: { body: string }) => {
        calls.push({
          method: url.split("/").pop() ?? "",
          body: JSON.parse(init.body) as Record<string, unknown>,
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true, result: true })));
      }) as unknown as typeof fetch,
    });
    await adapter.indicateTyping({ externalConversationId: "5" });
    const draft = adapter.openDraft({ externalConversationId: "5" });
    assert.ok(draft);
    draft.update("Hey");
    await sleep(30);
    draft.update("Hey there");
    await sleep(30);
    await draft.close();
    assert.equal(calls[0]?.method, "sendChatAction");
    assert.equal(calls[0]?.body["action"], "typing");
    const drafts = calls.filter((c) => c.method === "sendMessageDraft");
    assert.ok(drafts.length >= 2);
    assert.equal(
      new Set(drafts.map((c) => c.body["draft_id"])).size,
      1,
      "updates animate ONE draft",
    );
    assert.ok(
      drafts.every((c) => c.body["chat_id"] === "5" && typeof c.body["draft_id"] === "number"),
    );
    assert.equal(drafts.at(-1)?.body["text"], "Hey there");
  });
});
