import type { ExecutionPlanRecord } from "@kaada/domain";

import { runMessage } from "./runner.js";
import type { RunOutcome } from "./runner.js";

/** The states a browser or a channel may be shown for a payment that is being carried out. */
export type PaymentState =
  | "NOT_STARTED"
  | "ROOT_ACTION_REQUIRED"
  | "PROCESSING_PAYMENT"
  | "PAYMENT_SENT"
  | "PAYMENT_PENDING"
  | "PAYMENT_FAILED"
  | "REAUTHORIZATION_REQUIRED"
  | "GAS_FUNDING_REQUIRED"
  | "INSUFFICIENT_BALANCE"
  | "EXECUTION_ROUTE_UNSUPPORTED";

export interface PaymentView {
  state: PaymentState;
  message: string;
  /** A code a person can quote to support. Never an internal reason, a hash or an amount. */
  code?: string;
}

const view = (outcome: RunOutcome): PaymentView => {
  switch (outcome.status) {
    case "ROOT_ACTION_REQUIRED":
      return { state: "ROOT_ACTION_REQUIRED", message: runMessage(outcome) };
    case "PAYMENT_FAILED":
      return { state: "PAYMENT_FAILED", message: runMessage(outcome), code: outcome.code };
    case "REAUTHORIZATION_REQUIRED":
      return { state: "REAUTHORIZATION_REQUIRED", message: runMessage(outcome) };
    case "NOT_READY":
      return { state: "NOT_STARTED", message: runMessage(outcome) };
    default:
      return { state: outcome.status, message: runMessage(outcome) };
  }
};

/**
 * What to tell the person, from the most recent run outcome in this process if there is one, else from
 * the stored record. A stored status never claims more than the chain and the provider agreed on:
 * PAYMENT_SENT appears only for COMPLETED.
 */
export function paymentView(
  record: ExecutionPlanRecord | null,
  latest: RunOutcome | undefined,
): PaymentView {
  if (!record) return view({ status: "NOT_READY" });
  switch (record.status) {
    case "COMPLETED":
      return view({ status: "PAYMENT_SENT" });
    case "FAILED":
      return view({ status: "PAYMENT_FAILED", code: record.failureCode ?? "FAILED" });
    case "EXPIRED":
      return view({ status: "REAUTHORIZATION_REQUIRED", reason: "EXPIRED" });
    case "BLOCKED":
      return view({ status: "PAYMENT_FAILED", code: record.failureCode ?? "BLOCKED" });
    case "REQUIRES_USER_ACTION":
      return view({ status: "ROOT_ACTION_REQUIRED", rootActionId: "" });
    case "SIGNING":
    case "SUBMITTING":
    case "SUBMITTED":
      return view(latest?.status === "PAYMENT_PENDING" ? latest : { status: "PROCESSING_PAYMENT" });
    case "SETTLING":
      return view({ status: "PAYMENT_PENDING" });
    case "READY":
      // Not started, or stopped before taking execution rights (e.g. waiting for gas).
      return latest && latest.status !== "PAYMENT_SENT"
        ? view(latest)
        : view({ status: "NOT_READY" });
    case "PREPARING":
    default:
      return view({ status: "NOT_READY" });
  }
}
