import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";
import type { WalletFundingEvent } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { OutboundChannelMessage } from "../src/core/channels/types.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { describeHome, homeFor } from "../src/core/currency/catalog.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, createHarness, intent } from "./support/harness.js";
import { joao, setup } from "./support/payment-world.js";

const NGN = (whole: bigint) => whole * 10n ** 6n;

/** A person whose home country is chosen, in the plain (no pricing) harness. */
async function withHome(country: string | undefined) {
  const h = createHarness();
  h.world.addUser({ id: randomUUID(), username: "daniel" });
  h.world.addUser({ id: randomUUID(), username: "joao" });
  const home = country ? homeFor(country) : undefined;
  if (home) await h.world.repositories.users.setHome(SENDER, home);
  return h;
}

const amountIs = (h: Awaited<ReturnType<typeof withHome>>, turn: AgentTurnResult, code: string) => {
  const stored = h.world.intents.get(turn.intentId ?? "");
  const fiat = h.assets[code as "NGN" | "BRL" | "USD" | "ARS"];
  return stored?.amount?.money.assetId === fiat.id;
};

const sendText = (
  h: Awaited<ReturnType<typeof withHome>>,
  text: string,
  currency: string | null,
  name = "daniel",
  value = "300",
) => {
  h.script.set(
    text,
    intent({
      type: "SEND",
      recipient: { type: "USERNAME", value: name },
      amount: { value, ...(currency && { currencyOrAsset: currency }) },
    } as never),
  );
  return h.say(text);
};

