import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { CELO_CHAIN_ID, isCandidateSetCurrent } from "@kaada/domain";
import type {
  Asset,
  CandidateResult,
  CapabilityType,
  Provider,
  ProviderCapability,
  ProviderRepository,
  RoutingCandidateSet,
} from "@kaada/domain";

import { composeRevisionHooks } from "../src/core/intents/intent-commit.js";
import { createCandidateServices } from "../src/core/routing/candidate-services.js";
import type { AgentTurnResult } from "../src/core/agent/agent-service.js";
import { createHarness, intent, SENDER } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

/*
 * The agent hands a RoutingRequest to the candidate resolver (Build 7). Capabilities below are TEST
 * FIXTURES: the seeded database has none, and nothing here claims Textile supports anything.
 */

function setup(options: Parameters<typeof createHarness>[0] = {}) {
  const h = createHarness(options);
  const wBRL: Asset = {
    id: randomUUID(),
    symbol: "wBRL",
    name: "wBRL (test fixture)",
    kind: "LOCAL_STABLECOIN",
    decimals: 6,
    chainId: CELO_CHAIN_ID,
    contractAddress: "0x0000000000000000000000000000000000000b01",
    fiatCode: "BRL",
    countryCode: "BR",
    isActive: true,
  };
  h.world.addAsset(wBRL);

  const textile: Provider = {
    id: randomUUID(),
    slug: "textile",
    name: "Textile",
    type: "FX",
    isActive: true,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const rows: ProviderCapability[] = [];
  const providers: ProviderRepository = {
    findBySlug: () => Promise.resolve(textile),
    listActive: () => Promise.resolve([textile]),
    listCapabilities: () => Promise.resolve(rows.filter((row) => row.isActive)),
  };
  const allow = (input: Asset, output: Asset, types: CapabilityType[]) => {
    for (const capability of types) {
      rows.push({
        id: randomUUID(),
        providerId: textile.id,
        capability,
        chainId: CELO_CHAIN_ID,
        inputAssetId: input.id,
        outputAssetId: output.id,
        isActive: true,
        metadata: {},
        createdAt: new Date(0),
        updatedAt: new Date(0),
      });
    }
  };
  const services = createCandidateServices({ assets: h.world.repositories.assets, providers });
  h.world.addRecipient({
    id: randomUUID(),
    ownerUserId: SENDER,
    type: "SAVED_BENEFICIARY",
    displayName: "João Silva",
    identifier: "joao",
    destinationCountry: "BR",
  });
  return { h, wBRL, services, allow };
}

const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };

async function candidatesFor(
  services: ReturnType<typeof setup>["services"],
  turn: AgentTurnResult,
): Promise<CandidateResult> {
  assert.equal(turn.response.type, "ROUTING_REQUIRED", JSON.stringify(turn.response));
  if (turn.response.type !== "ROUTING_REQUIRED") throw new Error("unreachable");
  return services.candidates.resolve(turn.response.request);
}

function ready(result: CandidateResult): RoutingCandidateSet {
  assert.equal(result.status, "READY", JSON.stringify(result));
  if (result.status !== "READY") throw new Error("unreachable");
  return result.set;
}

