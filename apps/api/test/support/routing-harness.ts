import { randomUUID } from "node:crypto";

import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createFxProviderDirectory,
  createProviderCapabilityRegistry,
  createRoutePlanner,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
} from "@kaada/domain";
import type { Asset, AssetRegistry, CapabilityType, FxProvider } from "@kaada/domain";

import { MOCK_FX_FIXTURES, MockFxProvider } from "../../src/infrastructure/fx/mock-fx-provider.js";
import type { MockPairFixture } from "../../src/infrastructure/fx/mock-fx-provider.js";
import type { WalletFundingResolver } from "../../src/core/routing/funding-resolver.js";
import { RoutingService } from "../../src/core/routing/routing-service.js";
import { createHarness, SENDER } from "./harness.js";
import type { Harness } from "./harness.js";
import type { InMemoryWorld } from "./in-memory.js";

/*
 * TEST FIXTURES. Real Celo token metadata (symbols, decimals, currencies) with made-up addresses, and
 * the MOCK / DEVELOPMENT price fixtures. Nothing here is a real price or a claim about a provider.
 */

const token = (
  symbol: string,
  kind: Asset["kind"],
  decimals: number,
  fiatCode: string,
  countryCode?: string,
): Asset => ({
  id: randomUUID(),
  symbol,
  name: symbol,
  kind,
  decimals,
  chainId: CELO_CHAIN_ID,
  contractAddress: `0x${randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
  fiatCode,
  ...(countryCode && { countryCode }),
  isActive: true,
});

export const RFQ: CapabilityType[] = ["QUOTE", "SWAP", "EXACT_INPUT", "EXACT_OUTPUT"];

export interface RoutingHarness {
  h: Harness;
  world: InMemoryWorld;
  /** Settlement tokens added on top of the base harness assets. */
  tokens: Record<"wBRL" | "wARS" | "cNGN" | "IDRX" | "wMXN", Asset>;
  mock: MockFxProvider;
  routing: RoutingService;
  clock: { now: Date; advance(ms: number): void };
  capabilityProvider: ReturnType<InMemoryWorld["addProvider"]>;
  /** Adds capability rows for one directed pair. */
  allow(input: Asset, output: Asset, types?: CapabilityType[], providerId?: string): void;
  invalidateCapabilities(): void;
  candidates: ReturnType<typeof createRoutingCandidateResolver>;
  planner: ReturnType<typeof createRoutePlanner>;
  registry: ReturnType<typeof createAssetRegistry>;
  capabilityRegistry: ReturnType<typeof createProviderCapabilityRegistry>;
}

/** The base harness plus the Textile-shaped graph and a mock FX provider wired to a RoutingService. */
export function createRoutingHarness(
  options: {
    quoteTtlMs?: number;
    fixtures?: readonly MockPairFixture[];
    /** Capability rows to add; defaults to every fixture direction with all RFQ capabilities. */
    capabilityPairs?: [string, string][];
    /** The mock prices as if this many ms earlier, so its quotes arrive already expired. */
    mockClockSkewMs?: number;
    /** Price with this provider (bound to the "textile" capability) instead of the mock. */
    pricing?: (context: { assets: AssetRegistry; now: () => Date }) => FxProvider;
    /** Balance-aware funding for payments, built from the asset registry. */
    funding?: (registry: AssetRegistry) => WalletFundingResolver;
  } = {},
): RoutingHarness {
  const clock = {
    now: new Date("2026-10-09T12:00:00.000Z"),
    advance(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const holder: {
    routing?: RoutingService;
    mock?: MockFxProvider;
    capabilities?: ReturnType<typeof createProviderCapabilityRegistry>;
    candidates?: ReturnType<typeof createRoutingCandidateResolver>;
    planner?: ReturnType<typeof createRoutePlanner>;
    registry?: ReturnType<typeof createAssetRegistry>;
  } = {};

  const h = createHarness({
    now: () => clock.now,
    routing: (world) => {
      const registry = createAssetRegistry(world.repositories.assets);
      const capabilities = createProviderCapabilityRegistry(world.repositories.providers, {
        ttlMs: 0,
      });
      const mock = new MockFxProvider({
        assets: registry,
        now: () => new Date(clock.now.getTime() - (options.mockClockSkewMs ?? 0)),
        quoteTtlMs: options.quoteTtlMs ?? 30_000,
        ...(options.fixtures && { fixtures: options.fixtures }),
      });
      holder.mock = mock;
      holder.capabilities = capabilities;
      const settlement = createSettlementAssetResolver(registry);
      const candidates = createRoutingCandidateResolver({
        assets: registry,
        settlement,
        capabilities,
        countries: defaultCountryDirectory,
        maxHops: 2,
      });
      const planner = createRoutePlanner({
        assets: registry,
        capabilities,
        fx: createFxProviderDirectory([
          {
            capabilityProvider: "textile",
            provider: options.pricing?.({ assets: registry, now: () => clock.now }) ?? mock,
          },
        ]),
        now: () => clock.now,
      });
      holder.candidates = candidates;
      holder.planner = planner;
      holder.registry = registry;
      const routing = new RoutingService({
        candidates,
        planner,
        assets: registry,
        read: world.repositories,
        now: () => clock.now,
        ...(options.funding && { funding: options.funding(registry) }),
      });
      holder.routing = routing;
      return routing;
    },
  });
  const world = h.world;
  // Production has one USDC on Celo; the base harness's second USDC (another chain) would make the label ambiguous.
  h.assets.USDC_OTHER.isActive = false;

  const tokens = {
    wBRL: token("wBRL", "LOCAL_STABLECOIN", 18, "BRL", "BR"),
    wARS: token("wARS", "LOCAL_STABLECOIN", 18, "ARS", "AR"),
    cNGN: token("cNGN", "LOCAL_STABLECOIN", 6, "NGN", "NG"),
    IDRX: token("IDRX", "LOCAL_STABLECOIN", 2, "IDR", "ID"),
    // Exists as an asset but has no pricing and no provider capability: used to prove nothing is assumed.
    wMXN: token("wMXN", "LOCAL_STABLECOIN", 18, "MXN", "MX"),
  };
  for (const asset of Object.values(tokens)) world.addAsset(asset);
  for (const [code, name, country] of [
    ["IDR", "Indonesian Rupiah", "ID"],
    ["MXN", "Mexican Peso", "MX"],
  ] as const) {
    world.addAsset({
      id: randomUUID(),
      symbol: code,
      name,
      kind: "FIAT",
      decimals: 2,
      fiatCode: code,
      countryCode: country,
      isActive: true,
    });
  }

  const capabilityProvider = world.addProvider({ slug: "textile", name: "Textile (test)" });
  // The development adapter's own record: inactive, only there so priced quotes can be stored.
  world.addProvider({ slug: "mock-textile", name: "Mock Textile", isActive: false });

  const bySymbol = (symbol: string): Asset => {
    const found = [h.assets.USDT, h.assets.USDC_CELO, ...Object.values(tokens)].find(
      (asset) => asset.symbol === symbol,
    );
    if (!found) throw new Error(`no test asset ${symbol}`);
    return found;
  };
  const allow: RoutingHarness["allow"] = (input, output, types = RFQ, providerId) => {
    for (const capability of types) {
      world.addCapability({
        providerId: providerId ?? capabilityProvider.id,
        capability,
        chainId: CELO_CHAIN_ID,
        inputAssetId: input.id,
        outputAssetId: output.id,
      });
    }
  };
  const pairs =
    options.capabilityPairs ??
    (options.fixtures ?? MOCK_FX_FIXTURES).map((f): [string, string] => [f.input, f.output]);
  for (const [input, output] of pairs) allow(bySymbol(input), bySymbol(output));

  world.addRecipient({
    id: randomUUID(),
    ownerUserId: SENDER,
    type: "SAVED_BENEFICIARY",
    displayName: "João Silva",
    identifier: "joao",
    destinationCountry: "BR",
  });

  return {
    h,
    world,
    tokens,
    mock: holder.mock as MockFxProvider,
    routing: holder.routing as RoutingService,
    clock,
    capabilityProvider,
    allow,
    invalidateCapabilities: () => holder.capabilities?.invalidate(),
    candidates: holder.candidates as ReturnType<typeof createRoutingCandidateResolver>,
    planner: holder.planner as ReturnType<typeof createRoutePlanner>,
    registry: holder.registry as ReturnType<typeof createAssetRegistry>,
    capabilityRegistry: holder.capabilities as ReturnType<typeof createProviderCapabilityRegistry>,
  };
}