describe("an amount with no currency is in the person's home currency", () => {
  it("a Nigerian user's 'Send 300 to Daniel' is ₦300, with no question", async () => {
    const h = await withHome("NG");
    const turn = await sendText(h, "send 300 to daniel", null);
    assert.notEqual(turn.response.type, "CLARIFICATION_REQUIRED", JSON.stringify(turn.response));
    assert.ok(amountIs(h, turn, "NGN"));
    assert.match(turn.response.text, /You're sending ₦300 to daniel/i);
  });

  it("a Brazilian user's 'Send 300 to João' is R$300", async () => {
    const h = await withHome("BR");
    const turn = await sendText(h, "send 300 to joao", null, "joao");
    assert.ok(amountIs(h, turn, "BRL"));
    assert.match(turn.response.text, /You're sending R\$300 to /);
  });

  it("an explicit currency always wins: '$300' is dollars for a Nigerian user, 'R$100' is reais", async () => {
    const h = await withHome("NG");
    const dollars = await sendText(h, "send $300 to daniel", "USD");
    assert.ok(amountIs(h, dollars, "USD"));
    assert.match(dollars.response.text, /\$300/);
    const reais = await sendText(h, "send R$100 to daniel", "BRL", "daniel", "100");
    assert.ok(amountIs(h, reais, "BRL"));
  });

  it("the payment already in progress keeps its currency: 'make it 500' stays reais for a Nigerian user", async () => {
    const h = await withHome("NG");
    const first = await sendText(h, "send R$300 to daniel", "BRL");
    assert.ok(amountIs(h, first, "BRL"));
    h.script.set("make it 500", intent({ type: "SEND", amount: { value: "500" } } as never));
    const second = await h.say("make it 500");
    assert.equal(second.intentId, first.intentId, "the same payment was changed");
    const stored = h.world.intents.get(first.intentId ?? "");
    assert.equal(stored?.amount?.money.assetId, h.assets.BRL.id, "still reais, not Naira");
    assert.equal(stored?.amount?.money.amount, "50000");
  });

  it("with no home currency chosen, it still asks which currency (nothing is assumed)", async () => {
    const h = await withHome(undefined);
    const turn = await sendText(h, "send 300 to daniel", null);
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
    if (turn.response.type === "CLARIFICATION_REQUIRED")
      assert.equal(turn.response.field, "CURRENCY");
  });

  it("'Other' means no default currency: it asks, as before", async () => {
    const h = await withHome("ZZ");
    const turn = await sendText(h, "send 300 to daniel", null);
    assert.equal(turn.response.type, "CLARIFICATION_REQUIRED");
  });

  it("a payment is not defaulted when it is not a payment", async () => {
    const h = await withHome("NG");
    h.script.set(
      "how much is 50",
      intent({
        type: "QUOTE",
        amount: { value: "50" },
        fromAsset: "USDT",
      } as never),
    );
    const turn = await h.say("how much is 50");
    // A quote keeps its own rules; the home currency never turns it into a Naira quote.
    assert.notEqual(
      h.world.intents.get(turn.intentId ?? "")?.amount?.money.assetId,
      h.assets.NGN.id,
    );
  });
});

describe("the receiver's country does not change what the sender pays in", () => {
  it("a Nigerian user sending to a Brazilian recipient pays in Naira; the route decides what they receive", async () => {
    const w = setup();
    w.port.home = "NGN";
    await w.r.h.world.repositories.users.setHome(SENDER, { country: "NG", currency: "NGN" });
    w.r.h.script.set(
      "send 5000 to joao",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "5000" },
      } as never),
    );
    const turn = await w.r.h.say("send 5000 to joao");
    const stored = w.r.world.intents.get(turn.intentId ?? "");
    assert.equal(stored?.amount?.mode, "EXACT_INPUT", "what they spend is fixed");
    assert.equal(
      stored?.amount?.money.assetId,
      w.r.h.assets.NGN.id,
      "in Naira, not the recipient's Real",
    );
    assert.equal(stored?.sourceAssetId, w.r.h.assets.NGN.id);
  });

  it("'exactly R$500' fixes what João receives, and the home currency is the default way to pay", async () => {
    const w = setup();
    w.port.home = "NGN";
    w.port.held.set(w.r.tokens.cNGN.id, NGN(5_000_000n));
    w.fund("USDT", 1_000n);
    w.r.h.script.set(
      "send joao exactly r$500",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      } as never),
    );
    const turn = await w.r.h.say("send joao exactly r$500");
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    if (turn.response.type !== "PAYMENT_READY") return;
    assert.equal(
      turn.response.recipientReceives.expected.display,
      "R$500",
      "João gets exactly R$500",
    );
    assert.equal(
      turn.response.senderSpends.expected.symbol,
      "cNGN",
      "paid from the Naira they hold",
    );
    assert.match(turn.response.senderSpends.expected.display, /^₦/);
    // Without a home currency the same payment is paid from dollars: nothing about João changed.
    const other = setup();
    other.port.held.set(other.r.tokens.cNGN.id, NGN(5_000_000n));
    other.fund("USDT", 1_000n);
    other.r.h.script.set(
      "send joao exactly r$500",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      } as never),
    );
    const plain = await other.r.h.say("send joao exactly r$500");
    assert.equal(
      plain.response.type === "PAYMENT_READY" && plain.response.senderSpends.expected.symbol,
      "USDT",
    );
  });
});

describe("choosing a country", () => {
  it("maps each supported country to its default currency, and Other to none", () => {
    assert.deepEqual(homeFor("NG"), { country: "NG", currency: "NGN" });
    assert.deepEqual(homeFor("br"), { country: "BR", currency: "BRL" });
    assert.deepEqual(homeFor("AR"), { country: "AR", currency: "ARS" });
    assert.deepEqual(homeFor("ID"), { country: "ID", currency: "IDR" });
    assert.deepEqual(homeFor("ZZ"), { country: "ZZ", currency: null });
    assert.equal(homeFor("FR"), undefined, "an unsupported country is not invented");
    assert.equal(
      describeHome({ country: "NG", currency: "NGN" }),
      "Nigeria 🇳🇬\nYour default currency is Nigerian Naira (₦).",
    );
  });

  it("is stored on the person, and a person who has not chosen has none", async () => {
    const h = await withHome(undefined);
    assert.equal((await h.world.repositories.users.findById(SENDER))?.homeCountry, undefined);
    const user = await h.world.repositories.users.setHome(SENDER, {
      country: "NG",
      currency: "NGN",
    });
    assert.equal(user.homeCountry, "NG");
    assert.equal(user.homeCurrency, "NGN");
    const other = await h.world.repositories.users.setHome(SENDER, {
      country: "ZZ",
      currency: null,
    });
    assert.equal(other.homeCountry, "ZZ");
    assert.equal(other.homeCurrency, undefined);
  });
});

