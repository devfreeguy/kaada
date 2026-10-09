import {
  createAssetRegistry,
  createProviderCapabilityRegistry,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
} from "@kaada/domain";
import type {
  AssetRepository,
  CapabilityCacheOptions,
  CountryDirectory,
  ProviderCapabilityRegistry,
  ProviderRepository,
  RoutingCandidateResolver,
  SettlementAssetResolver,
} from "@kaada/domain";

export interface CandidateServices {
  settlement: SettlementAssetResolver;
  capabilities: ProviderCapabilityRegistry;
  candidates: RoutingCandidateResolver;
  /** Drops the cached capability snapshot (call after changing provider data). */
  invalidate(): void;
}

/**
 * Wires asset resolution and provider capability lookup into a candidate resolver for the router.
 * `assets` may be the cached asset repository (resolution tolerates a short-lived snapshot); the
 * capability registry keeps its own small snapshot, and the database stays authoritative for both.
 */
export function createCandidateServices(deps: {
  assets: AssetRepository;
  providers: ProviderRepository;
  countries?: CountryDirectory;
  capabilityCache?: CapabilityCacheOptions;
}): CandidateServices {
  const registry = createAssetRegistry(deps.assets);
  const settlement = createSettlementAssetResolver(registry);
  const capabilities = createProviderCapabilityRegistry(deps.providers, deps.capabilityCache);
  return {
    settlement,
    capabilities,
    candidates: createRoutingCandidateResolver({
      assets: registry,
      settlement,
      capabilities,
      countries: deps.countries ?? defaultCountryDirectory,
    }),
    invalidate: () => capabilities.invalidate(),
  };
}
