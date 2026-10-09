import type { CapabilityType, ProviderCapability, ProviderRepository } from "./provider.js";

export interface PairQuery {
  chainId: number;
  inputAssetId: string;
  outputAssetId: string;
}

/** What one provider can do for an asset pair, exactly as the capability rows state it. */
export interface ProviderPairSupport {
  providerId: string;
  providerSlug: string;
  /** Distinct capability types the provider has for the pair. No type implies another. */
  capabilities: CapabilityType[];
}

export interface SettlementCapabilityQuery {
  chainId: number;
  /** Rows where this asset is the input or the output. */
  assetId?: string;
  /** Rows for this country only. Rows without a country never match a country query. */
  countryCode?: string;
  capability?: CapabilityType;
}

/** A capability together with the provider it belongs to. */
export interface ProviderCapabilityEntry extends ProviderCapability {
  providerSlug: string;
}

/**
 * Answers "who can do what" from capability data and nothing else. A pair is supported only when a
 * row says so for exactly that chain, input and output; nothing is inferred (a QUOTE row is not a
 * SWAP, a SWAP is not an EXACT_OUTPUT, one direction is not the reverse). The router asks this
 * registry and never needs to know how a provider is implemented.
 */
export interface ProviderCapabilityRegistry {
  /** Per-provider capabilities for the pair, in the given direction. Empty when none. */
  getCapabilitiesForPair(query: PairQuery): Promise<ProviderPairSupport[]>;
  /**
   * Providers that have `capability` (and every type in `alsoRequire`) for the pair. Disabled
   * providers and disabled capability rows never appear.
   */
  getProvidersForPair(
    query: PairQuery & { capability: CapabilityType; alsoRequire?: readonly CapabilityType[] },
  ): Promise<ProviderPairSupport[]>;
  supportsPair(
    query: PairQuery & { capability: CapabilityType; alsoRequire?: readonly CapabilityType[] },
  ): Promise<boolean>;
  /** Every active capability of one provider (by slug). */
  getCapabilitiesForProvider(providerSlug: string): Promise<ProviderCapabilityEntry[]>;
  /** Ramp and payout style capabilities, narrowed by asset and country. */
  getSettlementCapabilities(query: SettlementCapabilityQuery): Promise<ProviderCapabilityEntry[]>;
  /** Drops the snapshot so the next read goes to the database. */
  invalidate(): void;
}

export interface CapabilityCacheOptions {
  /** How long a snapshot is trusted. Default one minute. */
  ttlMs?: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

interface Snapshot {
  entries: ProviderCapabilityEntry[];
  loadedAt: number;
}

/**
 * A registry over a ProviderRepository with a small process-local snapshot of the (few, slowly
 * changing) active capabilities. The database stays authoritative: the snapshot expires, concurrent
 * refreshes share one read, a failed refresh is never cached, and `invalidate()` forces a re-read.
 * Quotes are not cached here or anywhere in this layer.
 */
export function createProviderCapabilityRegistry(
  repository: ProviderRepository,
  options: CapabilityCacheOptions = {},
): ProviderCapabilityRegistry {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;

  let snapshot: Snapshot | undefined;
  let loading: Promise<ProviderCapabilityEntry[]> | undefined;

  async function entries(): Promise<ProviderCapabilityEntry[]> {
    if (snapshot && now() - snapshot.loadedAt < ttlMs) return snapshot.entries;
    loading ??= Promise.all([repository.listActive(), repository.listCapabilities()])
      .then(([providers, capabilities]) => {
        const slugs = new Map(providers.map((provider) => [provider.id, provider.slug]));
        // The repository already hides disabled providers and rows; re-checking here keeps the
        // registry correct over any ProviderRepository.
        const loaded = capabilities.flatMap((capability): ProviderCapabilityEntry[] => {
          const providerSlug = slugs.get(capability.providerId);
          return providerSlug !== undefined && capability.isActive
            ? [{ ...capability, providerSlug }]
            : [];
        });
        snapshot = { entries: loaded, loadedAt: now() };
        return loaded;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }

  async function getCapabilitiesForPair(query: PairQuery): Promise<ProviderPairSupport[]> {
    const byProvider = new Map<string, ProviderPairSupport>();
    for (const entry of await entries()) {
      if (
        entry.chainId !== query.chainId ||
        entry.inputAssetId !== query.inputAssetId ||
        entry.outputAssetId !== query.outputAssetId
      ) {
        continue;
      }
      const support = byProvider.get(entry.providerId) ?? {
        providerId: entry.providerId,
        providerSlug: entry.providerSlug,
        capabilities: [],
      };
      if (!support.capabilities.includes(entry.capability))
        support.capabilities.push(entry.capability);
      byProvider.set(entry.providerId, support);
    }
    return [...byProvider.values()].sort((a, b) => a.providerSlug.localeCompare(b.providerSlug));
  }

  async function getProvidersForPair(
    query: PairQuery & { capability: CapabilityType; alsoRequire?: readonly CapabilityType[] },
  ): Promise<ProviderPairSupport[]> {
    const required = [query.capability, ...(query.alsoRequire ?? [])];
    return (await getCapabilitiesForPair(query)).filter((support) =>
      required.every((capability) => support.capabilities.includes(capability)),
    );
  }

  return {
    getCapabilitiesForPair,
    getProvidersForPair,
    async supportsPair(query) {
      return (await getProvidersForPair(query)).length > 0;
    },
    async getCapabilitiesForProvider(providerSlug) {
      return (await entries()).filter((entry) => entry.providerSlug === providerSlug);
    },
    async getSettlementCapabilities(query) {
      return (await entries()).filter(
        (entry) =>
          entry.chainId === query.chainId &&
          (query.capability === undefined || entry.capability === query.capability) &&
          (query.assetId === undefined ||
            entry.inputAssetId === query.assetId ||
            entry.outputAssetId === query.assetId) &&
          (query.countryCode === undefined || entry.countryCode === query.countryCode),
      );
    },
    invalidate() {
      snapshot = undefined;
    },
  };
}
