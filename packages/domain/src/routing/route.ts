import { KaadaError } from "../errors/index.js";
import type { JsonObject } from "../json.js";
import type { Money } from "../money/index.js";

export const ROUTE_STATUSES = ["CREATED", "VALID", "EXPIRED", "SELECTED", "INVALID"] as const;
export type RouteStatus = (typeof ROUTE_STATUSES)[number];

export const ROUTE_STEP_TYPES = [
  "TRANSFER",
  "SWAP",
  "BRIDGE",
  "ON_RAMP",
  "OFF_RAMP",
  "BANK_PAYOUT",
] as const;
export type RouteStepType = (typeof ROUTE_STEP_TYPES)[number];

/** CHEAPEST is the only preference with defined meaning today; the others are reserved names. */
export const ROUTE_PREFERENCES = ["CHEAPEST", "FASTEST", "LOWEST_SLIPPAGE"] as const;
export type RoutePreference = (typeof ROUTE_PREFERENCES)[number];

interface RouteStepBase {
  id: string;
  routeId: string;
  /** Zero-based order within the route. */
  position: number;
  input: Money;
  output: Money;
  providerId?: string;
  /** The quote this step was priced from, when it came from one. */
  quoteId?: string;
  metadata?: JsonObject;
  createdAt: Date;
}

export interface SwapRouteStep extends RouteStepBase {
  type: "SWAP";
}
export interface TransferRouteStep extends RouteStepBase {
  type: "TRANSFER";
}
export interface BridgeRouteStep extends RouteStepBase {
  type: "BRIDGE";
}
export interface RampRouteStep extends RouteStepBase {
  type: "ON_RAMP" | "OFF_RAMP";
}
export interface BankPayoutRouteStep extends RouteStepBase {
  type: "BANK_PAYOUT";
}

export type RouteStep =
  SwapRouteStep | TransferRouteStep | BridgeRouteStep | RampRouteStep | BankPayoutRouteStep;

/**
 * A snapshot of one candidate way to move value from the sender asset to the recipient asset.
 * Routes are immutable once created; only `status` is expected to change.
 */
export interface PaymentRoute {
  id: string;
  intentId: string;
  status: RouteStatus;
  /** What the sender pays, as estimated when the route was built. */
  input: Money;
  /** What the recipient gets, as estimated when the route was built. */
  output: Money;
  totalFee?: Money;
  expiresAt?: Date;
  steps: RouteStep[];
  createdAt: Date;
}

/** The parts of a route that consistency checking needs; satisfied by stored and new routes. */
export interface RouteShape {
  id: string;
  input: Money;
  output: Money;
  steps: { position: number; input: Money; output: Money }[];
}

/**
 * Checks that a route is internally consistent: it has steps, the first step starts in the route
 * input asset, the last ends in the route output asset, and each step hands its output asset to the
 * next step. Amounts are not compared (fees make them legitimately differ).
 */
export function validatePaymentRoute(route: RouteShape): void {
  const ordered = [...route.steps].sort((a, b) => a.position - b.position);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (!first || !last) {
    throw new KaadaError("NO_ROUTE_AVAILABLE", "route has no steps", {
      details: { routeId: route.id },
    });
  }
  if (first.input.assetId !== route.input.assetId || last.output.assetId !== route.output.assetId) {
    throw new KaadaError("ASSET_MISMATCH", "route steps do not span the route assets", {
      details: { routeId: route.id },
    });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous && current && previous.output.assetId !== current.input.assetId) {
      throw new KaadaError("ASSET_MISMATCH", "route steps are not contiguous", {
        details: { routeId: route.id, position: current.position },
      });
    }
  }
}
