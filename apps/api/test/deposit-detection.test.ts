import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ChainBalanceReader } from "@kaada/blockchain";
import type { ChainReader } from "@kaada/blockchain";
import { TEST_NETWORK_TOKENS } from "@kaada/config";
import type { AppConfig } from "@kaada/config";
import { createId } from "@kaada/domain";
import type { Asset, AssetRegistry, Wallet, WalletFundingEvent } from "@kaada/domain";

import { ChannelActionService } from "../src/core/channels/action-service.js";
import { FundingAnnouncer } from "../src/core/channels/funding-announcer.js";
import { ChannelIdentityService } from "../src/core/channels/identity-service.js";
import { ChannelMessageService } from "../src/core/channels/message-service.js";
import type { OpenPaymentNeeds } from "../src/core/intents/coordinator.js";
import { WalletBalanceService } from "../src/core/wallets/balance-service.js";
import { WalletFundingWatcher } from "../src/core/wallets/funding-watcher.js";
import { testNetworkAssets } from "../src/wallet/network-tokens.js";
import { FakeAdapter, createMemoryChannelStores } from "./support/channels-memory.js";
import { MemoryFundingStore } from "./support/funding-memory.js";
import { SENDER, createHarness } from "./support/harness.js";

const MAIN = 42220;
const TEST = 11142220;
const WALLET = "0x7f69f66bd039f9d57d32e1d34e86aa19597598c0";
const MAIN_CNGN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const JUNK = "0x1111111111111111111111111111111111111111";
const TEST_CNGN = TEST_NETWORK_TOKENS["celo-sepolia"][0]?.contractAddress.toLowerCase() ?? "";
const T0 = new Date("2026-10-14T12:00:00Z");
const CNGN = (units: number) => BigInt(units) * 1_000_000n;

const mainCngn: Asset = {
  id: createId(),
  symbol: "cNGN",
  name: "cNGN",
  kind: "LOCAL_STABLECOIN",
  decimals: 6,
  chainId: MAIN,
  contractAddress: MAIN_CNGN,
  isActive: true,
};
const testAssets = testNetworkAssets({
  wallet: { balances: { network: "celo-sepolia", chainId: TEST, testnet: true } },
} as unknown as AppConfig) as Asset[];
const testCngn = testAssets.find((asset) => asset.symbol === "cNGN") as Asset;

/** A chain with a ledger keyed by chain + contract + owner, so reading the wrong network or contract shows up as zero. */
class FakeChain implements ChainReader {
  readonly calls: { owner: string; tokens: string[] }[] = [];
  constructor(
    private readonly chainId: number,
    private readonly ledger: Map<string, bigint>,
  ) {}
  getErc20Balances(owner: string, tokens: string[]): Promise<bigint[]> {
    this.calls.push({ owner, tokens: tokens.map((token) => token.toLowerCase()) });
    return Promise.resolve(
      tokens.map(
        (token) =>
          this.ledger.get(
            `${String(this.chainId)}:${token.toLowerCase()}:${owner.toLowerCase()}`,
          ) ?? 0n,
      ),
    );
  }
  getErc20Decimals(tokens: string[]): Promise<number[]> {
    return Promise.resolve(tokens.map(() => 6));
  }
}

/** What a person is shown: the zero lines are left out (as the chat does). */
const held = <T extends { money: { amount: string } }>(view: { balances: T[] }): T[] =>
  view.balances.filter((line) => line.money.amount !== "0");

function world() {
  const ledger = new Map<string, bigint>();
  const set = (chainId: number, contract: string, units: bigint) =>
    ledger.set(`${String(chainId)}:${contract}:${WALLET}`, units);
  const mainChain = new FakeChain(MAIN, ledger);
  const testChain = new FakeChain(TEST, ledger);
  const all = new Map<string, Asset>([
    [mainCngn.id, mainCngn],
    ...testAssets.map((a): [string, Asset] => [a.id, a]),
  ]);
  const registry = {
    getById: (id: string) => Promise.resolve(all.get(id) ?? null),
  } as unknown as AssetRegistry;
  const reader = new ChainBalanceReader({
    assets: registry,
    chain: mainChain,
    networks: { [TEST]: testChain },
  });
  const wallet: Wallet = {
    id: createId(),
    userId: SENDER,
    chainId: MAIN,
    address: WALLET,
    isPrimary: true,
    type: "EMBEDDED",
    status: "ACTIVE",
    deployment: "COUNTERFACTUAL",
    createdAt: T0,
    updatedAt: T0,
  };
  const balances = (network: "test" | "main" = "test") =>
    new WalletBalanceService({
      assets: { listActive: () => Promise.resolve([mainCngn]) },
      reader,
      wallets: { getWallet: () => Promise.resolve(wallet) },
      ...(network === "test"
        ? {
            network: { chainId: TEST, label: "Celo Sepolia (test network)", testnet: true },
            networkTokens: () => Promise.resolve(testAssets),
          }
        : {}),
    });
  return { ledger, set, mainChain, testChain, reader, balances };
}

