import type {
  BalanceSnapshot,
  FundingCommit,
  WalletBalanceCheckpoint,
  WalletFundingEvent,
  WalletFundingStore,
  WalletToWatch,
} from "@kaada/domain";

/**
 * An in-memory WalletFundingStore with the same guarantees as the database one: the checkpoint moves only when the caller's
 * version still matches, and the event is recorded in the same step, so of any number of observers exactly one records it.
 * Safe because JavaScript runs `commit` to completion before another call starts (the database does it with a transaction).
 */
export class MemoryFundingStore implements WalletFundingStore {
  readonly wallets: WalletToWatch[] = [];
  readonly checkpoints = new Map<string, WalletBalanceCheckpoint>();
  readonly events: WalletFundingEvent[] = [];
  private next = 1;

  watch(wallet: WalletToWatch): void {
    this.wallets.push(wallet);
  }

  walletsToWatch(limit: number): Promise<WalletToWatch[]> {
    return Promise.resolve(this.wallets.slice(0, limit));
  }

  checkpoint(chainId: number, address: string): Promise<WalletBalanceCheckpoint | null> {
    return Promise.resolve(this.checkpoints.get(`${String(chainId)}:${address}`) ?? null);
  }

  commit(input: FundingCommit): Promise<{ committed: boolean }> {
    const key = `${String(input.chainId)}:${input.address}`;
    const current = this.checkpoints.get(key);
    if (
      input.expectedVersion === null
        ? current !== undefined
        : current?.version !== input.expectedVersion
    ) {
      return Promise.resolve({ committed: false });
    }
    const version = current ? current.version + 1 : 0;
    const balances: BalanceSnapshot = { ...input.balances };
    this.checkpoints.set(key, {
      id: current?.id ?? `cp-${String(this.next++)}`,
      userId: input.userId,
      chainId: input.chainId,
      address: input.address,
      balances,
      version,
      observedAt: input.now,
    });
    if (input.event) {
      this.events.push({
        id: input.event.id,
        userId: input.userId,
        chainId: input.chainId,
        address: input.address,
        items: input.event.items,
        createdAt: input.now,
        attempts: 0,
      });
    }
    return Promise.resolve({ committed: true });
  }

  claim(input: {
    now: Date;
    staleMs: number;
    maxAttempts: number;
    limit: number;
  }): Promise<WalletFundingEvent[]> {
    const staleBefore = input.now.getTime() - input.staleMs;
    const out: WalletFundingEvent[] = [];
    for (const event of this.events) {
      if (out.length >= input.limit) break;
      if (event.deliveredAt || event.attempts >= input.maxAttempts) continue;
      if (event.claimedAt && event.claimedAt.getTime() >= staleBefore) continue;
      event.claimedAt = input.now;
      out.push({ ...event });
    }
    return Promise.resolve(out);
  }

  markDelivered(ids: string[], now: Date): Promise<void> {
    for (const event of this.events)
      if (ids.includes(event.id) && !event.deliveredAt) event.deliveredAt = now;
    return Promise.resolve();
  }

  release(ids: string[]): Promise<void> {
    for (const event of this.events) {
      if (ids.includes(event.id) && !event.deliveredAt) {
        delete event.claimedAt;
        event.attempts += 1;
      }
    }
    return Promise.resolve();
  }
}
