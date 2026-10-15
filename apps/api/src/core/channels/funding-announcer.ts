import type { WalletFundingEvent, WalletFundingStore } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { PollResult } from "../wallets/funding-watcher.js";
import { errorDetails } from "./error-details.js";

export interface FundingAnnouncerDeps {
  /** Looks for deposits (records events). Channel-neutral. */
  watcher: { poll(): Promise<PollResult> };
  store: Pick<WalletFundingStore, "claim" | "markDelivered" | "release">;
  /** Delivers one event on the person's linked chats; reports how many reached them. */
  announce(event: WalletFundingEvent): Promise<{ delivered: number; failed: number }>;
  now?: () => Date;
  /** A delivery claim older than this is assumed dead and may be taken over. */
  staleClaimMs?: number;
  /** After this many failed deliveries an event is left alone (the balance is always one /balance away). */
  maxAttempts?: number;
  log?: AgentLog;
}

/**
 * The deposit dispatcher. Each pass it
 *   1. observes: the watcher reads supported balances and records funding events (one per real change, across instances);
 *   2. claims: takes the events nobody else is delivering (one claimant per event);
 *   3. delivers them on the person's linked chats and marks them delivered, or releases them so the next pass retries.
 */
export class FundingAnnouncer {
  private readonly log: AgentLog;
  private readonly now: () => Date;

  constructor(private readonly deps: FundingAnnouncerDeps) {
    this.log = deps.log ?? noopLog;
    this.now = deps.now ?? (() => new Date());
  }

  async sweep(): Promise<{ events: number; announced: number; failed: number }> {
    const polled = await this.deps.watcher.poll();
    let announced = 0;
    let failed = 0;
    const claimed = await this.deps.store.claim({
      now: this.now(),
      staleMs: this.deps.staleClaimMs ?? 60_000,
      maxAttempts: this.deps.maxAttempts ?? 8,
      limit: 50,
    });
    for (const event of claimed) {
      try {
        const result = await this.deps.announce(event);
        if (result.failed > 0 && result.delivered === 0) {
          await this.deps.store.release([event.id]);
          failed += 1;
        } else {
          // Delivered, or nobody to deliver to (no linked chat): either way it is finished.
          await this.deps.store.markDelivered([event.id], this.now());
          announced += 1;
        }
      } catch (error) {
        await this.deps.store.release([event.id]);
        failed += 1;
        this.log("warn", "funding.announce_failed", { ...errorDetails(error) });
      }
    }
    return { events: polled.events, announced, failed };
  }
}
