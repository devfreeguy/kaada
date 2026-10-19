import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { OnboardingAnnouncer } from "../src/core/channels/onboarding-announcer.js";
import type { OutboundAction, OutboundChannelMessage } from "../src/core/channels/types.js";
import type { CapabilityFlags } from "../src/core/conversation/capabilities.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import type { ConversationWriter } from "../src/core/conversation/presenter.js";
import { OnboardingLifecycleService } from "../src/core/onboarding/lifecycle-service.js";
import type { OnboardingFacts } from "../src/core/onboarding/state.js";
import {
  FakeAdapter,
  createMemoryChannelStores,
  createMemoryUserNotifications,
  inbound,
} from "./support/channels-memory.js";
import { SENDER, createHarness, intent } from "./support/harness.js";

const FLAGS: CapabilityFlags = {
  send: true,
  rates: true,
  balance: true,
  funding: { walletTransfer: true, localCurrency: false },
};
const ADDRESS = "0x1111111111111111111111111111111111111111";

interface Options {
  flags?: CapabilityFlags;
  requireRecovery?: boolean;
  recoveryAvailable?: boolean;
  writer?: ConversationWriter | null;
  /** Start as a brand-new Telegram account (no Kaada user yet) instead of a known one. */
  newcomer?: boolean;
}

/** A whole chat deployment over in-memory stores. `facts` is the authoritative state the tests move around. */
function world(options: Options = {}) {
  const h = createHarness();
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  const notifications = createMemoryUserNotifications();
  const facts: OnboardingFacts = {
    walletReady: false,
    pinConfigured: false,
    recoveryConfigured: options.recoveryAvailable ? false : null,
  };
  if (!options.newcomer) {
    h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  }
  const links: { userId: string; existingWallet: boolean }[] = [];
  const lifecycle = new OnboardingLifecycleService({
    notifications,
    state: { read: () => Promise.resolve({ ...facts }) },
    policy: { requireRecovery: options.requireRecovery ?? false },
  });
  const funding = { reads: 0 };
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
      handle: (input) => h.agent.handle(input),
      recentTurns: (conversationId, exclude, limit) =>
        h.agent.recentTurns(conversationId, exclude, limit),
    },
    conversation: new ConversationPresenter({
      writer: options.writer ?? null,
      flags: options.flags ?? FLAGS,
      timeoutMs: 200,
    }),
    onboarding: lifecycle,
    linked: h.world.repositories.identities,
    funding: {
      info: () => {
        funding.reads += 1;
        return Promise.resolve(
          facts.walletReady
            ? { address: ADDRESS, network: "Celo", assets: ["🇳🇬 Nigerian Naira", "🇺🇸 US Dollar"] }
            : null,
        );
      },
    },
    links: {
      setupLink: (userId, linkOptions) => {
        links.push({ userId, existingWallet: linkOptions?.existingWallet ?? false });
        return Promise.resolve(
          `https://app.kaada.test/setup/${linkOptions?.existingWallet ? "pin" : "new"}`,
        );
      },
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(facts.walletReady) },
    facts: { read: () => Promise.reject(new Error("unused")) },
  });
  const announcer = () =>
    new OnboardingAnnouncer({ lifecycle, announce: (a) => service.announceOnboarding(a) });
  return {
    h,
    adapter,
    facts,
    lifecycle,
    service,
    announcer,
    notifications,
    links,
    funding,
    stores,
  };
}

let n = 0;
const say = (text: string) => inbound({ eventId: `ob-${String(++n)}`, text, at: new Date() });
const start = () => inbound({ eventId: `ob-${String(++n)}`, command: "START" });
const press = (handle: string) => inbound({ eventId: `ob-${String(++n)}`, action: handle });

const buttons = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "ACTION" }> => a.type === "ACTION",
  );
const urls = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "OPEN_URL" }> => a.type === "OPEN_URL",
  );
const texts = (adapter: FakeAdapter) => adapter.sent.map((m) => m.text);