/** The chat side: a real ChannelMessageService over a fake adapter, with a profile and a conversions probe. */
function chat(options: {
  home?: { country?: string; currency?: string };
  routes?: [string, string][];
}) {
  const h = createHarness();
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  const profile: { country?: string; currency?: string } = { ...(options.home ?? {}) };
  const agentCalls: unknown[] = [];
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
      handle: (input: unknown): Promise<AgentTurnResult> => {
        agentCalls.push(input);
        return Promise.resolve({
          conversationId: randomUUID(),
          messageId: randomUUID(),
          duplicate: false,
          response: { type: "MESSAGE", text: "a priced conversion would be shown here" },
        });
      },
    },
    conversation: new ConversationPresenter({
      writer: null,
      flags: { send: true, rates: true, balance: true },
      timeoutMs: 1_000,
    }),
    linked: {
      listForUser: () => Promise.resolve([{ type: "TELEGRAM", externalId: "424242" }] as never),
    },
    profile: {
      get: () => Promise.resolve({ ...profile }),
      set: (_userId: string, home: { country: string; currency: string | null }) => {
        profile.country = home.country;
        if (home.currency) profile.currency = home.currency;
        else delete profile.currency;
        return Promise.resolve();
      },
    },
    conversions: {
      available: (from: string, to: string) =>
        Promise.resolve((options.routes ?? []).some(([a, b]) => a === from && b === to)),
    },
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
    now: () => new Date("2026-10-14T12:00:00Z"),
  } as never);
  return { adapter, service, agentCalls, profile };
}

const labels = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).map((action) => ("label" in action ? action.label : ""));
const handleOf = (message: OutboundChannelMessage | undefined, label: string) => {
  const found = (message?.actions ?? []).find(
    (action) => "label" in action && action.label === label,
  );
  return found && "handle" in found ? found.handle : undefined;
};

const received = (
  code: string,
  symbol: string,
  decimals: number,
  whole: bigint,
): WalletFundingEvent => {
  const amount = (whole * 10n ** BigInt(decimals)).toString();
  return {
    id: createId(),
    userId: SENDER,
    chainId: 42220,
    address: "0x1111111111111111111111111111111111111111",
    items: [
      {
        assetId: createId(),
        symbol,
        fiatCode: code,
        decimals,
        previous: "0",
        current: amount,
        delta: amount,
      },
    ],
    createdAt: new Date(),
    attempts: 0,
  };
};

let n = 0;
const press = (handle: string) => inbound({ eventId: `hc-${String(++n)}`, action: handle });

