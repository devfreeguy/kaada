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
}