/** The user has already been to the web page and the wallet exists, but nobody has told the chat yet. */
const walletCreated = (facts: OnboardingFacts) => {
  facts.walletReady = true;
};
const pinCreated = (facts: OnboardingFacts) => {
  facts.walletReady = true;
  facts.pinConfigured = true;
};

describe("first contact", () => {
  it("a new person's /start asks them to set up, with the secure setup button, and starts watching them", async () => {
    const w = world({ newcomer: true });
    await w.service.handleInbound(start());
    assert.match(w.adapter.last?.text ?? "", /Welcome to Kaada/);
    assert.match(w.adapter.last?.text ?? "", /get your wallet ready/);
    assert.deepEqual(
      urls(w.adapter.last).map((a) => [a.semantic, a.label]),
      [["OPEN_SETUP", "Set up Kaada"]],
    );
    assert.equal(w.links.at(-1)?.existingWallet, false, "creating a wallet, not continuing one");
    assert.ok(w.notifications.rows.some((row) => row.kind === "ONBOARDING_STARTED"));
  });
});

describe("the chat follows the web setup by itself", () => {
  it("wallet created in the web app: Telegram gets the next step (the PIN) without anyone typing", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.adapter.log.length = 0;

    walletCreated(w.facts);
    const result = await w.announcer().sweep();
    assert.equal(result.announced, 1);
    assert.match(w.adapter.last?.text ?? "", /Wallet ready 🎉/);
    assert.match(w.adapter.last?.text ?? "", /6-digit PIN/);
    const button = urls(w.adapter.last)[0];
    assert.equal(button?.label, "Set up PIN");
    assert.equal(w.links.at(-1)?.existingWallet, true, "continues the wallet that exists");
    assert.doesNotMatch(
      w.adapter.last?.text ?? "",
      /WALLET_|PIN_STATUS|_CREATED/,
      "no system wording",
    );
  });

  it("wallet ready but PIN missing: the next step is the PIN, and nothing says everything is done", async () => {
    const writer: ConversationWriter = {
      write: () =>
        Promise.resolve({
          acknowledgement: "You're all set ✅",
          body: "Your wallet and PIN are done.",
          question: null,
          closing: null,
          suggestedActionIds: ["SEND_MONEY"],
        }),
    };
    const w = world({ writer });
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    await w.announcer().sweep();
    assert.equal((await w.lifecycle.stateOf(userOf(w))).step, "PIN");
    assert.doesNotMatch(w.adapter.last?.text ?? "", /all set|✅/, "the model cannot skip a step");
    assert.match(w.adapter.last?.text ?? "", /PIN/);
    assert.equal(buttons(w.adapter.last).length, 0, "no payment actions while setup is unfinished");
  });

  it("PIN created in the web app: the person is told they are all set, with the first-use buttons", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    await w.announcer().sweep();
    w.adapter.log.length = 0;

    pinCreated(w.facts);
    await w.announcer().sweep();
    assert.match(w.adapter.last?.text ?? "", /You're all set ✅/);
    assert.match(w.adapter.last?.text ?? "", /What do you want to do first\?/);
    assert.deepEqual(
      buttons(w.adapter.last).map((a) => [a.semantic, a.label]),
      [
        ["SUGGESTION", "💰 Fund wallet"],
        ["SUGGESTION", "💸 Send money"],
        ["SUGGESTION", "💱 Today's rates"],
        ["SUGGESTION", "👛 Balance"],
      ],
    );
    assert.equal(urls(w.adapter.last).length, 0, "nothing left to set up");
  });

  it("when recovery is required, the next step after the PIN is recovery, not 'all set'", async () => {
    const w = world({ requireRecovery: true, recoveryAvailable: true });
    await w.service.handleInbound(start());
    pinCreated(w.facts);
    await w.announcer().sweep();
    assert.match(w.adapter.last?.text ?? "", /recovery/i);
    assert.match(w.adapter.last?.text ?? "", /email/i, "it says what recovery needs");
    assert.match(w.adapter.last?.text ?? "", /authenticator/i);
    assert.doesNotMatch(w.adapter.last?.text ?? "", /all set/i);
    // The step carries a secure button to the same setup page (an existing wallet), never a typed secret.
    const open = (w.adapter.last?.actions ?? []).filter((a) => a.type === "OPEN_URL");
    assert.deepEqual(
      open.map((a) => a.label),
      ["Secure my account"],
    );
    w.facts.recoveryConfigured = true;
    await w.announcer().sweep();
    assert.match(w.adapter.last?.text ?? "", /You're all set ✅/);
  });

  it("a person who finishes both steps between two checks gets ONE message, the latest, not a stack", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.adapter.log.length = 0;
    pinCreated(w.facts);
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, 1);
    assert.match(w.adapter.last?.text ?? "", /all set/);
  });
});

