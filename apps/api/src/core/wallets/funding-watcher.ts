import { createId } from "@kaada/domain";
import type {
  Asset,
  BalanceSnapshot,
  WalletFundingItem,
  WalletFundingStore,
  WalletBalanceReader,
  WalletToWatch,
} from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";

export interface FundingWatcherDeps {
  store: WalletFundingStore;
  reader: WalletBalanceReader;
  /** The tokens Kaada supports on the network being watched. Never discovered from chain history. */
  tokens: () => Promise<Asset[]>;
  chainId: number;
  /** A deposit smaller than 10^-dustDecimalsBelow of a token is recorded silently. */
  dustDecimalsBelow: number;
  /** A wallet with no checkpoint is "just created" (so a first deposit is news) only this long after activation. */
  newWalletMs: number;
  now?: () => Date;
  log?: AgentLog;
  /** Wallets read at the same time. */
  concurrency?: number;
  /** Most wallets watched in one pass. */
  limit?: number;
  /** Test hook: fires between reading the chain and committing (to interleave two observers). */
  beforeCommit?: () => Promise<void>;
}

export interface PollResult {
  checked: number;
  events: number;
  failed: number;
}

const toBig = (value: string | undefined): bigint => (value === undefined ? 0n : BigInt(value));

/** The smallest increase worth telling someone about: a hundredth of a token (never less than one smallest unit). */
export function dustFloor(decimals: number, below: number): bigint {
  const exponent = Math.max(0, decimals - below);
  return 10n ** BigInt(exponent);
}

/**
 * Supported-deposit detection. Each pass reads, for every watched wallet, the balance of every supported token on the configured
 * network (one batched chain call per wallet), compares it with the stored checkpoint and records ONE funding event for what
 * went up. It is channel-neutral: it knows nothing about chat apps and holds no timers (the caller schedules `poll`).
 *
 *  - Only Kaada's own wallets are read, and only the tokens in the registry for the network. Arbitrary tokens are never scanned.
 *  - The checkpoint moves by compare-and-set on its version, in one atomic step with the event: any number of instances, retries
 *    and restarts produce at most one event for a given change, and a balance that has not changed produces nothing.
 *  - A failed read changes nothing; the next pass tries again.
 */
export class WalletFundingWatcher {
  private readonly now: () => Date;
  private readonly log: AgentLog;

  constructor(private readonly deps: FundingWatcherDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
  }

  async poll(): Promise<PollResult> {
    const result: PollResult = { checked: 0, events: 0, failed: 0 };
    const tokens = await this.deps.tokens();
    if (tokens.length === 0) return result;
    const wallets = await this.deps.store.walletsToWatch(this.deps.limit ?? 500);
    const width = Math.max(1, this.deps.concurrency ?? 4);
    for (let index = 0; index < wallets.length; index += width) {
      await Promise.all(
        wallets.slice(index, index + width).map(async (wallet) => {
          try {
            const recorded = await this.observe(wallet, tokens);
            result.checked += 1;
            if (recorded) result.events += 1;
          } catch (error) {
            result.failed += 1;
            // Metadata only: which kind of failure, never the wallet or any amount.
            this.log("warn", "funding.observe_failed", {
              kind: error instanceof Error ? error.name : "unknown",
            });
          }
        }),
      );
    }
    return result;
  }

  /** One wallet. Returns whether this call recorded a funding event. */
  private async observe(wallet: WalletToWatch, tokens: Asset[]): Promise<boolean> {
    const { store, reader, chainId } = this.deps;
    const read = await reader.readBalances({
      chainId,
      address: wallet.address,
      assetIds: tokens.map((token) => token.id),
    });
    const address = read.address;
    const current: Record<string, string> = {};
    tokens.forEach((token, index) => {
      current[token.id] = read.tokens[index]?.amount ?? "0";
    });

    const checkpoint = await store.checkpoint(chainId, address);
    const now = this.now();
    // No checkpoint: a wallet made moments ago is compared against nothing (its first deposit is news); an older one is only
    // baselined, so switching this feature on never announces money that was already there.
    const fresh = now.getTime() - wallet.activatedAt.getTime() <= this.deps.newWalletMs;
    const previous: BalanceSnapshot | null = checkpoint ? checkpoint.balances : fresh ? {} : null;

    const items: WalletFundingItem[] = [];
    if (previous) {
      for (const token of tokens) {
        const before = toBig(previous[token.id]);
        const after = toBig(current[token.id]);
        const delta = after - before;
        if (delta > 0n && delta >= dustFloor(token.decimals, this.deps.dustDecimalsBelow)) {
          items.push({
            assetId: token.id,
            symbol: token.symbol,
            ...(token.fiatCode && { fiatCode: token.fiatCode }),
            decimals: token.decimals,
            previous: before.toString(),
            current: after.toString(),
            delta: delta.toString(),
          });
        }
      }
    }

    const unchanged =
      checkpoint !== null &&
      tokens.every((token) => toBig(checkpoint.balances[token.id]) === toBig(current[token.id])) &&
      Object.keys(checkpoint.balances).every((id) => id in current);
    if (unchanged) return false;

    await this.deps.beforeCommit?.();
    const { committed } = await store.commit({
      userId: wallet.userId,
      chainId,
      address,
      expectedVersion: checkpoint ? checkpoint.version : null,
      balances: current,
      now,
      ...(items.length > 0 && { event: { id: createId(), items } }),
    });
    // Not committed: another observer moved the checkpoint first, and it recorded the event. Nothing more to do here.
    return committed && items.length > 0;
  }
}
