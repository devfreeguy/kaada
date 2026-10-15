import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { ChainBalanceReader } from "@kaada/blockchain";
import type { ChainReader } from "@kaada/blockchain";
import { KaadaError, createAssetRegistry, createId } from "@kaada/domain";

import type { AgentBalanceReader, AgentTurnResult } from "../src/core/agent/agent-service.js";
import { BalanceReadError } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { commandMenu, helpText } from "../src/core/channels/commands.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { OutboundAction, OutboundChannelMessage } from "../src/core/channels/types.js";
import { availableCapabilities } from "../src/core/conversation/capabilities.js";
import type { CapabilityFlags } from "../src/core/conversation/capabilities.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { WalletFundingResolver } from "../src/core/routing/funding-resolver.js";
import { classifyBalanceFailure } from "../src/core/wallets/balance-failure.js";
import { TelegramAdapter } from "../src/infrastructure/channels/telegram/telegram-adapter.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, intent } from "./support/harness.js";
import { FakePort, USDT } from "./support/payment-world.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

const ADDRESS = "0x2222222222222222222222222222222222222222";
const FLAGS: CapabilityFlags = {
  send: true,
  rates: true,
  balance: true,
  funding: { walletTransfer: true, localCurrency: false },
};
const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };

/** A whole chat over the real Agent Core, with a wallet that holds exactly what the test says. */
function chat(options: { held?: bigint; lines?: { symbol: string; display: string }[] } = {}) {
  const port = new FakePort();
  const read: AgentBalanceReader = {
    read: () => Promise.resolve({ lines: options.lines ?? [] }),
  };
  const r: RoutingHarness = createRoutingHarness({
    funding: (registry) => new WalletFundingResolver({ wallet: port, assets: registry }),
    balances: read,
  });
  port.held.set(r.h.assets.USDT.id, options.held ?? 0n);
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
      recentTurns: (id, exclude, limit) => r.h.agent.recentTurns(id, exclude, limit),
      openPaymentResume: (input) => r.h.agent.openPaymentResume(input),
    },
    conversation: new ConversationPresenter({ writer: null, flags: FLAGS }),
    funding: {
      info: () => Promise.resolve({ address: ADDRESS, network: "Celo", assets: ["USDT", "USDC"] }),
    },
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
  });
  return { r, port, adapter, service, stores };
}

let n = 0;
const say = (text: string) => inbound({ eventId: `fx-${String(++n)}`, text });
const command = (name: "FUND" | "WALLET" | "HELP" | "RATES" | "BALANCE" | "CANCEL") =>
  inbound({ eventId: `fx-${String(++n)}`, command: name });
const press = (handle: string) => inbound({ eventId: `fx-${String(++n)}`, action: handle });
const buttons = (message: OutboundChannelMessage | undefined) =>
  (message?.actions ?? []).filter(
    (a): a is Extract<OutboundAction, { type: "ACTION" }> => a.type === "ACTION",
  );
const labels = (message: OutboundChannelMessage | undefined) =>
  buttons(message).map((a) => a.label);

describe("an empty wallet leads to funding, never to a dead end", () => {
  it("a wallet holding nothing says so and offers Fund wallet", async () => {
    const { r, adapter, service } = chat({ lines: [] });
    r.h.script.set("balance", intent({ type: "BALANCE" }));
    await service.handleInbound(say("balance"));
    assert.equal(adapter.last?.text, "Your wallet is empty right now. Want to fund it?");
    assert.deepEqual(labels(adapter.last), ["💰 Fund wallet"]);
    // and the button does what it says
    await service.handleInbound(press(buttons(adapter.last)[0]?.handle ?? ""));
    assert.ok((adapter.last?.text ?? "").includes(ADDRESS));
  });

  it("asking for one token the wallet does not hold names that token", async () => {
    const { r, adapter, service } = chat({ lines: [{ symbol: "USDC", display: "5" }] });
    r.h.script.set("usdt balance", intent({ type: "BALANCE", asset: "USDT" }));
    await service.handleInbound(say("usdt balance"));
    assert.equal(
      adapter.last?.text,
      "You don't have any USDT in your Kaada wallet yet.\n\nWant to fund it?",
    );
    assert.deepEqual(labels(adapter.last), ["💰 Fund wallet"]);
  });

  it("a funded wallet shows only what it holds, with the usual lead", async () => {
    const { r, adapter, service } = chat({ lines: [{ symbol: "USDT", display: "42.18" }] });
    r.h.script.set("balance", intent({ type: "BALANCE" }));
    await service.handleInbound(say("balance"));
    assert.match(adapter.last?.text ?? "", /^(Here's your balance|This is what you're holding) 👇/);
    assert.match(adapter.last?.text ?? "", /• 42\.18 USDT/);
    assert.doesNotMatch(adapter.last?.text ?? "", /0x|wei|rpc/i, "no technical detail");
  });

  it("/balance is a shortcut to the same answer", async () => {
    const { adapter, service } = chat({ lines: [] });
    await service.handleInbound(command("BALANCE"));
    assert.equal(adapter.last?.text, "Your wallet is empty right now. Want to fund it?");
  });
});