function userOf(w: ReturnType<typeof world>): string {
  const row = w.notifications.rows.find((r) => r.kind === "ONBOARDING_STARTED");
  assert.ok(row);
  return row.userId;
}

describe("returning people", () => {
  it("a fully set-up person's /start welcomes them back and never shows the setup prompt", async () => {
    const w = world();
    await w.service.handleInbound(start()); // tracked
    pinCreated(w.facts);
    await w.service.handleInbound(start());
    assert.match(w.adapter.last?.text ?? "", /Good to see you again|Welcome back/);
    assert.equal(urls(w.adapter.last).length, 0);
    assert.doesNotMatch(w.adapter.last?.text ?? "", /Set up|wallet ready/i);
    assert.deepEqual(
      buttons(w.adapter.last).map((a) => a.label),
      ["💸 Send money", "💱 Today's rates", "👛 Balance"],
    );
    // The announcement that was waiting is moot now: it must not arrive afterwards.
    const before = w.adapter.sent.length;
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, before);
  });

  it("a half-set-up person's /start resumes at the exact step and does not create another wallet", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    w.links.length = 0;
    await w.service.handleInbound(start());
    assert.match(
      w.adapter.last?.text ?? "",
      /wallet is ready, but your PIN still needs setting up/,
    );
    assert.match(w.adapter.last?.text ?? "", /Want to finish that\?/);
    assert.deepEqual(
      urls(w.adapter.last).map((a) => a.label),
      ["Continue setup"],
    );
    assert.deepEqual(
      w.links.map((l) => l.existingWallet),
      [true],
      "the link continues the existing wallet",
    );
  });
});

describe("'Done' is answered from the real state, never from the word", () => {
  it("after the wallet exists but before the PIN: 'Yep, your wallet is ready' and the PIN step", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.h.script.set("Done", intent({ type: "HELP", topic: "FAREWELL" }));
    walletCreated(w.facts); // the chat has not been told yet: the person types first
    await w.service.handleInbound(say("Done"));
    assert.match(w.adapter.last?.text ?? "", /Yep, your wallet is ready 🎉/);
    assert.match(w.adapter.last?.text ?? "", /set up your 6-digit PIN/);
    assert.equal(urls(w.adapter.last)[0]?.label, "Set up PIN");
    // …and the background announcement does not repeat it.
    const count = w.adapter.sent.length;
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, count);
  });

  it("typing 'Done' before anything was set up does not pretend it was", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.h.script.set("Done", intent({ type: "HELP", topic: "FAREWELL" }));
    await w.service.handleInbound(say("Done"));
    assert.match(w.adapter.last?.text ?? "", /Welcome to Kaada|get your wallet ready/);
    assert.equal(urls(w.adapter.last)[0]?.label, "Set up Kaada");
  });

  it("an unrecognised message from someone mid-setup gets their real next step, not 'I didn't understand'", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    await w.service.handleInbound(say("okay finished"));
    assert.doesNotMatch(w.adapter.last?.text ?? "", /didn't understand|didn't catch/i);
    assert.match(w.adapter.last?.text ?? "", /PIN/);
  });

  it("after onboarding is complete and announced, 'Done' is an ordinary goodbye with no setup talk", async () => {
    const w = world();
    await w.service.handleInbound(start());
    pinCreated(w.facts);
    await w.announcer().sweep();
    w.h.script.set("Done", intent({ type: "HELP", topic: "FAREWELL" }));
    const count = w.adapter.sent.length;
    await w.service.handleInbound(say("Done"));
    assert.equal(w.adapter.sent.length, count + 1);
    assert.doesNotMatch(w.adapter.last?.text ?? "", /PIN|set up|all set/i);
    assert.equal(urls(w.adapter.last).length, 0);
  });

  it("when setup finished a moment ago and nobody has said so, 'Done' gets the all-set message once", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.h.script.set("Done", intent({ type: "HELP", topic: "FAREWELL" }));
    pinCreated(w.facts);
    await w.service.handleInbound(say("Done"));
    assert.match(w.adapter.last?.text ?? "", /You're all set ✅/);
    const count = w.adapter.sent.length;
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, count, "the sweeper has nothing left to say");
  });
});

