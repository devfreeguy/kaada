/**
 * Supported-deposit detection, as data. A wallet's last observed balances are kept as a checkpoint; when a later observation
 * shows a supported token went up, ONE funding event is recorded in the same atomic step that moves the checkpoint. The event is
 * then delivered to the person's linked chats from an outbox, exactly like the onboarding notifications.
 *
 * Nothing here knows about chat apps, RPC endpoints or wording.
 */

/** Smallest-unit amounts as decimal strings, by asset id. Never floating point. */
export type BalanceSnapshot = Readonly<Record<string, string>>;

/** One token that went up in an observation. Amounts are smallest-unit decimal strings. */
export interface WalletFundingItem {
  assetId: string;
  symbol: string;
  /** The currency the token represents (its own metadata), so a deposit can be worded as one. */
  fiatCode?: string;
  decimals: number;
  previous: string;
  current: string;
  /** current - previous: what arrived. */
  delta: string;
}

export interface WalletBalanceCheckpoint {
  id: string;
  userId: string;
  chainId: number;
  address: string;
  balances: BalanceSnapshot;
  /** Increases by one with every committed observation; the compare-and-set key that makes two observers produce one event. */
  version: number;
  observedAt: Date;
}

export interface WalletFundingEvent {
  id: string;
  userId: string;
  chainId: number;
  address: string;
  /** What arrived together (several tokens seen in one observation are one event). */
  items: WalletFundingItem[];
  createdAt: Date;
  claimedAt?: Date;
  deliveredAt?: Date;
  attempts: number;
}

export interface WalletToWatch {
  userId: string;
  address: string;
  /** When the wallet became usable. A first deposit into a freshly made wallet is news; into an old one it is not. */
  activatedAt: Date;
}

export interface FundingCommit {
  userId: string;
  chainId: number;
  address: string;
  /** The version the caller read; null when it saw no checkpoint. Only the caller that matches it can commit. */
  expectedVersion: number | null;
  balances: BalanceSnapshot;
  now: Date;
  /** Recorded with the move, atomically, or not at all. */
  event?: { id: string; items: WalletFundingItem[] };
}

export interface WalletFundingStore {
  /**
   * Active embedded wallets with an address, belonging to people who have a linked chat to be told on: the only things ever
   * watched. (A wallet's address is the same on every network; which network is read is the caller's setting.)
   */
  walletsToWatch(limit: number): Promise<WalletToWatch[]>;
  checkpoint(chainId: number, address: string): Promise<WalletBalanceCheckpoint | null>;
  /**
   * Moves the checkpoint (and records the event, if any) when `expectedVersion` still matches. `committed` is false when
   * another observer got there first, which means that observer recorded the event: this caller must do nothing more.
   */
  commit(input: FundingCommit): Promise<{ committed: boolean }>;
  /** Atomically claims undelivered events (one claimant each, even across instances). */
  claim(input: {
    now: Date;
    staleMs: number;
    maxAttempts: number;
    limit: number;
  }): Promise<WalletFundingEvent[]>;
  markDelivered(ids: string[], now: Date): Promise<void>;
  release(ids: string[]): Promise<void>;
}