describe("a failed balance read is explained in the logs, not swallowed", () => {
  it("logs the reason and the token, shows a friendly sentence, and never fakes a balance", async () => {
    const r = createRoutingHarness({
      balances: {
        read: () => Promise.reject(new BalanceReadError("ASSET_UNSUPPORTED", "tUSDT")),
      },
    });
    r.h.script.set("balance", intent({ type: "BALANCE" }));
    const turn = await r.h.say("balance");
    assert.equal(turn.response.type, "ERROR");
    assert.match(turn.response.text, /couldn't read your balance right now/);
    const failure = r.h.logs.find((entry) => entry.event === "agent.balance.failed");
    assert.equal(failure?.fields["reason"], "ASSET_UNSUPPORTED");
    assert.equal(failure?.fields["detail"], "tUSDT");
  });

  it("separates a missing wallet, an unreadable token, an RPC outage and anything else", () => {
    assert.equal(
      classifyBalanceFailure(
        new KaadaError("ASSET_NOT_SUPPORTED", "x", { details: { symbol: "tBRL" } }),
      ).reason,
      "ASSET_UNSUPPORTED",
    );
    assert.equal(
      classifyBalanceFailure(new KaadaError("WALLET_NOT_ACTIVE", "x")).reason,
      "WALLET_NOT_READY",
    );
    const rpc = new Error("The request timed out");
    rpc.name = "TimeoutError";
    assert.equal(classifyBalanceFailure(rpc).reason, "RPC_UNAVAILABLE");
    assert.equal(classifyBalanceFailure(new Error("odd")).reason, "BALANCE_UNAVAILABLE");
  });

  it("the chain reader names the token that is not a contract instead of failing anonymously", async () => {
    const good = "0x00000000000000000000000000000000000000a1";
    const bad = "0x00000000000000000000000000000000000000b2";
    const chain: ChainReader = {
      getErc20Balances: (_owner, tokens) =>
        tokens.includes(bad)
          ? Promise.reject(new Error('The contract function "balanceOf" returned no data ("0x").'))
          : Promise.resolve(tokens.map(() => 0n)),
      getErc20Decimals: (tokens) => Promise.resolve(tokens.map(() => 6)),
    };
    const assets = [
      { id: "id-good", symbol: "USDT", contractAddress: good },
      { id: "id-bad", symbol: "tUSDT", contractAddress: bad },
    ].map((a) => ({
      ...a,
      name: a.symbol,
      kind: "USD_STABLECOIN" as const,
      decimals: 6,
      chainId: 42220,
      isActive: true,
    }));
    const reader = new ChainBalanceReader({
      assets: createAssetRegistry({
        findById: (id: string) => Promise.resolve(assets.find((a) => a.id === id) ?? null),
      } as never),
      chain,
    });
    await assert.rejects(
      reader.readBalances({
        chainId: 42220,
        address: ADDRESS,
        assetIds: assets.map((a) => a.id),
      }),
      (error: unknown) =>
        error instanceof KaadaError &&
        error.code === "ASSET_NOT_SUPPORTED" &&
        error.details?.["symbol"] === "tUSDT",
    );
  });
});

describe("commands", () => {
  it("the menu lists only what exists, and nothing for features that do not", () => {
    const all = commandMenu(FLAGS).map((entry) => entry.command);
    assert.deepEqual(all, ["start", "help", "balance", "fund", "wallet", "rates", "cancel"]);
    assert.ok(!all.includes("send"), "sending stays natural");
    assert.ok(!all.includes("history") && !all.includes("status"), "not built, so not offered");
    assert.deepEqual(
      commandMenu({ send: false, rates: false, balance: false }).map((entry) => entry.command),
      ["start", "help", "cancel"],
    );
  });

  it("/help lists what is available, concisely", async () => {
    const { adapter, service } = chat();
    await service.handleInbound(command("HELP"));
    assert.equal(adapter.last?.text, helpText(FLAGS));
    assert.match(adapter.last?.text ?? "", /💸 Send money/);
    assert.match(adapter.last?.text ?? "", /Shortcuts: \/balance \/fund \/wallet \/rates \/cancel/);
    assert.doesNotMatch(adapter.last?.text ?? "", /history|status/i);
  });

  it("/rates asks which pair, and /cancel cancels what is open", async () => {
    const { r, adapter, service } = chat({ held: 100n * USDT });
    await service.handleInbound(command("RATES"));
    assert.match(adapter.last?.text ?? "", /which (rate|pair)/i);
    r.h.script.set(
      "send",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
      }),
    );
    await service.handleInbound(say("send"));
    await service.handleInbound(command("CANCEL"));
    assert.match(adapter.last?.text ?? "", /cancelled/i);
  });
});