describe("delivery is persisted, deduplicated and retried", () => {
  it("the same transition seen twice, however it is recorded, is announced once", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    const userId = userOf(w);
    await w.lifecycle.observe(userId);
    await w.lifecycle.observe(userId);
    const rows = w.notifications.rows.filter((r) => r.kind === "WALLET_READY");
    assert.equal(rows.length, 1, "one row per user and kind");
    w.adapter.log.length = 0;
    await w.announcer().sweep();
    await w.announcer().sweep();
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, 1);
  });

  it("a failed Telegram delivery is retried on the next pass, then delivered once", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    w.adapter.log.length = 0;
    w.adapter.failNextSend = true;
    const first = await w.announcer().sweep();
    assert.equal(first.failed, 1);
    assert.equal(w.adapter.sent.length, 0);
    const second = await w.announcer().sweep();
    assert.equal(second.announced, 1);
    assert.equal(w.adapter.sent.length, 1);
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, 1, "and never again");
  });

  it("two API instances observing the same transition announce it once", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    w.adapter.log.length = 0;
    const [a, b, c] = [w.announcer(), w.announcer(), w.announcer()];
    await Promise.all([a.sweep(), b.sweep(), c.sweep()]);
    assert.equal(w.adapter.sent.length, 1);
  });

  it("a worker that died mid-delivery is taken over after the claim goes stale", async () => {
    const w = world();
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    await w.lifecycle.observe(userOf(w));
    const row = w.notifications.rows.find((r) => r.kind === "WALLET_READY");
    assert.ok(row);
    row.claimedAt = new Date(Date.now() - 10 * 60_000); // claimed long ago by a worker that never finished
    w.adapter.log.length = 0;
    await w.announcer().sweep();
    assert.equal(w.adapter.sent.length, 1);
  });

  it("a message and a lifecycle event at the same moment produce one consistent answer", async () => {
    const w = world();
    await w.service.handleInbound(start());
    w.h.script.set("Done", intent({ type: "HELP", topic: "FAREWELL" }));
    walletCreated(w.facts);
    w.adapter.log.length = 0;
    await Promise.all([w.announcer().sweep(), w.service.handleInbound(say("Done"))]);
    const onboardingTexts = texts(w.adapter).filter((t) => /PIN/.test(t));
    assert.equal(onboardingTexts.length, 1, "told once");
    assert.ok(texts(w.adapter).every((t) => !/didn't understand|all set/.test(t)));
  });
});