function watcherOver(
  w: ReturnType<typeof world>,
  store: MemoryFundingStore,
  extra: { beforeCommit?: () => Promise<void>; now?: () => Date } = {},
) {
  return new WalletFundingWatcher({
    store,
    reader: w.reader,
    tokens: () => w.balances().supportedTokens(),
    chainId: TEST,
    dustDecimalsBelow: 2,
    newWalletMs: 24 * 3_600_000,
    now: extra.now ?? (() => T0),
    ...(extra.beforeCommit && { beforeCommit: extra.beforeCommit }),
  });
}

const freshWallet = { userId: SENDER, address: WALLET, activatedAt: T0 };

describe("the balance is read on the right network and contract", () => {
  it("finds the 1,000 test cNGN at the test contract on the test network", async () => {
    const w = world();
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    const view = await w.balances().forUser(SENDER);
    assert.deepEqual(
      held(view).map((line) => [line.symbol, line.formatted, line.assetId]),
      [["cNGN", "1000", testCngn.id]],
    );
    assert.equal(w.testChain.calls.length > 0, true);
    assert.deepEqual(w.testChain.calls[0]?.tokens.includes(TEST_CNGN), true);
    assert.equal(w.mainChain.calls.length, 0, "mainnet is not touched");
  });

  it("never uses the mainnet cNGN address on the test network, and the two never share an identity", async () => {
    const w = world();
    w.set(MAIN, MAIN_CNGN, CNGN(5));
    const view = await w.balances().forUser(SENDER);
    assert.deepEqual(held(view), [], "the mainnet token's money is not the test network's");
    assert.ok(w.testChain.calls.every((call) => !call.tokens.includes(MAIN_CNGN)));
    assert.notEqual(mainCngn.id, testCngn.id);
    await assert.rejects(
      w.reader.readBalances({ chainId: TEST, address: WALLET, assetIds: [mainCngn.id] }),
      /ASSET_NOT_SUPPORTED|only ERC-20 tokens of this network/,
    );
    // And a network with no reader is refused rather than read from the wrong chain.
    await assert.rejects(
      w.reader.readBalances({ chainId: 1, address: WALLET, assetIds: [] }),
      /cannot be read on this network/,
    );
  });

  it("mainnet behaves as before and does not know the test token", async () => {
    const w = world();
    w.set(MAIN, MAIN_CNGN, CNGN(7));
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    const view = await w.balances("main").forUser(SENDER);
    assert.deepEqual(
      view.balances.map((line) => [line.assetId, line.formatted]),
      [[mainCngn.id, "7"]],
    );
    assert.ok(w.mainChain.calls.every((call) => !call.tokens.includes(TEST_CNGN)));
  });

  it("an unsupported token held by the wallet never appears (only registry tokens are read)", async () => {
    const w = world();
    w.set(TEST, JUNK, CNGN(9_999));
    w.set(TEST, TEST_CNGN, CNGN(3));
    const view = await w.balances().forUser(SENDER);
    assert.deepEqual(
      held(view).map((line) => line.symbol),
      ["cNGN"],
    );
    assert.ok(w.testChain.calls.every((call) => !call.tokens.includes(JUNK)));
  });

  it("/balance reflects a deposit immediately: nothing is cached", async () => {
    const w = world();
    const service = w.balances();
    assert.deepEqual(held(await service.forUser(SENDER)), [], "empty first");
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    assert.deepEqual(
      held(await service.forUser(SENDER)).map((line) => line.formatted),
      ["1000"],
    );
  });
});