describe("errors that help you carry on", () => {
  it("an empty wallet during a payment says what is wrong and offers Fund wallet and Cancel, keeping the payment", async () => {
    const { r, adapter, service } = chat({ held: 0n });
    r.h.script.set(
      "send",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
      }),
    );
    await service.handleInbound(say("send"));
    assert.equal(
      adapter.last?.text,
      "You don't currently have enough USDT for this payment.\n\nWant to fund your wallet and come back to it?",
    );
    assert.deepEqual(labels(adapter.last), ["💰 Fund wallet", "❌ Cancel"]);
    assert.doesNotMatch(adapter.last?.text ?? "", /Nothing was sent|No money/);
    assert.equal(
      [...r.world.intents.values()].filter((i) => i.status === "RESOLVED").length,
      1,
      "the payment is still there",
    );
  });

  it("after funding, Fund wallet shows the address and a Continue that re-prices the same payment", async () => {
    const { r, port, adapter, service } = chat({ held: 0n });
    r.h.script.set(
      "send",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
      }),
    );
    await service.handleInbound(say("send"));
    const intentId = [...r.world.intents.values()][0]?.id;
    await service.handleInbound(
      press(buttons(adapter.last).find((a) => a.label === "💰 Fund wallet")?.handle ?? ""),
    );
    assert.ok((adapter.last?.text ?? "").includes(ADDRESS));
    assert.match(adapter.last?.text ?? "", /tap Continue and I'll check your payment again/);
    const keep = buttons(adapter.last).find((a) => a.semantic === "CONTINUE_PAYMENT");
    assert.ok(keep, "Continue is offered because a payment is waiting");

    port.held.set(r.h.assets.USDT.id, 100n * USDT); // the transfer arrived
    await service.handleInbound(press(keep.handle));
    assert.match(adapter.last?.text ?? "", /You spend exactly/);
    assert.equal([...r.world.intents.values()].length, 1);
    assert.equal([...r.world.intents.values()][0]?.id, intentId, "the same payment, not a new one");
  });

  it("an unknown recipient is a short question, with Cancel and no safety narration", async () => {
    const { r, adapter, service } = chat({ held: 100n * USDT });
    r.h.script.set(
      "send john",
      intent({
        type: "SEND",
        recipient: { type: "SAVED_BENEFICIARY", value: "John" },
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    await service.handleInbound(say("send john"));
    const text = adapter.last?.text ?? "";
    assert.match(text, /I couldn't find John\. Who would you like to send it to\?/);
    assert.doesNotMatch(text, /Nothing was sent|No money|saved contact, a Kaada username/);
    assert.deepEqual(labels(adapter.last), ["❌ Cancel"]);
  });

  it("the payment summary no longer narrates expiry or internals", async () => {
    const { r, adapter, service } = chat({ held: 100n * USDT });
    r.h.script.set(
      "send",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
      }),
    );
    await service.handleInbound(say("send"));
    const text = adapter.last?.text ?? "";
    assert.doesNotMatch(
      text,
      /expire|seconds|Authorize within|final price is confirmed|Nothing was sent/i,
    );
    assert.match(text, /You spend exactly/);
  });
});