describe("the conversation knows where setup stands", () => {
  it("until setup is complete, payment actions are not suggested and the model is told the step", async () => {
    const prompts: string[] = [];
    const writer: ConversationWriter = {
      write: (prompt) => {
        prompts.push(prompt.user);
        return Promise.resolve({
          acknowledgement: "Hey 👋",
          body: null,
          question: "What do you need?",
          closing: null,
          suggestedActionIds: ["SEND_MONEY", "FUND_WALLET"],
        });
      },
    };
    const w = world({ writer });
    await w.service.handleInbound(start());
    walletCreated(w.facts);
    w.h.script.set("hi", intent({ type: "HELP", topic: "GREETING" }));
    await w.service.handleInbound(say("hi"));
    // The greeting from someone mid-setup is answered from their real state.
    assert.match(w.adapter.last?.text ?? "", /PIN/);
    assert.equal(buttons(w.adapter.last).filter((a) => a.semantic === "SUGGESTION").length, 0);
  });

  it("after setup is complete the greeting offers the everyday actions and no setup", async () => {
    const prompts: string[] = [];
    const writer: ConversationWriter = {
      write: (prompt) => {
        prompts.push(prompt.user);
        return Promise.resolve({
          acknowledgement: "Hey 👋",
          body: null,
          question: "What do you need?",
          closing: null,
          suggestedActionIds: [],
        });
      },
    };
    const w = world({ writer });
    await w.service.handleInbound(start());
    pinCreated(w.facts);
    await w.announcer().sweep();
    w.h.script.set("hi", intent({ type: "HELP", topic: "GREETING" }));
    await w.service.handleInbound(say("hi"));
    assert.match(prompts.at(-1) ?? "", /"onboardingStep":"COMPLETE"/);
    assert.deepEqual(
      buttons(w.adapter.last).map((a) => a.label),
      ["💸 Send money", "💱 Today's rates", "👛 Balance"],
    );
  });
});

