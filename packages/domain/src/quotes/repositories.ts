import type { Quote } from "./quote.js";

export type NewQuote = Omit<Quote, "createdAt">;

/** Quotes are immutable, so there is no update. */
export interface QuoteRepository {
  create(quote: NewQuote): Promise<Quote>;
  findById(id: string): Promise<Quote | null>;
  /** Newest first. */
  listByIntent(intentId: string): Promise<Quote[]>;
}