describe("money that arrives", () => {
  it("foreign money for a Naira user is announced as Real and offered a conversion ONLY when a route exists", async () => {
    const withRoute = chat({ home: { country: "NG", currency: "NGN" }, routes: [["BRL", "NGN"]] });
    await withRoute.service.announceFunding(received("BRL", "wBRL", 18, 500n));
    const message = withRoute.adapter.sent[0];
    assert.match(message?.text ?? "", /^You received R\$500 🇧🇷/);
    assert.match(message?.text ?? "", /Would you like to convert it to Nigerian Naira\?/);
    assert.deepEqual(labels(message), ["🔄 Convert to Nigerian Naira", "Keep as Brazilian Real"]);
    assert.doesNotMatch(message?.text ?? "", /wBRL|0x/);
    assert.equal(withRoute.agentCalls.length, 0, "nothing is converted for them");

    const noRoute = chat({ home: { country: "NG", currency: "NGN" }, routes: [] });
    await noRoute.service.announceFunding(received("BRL", "wBRL", 18, 500n));
    const plain = noRoute.adapter.sent[0];
    assert.match(plain?.text ?? "", /^You received R\$500 🇧🇷/);
    assert.match(plain?.text ?? "", /It's in your Brazilian Real balance\./);
    assert.deepEqual(labels(plain), [], "no conversion is advertised that could not settle");
  });

  it("money in the person's own currency needs no conversion and no buttons", async () => {
    const { adapter, service } = chat({
      home: { country: "NG", currency: "NGN" },
      routes: [["BRL", "NGN"]],
    });
    await service.announceFunding(received("NGN", "cNGN", 6, 5_000n));
    assert.equal(adapter.sent[0]?.text, "You received ₦5,000 💰");
    assert.deepEqual(labels(adapter.sent[0]), []);
  });

  it("'Keep as Real' keeps it: nothing is converted, and the balance view still shows it", async () => {
    const { adapter, service, agentCalls } = chat({
      home: { country: "NG", currency: "NGN" },
      routes: [["BRL", "NGN"]],
    });
    await service.announceFunding(received("BRL", "wBRL", 18, 500n));
    const keep = handleOf(adapter.sent[0], "Keep as Brazilian Real");
    assert.ok(keep);
    await service.handleInbound(press(keep));
    assert.match(adapter.sent[1]?.text ?? "", /keep that in Brazilian Real/);
    assert.equal(agentCalls.length, 0, "nothing was started");
    // The held currencies are shown side by side: a foreign balance is never folded into the home currency.
    const { balanceBlock } = await import("../src/core/currency/catalog.js");
    assert.equal(
      balanceBlock([
        { symbol: "cNGN", fiatCode: "NGN", decimals: 6, amount: NGN(12_500n).toString() },
        { symbol: "wBRL", fiatCode: "BRL", decimals: 18, amount: (500n * 10n ** 18n).toString() },
        { symbol: "USDC", fiatCode: "USD", decimals: 6, amount: "25000000" },
      ]),
      "🇳🇬 Nigerian Naira: ₦12,500\n🇧🇷 Brazilian Real: R$500\n🇺🇸 US Dollar: $25",
    );
  });

  it("'Convert to Naira' starts the normal conversion for exactly that amount (nothing is invented here)", async () => {
    const { adapter, service, agentCalls } = chat({
      home: { country: "NG", currency: "NGN" },
      routes: [["BRL", "NGN"]],
    });
    await service.announceFunding(received("BRL", "wBRL", 18, 500n));
    const convert = handleOf(adapter.sent[0], "🔄 Convert to Nigerian Naira");
    assert.ok(convert);
    await service.handleInbound(press(convert));
    assert.equal(agentCalls.length, 1);
    assert.deepEqual(
      {
        command: (agentCalls[0] as { command: string }).command,
        ...(agentCalls[0] as { conversion: object }),
      },
      {
        command: "CONVERT_CURRENCY",
        kind: "COMMAND",
        userId: SENDER,
        channel: "TELEGRAM",
        externalConversationId: "424242",
        conversion: { from: "BRL", to: "NGN", amount: "500" },
        externalMessageId: (agentCalls[0] as { externalMessageId: string }).externalMessageId,
      },
    );
  });

  it("a person with no home currency is told plainly, with nothing to convert to", async () => {
    const { adapter, service } = chat({ routes: [["BRL", "NGN"]] });
    await service.announceFunding(received("BRL", "wBRL", 18, 500n));
    assert.match(adapter.sent[0]?.text ?? "", /^Nice, your wallet just received R\$500 💰/);
  });
});

describe("conversions go through the normal pricing and authorization", () => {
  it("the Convert button's request is priced by the routing layer and waits for authorization", async () => {
    const w = setup({ authorize: true });
    w.port.home = "USD";
    w.fund("USDT", 100n);
    const turn = await w.r.h.agent.handle({
      kind: "COMMAND",
      command: "CONVERT_CURRENCY",
      userId: SENDER,
      channel: "TELEGRAM",
      externalConversationId: "chat-convert",
      externalMessageId: "cv-1",
      conversion: { from: "USD", to: "BRL", amount: "20" },
    });
    assert.ok(w.priced.length > 0, "the rate came from the pricing layer");
    assert.equal(turn.response.type, "AUTHORIZATION_REQUIRED", JSON.stringify(turn.response));
    if (turn.response.type !== "AUTHORIZATION_REQUIRED") return;
    assert.equal(turn.response.summary.senderSpends.display, "$20");
    assert.match(turn.response.summary.recipientReceives.display, /^R\$/);
    // Exact identity underneath: smallest units of the exact settlement tokens.
    assert.equal(turn.response.summary.senderSpends.assetId, w.r.h.assets.USDT.id);
  });

  it("discovery says which conversions exist, and does not price anything", async () => {
    const w = setup();
    assert.equal(await w.r.routing.canConvert("USD", "BRL"), true);
    assert.equal(await w.r.routing.canConvert("BRL", "BRL"), false);
    assert.equal(await w.r.routing.canConvert("BRL", "EUR"), false);
    assert.deepEqual(w.priced, []);
  });
});

describe("onboarding asks where the person uses Kaada", () => {
  it("/start asks once for a person with no country, with a button per country and Other", async () => {
    const { adapter, service } = chat({});
    await service.handleInbound(inbound({ eventId: `hc-${String(++n)}`, command: "START" }));
    const prompt = adapter.sent[adapter.sent.length - 1];
    assert.equal(prompt?.text, "Where will you mainly use Kaada?");
    assert.deepEqual(labels(prompt), [
      "🇳🇬 Nigeria",
      "🇧🇷 Brazil",
      "🇦🇷 Argentina",
      "🇮🇩 Indonesia",
      "🌍 Other",
    ]);
    assert.doesNotMatch(prompt?.text ?? "", /cNGN|wBRL|wARS|IDRX/);
  });

  it("choosing Nigeria sets Naira and says so; the choice is then not asked again", async () => {
    const { adapter, service, profile } = chat({});
    await service.handleInbound(inbound({ eventId: `hc-${String(++n)}`, command: "START" }));
    const nigeria = handleOf(adapter.sent[adapter.sent.length - 1], "🇳🇬 Nigeria");
    assert.ok(nigeria);
    await service.handleInbound(press(nigeria));
    assert.equal(
      adapter.sent[adapter.sent.length - 1]?.text,
      "Nigeria 🇳🇬\nYour default currency is Nigerian Naira (₦).",
    );
    assert.deepEqual([profile.country, profile.currency], ["NG", "NGN"]);
    const before = adapter.sent.length;
    await service.handleInbound(inbound({ eventId: `hc-${String(++n)}`, command: "START" }));
    assert.ok(
      adapter.sent.slice(before).every((m) => m.text !== "Where will you mainly use Kaada?"),
      "not asked again",
    );
  });

  it("'Other' records no default currency, and it can be changed later with /country", async () => {
    const { adapter, service, profile } = chat({ home: { country: "NG", currency: "NGN" } });
    await service.handleInbound(inbound({ eventId: `hc-${String(++n)}`, command: "COUNTRY" }));
    const prompt = adapter.sent[adapter.sent.length - 1];
    assert.equal(prompt?.text, "Where will you mainly use Kaada?");
    const brazil = handleOf(prompt, "🇧🇷 Brazil");
    assert.ok(brazil);
    await service.handleInbound(press(brazil));
    assert.deepEqual([profile.country, profile.currency], ["BR", "BRL"]);
    await service.handleInbound(inbound({ eventId: `hc-${String(++n)}`, command: "COUNTRY" }));
    const other = handleOf(adapter.sent[adapter.sent.length - 1], "🌍 Other");
    assert.ok(other);
    await service.handleInbound(press(other));
    assert.deepEqual([profile.country, profile.currency], ["ZZ", undefined]);
    assert.match(adapter.sent[adapter.sent.length - 1]?.text ?? "", /won't assume a currency/);
  });
});
