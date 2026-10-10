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
import type { AppConfig } from "@kaada/config";

import type { AgentLog, AgentRepositories } from "../../core/agent/ports.js";
import type { WalletFundingResolver } from "../../core/routing/funding-resolver.js";
import { RoutingService } from "../../core/routing/routing-service.js";
import { MockFxProvider } from "./mock-fx-provider.js";
import { TextileClient, TextileFxProvider, createFetchTransport } from "./textile/index.js";

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
    /** Balance-aware funding for payments; omit when no wallet provider is configured. */
    funding?: WalletFundingResolver;
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
  return new RoutingService({
    candidates: createRoutingCandidateResolver({
      assets: registry,
      settlement: createSettlementAssetResolver(registry),
      capabilities,
      countries: defaultCountryDirectory,
      maxHops: 2,
    }),
    planner: createRoutePlanner({
      assets: registry,
      capabilities,
      fx: createFxProviderDirectory([{ capabilityProvider: "textile", provider: pricing }]),
      now,
    }),
    assets: registry,
    read: deps.read,
    now,
    ...(deps.funding && { funding: deps.funding }),
    ...(deps.log && { log: deps.log }),
  });
}