describe("funding", () => {
  async function ready(options: Options = {}) {
    const w = world(options);
    await w.service.handleInbound(start());
    pinCreated(w.facts);
    await w.announcer().sweep();
    return w;
  }
  const tap = async (w: ReturnType<typeof world>, label: string) => {
    const button = buttons(w.adapter.last).find((a) => a.label === label);
    assert.ok(button, `no "${label}" button`);
    await w.service.handleInbound(press(button.handle));
  };
  const copyButtons = (message: OutboundChannelMessage | undefined) =>
    (message?.actions ?? []).filter(
      (a): a is Extract<OutboundAction, { type: "COPY_TEXT" }> => a.type === "COPY_TEXT",
    );
  const command = (name: "FUND" | "WALLET" | "HELP" | "RATES" | "BALANCE") =>
    inbound({ eventId: `ob-${String(++n)}`, command: name });

  it("shows the person's own @tag with a button to copy it, so others can pay them by it", async () => {
    const w = await ready();
    await w.service.handleInbound(
      inbound({ eventId: `ob-${String(++n)}`, command: "FUND", username: "kryptonite_bk" }),
    );
    const text = w.adapter.last?.text ?? "";
    assert.match(text, /Your Kaada tag: @kryptonite_bk/);
    assert.deepEqual(
      copyButtons(w.adapter.last).map((a) => [a.label, a.text]),
      [
        ["📋 Copy address", ADDRESS],
        ["🏷️ Copy my @tag", "@kryptonite_bk"],
      ],
    );
  });

  it("'Fund wallet' goes straight to the real way to fund: the wallet's address, the network and the supported assets", async () => {
    const w = await ready();
    await tap(w, "💰 Fund wallet");
    const text = w.adapter.last?.text ?? "";
    assert.match(text, /^Sure 👍 You can fund your Kaada wallet from another wallet\./);
    assert.match(text, /Network: Celo/);
    assert.ok(text.includes(`Wallet: ${ADDRESS}`));
    assert.match(text, /Your Kaada wallet currently supports:/);
    assert.match(text, /🇳🇬 Nigerian Naira/);
    assert.match(text, /🇺🇸 US Dollar/);
    assert.doesNotMatch(text, /cNGN|USDT|USDC/, "tickers are not the primary view");
    assert.match(
      text,
      /Only send supported currencies on the Celo network to this address\. Funds sent on another network, or unsupported assets, may not appear in Kaada and may be difficult or impossible to recover\./,
    );
    assert.deepEqual(w.adapter.last?.code, [ADDRESS], "the address is shown monospace");
    assert.deepEqual(
      copyButtons(w.adapter.last).map((a) => [a.label, a.text]),
      [["📋 Copy address", ADDRESS]],
    );
    assert.deepEqual(
      buttons(w.adapter.last).map((a) => a.label),
      ["👛 Balance"],
    );
    assert.doesNotMatch(text, /local currency/i);
  });

  it("'How can I fund my account?' typed in words gets the same trusted answer, not 'I don't know'", async () => {
    const w = await ready();
    w.h.script.set("How can I fund my account?", intent({ type: "HELP", topic: "FUNDING" }));
    await w.service.handleInbound(say("How can I fund my account?"));
    assert.ok((w.adapter.last?.text ?? "").includes(ADDRESS));
    assert.match(w.adapter.last?.text ?? "", /Network: Celo/);
  });

  it("/fund and /wallet are shortcuts to the same flows", async () => {
    const w = await ready();
    await w.service.handleInbound(command("FUND"));
    assert.match(w.adapter.last?.text ?? "", /You can fund your Kaada wallet/);
    await w.service.handleInbound(command("WALLET"));
    assert.equal(w.adapter.last?.text, `Your Kaada wallet\nNetwork: Celo\nAddress: ${ADDRESS}`);
    assert.deepEqual(w.adapter.last?.code, [ADDRESS]);
  });

  it("before the wallet exists, funding points at the setup step instead", async () => {
    const w = world();
    await w.service.handleInbound(start());
    await w.service.handleInbound(command("FUND"));
    assert.doesNotMatch(w.adapter.last?.text ?? "", /0x[0-9a-f]{40}/i);
    assert.equal(urls(w.adapter.last)[0]?.label, "Set up Kaada");
  });

  it("a method with no working provider (local currency) is never advertised; a real choice shows a menu", async () => {
    const w = await ready();
    await tap(w, "💰 Fund wallet");
    assert.doesNotMatch(JSON.stringify(w.adapter.sent), /local currency/i);

    // Registry control: with a real provider flag there are two ways, so there is a choice to make.
    const live = await ready({
      flags: { ...FLAGS, funding: { walletTransfer: true, localCurrency: true } },
    });
    await tap(live, "💰 Fund wallet");
    assert.match(live.adapter.last?.text ?? "", /How would you like to fund your wallet\?/);
    assert.deepEqual(
      buttons(live.adapter.last).map((a) => a.label),
      ["Send from another wallet", "Fund with local currency"],
    );
  });

  it("with no funding method at all, Fund wallet is not even a button", async () => {
    const w = await ready({
      flags: { ...FLAGS, funding: { walletTransfer: false, localCurrency: false } },
    });
    assert.ok(!buttons(w.adapter.last).some((a) => a.label === "💰 Fund wallet"));
  });

  it("funding details come from trusted state, never from a model", async () => {
    let modelCalls = 0;
    const w = await ready({
      writer: {
        write: () => {
          modelCalls += 1;
          return Promise.resolve({
            acknowledgement: "Send to 0xDEADBEEF on Ethereum",
            body: null,
            question: null,
            closing: null,
            suggestedActionIds: [],
          });
        },
      },
    });
    const before = modelCalls;
    await tap(w, "💰 Fund wallet");
    const text = w.adapter.last?.text ?? "";
    assert.ok(text.includes(ADDRESS));
    assert.doesNotMatch(text, /DEADBEEF|Ethereum/);
    assert.equal(modelCalls, before, "no model call for funding");
  });

  it("a button for a funding method that is not offered answers 'not available' and reveals nothing", async () => {
    const w = await ready();
    const actions = new ChannelActionService(w.stores.channelActions);
    const handle = await actions.issue({
      userId: userOf(w),
      channel: "TELEGRAM",
      externalUserId: "424242",
      conversationId: randomUUID(),
      kind: "SUGGESTION",
      payload: { suggestion: "FUND_LOCAL_CURRENCY" },
    });
    const reads = w.funding.reads;
    await w.service.handleInbound(press(handle));
    assert.equal(w.adapter.last?.text, "That way of funding your wallet isn't available.");
    assert.equal(w.funding.reads, reads, "no wallet details were even read");
  });
});
