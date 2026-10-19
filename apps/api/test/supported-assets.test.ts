import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { createId } from "@kaada/domain";

import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { ChannelActionService } from "../src/core/channels/action-service.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import { ConversationPresenter } from "../src/core/conversation/presenter.js";
import { deriveResponseState } from "../src/core/conversation/states.js";
import { INTENT_SYSTEM_PROMPT } from "../src/infrastructure/llm/intent-prompt.js";
import { FakeAdapter, createMemoryChannelStores, inbound } from "./support/channels-memory.js";
import { SENDER, createHarness } from "./support/harness.js";

const ADDRESS = "0x62a39b4081d6e763fbf6a2b75b9ad06541327cf9";

/** A chat deployment whose agent answers every message with the given topic, and whose wallet is funded-ready. */
function world(topic: "SUPPORTED_ASSETS" | "FUNDING", hasWallet = true) {
  const h = createHarness();
  h.world.addIdentity({ id: createId(), userId: SENDER, type: "TELEGRAM", externalId: "424242" });
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
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
      handle: (): Promise<AgentTurnResult> =>
        Promise.resolve({
          conversationId: randomUUID(),
          messageId: randomUUID(),
          duplicate: false,
          response: { type: "CHAT", topic, text: "model wording that must not be used" },
        }),
    },
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
    linked: h.world.repositories.identities,
    funding: {
      info: () =>
        Promise.resolve(
          hasWallet
            ? {
                address: ADDRESS,
                network: "Celo",
                assets: ["🇳🇬 Nigerian Naira", "🇺🇸 US Dollar"],
              }
            : null,
        ),
    },
    links: {
      setupLink: () => Promise.resolve("https://app.kaada.test/setup/T"),
      authorizationLink: () => Promise.resolve("https://app.kaada.test/authorize/T"),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(hasWallet) },
    facts: { read: () => Promise.reject(new Error("unused")) },
  });
  return { adapter, service };
}

let n = 0;
const say = (text: string) => inbound({ eventId: `sa-${String(++n)}`, text, at: new Date() });

describe("'can I receive CELO?' and 'what do you support?' are answered from the wallet's real details", () => {
  it("lists the supported currencies by name, says CELO can be received for fees, and offers to fund", async () => {
    const { adapter, service } = world("SUPPORTED_ASSETS");
    await service.handleInbound(say("Can I receive CELO?"));
    const reply = adapter.sent.at(-1);
    assert.match(reply?.text ?? "", /Nigerian Naira/);
    assert.match(reply?.text ?? "", /US Dollar/);
    assert.match(reply?.text ?? "", /CELO: yes, you can receive a small amount of CELO/);
    assert.match(reply?.text ?? "", /network fee/);
    assert.doesNotMatch(reply?.text ?? "", /model wording that must not be used/);
    assert.doesNotMatch(reply?.text ?? "", /USDT|USDC|cNGN/, "currencies are named, never tickers");
    assert.ok((reply?.actions ?? []).length > 0, "a way forward (fund wallet) is offered");
  });

  it("a person with no wallet yet gets the setup step, not a list for a wallet that does not exist", async () => {
    const { adapter, service } = world("SUPPORTED_ASSETS", false);
    await service.handleInbound(say("what coin do you support?"));
    assert.doesNotMatch(adapter.sent.at(-1)?.text ?? "", /CELO: yes/);
  });

  it("'where is my wallet address' (a funding question) shows the wallet address", async () => {
    const { adapter, service } = world("FUNDING");
    await service.handleInbound(
      say("I am going to ask my friend to send me some funds, where is my wallet address"),
    );
    assert.ok(adapter.sent.some((m) => (m.text ?? "").includes(ADDRESS)));
  });

  it("the topic is a known chat state, so it can never fall through to a generic reply", () => {
    assert.equal(
      deriveResponseState({ response: { type: "CHAT", topic: "SUPPORTED_ASSETS", text: "x" } }),
      "CAPABILITY_DISCOVERY",
    );
  });
});

describe("the interpreter is told to read intent, not keywords", () => {
  it("names the funding and supported-assets topics with the phrasings people actually use", () => {
    assert.match(INTENT_SYSTEM_PROMPT, /where is my wallet address/);
    assert.match(INTENT_SYSTEM_PROMPT, /SUPPORTED_ASSETS/);
    assert.match(
      INTENT_SYSTEM_PROMPT,
      /Can I receive CELO\?" -> \{"type":"HELP","topic":"SUPPORTED_ASSETS"\}/,
    );
    assert.match(INTENT_SYSTEM_PROMPT, /Decide by what the person WANTS, not by keywords/);
  });
});
