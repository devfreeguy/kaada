import {
  createAssetRegistry,
  createFxProviderDirectory,
  createProviderCapabilityRegistry,
  createRoutePlanner,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
} from "@kaada/domain";
import type { AssetRepository, FxProvider, ProviderRepository } from "@kaada/domain";
import { SETTINGS } from "@kaada/config";
import type { AppConfig } from "@kaada/config";

import type { AgentLog, AgentRepositories } from "../../core/agent/ports.js";
import type { WalletFundingResolver } from "../../core/routing/funding-resolver.js";
import { RoutingService } from "../../core/routing/routing-service.js";
import type { AuthorizationGate } from "../../core/routing/routing-service.js";
import { MockFxProvider } from "./mock-fx-provider.js";
import { TextileClient, TextileFxProvider, createFetchTransport } from "./textile/index.js";
import {
  INDICATIVE_SWAPPER,
  UniswapClient,
  UniswapFxProvider,
  createUniswapFetchTransport,
} from "./uniswap/index.js";

/**
 * Builds the routing service for the configured price source, or null when pricing is off
 * (FX_PROVIDER=none), in which case the agent stops at ROUTING_REQUIRED.
 *
 * The mock provider returns made-up prices. Configuration already refuses it in production; this
 * refuses it again so no code path can wire fixtures into a production process.
 */
export function createRoutingService(
  config: Pick<AppConfig, "nodeEnv" | "fx">,
  deps: {
    assets: AssetRepository;
    providers: ProviderRepository;
    read: Pick<AgentRepositories, "routes" | "quotes">;
    /** The network routes are planned on (default: Celo mainnet). */
    chainId?: number;
    /** Network-fee check for direct transfers; omit when it is not configured. */
    gas?: {
      enoughForFees(address: string, spendingWei?: bigint): Promise<boolean | undefined>;
    };
    /** The person's home currency, for the default way to pay. */
    profile?: { homeCurrency(userId: string): Promise<string | undefined> };
    /** Balance-aware funding for payments; omit when no wallet provider is configured. */
    funding?: WalletFundingResolver;
    /** Payment authorization (PIN step); omit when no wallet provider is configured. */
    authorization?: AuthorizationGate;
    log?: AgentLog;
    now?: () => Date;
  },
): RoutingService | null {
  if (config.fx.provider === "none") return null;
  // Fixtures never run in production, and there is no fallback to them from any other provider.
  if (config.fx.provider === "mock" && config.nodeEnv === "production") {
    throw new Error("the mock FX provider cannot be used in production");
  }

  const now = deps.now ?? (() => new Date());
  const registry = createAssetRegistry(deps.assets);
  const capabilities = createProviderCapabilityRegistry(deps.providers);
  // Capabilities live under "textile". The mock only stands in for pricing them and reports its own
  // id ("mock-textile"), so nothing it prices is mistaken for a real Textile quote.
  let pricing: FxProvider;
  if (config.fx.provider === "textile") {
    const textile = config.fx.textile;
    if (!textile) throw new Error("FX_PROVIDER=textile requires the Textile settings");
    pricing = new TextileFxProvider({
      assets: registry,
      now,
      client: new TextileClient({
        transport: createFetchTransport({ baseUrl: textile.apiUrl, apiKey: textile.apiKey }),
        timeoutMs: textile.timeoutMs,
      }),
      ...(deps.log && { log: deps.log }),
    });
  } else {
    pricing = new MockFxProvider({ assets: registry, now });
  }

  /*
   * Uniswap, when its key is configured: a SECOND price source, not a replacement. The two serve disjoint pairs — every
   * Textile corridor runs against USDT, every Uniswap row is a pair Textile has no corridor for — so neither is ever
   * asked about the other's pairs and no call is wasted. Which one serves a hop is decided by the capability rows, not
   * here.
   *
   * Unconfigured, the binding is simply absent: a seeded Uniswap row then fails to price with "no price source is
   * wired", the planner discards that path, and the Textile route through USDT answers as it does today.
   */
  const uniswap = config.fx.uniswap;
  const uniswapProvider: FxProvider | undefined = uniswap
    ? new UniswapFxProvider({
        assets: registry,
        now,
        client: new UniswapClient({
          transport: createUniswapFetchTransport({
            baseUrl: uniswap.apiUrl,
            apiKey: uniswap.apiKey,
          }),
          timeoutMs: uniswap.timeoutMs,
        }),
        quoteSwapper: INDICATIVE_SWAPPER,
        slippagePercent: uniswap.slippagePercent,
        ...(deps.log && { log: deps.log }),
      })
    : // Development only: the mock stands in so seeded Uniswap rows are priceable without a key. It reports its own
      // id, so nothing it prices is mistaken for a real Uniswap quote, and production never reaches this branch.
      config.fx.provider === "mock"
      ? pricing
      : undefined;

  return new RoutingService({
    candidates: createRoutingCandidateResolver({
      assets: registry,
      settlement: createSettlementAssetResolver(registry),
      capabilities,
      countries: defaultCountryDirectory,
      maxHops: 2,
      ...(deps.chainId !== undefined && { chainId: deps.chainId }),
    }),
    planner: createRoutePlanner({
      assets: registry,
      capabilities,
      fx: createFxProviderDirectory([
        { capabilityProvider: "textile", provider: pricing },
        ...(uniswapProvider ? [{ capabilityProvider: "uniswap", provider: uniswapProvider }] : []),
      ]),
      now,
      // The dollar floor every cross-currency route has to clear between its hops.
      minimumIntermediate: SETTINGS.routing.minimumSendUsd,
      ...(deps.chainId !== undefined && { chainId: deps.chainId }),
    }),
    assets: registry,
    read: deps.read,
    now,
    ...(deps.funding && { funding: deps.funding }),
    ...(deps.gas && { gas: deps.gas }),
    ...(deps.profile && { profile: deps.profile }),
    ...(deps.authorization && { authorization: deps.authorization }),
    ...(deps.log && { log: deps.log }),
  });
}
