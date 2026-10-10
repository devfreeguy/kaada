import type { JsonObject } from "../json.js";

/**
 * The Execution row for one authorized payment through its whole life:
 *
 *   PREPARING -> READY -> (REQUIRES_USER_ACTION -> READY) -> SIGNING -> SUBMITTING -> SUBMITTED
 *             -> SETTLING -> COMPLETED          (or FAILED / EXPIRED / BLOCKED at the points they apply)
 *
 * SIGNING is entered only together with consuming the payment authorization, atomically; nothing
 * after it is ever retried blindly.
 */
export type PlanRecordStatus =
  | "PREPARING"
  | "READY"
  | "BLOCKED"
  | "EXPIRED"
  | "FAILED"
  | "REQUIRES_USER_ACTION"
  | "SIGNING"
  | "SUBMITTING"
  | "SUBMITTED"
  | "SETTLING"
  | "COMPLETED";

/** Statuses after which nothing more happens to the execution. */
export const TERMINAL_EXECUTION_STATUSES: readonly PlanRecordStatus[] = [
  "COMPLETED",
  "FAILED",
  "EXPIRED",
  "BLOCKED",
];

/** Statuses in which funds may already have moved or be moving: never retried blindly. */
export const IN_FLIGHT_EXECUTION_STATUSES: readonly PlanRecordStatus[] = [
  "SIGNING",
  "SUBMITTING",
  "SUBMITTED",
  "SETTLING",
];

export interface ExecutionPlanRecord {
  id: string;
  userId: string;
  intentId: string;
  routeId: string;
  paymentAuthorizationId: string;
  walletId: string;
  firmQuoteAttemptId?: string;
  status: PlanRecordStatus;
  /** The serialized ExecutionPlan. Holds no secret, signature or claim token. */
  plan?: JsonObject;
  failureCode?: string;
  /** Set when execution rights were acquired and the authorization consumed (atomically). */
  authorizationConsumedAt?: Date;
  /** What the person must do next, while REQUIRES_USER_ACTION. */
  userActionKind?: string;
  /** PENDING, SUBMITTED or FAILED: whether the provider has been told. */
  providerSubmitState?: "PENDING" | "SUBMITTED" | "FAILED";
  /** What actually settled, smallest units, once read from the provider / chain. */
  settledInputAmount?: string;
  settledOutputAmount?: string;
  claimTombstonedAt?: Date;
  lastReconciledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NewExecutionPlanRecord = Pick<
  ExecutionPlanRecord,
  "id" | "userId" | "intentId" | "routeId" | "paymentAuthorizationId" | "walletId"
>;

export interface ExecutionPlanRepository {
  /** One record per authorization: a repeat returns the existing one and creates nothing. */
  begin(record: NewExecutionPlanRecord): Promise<{ record: ExecutionPlanRecord; created: boolean }>;
  findByAuthorization(paymentAuthorizationId: string): Promise<ExecutionPlanRecord | null>;
  findById(id: string): Promise<ExecutionPlanRecord | null>;
  /**
   * Compare-and-set: moves the record from any status in `from` to `to` in one conditional UPDATE and
   * returns it, or null if it was not in `from`. Of racing callers exactly one wins.
   */
  transition(
    id: string,
    from: readonly PlanRecordStatus[],
    to: PlanRecordStatus,
    fields?: TransitionFields,
  ): Promise<ExecutionPlanRecord | null>;
  /**
   * THE execution lock. In the caller's transaction: lock the row, require READY, consume the payment
   * authorization (ACTIVE and unexpired) and move to SIGNING with `authorizationConsumedAt` set. Either
   * all of it happens or none of it does; of racing callers exactly one is ACQUIRED.
   */
  acquire(id: string, now: Date): Promise<AcquireResult>;
  /** Records in the given statuses, oldest first (for reconciliation). */
  listByStatus(
    statuses: readonly PlanRecordStatus[],
    limit: number,
  ): Promise<ExecutionPlanRecord[]>;
  update(
    id: string,
    update: {
      status: PlanRecordStatus;
      plan?: JsonObject;
      failureCode?: string;
      firmQuoteAttemptId?: string;
    },
  ): Promise<ExecutionPlanRecord>;
}

export interface TransitionFields {
  failureCode?: string;
  userActionKind?: string | null;
  providerSubmitState?: "PENDING" | "SUBMITTED" | "FAILED";
  settledInputAmount?: string;
  settledOutputAmount?: string;
  claimTombstonedAt?: Date;
  lastReconciledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  plan?: JsonObject;
  firmQuoteAttemptId?: string;
}

export type AcquireResult =
  | { status: "ACQUIRED"; record: ExecutionPlanRecord }
  | { status: "NOT_READY" }
  | { status: "AUTHORIZATION_UNAVAILABLE" };
