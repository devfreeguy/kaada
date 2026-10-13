import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import type { Announcement, OnboardingLifecycleService } from "../onboarding/lifecycle-service.js";
import { errorDetails } from "./error-details.js";

export interface OnboardingAnnouncerDeps {
  lifecycle: OnboardingLifecycleService;
  /** Delivers one announcement on the person's linked chats; reports how many reached them. */
  announce(announcement: Announcement): Promise<{ delivered: number; failed: number }>;
  log?: AgentLog;
}

/**
 * The notification dispatcher for onboarding. Each pass it
 *   1. observes: records the milestones that people still setting up have newly reached (persisted, unique per person and kind);
 *   2. claims: takes the announcements nobody else is delivering (one claimant per row, across instances);
 *   3. delivers them on the person's linked chats, and marks them delivered, or releases them so the next pass retries.
 *
 * It reads authoritative state and tells people about it. It never advances onboarding, and it never looks at chat text.
 */
export class OnboardingAnnouncer {
  private readonly log: AgentLog;

  constructor(private readonly deps: OnboardingAnnouncerDeps) {
    this.log = deps.log ?? noopLog;
  }

  async sweep(): Promise<{ observed: number; announced: number; failed: number }> {
    const { lifecycle } = this.deps;
    const observed = await lifecycle.observeAll();
    let announced = 0;
    let failed = 0;
    for (const announcement of await lifecycle.claimAnnouncements()) {
      try {
        const result = await this.deps.announce(announcement);
        if (result.failed > 0 && result.delivered === 0) {
          // Nothing reached them: put the claim back so the next pass tries again.
          await lifecycle.release(announcement.ids);
          failed += 1;
        } else {
          await lifecycle.markDelivered(announcement.ids);
          announced += 1;
        }
      } catch (error) {
        await lifecycle.release(announcement.ids);
        failed += 1;
        this.log("warn", "onboarding.announce_failed", { ...errorDetails(error) });
      }
    }
    return { observed, announced, failed };
  }
}
