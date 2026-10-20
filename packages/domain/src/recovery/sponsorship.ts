/**
 * The platform's sponsoring of a wallet (opening its account and paying the gas of its first Recovery Code setup) is capped per
 * wallet and per day across ALL wallets. The ledger is the one place those caps are checked and the spend is recorded, in a single
 * atomic step, so any number of parallel requests (or instances) cannot together go over a cap.
 *
 * A spend is a reservation first (the most it may cost) and a settlement afterwards (what it really cost; zero releases it). A
 * reservation that is never settled (a crash) keeps counting in full, which errs on the side of spending less.
 */
export type SponsorLimit = "WALLET_CAP" | "DAILY_BUDGET";

export type SponsorReservation =
  | {
      granted: true;
      /** Settle with this id. */
      id: string;
      /** How much may be spent: what was wanted, cut down to what both caps still allow. */
      grantedWei: bigint;
      /** Set when the grant is smaller than what was wanted: which cap cut it. */
      limitedBy?: SponsorLimit;
    }
  | { granted: false; reason: SponsorLimit };

export interface SponsorshipLedger {
  /**
   * Atomically: works out what this wallet may still be given (its lifetime cap) and what the platform may still give today (a
   * rolling window across all wallets), reserves the smaller of that and `wantWei`, and records it. Refuses when nothing is left.
   */
  reserve(input: {
    userId: string;
    walletId: string;
    wantWei: bigint;
    walletCapWei: bigint;
    dailyCapWei: bigint;
    windowMs: number;
    now: Date;
  }): Promise<SponsorReservation>;
  /** Records what a reservation really cost (zero releases it). Idempotent for the same id: the last settlement wins. */
  settle(input: { id: string; userId: string; walletId: string; spentWei: bigint }): Promise<void>;
  /** Everything reserved or spent in the window, across all wallets. */
  usedInWindow(now: Date, windowMs: number): Promise<bigint>;
}

/** The value of what a wallet has received, in millionths of a US dollar. Only tokens that stand for US dollars count. */
export interface DepositItem {
  fiatCode?: string;
  decimals: number;
  delta: string;
}

const MICRO = 1_000_000n;

/**
 * Stablecoins that stand for US dollars are worth one dollar each. Native CELO, other currencies' tokens and anything without a
 * price are worth nothing here: there is no price to value them with, so they cannot make a wallet qualify.
 */
export function depositValueUsdMicros(items: readonly DepositItem[]): bigint {
  let total = 0n;
  for (const item of items) {
    if (item.fiatCode?.toUpperCase() !== "USD") continue;
    if (!/^[0-9]+$/.test(item.delta) || !Number.isInteger(item.decimals) || item.decimals < 0)
      continue;
    total += (BigInt(item.delta) * MICRO) / 10n ** BigInt(item.decimals);
  }
  return total;
}