describe("deposit detection", () => {
  it("0 -> 1,000 cNGN is exactly one funding event; polling again adds nothing", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    const watcher = watcherOver(w, store);
    assert.equal((await watcher.poll()).events, 0, "an empty wallet is only baselined");
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    assert.equal((await watcher.poll()).events, 1);
    assert.equal((await watcher.poll()).events, 0);
    assert.equal((await watcher.poll()).events, 0);
    assert.equal(store.events.length, 1);
    const [item] = store.events[0]?.items ?? [];
    assert.deepEqual(
      [item?.symbol, item?.previous, item?.current, item?.delta],
      ["cNGN", "0", CNGN(1_000).toString(), CNGN(1_000).toString()],
    );
  });

  it("1,000 -> 1,200 is a deposit of 200; a fall is silent; dust is silent; the next rise counts from the lower balance", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    const watcher = watcherOver(w, store);
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    await watcher.poll();
    assert.equal(store.events.length, 1);
    w.set(TEST, TEST_CNGN, CNGN(1_200));
    await watcher.poll();
    assert.equal(store.events.length, 2);
    assert.equal(store.events[1]?.items[0]?.delta, CNGN(200).toString());
    assert.equal(store.events[1]?.items[0]?.previous, CNGN(1_000).toString());
    w.set(TEST, TEST_CNGN, CNGN(900));
    await watcher.poll();
    assert.equal(store.events.length, 2, "spending is not news");
    w.set(TEST, TEST_CNGN, CNGN(900) + 1_000n);
    await watcher.poll();
    assert.equal(store.events.length, 2, "a thousandth of a token is dust");
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    await watcher.poll();
    assert.equal(store.events.length, 3);
    assert.equal(store.events[2]?.items[0]?.delta, (CNGN(100) - 1_000n).toString());
  });

  it("several tokens arriving together are ONE event", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    const watcher = watcherOver(w, store);
    await watcher.poll();
    const usdc = TEST_NETWORK_TOKENS["celo-sepolia"].find((token) => token.symbol === "USDC");
    w.set(TEST, TEST_CNGN, CNGN(10));
    w.set(TEST, usdc?.contractAddress.toLowerCase() ?? "", 25_000_000n);
    await watcher.poll();
    assert.equal(store.events.length, 1);
    assert.deepEqual(store.events[0]?.items.map((item) => item.symbol).sort(), ["USDC", "cNGN"]);
  });

  it("two workers that see the same deposit at the same moment produce one event", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    await watcherOver(w, store).poll(); // baseline
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const barrier = async () => {
      arrived += 1;
      if (arrived === 2) open();
      await gate; // both have read the chain and the checkpoint; now both commit
    };
    const [a, b] = await Promise.all([
      watcherOver(w, store, { beforeCommit: barrier }).poll(),
      watcherOver(w, store, { beforeCommit: barrier }).poll(),
    ]);
    assert.equal(a.events + b.events, 1);
    assert.equal(store.events.length, 1);
  });

  it("a restart does not repeat an event, and an old wallet is baselined, not announced", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    await watcherOver(w, store).poll();
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    await watcherOver(w, store).poll();
    assert.equal(store.events.length, 1);
    // "Restart": brand new instances over the same persisted state.
    assert.equal((await watcherOver(w, store).poll()).events, 0);
    assert.equal((await watcherOver(w, store).poll()).events, 0);
    assert.equal(store.events.length, 1);

    // Money already in a long-established wallet when the feature is switched on is not "just received".
    const other = world();
    const fresh = new MemoryFundingStore();
    fresh.watch({ userId: SENDER, address: WALLET, activatedAt: new Date("2026-01-01T00:00:00Z") });
    other.set(TEST, TEST_CNGN, CNGN(1_000));
    assert.equal((await watcherOver(other, fresh).poll()).events, 0);
    assert.equal(fresh.checkpoints.size, 1, "the balance is remembered");
  });

  it("a failed read changes nothing, and the same deposit is found on the next pass", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    const watcher = watcherOver(w, store);
    await watcher.poll();
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    const original = w.testChain.getErc20Balances.bind(w.testChain);
    w.testChain.getErc20Balances = () => Promise.reject(new Error("rpc down"));
    const failed = await watcher.poll();
    assert.deepEqual([failed.failed, failed.events], [1, 0]);
    w.testChain.getErc20Balances = original;
    assert.equal((await watcher.poll()).events, 1);
    assert.equal(store.events.length, 1);
  });
});

/** The chat side: a real ChannelMessageService over a fake adapter and agent. */
function chat(options: {
  needs?: OpenPaymentNeeds | undefined;
  held?: { symbol: string; assetId: string; amount: string }[];
}) {
  const h = createHarness();
  const stores = createMemoryChannelStores();
  const adapter = new FakeAdapter();
  let agentTurns = 0;
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
      handle: () => {
        agentTurns += 1;
        return Promise.reject(new Error("a deposit must never run the agent"));
      },
      openPaymentNeeds: () => Promise.resolve(options.needs),
    },
    linked: {
      listForUser: () => Promise.resolve([{ type: "TELEGRAM", externalId: "424242" }] as never),
    },
    funding: {
      info: () => Promise.resolve(null),
      holdings: () => Promise.resolve(options.held ?? null),
    },
    resumeWindowMs: 3_600_000,
    matchBySymbol: true,
    links: {
      setupLink: () => Promise.resolve(null),
      authorizationLink: () => Promise.reject(new Error("a deposit never asks for authorization")),
    },
    wallets: { hasActiveWallet: () => Promise.resolve(true) },
    facts: { read: () => Promise.reject(new Error("unused")) },
    now: () => T0,
  } as never);
  return { adapter, service, agentTurns: () => agentTurns };
}

