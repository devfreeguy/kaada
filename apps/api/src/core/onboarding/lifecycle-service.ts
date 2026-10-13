import { createId } from "@kaada/domain";
import type { UserNotification, UserNotificationRepository } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";
import { noopLog } from "../agent/ports.js";
import { deriveOnboarding, milestoneRank, reachedMilestones } from "./state.js";
import type { OnboardingPolicy, OnboardingState, OnboardingStateReader } from "./state.js";

export interface LifecycleServiceDeps {
  notifications: UserNotificationRepository;
  state: OnboardingStateReader;
  policy: OnboardingPolicy;
  log?: AgentLog;
  now?: () => Date;
  /** A delivery claim older than this is assumed dead and may be taken over. */
  staleClaimMs?: number;
  /** After this many failed deliveries a notification is left alone (the person can always ask in chat). */
  maxAttempts?: number;
}

export interface Announcement {
  userId: string;
  /** The most advanced milestone among the rows; the words come from the CURRENT state, not from this. */
  kind: UserNotification["kind"];
  /** Every row claimed for this person: all are marked delivered together (earlier ones are superseded). */
  ids: string[];
  state: OnboardingState;
}

/**
 * The onboarding side of the notification outbox. It turns changes in authoritative state into persisted, deduplicated
 * notifications, and hands them out one claimant at a time so that however many API instances (and inbound messages) notice a
 * transition, it is announced once.
 *
 *   state (wallet, PIN, recovery) -> observe() -> UserNotification rows (unique per user and kind)
 *                                 -> claimAnnouncements() -> deliver -> markDelivered() | release()
 *
 * It knows nothing about chat apps: delivery is the caller's job, through whatever channels the person has linked.
 */
export class OnboardingLifecycleService {
  private readonly now: () => Date;
  private readonly log: AgentLog;
  private readonly staleClaimMs: number;
  private readonly maxAttempts: number;

  constructor(private readonly deps: LifecycleServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? noopLog;
    this.staleClaimMs = deps.staleClaimMs ?? 60_000;
    this.maxAttempts = deps.maxAttempts ?? 8;
  }

  /** The person's current onboarding state, freshly read. The single source for every message about it. */
  async stateOf(userId: string): Promise<OnboardingState> {
    return deriveOnboarding(await this.deps.state.read(userId), this.deps.policy);
  }

  /**
   * Starts watching a person (idempotent). Milestones they have ALREADY reached are recorded silently, so a person who is
   * further along than the chat knows is not congratulated for things that happened long ago.
   */
  async track(userId: string): Promise<void> {
    const now = this.now();
    const started = await this.deps.notifications.record({
      id: createId(),
      userId,
      kind: "ONBOARDING_STARTED",
      now,
      silent: true,
    });
    if (!started.created) return;
    const state = await this.stateOf(userId);
    for (const kind of reachedMilestones(state)) {
      await this.deps.notifications.record({ id: createId(), userId, kind, now, silent: true });
    }
  }

  /** Whether this person is being watched for onboarding progress. */
  async isTracked(userId: string): Promise<boolean> {
    const rows = await this.deps.notifications.listForUser(userId);
    return rows.some((row) => row.kind === "ONBOARDING_STARTED");
  }

  /** Records the milestones the person's authoritative state has reached since last looked. Returns the new ones. */
  async observe(userId: string): Promise<UserNotification["kind"][]> {
    const state = await this.stateOf(userId);
    const known = new Set(
      (await this.deps.notifications.listForUser(userId)).map((row) => row.kind),
    );
    const created: UserNotification["kind"][] = [];
    for (const kind of reachedMilestones(state)) {
      if (known.has(kind)) continue;
      const result = await this.deps.notifications.record({
        id: createId(),
        userId,
        kind,
        now: this.now(),
      });
      if (result.created) created.push(kind);
    }
    if (created.length > 0)
      this.log("info", "onboarding.milestones", { userId, created: created.join(",") });
    return created;
  }

  /** Looks at everyone still onboarding. Safe to run from every instance at once. */
  async observeAll(limit = 50): Promise<number> {
    const users = await this.deps.notifications.listUsersInOnboarding(limit);
    let recorded = 0;
    for (const userId of users) recorded += (await this.observe(userId)).length;
    return recorded;
  }

  /**
   * Claims everything waiting to be announced (for one person, or everyone) and groups it per person. Whoever claims a row is
   * the only one who may tell the person about it: the sweeper and an inbound "Done" can race, and exactly one of them wins.
   */
  async claimAnnouncements(userId?: string, limit = 50): Promise<Announcement[]> {
    const claimed = await this.deps.notifications.claim({
      now: this.now(),
      staleMs: this.staleClaimMs,
      maxAttempts: this.maxAttempts,
      limit,
      ...(userId && { userId }),
    });
    const byUser = new Map<string, UserNotification[]>();
    for (const row of claimed) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);

    const announcements: Announcement[] = [];
    for (const [id, rows] of byUser) {
      const ids = rows.map((row) => row.id);
      const announced = rows.filter((row) => milestoneRank(row.kind) >= 0);
      if (announced.length === 0) {
        // Nothing the person needs to hear (silent milestones only).
        await this.deps.notifications.markDelivered(ids, this.now());
        continue;
      }
      const top = announced.reduce((best, row) =>
        milestoneRank(row.kind) > milestoneRank(best.kind) ? row : best,
      );
      announcements.push({ userId: id, kind: top.kind, ids, state: await this.stateOf(id) });
    }
    return announcements;
  }

  markDelivered(ids: string[]): Promise<void> {
    return this.deps.notifications.markDelivered(ids, this.now());
  }

  release(ids: string[]): Promise<void> {
    return this.deps.notifications.release(ids);
  }

  /**
   * True when an announcement reached this person at or after `since`. A message typed BEFORE the announcement arrived is already
   * answered by it: replying as well would tell them the same thing twice.
   */
  async announcedSince(userId: string, since: Date): Promise<boolean> {
    const rows = await this.deps.notifications.listForUser(userId);
    return rows.some(
      (row) =>
        milestoneRank(row.kind) >= 0 &&
        row.deliveredAt !== undefined &&
        row.deliveredAt.getTime() >= since.getTime(),
    );
  }

  /** True when another worker holds an announcement for this person that is on its way right now. */
  async hasAnnouncementInFlight(userId: string): Promise<boolean> {
    const rows = await this.deps.notifications.listForUser(userId);
    const cutoff = this.now().getTime() - this.staleClaimMs;
    return rows.some(
      (row) =>
        row.deliveredAt === undefined &&
        row.claimedAt !== undefined &&
        row.claimedAt.getTime() > cutoff &&
        milestoneRank(row.kind) >= 0,
    );
  }
}
