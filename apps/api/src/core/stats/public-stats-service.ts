import type { CompletedPaymentGroup, PaymentStatsRepository } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { errorDetails } from "../channels/error-details.js";

/** One currency's line on the public page. */
export interface PublicVolume {
  /** ISO code for a currency ("NGN", "USD"), or the coin symbol ("CELO"). */
  currency: string;
  /** Whole units delivered (rounded DOWN, no decimals): "1250000". Never one payment's exact amount. */
  amount: string;
  payments: number;
}

export interface PublicStats {
  /** Every completed payment, in any currency. */
  completedPayments: number;
  /** Per currency, only where enough payments make up the number (see `minPaymentsPerCurrency`). */
  volume: PublicVolume[];
  updatedAt: string;
}

export interface PublicStatsDeps {
  stats: PaymentStatsRepository;
  /** A currency is shown only when at least this many payments make it up, so one payment can never be read from it. */
  minPaymentsPerCurrency?: number;
  /** How long a computed answer is reused. The database is read at most this often, whatever the traffic. */
  ttlMs?: number;
  log?: AgentLog;
  now?: () => Date;
}

/**
 * The numbers a marketing page may show: how many payments completed and how much was delivered per currency. Aggregate only,
 * rounded down to whole units, small groups withheld, and cached, so the endpoint reveals nothing about any person or payment and
 * cannot be used to load the database.
 *
 * Several tokens of one currency (USDT and USDC are both US Dollars) are one line; a coin that is not a currency (CELO) is listed by
 * its symbol. Different currencies are NOT added together: that would need an exchange rate, and a wrong one on a public page is worse
 * than none.
 */
export class PublicStatsService {
  private cached: { value: PublicStats; at: number } | undefined;
  private loading: Promise<PublicStats> | undefined;
  private readonly now: () => Date;

  constructor(private readonly deps: PublicStatsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async get(): Promise<PublicStats> {
    const ttl = this.deps.ttlMs ?? 5 * 60_000;
    const at = this.now().getTime();
    if (this.cached && at - this.cached.at < ttl) return this.cached.value;
    this.loading ??= this.compute().finally(() => {
      this.loading = undefined;
    });
    try {
      const value = await this.loading;
      this.cached = { value, at: this.now().getTime() };
      return value;
    } catch (error) {
      // A page that is slightly old beats a page that is broken; with nothing to show the caller says so.
      this.deps.log?.("error", "public_stats.compute_failed", {
        ...errorDetails(error),
        servedStale: this.cached !== undefined,
      });
      if (this.cached) return this.cached.value;
      throw error;
    }
  }

  private async compute(): Promise<PublicStats> {
    const groups = await this.deps.stats.completedByAsset();
    const min = this.deps.minPaymentsPerCurrency ?? 5;

    const byCurrency = new Map<string, { whole: bigint; payments: number }>();
    let completedPayments = 0;
    for (const group of groups) {
      completedPayments += group.payments;
      const currency = labelOf(group);
      const current = byCurrency.get(currency) ?? { whole: 0n, payments: 0 };
      // Whole units, rounded down per asset (a token of 6 and a token of 18 decimals are not mixed in smallest units).
      current.whole += BigInt(group.total) / 10n ** BigInt(group.decimals);
      current.payments += group.payments;
      byCurrency.set(currency, current);
    }
    const volume = [...byCurrency.entries()]
      .filter(([, entry]) => entry.payments >= min)
      .map(([currency, entry]) => ({
        currency,
        amount: entry.whole.toString(),
        payments: entry.payments,
      }))
      .sort((a, b) => b.payments - a.payments || a.currency.localeCompare(b.currency));

    return { completedPayments, volume, updatedAt: this.now().toISOString() };
  }
}

const labelOf = (group: CompletedPaymentGroup): string => group.fiatCode ?? group.symbol;