const funded = (previous: bigint, current: bigint): WalletFundingEvent => ({
  id: createId(),
  userId: SENDER,
  chainId: TEST,
  address: WALLET,
  items: [
    {
      assetId: testCngn.id,
      symbol: "cNGN",
      decimals: 6,
      previous: previous.toString(),
      current: current.toString(),
      delta: (current - previous).toString(),
    },
  ],
  createdAt: T0,
  attempts: 0,
});

const openPayment = (minutesAgo: number): OpenPaymentNeeds => ({
  resume: {
    intentId: createId(),
    revision: 2,
    operation: "SEND",
    recipient: "Daniel",
    amount: "500 cNGN",
    pending: false,
  },
  lastActiveAt: new Date(T0.getTime() - minutesAgo * 60_000),
  required: { symbol: "cNGN", assetId: mainCngn.id, amount: CNGN(500).toString() },
});
const holding = (units: number) => [
  { symbol: "cNGN", assetId: testCngn.id, amount: CNGN(units).toString() },
];

describe("telling people", () => {
  it("a plain deposit says what arrived, with a couple of useful buttons", async () => {
    const { adapter, service } = chat({});
    const result = await service.announceFunding(funded(0n, CNGN(1_000)));
    assert.deepEqual(result, { delivered: 1, failed: 0 });
    const message = adapter.sent[0];
    assert.match(
      message?.text ?? "",
      /^Nice, your wallet just received 1,000 cNGN 💰\n\nYou're ready to use it\.$/,
    );
    const labels = (message?.actions ?? []).map((a) => ("label" in a ? a.label : ""));
    assert.ok(labels.length <= 2, "no pile of buttons");
  });

  it("an open, recent payment that this deposit makes affordable is offered back with Continue and Cancel", async () => {
    const { adapter, service, agentTurns } = chat({ needs: openPayment(10), held: holding(1_000) });
    await service.announceFunding(funded(0n, CNGN(1_000)));
    const message = adapter.sent[0];
    assert.match(
      message?.text ?? "",
      /Your cNGN just arrived 💰[\s\S]*enough to continue your payment to Daniel/,
    );
    const semantics = (message?.actions ?? []).map((a) => ("semantic" in a ? a.semantic : ""));
    assert.ok(semantics.includes("CONTINUE_PAYMENT") && semantics.includes("CANCEL"));
    assert.equal(adapter.sent.length, 1, "one message, and nothing was run or authorized by it");
    assert.equal(agentTurns(), 0);
  });

  it("a payment that is still too big, or was already affordable, is not claimed as unlocked", async () => {
    const short = chat({ needs: openPayment(10), held: holding(300) });
    await short.service.announceFunding(funded(0n, CNGN(300)));
    assert.match(short.adapter.sent[0]?.text ?? "", /^Nice, your wallet just received 300 cNGN/);

    const already = chat({ needs: openPayment(10), held: holding(1_500) });
    await already.service.announceFunding(funded(CNGN(1_000), CNGN(1_500)));
    assert.match(already.adapter.sent[0]?.text ?? "", /^Nice, your wallet just received 500 cNGN/);
  });

  it("a payment left open longer than the progress window is NOT brought back", async () => {
    const { adapter, service } = chat({ needs: openPayment(61), held: holding(1_000) });
    await service.announceFunding(funded(0n, CNGN(1_000)));
    const message = adapter.sent[0];
    assert.match(message?.text ?? "", /^Nice, your wallet just received 1,000 cNGN/);
    const semantics = (message?.actions ?? []).map((a) => ("semantic" in a ? a.semantic : ""));
    assert.ok(!semantics.includes("CONTINUE_PAYMENT"));
  });

  it("delivery is claimed once and marked delivered; a failed delivery is retried, not lost", async () => {
    const w = world();
    const store = new MemoryFundingStore();
    store.watch(freshWallet);
    const { adapter, service } = chat({});
    const announcer = new FundingAnnouncer({
      watcher: watcherOver(w, store),
      store,
      announce: (event) => service.announceFunding(event),
      now: () => T0,
    });
    await announcer.sweep(); // baseline
    w.set(TEST, TEST_CNGN, CNGN(1_000));
    adapter.failNextSend = true;
    const first = await announcer.sweep();
    assert.deepEqual([first.announced, first.failed], [0, 1]);
    const second = await announcer.sweep();
    assert.deepEqual([second.announced, second.failed], [1, 0]);
    await announcer.sweep();
    await announcer.sweep();
    assert.equal(adapter.sent.length, 1, "told exactly once");
    assert.equal(store.events.length, 1);
  });
});
