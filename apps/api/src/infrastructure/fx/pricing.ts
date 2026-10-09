import {
  createAssetRegistry,
  createFxProviderDirectory,
  createProviderCapabilityRegistry,
  createRoutePlanner,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
} from "@kaada/domain";
import type { AssetRepository, ProviderRepository } from "@kaada/domain";
import type { AppConfig } from "@kaada/config";

import type { AgentLog, AgentRepositories } from "../../core/agent/ports.js";
import { RoutingService } from "../../core/routing/routing-service.js";
import { MockFxProvider } from "./mock-fx-provider.js";

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
    log?: AgentLog;
    now?: () => Date;
  },
): RoutingService | null {
  if (config.fx.provider === "none") return null;
  if (config.nodeEnv === "production") {
    throw new Error("the mock FX provider cannot be used in production");
  }

  const now = deps.now ?? (() => new Date());
  const registry = createAssetRegistry(deps.assets);
  const capabilities = createProviderCapabilityRegistry(deps.providers);
  // Capabilities live under "textile"; the mock only stands in for pricing them. It reports its own
  // id ("mock-textile"), so nothing it prices is mistaken for a real Textile quote.
  const mock = new MockFxProvider({ assets: registry, now });
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
      fx: createFxProviderDirectory([{ capabilityProvider: "textile", provider: mock }]),
      now,
    }),
    assets: registry,
    read: deps.read,
    now,
    ...(deps.log && { log: deps.log }),
  });
}
