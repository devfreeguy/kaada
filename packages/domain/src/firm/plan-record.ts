import type { JsonObject } from "../json.js";

/**
 * The Execution row for one authorized payment, as far as THIS stage goes: it can be prepared, ready,
 * blocked, expired or failed. It is never executing, settling or completed: nothing here moves funds.
 */
export type PlanRecordStatus = "PREPARING" | "READY" | "BLOCKED" | "EXPIRED" | "FAILED";

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