describe("emoji: light, and not around money at risk", () => {
  it("buttons carry a small icon where it helps, taken from the one capability registry", () => {
    assert.deepEqual(
      availableCapabilities(FLAGS).map((capability) => capability.label),
      ["💰 Fund wallet", "💸 Send money", "💱 Today's rates", "👛 Balance"],
    );
  });

  it("serious messages carry no playful emoji", async () => {
    const { r, adapter, service } = chat({ held: 0n });
    r.h.script.set(
      "send",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
        sourceAsset: "USDT",
      }),
    );
    await service.handleInbound(say("send"));
    assert.doesNotMatch(adapter.last?.text ?? "", /\p{Extended_Pictographic}/u);
  });
});

// ───────────────────────── Telegram rendering ─────────────────────────

function telegram() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const adapter = new TelegramAdapter({
    botToken: "1:TOKEN",
    webhookSecret: "a-long-enough-webhook-secret_123",
    fetch: ((url: string, init: { body: string }) => {
      calls.push({
        method: url.split("/").pop() ?? "",
        body: JSON.parse(init.body) as Record<string, unknown>,
      });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })));
    }) as unknown as typeof fetch,
  });
  return { adapter, calls };
}

describe("Telegram: commands, copy button, monospace address", () => {
  it("understands the new commands, with or without the bot name", () => {
    const { adapter } = telegram();
    const parse = (text: string) =>
      adapter.parseWebhook({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          from: { id: 5, is_bot: false, first_name: "A" },
          chat: { id: 5, type: "private" },
          text,
        },
      })?.content;
    assert.deepEqual(parse("/balance"), { kind: "COMMAND", command: "BALANCE" });
    assert.deepEqual(parse("/fund@kaadabot"), { kind: "COMMAND", command: "FUND" });
    assert.deepEqual(parse("/wallet"), { kind: "COMMAND", command: "WALLET" });
    assert.deepEqual(parse("/rates"), { kind: "COMMAND", command: "RATES" });
    assert.deepEqual(
      parse("/history"),
      { kind: "TEXT", text: "/history" },
      "unknown commands are plain text",
    );
  });

  it("sends the address as a monospace entity and a native copy button, with no callback data", async () => {
    const { adapter, calls } = telegram();
    const text = `Wallet: ${ADDRESS}\n\nOnly send on Celo.`;
    await adapter.send(
      { externalConversationId: "5" },
      {
        text,
        code: [ADDRESS],
        actions: [{ type: "COPY_TEXT", label: "📋 Copy address", text: ADDRESS }],
      },
    );
    const body = calls[0]?.body as {
      entities: { type: string; offset: number; length: number }[];
      reply_markup: { inline_keyboard: Record<string, unknown>[][] };
    };
    assert.deepEqual(body.entities, [
      { type: "code", offset: text.indexOf(ADDRESS), length: ADDRESS.length },
    ]);
    assert.deepEqual(body.reply_markup.inline_keyboard[0]?.[0], {
      text: "📋 Copy address",
      copy_text: { text: ADDRESS },
    });
  });

  it("publishes the command menu", async () => {
    const { adapter, calls } = telegram();
    await adapter.registerCommands(commandMenu(FLAGS));
    assert.equal(calls[0]?.method, "setMyCommands");
    assert.equal((calls[0]?.body["commands"] as unknown[]).length, 7);
  });

  it("icon labels still pair two to a row, and a long label does not", async () => {
    const { adapter, calls } = telegram();
    const suggestion = (label: string) => ({
      type: "ACTION" as const,
      semantic: "SUGGESTION" as const,
      label,
      handle: "AbCdEfGhIjKlMnOpQrStUv",
    });
    await adapter.send(
      { externalConversationId: "5" },
      {
        text: "hi",
        actions: ["💰 Fund wallet", "💸 Send money", "💱 Today's rates", "👛 Balance"].map(
          suggestion,
        ),
      },
    );
    const rows = (calls[0]?.body["reply_markup"] as { inline_keyboard: { text: string }[][] })
      .inline_keyboard;
    assert.deepEqual(
      rows.map((row) => row.map((b) => b.text)),
      [
        ["💰 Fund wallet", "💸 Send money"],
        ["💱 Today's rates", "👛 Balance"],
      ],
    );
  });
});

void randomUUID;