describe("agent hand-off to candidate resolution", () => {
  it("turns 'Send João exactly R$500' into a wBRL candidate, carrying the intent revision", async () => {
    const { h, wBRL, services, allow } = setup();
    allow(h.assets.USDT, wBRL, ["QUOTE", "SWAP", "EXACT_OUTPUT"]);
    h.script.set(
      "send joão exactly r$500",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      }),
    );
    const turn = await h.say("send joão exactly r$500");
    const set = ready(await candidatesFor(services, turn));

    assert.equal(set.intentRevision, 1);
    assert.equal(set.amount.denomination, "BRL");
    assert.equal(set.amount.humanValue, "500");
    assert.equal(set.amount.mode, "EXACT_OUTPUT");
    assert.deepEqual(
      set.destination.candidates.map((c) => [c.symbol, c.providers]),
      [["wBRL", ["textile"]]],
    );
    // USDC (on Celo) has no provider for the pair, so it is not offered; USDT is, as a candidate only.
    assert.deepEqual(
      set.source.candidates.map((c) => c.symbol),
      ["USDT"],
    );
    assert.equal(set.recipient?.displayName, "João Silva");
    assert.equal(set.destinationCountry, "BR");
    assert.equal(JSON.stringify(set).includes("route"), false, "no route is chosen");
  });

  it("keeps a 'use USDT' preference through persistence and into the candidate set", async () => {
    const { h, wBRL, services, allow } = setup();
    allow(h.assets.USDT, wBRL, ["QUOTE", "SWAP", "EXACT_INPUT"]);
    allow(h.assets.USDC_CELO, wBRL, ["QUOTE", "SWAP", "EXACT_INPUT"]);
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    h.script.set("use usdt", intent({ type: "SEND", sourceAsset: "USDT" }));

    const without = ready(await candidatesFor(services, await h.say("send $20 to joão")));
    assert.deepEqual(without.source.candidates.map((c) => c.symbol).sort(), ["USDC", "USDT"]);
    assert.equal(without.source.origin, "SETTLEMENT");
    assert.equal(without.explicitSourceAssetId, null);
    assert.equal(without.amount.denomination, "USD", "USD stays a currency, not a token");

    const withPreference = ready(await candidatesFor(services, await h.say("use usdt")));
    assert.equal(withPreference.explicitSourceAssetId, h.assets.USDT.id);
    assert.deepEqual(
      withPreference.source.candidates.map((c) => c.symbol),
      ["USDT"],
    );
    assert.equal(withPreference.intentRevision, without.intentRevision + 1);
  });

  it("makes a candidate set stale as soon as the intent changes", async () => {
    const { h, wBRL, services, allow } = setup();
    allow(h.assets.USDT, wBRL, ["QUOTE", "SWAP", "EXACT_INPUT"]);
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    h.script.set(
      "make it $40",
      intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    );
    const first = await h.say("send $20 to joão");
    const set = ready(await candidatesFor(services, first));
    const stored = h.world.intents.get(first.intentId ?? "");
    assert.ok(stored);
    assert.equal(isCandidateSetCurrent(set, stored), true);

    await h.say("make it $40");
    const after = h.world.intents.get(first.intentId ?? "");
    assert.ok(after);
    assert.equal(isCandidateSetCurrent(set, after), false, "the old set is bound to revision 1");
  });

  it("returns an explicit, safe answer for a corridor nobody supports, without a route or quote", async () => {
    const { h, services } = setup();
    h.script.set(
      "send joão exactly r$500",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      }),
    );
    const result = await candidatesFor(services, await h.say("send joão exactly r$500"));
    assert.equal(result.status, "UNSUPPORTED");
    assert.equal(result.status === "UNSUPPORTED" && result.code, "NO_PROVIDER_FOR_PAIR");
    assert.equal(
      result.status === "UNSUPPORTED" && result.text,
      "I don't have a supported way to convert USD to BRL yet.",
    );
  });

  it("does not turn a currency into a token by name: no BRL token means no settlement asset", async () => {
    const h: Harness = createHarness();
    h.world.addRecipient({
      id: randomUUID(),
      ownerUserId: SENDER,
      type: "SAVED_BENEFICIARY",
      displayName: "João Silva",
      identifier: "joao",
      destinationCountry: "BR",
    });
    const services = createCandidateServices({
      assets: h.world.repositories.assets,
      providers: {
        findBySlug: () => Promise.resolve(null),
        listActive: () => Promise.resolve([]),
        listCapabilities: () => Promise.resolve([]),
      },
    });
    h.script.set(
      "send joão exactly r$500",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "500", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
      }),
    );
    const result = await candidatesFor(services, await h.say("send joão exactly r$500"));
    assert.equal(result.status === "UNSUPPORTED" && result.code, "NO_SETTLEMENT_ASSET");
    assert.equal(
      result.status === "UNSUPPORTED" && result.text,
      "I currently don't have a supported settlement route for BRL.",
    );
  });
});

describe("revision hook", () => {
  it("runs every composed hook once per revision, in order", async () => {
    const calls: string[] = [];
    const hook = composeRevisionHooks(
      () => {
        calls.push("first");
        return Promise.resolve();
      },
      () => {
        calls.push("second");
        return Promise.resolve();
      },
    );
    const { h } = setup({ onIntentRevised: hook });
    h.script.set(
      "send $20 to joão",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "20", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      }),
    );
    h.script.set(
      "make it $40",
      intent({ type: "SEND", amount: { value: "40", currencyOrAsset: "USD" } }),
    );
    await h.say("send $20 to joão");
    assert.deepEqual(calls, []);
    await h.say("make it $40");
    assert.deepEqual(calls, ["first", "second"]);
  });
});
