/**
 * What the public marketing numbers are made of: completed payments grouped by the asset that was delivered. Aggregate only: there is
 * no user, wallet, recipient or individual payment in it, and nothing here can name one.
 */
export interface CompletedPaymentGroup {
  assetId: string;
  symbol: string;
  /** The currency the asset represents, when it is one (a stablecoin of Naira, Dollars...). Absent for a coin like CELO. */
  fiatCode?: string;
  decimals: number;
  /** How many payments completed in this asset. */
  payments: number;
  /** The sum of what was delivered, in the asset's smallest units (a canonical integer string). */
  total: string;
}

export interface PaymentStatsRepository {
  /** Completed payments (settled on chain), grouped by delivered asset. Read only. */
  completedByAsset(): Promise<CompletedPaymentGroup[]>;
}
