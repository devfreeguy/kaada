import type { ExecutionPlanRecord, JsonObject } from "@kaada/domain";

import type { PreparationOutcome } from "./preparation-service.js";

/**
 * Runs a preparation in the background and lets the page ask how it went. One run per authorization
 * at a time in this process; across processes the database (one live firm attempt, one plan record)
 * is what keeps duplicates from costing a provider slot. A restart loses the in-memory result, so the
 * outcome is also derivable from the stored plan record.
 */
export class PreparationTracker {
  private readonly running = new Map<string, Promise<void>>();
  private readonly latest = new Map<string, { outcome: PreparationOutcome; at: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Starts a run unless one is already in flight for this authorization. Never throws. */
  start(authorizationId: string, run: () => Promise<PreparationOutcome>): "STARTED" | "RUNNING" {
    if (this.running.has(authorizationId)) return "RUNNING";
    const job = run()
      .then((outcome) => {
        this.latest.set(authorizationId, { outcome, at: this.now() });
      })
      .catch(() => {
        this.latest.set(authorizationId, {
          outcome: { status: "FINAL_PRICE_UNAVAILABLE", code: "UNEXPECTED" },
          at: this.now(),
        });
      })
      .finally(() => {
        this.running.delete(authorizationId);
        this.prune();
      });
    this.running.set(authorizationId, job);
    return "STARTED";
  }

  isRunning(authorizationId: string): boolean {
    return this.running.has(authorizationId);
  }

  outcome(authorizationId: string): PreparationOutcome | undefined {
    return this.latest.get(authorizationId)?.outcome;
  }

  /** Waits for any in-flight run (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  private prune(): void {
    const cutoff = this.now() - 30 * 60 * 1000;
    for (const [id, entry] of this.latest) if (entry.at < cutoff) this.latest.delete(id);
  }
}

/** The accept cutoff recorded in a serialized plan, or undefined if it is missing or malformed. */
export function planExpiresAt(plan: JsonObject | undefined): Date | undefined {
  const value = plan?.["expiresAt"];
  if (typeof value !== "string") return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** What a stored plan record says when the in-memory result is gone. */
export function outcomeFromRecord(
  record: ExecutionPlanRecord | null,
): PreparationOutcome | undefined {
  if (!record) return undefined;
  switch (record.status) {
    case "READY":
      return {
        status: "EXECUTION_READY",
        executionId: record.id,
        expiresAt: planExpiresAt(record.plan) ?? new Date(0),
        reused: true,
      };
    case "BLOCKED":
      return { status: "EXECUTION_BLOCKED", executionId: record.id, blockers: [] };
    case "PREPARING":
      return { status: "PREPARATION_IN_PROGRESS" };
    case "EXPIRED":
      return { status: "FINAL_PRICE_UNAVAILABLE", code: "EXPIRED" };
    case "REQUIRES_USER_ACTION":
    case "SIGNING":
    case "SUBMITTING":
    case "SUBMITTED":
    case "SETTLING":
    case "COMPLETED":
      // Priced and past it: payment progress is reported by the run status, not by preparation.
      return {
        status: "EXECUTION_READY",
        executionId: record.id,
        expiresAt: planExpiresAt(record.plan) ?? new Date(0),
        reused: true,
      };
    case "FAILED":
      switch (record.failureCode) {
        case "OUTSIDE_AUTHORIZED_LIMITS":
          return { status: "REAUTHORIZATION_REQUIRED", reason: "OUTSIDE_AUTHORIZED_LIMITS" };
        case "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY":
          return { status: "FIRM_QUOTE_TOO_CLOSE_TO_EXPIRY" };
        case "INSUFFICIENT_BALANCE":
          return { status: "INSUFFICIENT_BALANCE" };
        case "PROVIDER_CAPACITY_REACHED":
          return { status: "PROVIDER_CAPACITY_REACHED" };
        default:
          return { status: "FINAL_PRICE_UNAVAILABLE", code: record.failureCode ?? "UNKNOWN" };
      }
  }
}
