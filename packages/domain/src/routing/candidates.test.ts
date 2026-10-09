import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssetRegistry, defaultCountryDirectory } from "../assets/index.js";
import type { Asset, AssetRepository } from "../assets/index.js";
import type { RoutingRequest } from "../intents/routing-request.js";
import { createMoney } from "../money/index.js";
import { createProviderCapabilityRegistry } from "../providers/index.js";
import type {
  CapabilityType,
  Provider,
  ProviderCapability,
  ProviderRepository,
} from "../providers/index.js";
import { CELO_CHAIN_ID, createSettlementAssetResolver } from "../settlement/index.js";
import { createRoutingCandidateResolver, isCandidateSetCurrent } from "./candidate-resolver.js";
import type { CandidateResult, RoutingCandidateSet } from "./candidates.js";

/*
 * TEST FIXTURES ONLY. The ids and addresses below are made up so the resolver can be exercised on
 * shapes that do not exist in the seeded database (no Textile capability is seeded at all). Nothing
 * here claims any provider supports any pair.
 */

let counter = 0;
const id = (label: string) =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}-${label}`.slice(0, 36);

const fiat = (code: string, countryCode: string): Asset => ({
  id: id(code),
  symbol: code,
  name: code,
  kind: "FIAT",
  decimals: 2,
  fiatCode: code,
  countryCode,
  isActive: true,
});

const token = (
  symbol: string,
  kind: "USD_STABLECOIN" | "LOCAL_STABLECOIN",
  fiatCode: string,
  extra: Partial<Asset> = {},
): Asset => ({
  id: id(symbol),
  symbol,
  name: symbol,
  kind,
  decimals: 6,
  chainId: CELO_CHAIN_ID,
  contractAddress: `0x${String(++counter).padStart(40, "0")}`,
  fiatCode,
  isActive: true,
  ...extra,
});

function createWorld() {
  const a = {
    USD: fiat("USD", "US"),
    BRL: fiat("BRL", "BR"),
    ARS: fiat("ARS", "AR"),
    MXN: fiat("MXN", "MX"),
    COP: fiat("COP", "CO"),
    PEN: fiat("PEN", "PE"),
    CLP: fiat("CLP", "CL"),
    NGN: fiat("NGN", "NG"),
    USDT: token("USDT", "USD_STABLECOIN", "USD"),
    USDC: token("USDC", "USD_STABLECOIN", "USD"),
    wBRL: token("wBRL", "LOCAL_STABLECOIN", "BRL", { countryCode: "BR" }),
    wARS: token("wARS", "LOCAL_STABLECOIN", "ARS", { countryCode: "AR" }),
    wMXN: token("wMXN", "LOCAL_STABLECOIN", "MXN", { countryCode: "MX" }),
    wCOP: token("wCOP", "LOCAL_STABLECOIN", "COP", { countryCode: "CO" }),
    wPEN: token("wPEN", "LOCAL_STABLECOIN", "PEN", { countryCode: "PE" }),
    wCLP: token("wCLP", "LOCAL_STABLECOIN", "CLP", { countryCode: "CL" }),
    // Another BRL token, so BRL has two settlement assets.
    BRLX: token("BRLX", "LOCAL_STABLECOIN", "BRL", { countryCode: "BR" }),
    // A token that is not marked as representing any currency, and one on another chain.
    LOOSE: token("LOOSE", "USD_STABLECOIN", "USD", { chainId: 1 }),
  };
  const assets = Object.values(a);
  const assetRepository: AssetRepository = {
    findById: (assetId) => Promise.resolve(assets.find((x) => x.id === assetId) ?? null),
    findBySymbol: (symbol, o) =>
      Promise.resolve(
        assets.filter(
          (x) =>
            x.symbol.toLowerCase() === symbol.toLowerCase() &&
            (o?.chainId === undefined || x.chainId === o.chainId),
        ),
      ),
    findByFiatCode: (code) =>
      Promise.resolve(assets.filter((x) => x.kind === "FIAT" && x.fiatCode === code.toUpperCase())),
    findByDenomination: (code, o) =>
      Promise.resolve(
        assets.filter(
          (x) =>
            x.kind !== "FIAT" &&
            x.fiatCode === code.toUpperCase() &&
            (o?.chainId === undefined || x.chainId === o.chainId),
        ),
      ),
    listActive: () => Promise.resolve(assets.filter((x) => x.isActive)),
    listAll: () => Promise.resolve([...assets]),
  };

  const providers: Provider[] = (["textile", "ripio"] as const).map((slug) => ({
    id: id(slug),
    slug,
    name: slug,
    type: slug === "textile" ? "FX" : "RAMP",
    isActive: true,
    metadata: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }));
  const textile = providers[0] as Provider;
  const ripio = providers[1] as Provider;
  const capabilities: ProviderCapability[] = [];
  let reads = 0;

  const providerRepository: ProviderRepository = {
    findBySlug: (slug) => Promise.resolve(providers.find((p) => p.slug === slug) ?? null),
    listActive: () => Promise.resolve(providers.filter((p) => p.isActive)),
    listCapabilities: () => {
      reads += 1;
      const active = new Set(providers.filter((p) => p.isActive).map((p) => p.id));
      return Promise.resolve(capabilities.filter((c) => c.isActive && active.has(c.providerId)));
    },
  };

  const addCapability = (
    provider: Provider,
    capability: CapabilityType,
    over: Partial<ProviderCapability> = {},
  ): ProviderCapability => {
    const row: ProviderCapability = {
      id: id("cap"),
      providerId: provider.id,
      capability,
      chainId: CELO_CHAIN_ID,
      isActive: true,
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    };
    capabilities.push(row);
    return row;
  };

  /** A full set of Textile-style rows for one directed pair. */
  const textilePair = (
    from: Asset,
    to: Asset,
    types: CapabilityType[] = ["QUOTE", "SWAP", "EXACT_INPUT", "EXACT_OUTPUT"],
  ) => {
    for (const type of types) {
      addCapability(textile, type, { inputAssetId: from.id, outputAssetId: to.id });
    }
  };

  const registry = createAssetRegistry(assetRepository);
  let clock = 0;
  const capabilityRegistry = createProviderCapabilityRegistry(providerRepository, {
    ttlMs: 1000,
    now: () => clock,
  });
  const resolver = createRoutingCandidateResolver({
    assets: registry,
    settlement: createSettlementAssetResolver(registry),
    capabilities: capabilityRegistry,
    countries: defaultCountryDirectory,
  });

  return {
    a,
    textile,
    ripio,
    providers,
    capabilities,
    addCapability,
    textilePair,
    registry,
    settlement: createSettlementAssetResolver(registry),
    capabilityRegistry,
    resolver,
    reads: () => reads,
    advance: (ms: number) => void (clock += ms),
    request: (
      over: { [K in keyof RoutingRequest]?: RoutingRequest[K] | undefined } = {},
    ): RoutingRequest => {
      const base: RoutingRequest = {
        intentId: "intent-1",
        intentRevision: 3,
        userId: "user-1",
        operation: "SEND",
        purpose: "PAYMENT",
        amount: createMoney("50000", a.BRL.id),
        amountMode: "EXACT_OUTPUT",
        destinationAssetId: a.BRL.id,
        destinationCountry: "BR",
      };
      const merged: Record<string, unknown> = { ...base };
      for (const [key, value] of Object.entries(over)) {
        if (value === undefined) delete merged[key];
        else merged[key] = value;
      }
      return merged as unknown as RoutingRequest;
    },
  };
}

function ready(result: CandidateResult): RoutingCandidateSet {
  assert.equal(result.status, "READY", JSON.stringify(result));
  if (result.status !== "READY") throw new Error("unreachable");
  return result.set;
}

function unsupported(result: CandidateResult) {
  assert.equal(result.status, "UNSUPPORTED", JSON.stringify(result));
  if (result.status !== "UNSUPPORTED") throw new Error("unreachable");
  return result;
}

describe("SettlementAssetResolver", () => {
  it("resolves BRL to the one active Celo token that is marked as BRL, and keeps fiat BRL separate", async () => {
    const w = createWorld();
    // Only wBRL is marked BRL in this world: drop the second BRL token.
    w.a.BRLX.isActive = false;
    const result = await w.settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "BRL" });
    assert.equal(result.status, "RESOLVED");
    assert.deepEqual(result.status === "RESOLVED" && result.assets.map((x) => x.id), [w.a.wBRL.id]);
    // The fiat asset itself is still the dollar-or-real, never the token.
    assert.deepEqual(
      (await w.registry.findByFiatCode("BRL")).map((x) => x.id),
      [w.a.BRL.id],
    );
  });

  it("never turns BRL into wBRL by symbol: a token is eligible only through explicit metadata", async () => {
    const w = createWorld();
    w.a.wBRL.fiatCode = "ARS"; // metadata says the token is not BRL, whatever its name suggests
    w.a.BRLX.isActive = false;
    const result = await w.settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "BRL" });
    assert.deepEqual(result, {
      status: "UNSUPPORTED",
      denomination: "BRL",
      reason: "NO_SETTLEMENT_ASSET",
    });
  });

  it("offers every USD stablecoin and picks none: USD does not become USDT", async () => {
    const w = createWorld();
    const result = await w.settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "usd" });
    assert.equal(result.status, "AMBIGUOUS");
    assert.deepEqual(
      result.status === "AMBIGUOUS" && result.assets.map((x) => x.symbol).sort(),
      ["USDC", "USDT"],
      "the token on another chain is excluded",
    );
    assert.deepEqual(
      (await w.registry.findByFiatCode("USD")).map((x) => x.id),
      [w.a.USD.id],
    );
  });

  it("reports several settlement assets as ambiguous and none as unsupported", async () => {
    const w = createWorld();
    const brl = await w.settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "BRL" });
    assert.equal(brl.status, "AMBIGUOUS");
    const eur = await w.settlement.resolveCurrency({ chainId: CELO_CHAIN_ID, fiatCode: "EUR" });
    assert.equal(eur.status, "UNSUPPORTED");
  });

  it("resolves explicit assets as themselves, and refuses inactive, unknown or other-chain ones", async () => {
    const w = createWorld();
    const ok = await w.settlement.resolveAsset({ chainId: CELO_CHAIN_ID, assetId: w.a.USDT.id });
    assert.equal(ok.status === "RESOLVED" && ok.assets[0].symbol, "USDT");
    w.a.USDC.isActive = false;
    const inactive = await w.settlement.resolveAsset({
      chainId: CELO_CHAIN_ID,
      assetId: w.a.USDC.id,
    });
    assert.equal(inactive.status === "UNSUPPORTED" && inactive.reason, "ASSET_INACTIVE");
    const other = await w.settlement.resolveAsset({
      chainId: CELO_CHAIN_ID,
      assetId: w.a.LOOSE.id,
    });
    assert.equal(other.status === "UNSUPPORTED" && other.reason, "WRONG_CHAIN");
    const unknown = await w.settlement.resolveAsset({ chainId: CELO_CHAIN_ID, assetId: "nope" });
    assert.equal(unknown.status === "UNSUPPORTED" && unknown.reason, "UNKNOWN_ASSET");
  });
});

describe("ProviderCapabilityRegistry", () => {
  const pair = (w: ReturnType<typeof createWorld>) => ({
    chainId: CELO_CHAIN_ID,
    inputAssetId: w.a.USDT.id,
    outputAssetId: w.a.wBRL.id,
  });

  it("answers pair queries from data, in one direction only", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL);
    const forward = await w.capabilityRegistry.getProvidersForPair({
      ...pair(w),
      capability: "QUOTE",
    });
    assert.deepEqual(
      forward.map((p) => p.providerSlug),
      ["textile"],
    );
    assert.equal(await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "SWAP" }), true);
    const reverse = await w.capabilityRegistry.supportsPair({
      chainId: CELO_CHAIN_ID,
      inputAssetId: w.a.wBRL.id,
      outputAssetId: w.a.USDT.id,
      capability: "QUOTE",
    });
    assert.equal(reverse, false, "a reverse direction is not assumed");
  });

  it("keeps QUOTE and SWAP distinct", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL, ["QUOTE"]);
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "QUOTE" }),
      true,
    );
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "SWAP" }),
      false,
    );
    assert.equal(
      await w.capabilityRegistry.supportsPair({
        ...pair(w),
        capability: "QUOTE",
        alsoRequire: ["SWAP"],
      }),
      false,
    );
  });

  it("keeps EXACT_INPUT and EXACT_OUTPUT distinct", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL, ["QUOTE", "SWAP", "EXACT_INPUT"]);
    const [support] = await w.capabilityRegistry.getCapabilitiesForPair(pair(w));
    assert.deepEqual(support?.capabilities.sort(), ["EXACT_INPUT", "QUOTE", "SWAP"]);
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "EXACT_OUTPUT" }),
      false,
    );
  });

  it("does not match a different pair, a different chain, or an unlisted provider", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL);
    const wrongPair = { ...pair(w), outputAssetId: w.a.wARS.id, capability: "QUOTE" } as const;
    assert.equal(await w.capabilityRegistry.supportsPair(wrongPair), false);
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), chainId: 1, capability: "QUOTE" }),
      false,
    );
    assert.deepEqual(await w.capabilityRegistry.getCapabilitiesForProvider("ripio"), []);
    assert.equal((await w.capabilityRegistry.getCapabilitiesForProvider("textile")).length, 4);
  });

  it("ignores a disabled provider and a disabled capability row", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL);
    w.textile.isActive = false;
    w.capabilityRegistry.invalidate();
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "QUOTE" }),
      false,
    );
    assert.deepEqual(await w.capabilityRegistry.getCapabilitiesForProvider("textile"), []);

    w.textile.isActive = true;
    for (const row of w.capabilities) if (row.capability === "SWAP") row.isActive = false;
    w.capabilityRegistry.invalidate();
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "QUOTE" }),
      true,
    );
    assert.equal(
      await w.capabilityRegistry.supportsPair({ ...pair(w), capability: "SWAP" }),
      false,
    );
  });

  it("finds country-specific ramp capabilities", async () => {
    const w = createWorld();
    w.addCapability(w.ripio, "OFF_RAMP", { inputAssetId: w.a.wBRL.id, countryCode: "BR" });
    w.addCapability(w.ripio, "BANK_PAYOUT", { outputAssetId: w.a.BRL.id, countryCode: "BR" });
    const brazil = await w.capabilityRegistry.getSettlementCapabilities({
      chainId: CELO_CHAIN_ID,
      countryCode: "BR",
      capability: "OFF_RAMP",
    });
    assert.deepEqual(
      brazil.map((c) => c.providerSlug),
      ["ripio"],
    );
    const argentina = await w.capabilityRegistry.getSettlementCapabilities({
      chainId: CELO_CHAIN_ID,
      countryCode: "AR",
    });
    assert.deepEqual(argentina, []);
    const forAsset = await w.capabilityRegistry.getSettlementCapabilities({
      chainId: CELO_CHAIN_ID,
      assetId: w.a.wBRL.id,
    });
    assert.deepEqual(
      forAsset.map((c) => c.capability),
      ["OFF_RAMP"],
    );
  });

  it("caches the snapshot until it expires or is invalidated, and never caches a failure", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL);
    const ask = () => w.capabilityRegistry.supportsPair({ ...pair(w), capability: "QUOTE" });

    await ask();
    await ask();
    assert.equal(w.reads(), 1, "one read serves repeated questions");

    w.textile.isActive = false;
    assert.equal(await ask(), true, "a stale answer is served inside the TTL");
    w.capabilityRegistry.invalidate();
    assert.equal(await ask(), false, "invalidation re-reads the database");
    assert.equal(w.reads(), 2);

    w.advance(2000);
    await ask();
    assert.equal(w.reads(), 3, "expiry re-reads too");

    // A failing read is surfaced and not remembered.
    const flaky = createProviderCapabilityRegistry({
      findBySlug: () => Promise.resolve(null),
      listActive: () => Promise.reject(new Error("db down")),
      listCapabilities: () => Promise.resolve([]),
    });
    await assert.rejects(flaky.getCapabilitiesForProvider("textile"), /db down/);
    await assert.rejects(flaky.getCapabilitiesForProvider("textile"), /db down/);
  });
});

describe("RoutingCandidateSet", () => {
  it("hands over BRL as the verified wBRL candidate, with providers and the intent revision", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);
    w.textilePair(w.a.USDC, w.a.wBRL);

    const set = ready(await w.resolver.resolve(w.request()));
    assert.equal(set.intentRevision, 3);
    assert.equal(set.intentId, "intent-1");
    assert.equal(set.chainId, CELO_CHAIN_ID);
    assert.deepEqual(set.amount, {
      denomination: "BRL",
      assetId: w.a.BRL.id,
      mode: "EXACT_OUTPUT",
      humanValue: "500",
      money: createMoney("50000", w.a.BRL.id),
    });
    assert.deepEqual(
      set.destination.candidates.map((c) => [c.assetId, c.providers]),
      [[w.a.wBRL.id, ["textile"]]],
    );
    assert.deepEqual(set.source.candidates.map((c) => c.symbol).sort(), ["USDC", "USDT"]);
    assert.equal(set.source.origin, "DEFAULT_FUNDING");
    assert.equal(set.explicitSourceAssetId, null);
    assert.deepEqual(set.requiredCapabilities, ["QUOTE", "SWAP", "EXACT_OUTPUT"]);
    assert.equal(isCandidateSetCurrent(set, { id: "intent-1", revision: 3 }), true);
    assert.equal(isCandidateSetCurrent(set, { id: "intent-1", revision: 4 }), false);
  });

  it("USD stays a currency: EXACT_INPUT offers USD stablecoins as candidates, picking none", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);
    const set = ready(
      await w.resolver.resolve(
        w.request({
          amount: createMoney("2000", w.a.USD.id),
          amountMode: "EXACT_INPUT",
          sourceAssetId: w.a.USD.id,
        }),
      ),
    );
    assert.equal(set.amount.denomination, "USD");
    assert.equal(set.amount.humanValue, "20");
    assert.equal(set.source.origin, "SETTLEMENT");
    // USDC has no provider for the pair, so only USDT is retained; nothing was chosen by guesswork.
    assert.deepEqual(
      set.source.candidates.map((c) => c.symbol),
      ["USDT"],
    );
    assert.deepEqual(
      set.pairs.map((p) => p.providers.map((x) => x.slug)),
      [["textile"]],
    );
  });

  it("carries an explicit USDT preference through, and resolves it as the only source", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);
    w.textilePair(w.a.USDC, w.a.wBRL);
    const set = ready(
      await w.resolver.resolve(
        w.request({
          amount: createMoney("2000", w.a.USD.id),
          amountMode: "EXACT_INPUT",
          sourceAssetId: w.a.USD.id,
          preferredSourceAssetId: w.a.USDT.id,
        }),
      ),
    );
    assert.equal(set.explicitSourceAssetId, w.a.USDT.id);
    assert.equal(set.source.origin, "EXPLICIT_PREFERENCE");
    assert.deepEqual(
      set.source.candidates.map((c) => c.assetId),
      [w.a.USDT.id],
    );
  });

  it("fails clearly for an unsupported explicit source asset", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);

    w.a.USDC.isActive = false;
    const inactive = unsupported(
      await w.resolver.resolve(w.request({ preferredSourceAssetId: w.a.USDC.id })),
    );
    assert.equal(inactive.code, "SOURCE_ASSET_UNSUPPORTED");
    assert.equal(inactive.side, "SOURCE");
    assert.match(inactive.text, /can't pay with/);

    const otherChain = unsupported(
      await w.resolver.resolve(w.request({ preferredSourceAssetId: w.a.LOOSE.id })),
    );
    assert.equal(otherChain.code, "SOURCE_ASSET_UNSUPPORTED");

    const fiatPreference = unsupported(
      await w.resolver.resolve(w.request({ preferredSourceAssetId: w.a.NGN.id })),
    );
    assert.equal(fiatPreference.code, "SOURCE_ASSET_UNSUPPORTED");

    // A token that cannot fund a USD amount (it represents BRL) is refused, not coerced.
    const mismatched = unsupported(
      await w.resolver.resolve(
        w.request({
          amount: createMoney("2000", w.a.USD.id),
          amountMode: "EXACT_INPUT",
          sourceAssetId: w.a.USD.id,
          preferredSourceAssetId: w.a.wBRL.id,
        }),
      ),
    );
    assert.equal(mismatched.code, "SOURCE_ASSET_UNSUPPORTED");
  });

  it("reports a currency with no settlement asset, without implying a provider supports it", async () => {
    const w = createWorld();
    // NGN is a known fiat, but no token in this world represents it.
    const naira = unsupported(
      await w.resolver.resolve(
        w.request({
          destinationAssetId: undefined,
          destinationCountry: "NG",
          amountMode: "EXACT_INPUT",
          amount: createMoney("2000", w.a.USD.id),
          sourceAssetId: w.a.USD.id,
        }),
      ),
    );
    assert.equal(naira.code, "NO_SETTLEMENT_ASSET");
    assert.equal(naira.side, "DESTINATION");
    assert.equal(naira.text, "I currently don't have a supported settlement route for NGN.");

    // A country whose currency Kaada does not know is unsupported too, never "same as the amount".
    const unknownCountry = unsupported(
      await w.resolver.resolve(
        w.request({
          destinationAssetId: undefined,
          destinationCountry: "ZZ",
          amountMode: "EXACT_INPUT",
          amount: createMoney("2000", w.a.USD.id),
          sourceAssetId: w.a.USD.id,
        }),
      ),
    );
    assert.equal(unknownCountry.code, "NO_SETTLEMENT_ASSET");
  });

  it("reports ambiguity when a non-USD currency has several candidates that providers also serve", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL);
    w.textilePair(w.a.USDT, w.a.BRLX);
    const result = unsupported(await w.resolver.resolve(w.request()));
    assert.equal(result.code, "AMBIGUOUS_SETTLEMENT_ASSET");
    assert.equal(result.side, "DESTINATION");
    assert.deepEqual(result.details.assetIds?.sort(), [w.a.wBRL.id, w.a.BRLX.id].sort());

    // Providers narrowing the choice to one asset resolves the ambiguity from data.
    const narrowed = createWorld();
    narrowed.textilePair(narrowed.a.USDT, narrowed.a.wBRL);
    ready(await narrowed.resolver.resolve(narrowed.request()));
  });

  it("an unsupported pair fails explicitly with NO_PROVIDER_FOR_PAIR", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    const result = unsupported(await w.resolver.resolve(w.request()));
    assert.equal(result.code, "NO_PROVIDER_FOR_PAIR");
    assert.match(result.text, /don't have a supported way to convert/);
  });

  it("a provider that lacks a needed capability gives PROVIDER_CAPABILITY_UNAVAILABLE", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL, ["QUOTE", "EXACT_INPUT"]);
    const result = unsupported(await w.resolver.resolve(w.request()));
    assert.equal(result.code, "PROVIDER_CAPABILITY_UNAVAILABLE");
    assert.deepEqual(result.details.missingCapabilities?.sort(), ["EXACT_OUTPUT", "SWAP"]);

    // A QUOTE request needs only QUOTE plus the amount mode, never SWAP.
    const quote = ready(
      await w.resolver.resolve(
        w.request({
          operation: "QUOTE",
          purpose: "QUOTE",
          amountMode: "EXACT_INPUT",
          amount: createMoney("5000", w.a.USDT.id),
          sourceAssetId: w.a.USDT.id,
        }),
      ),
    );
    assert.deepEqual(quote.requiredCapabilities, ["QUOTE", "EXACT_INPUT"]);
    assert.equal(quote.purpose, "QUOTE");
  });

  it("does not assume Textile supports wMXN, wCOP, wPEN or wCLP", async () => {
    const w = createWorld();
    w.textilePair(w.a.USDT, w.a.wBRL); // the only pair anyone verified in this fixture
    for (const [code, token, country] of [
      ["MXN", w.a.wMXN, "MX"],
      ["COP", w.a.wCOP, "CO"],
      ["PEN", w.a.wPEN, "PE"],
      ["CLP", w.a.wCLP, "CL"],
    ] as const) {
      assert.ok(token.isActive, `${token.symbol} exists as an asset`);
      const asset = w.a[code];
      const result = unsupported(
        await w.resolver.resolve(
          w.request({
            amount: createMoney("10000", asset.id),
            destinationAssetId: asset.id,
            destinationCountry: country,
          }),
        ),
      );
      assert.equal(result.code, "NO_PROVIDER_FOR_PAIR", code);
      assert.equal(
        await w.capabilityRegistry.supportsPair({
          chainId: CELO_CHAIN_ID,
          inputAssetId: w.a.USDT.id,
          outputAssetId: token.id,
          capability: "QUOTE",
        }),
        false,
        `${token.symbol} has no Textile capability`,
      );
    }
  });

  it("stops at an asset that was disabled, and a capability that was disabled", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);
    ready(await w.resolver.resolve(w.request()));

    w.a.wBRL.isActive = false;
    assert.equal(unsupported(await w.resolver.resolve(w.request())).code, "NO_SETTLEMENT_ASSET");

    w.a.wBRL.isActive = true;
    for (const row of w.capabilities) row.isActive = false;
    w.capabilityRegistry.invalidate();
    assert.equal(unsupported(await w.resolver.resolve(w.request())).code, "NO_PROVIDER_FOR_PAIR");
  });

  it("fabricates nothing: no rate, fee, quote, route or balance anywhere in the set", async () => {
    const w = createWorld();
    w.a.BRLX.isActive = false;
    w.textilePair(w.a.USDT, w.a.wBRL);
    const set = ready(await w.resolver.resolve(w.request()));
    const text = JSON.stringify(Object.keys(set)) + JSON.stringify(Object.keys(set.amount));
    for (const forbidden of [
      "rate",
      "fee",
      "quote",
      "route",
      "slippage",
      "balance",
      "sourceAmount",
    ]) {
      assert.equal(text.toLowerCase().includes(forbidden), false, forbidden);
    }
    // Nothing says the user holds any candidate.
    const flat = JSON.stringify(set.source);
    assert.equal(
      flat.includes("balance") || flat.includes("owned") || flat.includes("held"),
      false,
    );
    assert.equal(set.pairs.length, 1);
    assert.equal(set.pairs[0]?.kind, "CONVERSION");
  });

  it("needs no provider for a pair whose two sides are the same token", async () => {
    const w = createWorld();
    const set = ready(
      await w.resolver.resolve(
        w.request({
          amount: createMoney("5000000", w.a.USDT.id),
          amountMode: "EXACT_INPUT",
          sourceAssetId: w.a.USDT.id,
          destinationAssetId: w.a.USDT.id,
          destinationCountry: undefined,
        }),
      ),
    );
    assert.equal(set.pairs[0]?.kind, "DIRECT");
    assert.equal(set.amount.humanValue, "5");
  });
});
