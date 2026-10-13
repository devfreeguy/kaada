import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import type { ExecutionPlanRecord } from "@kaada/domain";

import {
  PaymentStatusDispatcher,
  deriveProgress,
  describeProgress,
  isTerminalProgress,
} from "../src/core/channels/payment-status.js";
import type { PaymentFacts, PaymentProgress } from "../src/core/channels/payment-status.js";
import { FakeAdapter, createMemoryChannelStores } from "./support/channels-memory.js";

const NOW = new Date("2026-10-22T12:00:00Z");
const later = new Date(NOW.getTime() + 300_000);
const plan = (status: ExecutionPlanRecord["status"], failureCode?: string) =>
  ({ status, ...(failureCode && { failureCode }) }) as ExecutionPlanRecord;

const pending = (over: Partial<PaymentFacts> = {}): PaymentFacts => ({
  session: { status: "PENDING", expiresAt: later },
  authorized: false,
  plan: null,
  ...over,
});
const authorized = (
  record: ExecutionPlanRecord | null,
  over: Partial<PaymentFacts> = {},
): PaymentFacts => ({
  session: { status: "AUTHORIZED", expiresAt: later },
  authorized: true,
  plan: record,
  ...over,
});

describe("deriveProgress", () => {
  const cases: [string, PaymentFacts, PaymentProgress][] = [
    ["waiting for the PIN", pending(), { state: "AWAITING_AUTHORIZATION" }],
    [
      "the session ran out",
      pending({ session: { status: "PENDING", expiresAt: NOW } }),
      { state: "AUTHORIZATION_EXPIRED" },
    ],
    [
      "the session was marked expired",
      pending({ session: { status: "EXPIRED", expiresAt: later } }),
      { state: "AUTHORIZATION_EXPIRED" },
    ],
    [
      "the session was cancelled",
      pending({ session: { status: "CANCELLED", expiresAt: later } }),
      { state: "AUTHORIZATION_CANCELLED" },
    ],
    ["the session is gone", pending({ session: null }), { state: "AUTHORIZATION_CANCELLED" }],
    ["authorized, nothing prepared yet", authorized(null), { state: "PREPARING" }],
    [
      "root action needed",
      authorized(plan("REQUIRES_USER_ACTION")),
      { state: "ROOT_ACTION_REQUIRED" },
    ],
    ["signing", authorized(plan("SIGNING")), { state: "PROCESSING" }],
    ["submitted", authorized(plan("SUBMITTED")), { state: "PROCESSING" }],
    ["settling", authorized(plan("SETTLING")), { state: "PENDING" }],
    ["completed", authorized(plan("COMPLETED")), { state: "COMPLETED" }],
    ["failed", authorized(plan("FAILED", "REVERTED")), { state: "FAILED", code: "REVERTED" }],
    [
      "expired after authorization",
      authorized(plan("EXPIRED")),
      { state: "REAUTHORIZATION_REQUIRED" },
    ],
  ];
  for (const [name, facts, expected] of cases) {
    it(name, () => assert.deepEqual(deriveProgress(facts, NOW), expected));
  }

  it("an ambiguous outcome is 'pending', never 'failed', and the words never say to retry", () => {
    const progress = deriveProgress(authorized(plan("SETTLING")), NOW);
    assert.equal(progress.state, "PENDING");
    const words = describeProgress(progress);
    assert.match(words, /still confirming/);
    assert.match(words, /please don't send it again/);
    assert.doesNotMatch(words, /try again|retry/i);
  });

  it("a payment is only ever 'sent' when the record says COMPLETED", () => {
    for (const status of [
      "READY",
      "PREPARING",
      "SIGNING",
      "SUBMITTING",
      "SUBMITTED",
      "SETTLING",
    ] as const) {
      assert.notEqual(deriveProgress(authorized(plan(status)), NOW).state, "COMPLETED", status);
    }
  });

  it("knows which states end the story", () => {
    assert.equal(isTerminalProgress("COMPLETED"), true);
    assert.equal(isTerminalProgress("FAILED"), true);
    assert.equal(isTerminalProgress("PENDING"), false);
    assert.equal(isTerminalProgress("PROCESSING"), false);
    assert.equal(isTerminalProgress("ROOT_ACTION_REQUIRED"), false);
    assert.equal(isTerminalProgress("AWAITING_AUTHORIZATION"), false);
  });
});

describe("PaymentStatusDispatcher", () => {
  function build() {
    const stores = createMemoryChannelStores(() => NOW);
    const adapter = new FakeAdapter();
    let facts: PaymentFacts = pending();
    const rootLinks: string[] = [];
    const dispatcher = new PaymentStatusDispatcher({
      statuses: stores.channelPaymentStatuses,
      facts: { read: () => Promise.resolve(facts) },
      adapters: new Map([["TELEGRAM", adapter]]),
      rootActionLink: (sessionId) => {
        rootLinks.push(sessionId);
        return Promise.resolve("https://app.kaada.test/root-action/TOKEN");
      },
      now: () => NOW,
    });
    return {
      stores,
      adapter,
      dispatcher,
      rootLinks,
      set: (next: PaymentFacts) => (facts = next),
    };
  }
  const track = async (ctx: ReturnType<typeof build>) => {
    const sessionId = randomUUID();
    await ctx.stores.channelPaymentStatuses.create({
      id: randomUUID(),
      userId: randomUUID(),
      channel: "TELEGRAM",
      externalConversationId: "424242",
      authorizationSessionId: sessionId,
      externalSummaryMessageId: "50",
      lastState: "AWAITING_AUTHORIZATION",
      terminal: false,
    });
    return sessionId;
  };

  it("announces nothing while the payment still waits for the PIN", async () => {
    const ctx = build();
    await track(ctx);
    assert.deepEqual(await ctx.dispatcher.sweep(), { examined: 1, announced: 0 });
    assert.equal(ctx.adapter.log.length, 0);
  });

  it("sends ONE status message when authorized, then edits it as the payment moves to 'sent'", async () => {
    const ctx = build();
    await track(ctx);
    ctx.set(authorized(null));
    await ctx.dispatcher.sweep();
    assert.equal(ctx.adapter.sent.length, 1);
    assert.match(ctx.adapter.sent[0]?.text ?? "", /Confirming the final price/);
    const messageId = ctx.adapter.log.find((l) => l.kind === "send")?.externalMessageId;

    ctx.set(authorized(plan("SIGNING")));
    await ctx.dispatcher.sweep();
    ctx.set(authorized(plan("SETTLING")));
    await ctx.dispatcher.sweep();
    ctx.set(authorized(plan("COMPLETED")));
    await ctx.dispatcher.sweep();

    assert.equal(ctx.adapter.sent.length, 1, "no new message per step");
    const edits = ctx.adapter.log.filter((l) => l.kind === "update");
    assert.deepEqual(
      edits.map((e) => e.externalMessageId),
      [messageId, messageId, messageId],
    );
    assert.match(edits[0]?.message?.text ?? "", /Processing your payment/);
    assert.match(edits[1]?.message?.text ?? "", /still confirming/);
    assert.match(edits[2]?.message?.text ?? "", /Payment sent ✅/);
  });

  it("does not repeat an announcement on further sweeps, and stops watching a finished payment", async () => {
    const ctx = build();
    await track(ctx);
    ctx.set(authorized(plan("COMPLETED")));
    await ctx.dispatcher.sweep();
    const count = ctx.adapter.log.length;
    assert.deepEqual(await ctx.dispatcher.sweep(), { examined: 0, announced: 0 });
    assert.equal(ctx.adapter.log.length, count);
  });

  it("two dispatchers (two instances) announce one change exactly once", async () => {
    const ctx = build();
    await track(ctx);
    ctx.set(authorized(plan("COMPLETED")));
    const other = new PaymentStatusDispatcher({
      statuses: ctx.stores.channelPaymentStatuses,
      facts: { read: () => Promise.resolve(authorized(plan("COMPLETED"))) },
      adapters: new Map([["TELEGRAM", ctx.adapter]]),
      now: () => NOW,
    });
    await Promise.all([ctx.dispatcher.sweep(), other.sweep(), ctx.dispatcher.sweep()]);
    assert.equal(ctx.adapter.sent.length, 1);
  });

  it("a failed send puts the claim back so the next pass tells the person", async () => {
    const ctx = build();
    await track(ctx);
    ctx.set(authorized(plan("COMPLETED")));
    ctx.adapter.failNextSend = true;
    assert.deepEqual(await ctx.dispatcher.sweep(), { examined: 1, announced: 0 });
    assert.equal(ctx.adapter.sent.length, 0);
    assert.deepEqual(await ctx.dispatcher.sweep(), { examined: 1, announced: 1 });
    assert.match(ctx.adapter.last?.text ?? "", /Payment sent/);
  });

  it("a root step comes with a secure 'Continue securely' link, issued only when announced", async () => {
    const ctx = build();
    const sessionId = await track(ctx);
    ctx.set(authorized(plan("REQUIRES_USER_ACTION")));
    await ctx.dispatcher.sweep();
    await ctx.dispatcher.sweep();
    assert.deepEqual(ctx.rootLinks, [sessionId]);
    const action = ctx.adapter.last?.actions?.[0];
    assert.equal(action?.type, "OPEN_URL");
    assert.equal(action?.type === "OPEN_URL" && action.semantic, "OPEN_ROOT_ACTION");
    assert.match(ctx.adapter.last?.text ?? "", /One security step is needed/);
  });

  it("an expired authorization replaces the summary, so its button is no longer offered", async () => {
    const ctx = build();
    await track(ctx);
    ctx.set(pending({ session: { status: "EXPIRED", expiresAt: NOW } }));
    await ctx.dispatcher.sweep();
    const edit = ctx.adapter.log.find((l) => l.kind === "update");
    assert.equal(edit?.externalMessageId, "50");
    assert.equal(edit?.message?.actions, undefined);
    assert.match(edit?.message?.text ?? "", /wasn't confirmed in time/);
  });

  it("covers every failure the person can meet, in plain words", () => {
    const states: PaymentProgress[] = [
      { state: "FAILED", code: "REVERTED" },
      { state: "INSUFFICIENT_BALANCE" },
      { state: "REAUTHORIZATION_REQUIRED" },
      { state: "GAS_FUNDING_REQUIRED" },
      { state: "NO_ROUTE" },
    ];
    for (const progress of states) {
      const words = describeProgress(progress);
      assert.ok(words.length > 20);
      assert.doesNotMatch(words, /0x[0-9a-f]{8}|stack|undefined|Error:/i);
    }
    assert.match(describeProgress({ state: "FAILED", code: "REVERTED" }), /Reference: REVERTED/);
  });
});
