import type { PaymentRoute, RouteStatus } from "./route.js";

export type NewRoute = Omit<PaymentRoute, "createdAt" | "steps"> & {
  steps: Omit<PaymentRoute["steps"][number], "createdAt">[];
};

export interface RouteRepository {
  /** Stores a route and all its steps atomically. */
  createWithSteps(route: NewRoute): Promise<PaymentRoute>;
  /** The route with its steps ordered by position. */
  findById(id: string): Promise<PaymentRoute | null>;
  updateStatus(id: string, status: RouteStatus): Promise<PaymentRoute>;
  /** Routes of an intent, newest first, with their steps. */
  listByIntent(intentId: string): Promise<PaymentRoute[]>;
  /**
   * Marks INVALID every still-usable route (CREATED, VALID, SELECTED) of the intent that was built for
   * a revision older than `currentRevision`. Rows are kept; only their status changes. Returns how
   * many were invalidated.
   */
  invalidateOlderThan(intentId: string, currentRevision: number): Promise<number>;
}
