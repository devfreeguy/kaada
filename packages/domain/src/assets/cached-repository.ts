import type { Asset } from "./asset.js";
import type { AssetRepository } from "./registry.js";

export interface CacheOptions {
  /** How long a snapshot is trusted. Default one minute. */
  ttlMs?: number;
  /** Clock in milliseconds; injectable for tests. */
  now?: () => number;
}

export interface CachedAssetRepository extends AssetRepository {
  /** Drops the snapshot so the next read goes to the database. */
  invalidate(): void;
}

const byChainThenId = (a: Asset, b: Asset): number =>
  (a.chainId ?? Number.MAX_SAFE_INTEGER) - (b.chainId ?? Number.MAX_SAFE_INTEGER) ||
  a.id.localeCompare(b.id);

/**
 * A process-local read cache for the asset table. Assets are few and change rarely, so one snapshot
 * of the whole table answers every lookup. The database stays authoritative: the snapshot expires
 * after `ttlMs`, concurrent refreshes share one query, a failed refresh is never cached, and
 * `invalidate()` forces a re-read.
 *
 * Use it for interpretation and resolution, where a stale answer is harmless. Before money moves,
 * confirm an asset is still active with an uncached read.
 */
export function createCachedAssetRepository(
  source: AssetRepository,
  options: CacheOptions = {},
): CachedAssetRepository {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;

  let snapshot: { assets: Asset[]; loadedAt: number } | undefined;
  let loading: Promise<Asset[]> | undefined;

  async function assets(): Promise<Asset[]> {
    if (snapshot && now() - snapshot.loadedAt < ttlMs) return snapshot.assets;
    loading ??= source
      .listAll()
      .then((loaded) => {
        snapshot = { assets: loaded, loadedAt: now() };
        return loaded;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  }

  return {
    invalidate() {
      snapshot = undefined;
    },
    async findById(id) {
      return (await assets()).find((asset) => asset.id === id) ?? null;
    },
    async findBySymbol(symbol, lookup) {
      const wanted = symbol.toLowerCase();
      return (await assets())
        .filter(
          (asset) =>
            asset.symbol.toLowerCase() === wanted &&
            (lookup?.chainId === undefined || asset.chainId === lookup.chainId),
        )
        .sort(byChainThenId);
    },
    async findByFiatCode(code) {
      const wanted = code.trim().toLowerCase();
      return (await assets())
        .filter((asset) => asset.fiatCode?.toLowerCase() === wanted)
        .sort(byChainThenId);
    },
    async listActive() {
      return (await assets()).filter((asset) => asset.isActive);
    },
    async listAll() {
      return [...(await assets())];
    },
  };
}
