/**
 * What a user notification is about. Semantic, never wording: how it is said (and in which channel) is decided downstream.
 * Onboarding is the first producer. The set is closed here so a typo cannot create a notification nobody renders.
 */
export const USER_NOTIFICATION_KINDS = [
  "ONBOARDING_STARTED",
  "WALLET_ROOT_CREATED",
  "WALLET_READY",
  "PIN_CREATED",
  "RECOVERY_CONFIGURED",
  "ONBOARDING_COMPLETED",
] as const;
export type UserNotificationKind = (typeof USER_NOTIFICATION_KINDS)[number];

export interface UserNotification {
  id: string;
  userId: string;
  kind: UserNotificationKind;
  createdAt: Date;
  /** Set while a worker is delivering it; a stale claim may be taken over. */
  claimedAt?: Date;
  /** When the person was told, or when no telling was needed (silent, superseded). */
  deliveredAt?: Date;
  attempts: number;
}

/**
 * A persisted, deduplicated outbox. There is at most one row per (user, kind): recording a transition twice, from any number
 * of instances, creates it once, and only the instance that created it is "the" observer of that transition.
 */
export interface UserNotificationRepository {
  /**
   * Records that `kind` happened to `userId`. `created` is true only for the call that inserted the row. With `silent` the row
   * is born delivered (it marks a milestone without anyone needing to be told).
   */
  record(input: {
    id: string;
    userId: string;
    kind: UserNotificationKind;
    now: Date;
    silent?: boolean;
  }): Promise<{ created: boolean }>;

  listForUser(userId: string): Promise<UserNotification[]>;

  /** Users who have started onboarding and have not completed it, oldest first. */
  listUsersInOnboarding(limit: number): Promise<string[]>;

  /**
   * Atomically claims undelivered rows (never claimed, or claimed longer than `staleMs` ago, with fewer than `maxAttempts`
   * attempts). Each row is claimed by exactly one caller even when several run at once. Pass `userId` to claim only theirs.
   */
  claim(input: {
    now: Date;
    staleMs: number;
    maxAttempts: number;
    limit: number;
    userId?: string;
  }): Promise<UserNotification[]>;

  /** Marks claimed rows as delivered (the person was told, or the row was superseded by a later one). */
  markDelivered(ids: string[], now: Date): Promise<void>;

  /** Gives claimed rows back for a retry and counts the failed attempt. */
  release(ids: string[]): Promise<void>;
}
