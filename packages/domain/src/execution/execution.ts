import type { JsonObject, JsonValue } from "../json.js";
import type { Money } from "../money/index.js";
import type { ResolvedRecipient } from "../recipients/index.js";
import type { PaymentRoute } from "../routing/index.js";

export const EXECUTION_STATUSES = [
  "CREATED",
  "PREPARING",
  "READY",
  "BLOCKED",
  "REQUIRES_USER_ACTION",
  "SIGNING",
  "SUBMITTING",
  "SUBMITTED",
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "EXECUTING",
  "SETTLING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

/** A user-confirmed attempt to carry out one route for one intent. */
export interface Execution {
  id: string;
  intentId: string;
  routeId: string;
  userId: string;
  status: ExecutionStatus;
  /** Globally unique: replaying the same key can never start a second execution. */
  idempotencyKey: string;
  confirmedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  failureCode?: string;
  failureMessage?: string;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** What a caller supplies to start an execution. */
export interface ExecutionRequest {
  intentId: string;
  routeId: string;
  userId: string;
  idempotencyKey: string;
}

/** The outcome reported after an execution attempt. */
export interface ExecutionResult {
  executionId: string;
  status: ExecutionStatus;
  /** Present when status is FAILED. */
  failure?: { code: string; message: string };
  /** Ids of the Transactions that were created, in order. */
  transactionIds: string[];
}

/** An audit entry. Append-only: never updated or deleted. */
export interface AuditEvent {
  id: string;
  userId?: string;
  executionId?: string;
  /** Dotted event name, e.g. "execution.confirmed". */
  type: string;
  entityType?: string;
  entityId?: string;
  data?: JsonValue;
  createdAt: Date;
}

/**
 * Channel-independent summary of what the user is about to approve. Telegram, web and others render
 * it their own way.
 */
export interface PaymentConfirmation {
  operation: "SEND" | "CONVERT";
  senderSpends: Money;
  recipientReceives: Money;
  recipient?: ResolvedRecipient;
  /** Fees, possibly in several assets. */
  fees: Money[];
  route: PaymentRoute;
  expiresAt?: Date;
}
