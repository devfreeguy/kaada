import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { OnboardingAnnouncer } from "../src/core/channels/onboarding-announcer.js";
import type { OutboundChannelMessage } from "../src/core/channels/types.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { OnboardingLifecycleService } from "../src/core/onboarding/lifecycle-service.js";
import type { OnboardingFacts } from "../src/core/onboarding/state.js";
import {
  FakeAdapter,
  createMemoryChannelStores,
  createMemoryUserNotifications,
  inbound,
} from "./support/channels-memory.js";
import { SENDER, createHarness } from "./support/harness.js";

const QUESTION = /where will you mainly use Kaada\?/i;

/** The onboarding deployment with a profile store, so the country step is live. */
function world(options: { home?: { country: string; currency: string } } = {}) {
  const h = createHarness();
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  const facts: OnboardingFacts = {
    walletReady: false,
    pinConfigured: false,
    walletFunded: true,
    recoveryConfigured: null,
  };
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  const lifecycle = new OnboardingLifecycleService({
    notifications: createMemoryUserNotifications(),
    state: { read: () => Promise.resolve({ ...facts }) },
    policy: { requireRecovery: false },
  });
  const profile: { country?: string; currency?: string } = { ...(options.home ?? {}) };
  const service = new ChannelMessageService({
    adapters: new Map([["TELEGRAM", adapter]]),
    identities: new ChannelIdentityService({
      users: h.world.repositories.users,
      identities: h.world.repositories.identities,
    }),
    actions: new ChannelActionService(stores.channelActions),
    inboundEvents: stores.inboundEvents,
    statuses: stores.channelPaymentStatuses,
    agent: { handle: (input) => h.agent.handle(input) },
    conversation: new ConversationPresenter({
      writer: null,
      flags: {
        send: true,
        rates: true,
        balance: true,
        funding: { walletTransfer: true, localCurrency: false },
      },
      timeoutMs: 200,
    }),
    onboarding: lifecycle,
    linked: h.world.repositories.identities,
    profile: {
      get: () => Promise.resolve({ ...profile }),
      set: (_userId: string, home: { country: string; currency: string | null }) => {
        profile.country = home.country;
        if (home.currency) profile.currency = home.currency;
        else delete profile.currency;
        return Promise.resolve();
      },
    },
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(facts.walletReady) },
    facts: { read: () => Promise.reject(new Error("unused")) },
  });
  const sweep = () =>
    new OnboardingAnnouncer({ lifecycle, announce: (a) => service.announceOnboarding(a) }).sweep();
  return { adapter, facts, service, sweep, profile };
}

let n = 0;
const start = () => inbound({ eventId: `oc-${String(++n)}`, command: "START" });
const press = (handle: string) => inbound({ eventId: `oc-${String(++n)}`, action: handle });
const asked = (adapter: FakeAdapter) =>
  adapter.sent.filter((m) => QUESTION.test(m.text ?? "")).length;
const handleOf = (message: OutboundChannelMessage | undefined, label: string) => {
  const found = (message?.actions ?? []).find((a) => "label" in a && a.label === label);
  return found && "handle" in found ? found.handle : undefined;
};
const labels = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).map((a) => ("label" in a ? a.label : ""));
const finish = (facts: OnboardingFacts) => {
  facts.walletReady = true;
  facts.pinConfigured = true;
};

describe("the country question comes after secure onboarding", () => {
  it("is not asked right after /start, nor while the wallet or PIN is unfinished", async () => {
    const w = world();
    await w.service.handleInbound(start());
    assert.equal(asked(w.adapter), 0);

    w.facts.walletReady = true;
    await w.sweep();
    await w.service.handleInbound(start());
    assert.equal(asked(w.adapter), 0, "wallet ready, PIN still missing");
  });

  it("is asked once setup completes asynchronously, with the account-ready copy and a button per country", async () => {
    const w = world();
    await w.service.handleInbound(start());
    finish(w.facts);
    await w.sweep();
    const prompt = w.adapter.sent.at(-1);
    assert.match(prompt?.text ?? "", /Your Kaada account is ready ✅/);
    assert.match(prompt?.text ?? "", QUESTION);
    assert.deepEqual(labels(prompt), [
      "🇳🇬 Nigeria",
      "🇧🇷 Brazil",
      "🇦🇷 Argentina",
      "🇮🇩 Indonesia",
      "🌍 Other",
    ]);
    assert.equal(asked(w.adapter), 1);

    await w.sweep();
    assert.equal(asked(w.adapter), 1, "the same completion is not announced twice");
  });

  it("a completed person with no country resumes at the country step on /start", async () => {
    const w = world();
    finish(w.facts);
    await w.service.handleInbound(start());
    assert.equal(asked(w.adapter), 1);
    assert.match(w.adapter.sent.at(-1)?.text ?? "", /Your Kaada account is ready ✅/);
  });

  it("a person who already has a country is never asked", async () => {
    const w = world({ home: { country: "NG", currency: "NGN" } });
    finish(w.facts);
    await w.service.handleInbound(start());
    await w.sweep();
    assert.equal(asked(w.adapter), 0);
  });

  it("choosing a country saves country and currency, confirms the default, shows first-use actions, and is not asked again", async () => {
    const w = world();
    finish(w.facts);
    await w.service.handleInbound(start());
    const nigeria = handleOf(w.adapter.sent.at(-1), "🇳🇬 Nigeria");
    assert.ok(nigeria);
    await w.service.handleInbound(press(nigeria));

    assert.deepEqual([w.profile.country, w.profile.currency], ["NG", "NGN"]);
    const confirmation = w.adapter.sent.at(-1);
    assert.equal(confirmation?.text, "Nigeria 🇳🇬\nYour default currency is Nigerian Naira (₦).");
    assert.equal(labels(confirmation).length, 4, "fund, send, balance and rates");

    const before = asked(w.adapter);
    await w.service.handleInbound(start());
    await w.sweep();
    assert.equal(asked(w.adapter), before, "not asked twice");
  });
});

describe("first-use actions follow only a first real choice", () => {
  it("changing country, choosing Other, or pressing again shows no first-use buttons", async () => {
    const w = world({ home: { country: "NG", currency: "NGN" } });
    finish(w.facts);
    await w.service.handleInbound(inbound({ eventId: `oc-${String(++n)}`, command: "COUNTRY" }));
    const brazil = handleOf(w.adapter.sent.at(-1), "🇧🇷 Brazil");
    assert.ok(brazil);
    await w.service.handleInbound(press(brazil));
    assert.deepEqual([w.profile.country, w.profile.currency], ["BR", "BRL"]);
    assert.equal(labels(w.adapter.sent.at(-1)).length, 0, "a later change is not onboarding");
  });

  it("choosing Other as the first answer records no currency and offers no buttons", async () => {
    const w = world();
    finish(w.facts);
    await w.service.handleInbound(start());
    const other = handleOf(w.adapter.sent.at(-1), "🌍 Other");
    assert.ok(other);
    await w.service.handleInbound(press(other));
    assert.deepEqual([w.profile.country, w.profile.currency], ["ZZ", undefined]);
    assert.equal(labels(w.adapter.sent.at(-1)).length, 0);
  });
});
