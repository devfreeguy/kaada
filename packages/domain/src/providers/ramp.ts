import type { JsonObject } from "../json.js";
import type { Money } from "../money/index.js";

export const RAMP_TYPES = ["ON_RAMP", "OFF_RAMP"] as const;
export type RampType = (typeof RAMP_TYPES)[number];

export const RAMP_STATUSES = [
  "CREATED",
  "REDIRECT_REQUIRED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type RampStatus = (typeof RAMP_STATUSES)[number];

/**
 * A fiat on/off-ramp session. Neither `redirectUrl` (hosted flows) nor `externalSessionId`
 * (API-driven flows) is required, so one shape serves both.
 */
export interface RampSession {
  id: string;
  userId: string;
  providerId: string;
  type: RampType;
  status: RampStatus;
  assetId: string;
  /** Smallest-unit amount of `assetId`, when known up front. */
  amount?: string;
  countryCode?: string;
  destinationAddress?: string;
  externalSessionId?: string;
  redirectUrl?: string;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** What a ramp provider is asked to set up. */
export interface RampRequest {
  userId: string;
  assetId: string;
  amount?: Money;
  countryCode?: string;
  destinationAddress?: string;
}

/** What a ramp provider returns, normalised. */
export interface RampSessionResult {
  status: RampStatus;
  externalSessionId?: string;
  redirectUrl?: string;
  metadata?: JsonObject;
}
