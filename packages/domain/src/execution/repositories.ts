import type { Execution } from "./execution.js";

export type NewExecution = Omit<Execution, "createdAt" | "updatedAt">;

/** Fields an execution may change after creation. */
export type ExecutionUpdate = Partial<
  Pick<
    Execution,
    | "status"
    | "confirmedAt"
    | "startedAt"
    | "completedAt"
    | "failedAt"
    | "failureCode"
    | "failureMessage"
    | "metadata"
  >
>;

export interface CreateExecutionResult {
  execution: Execution;
  /** False when an execution with the same idempotency key already existed and was returned. */
  created: boolean;
}

export interface ExecutionRepository {
  /** Idempotent on `idempotencyKey`: a repeat call returns the original execution. */
  create(execution: NewExecution): Promise<CreateExecutionResult>;
  findById(id: string): Promise<Execution | null>;
  findByIdempotencyKey(idempotencyKey: string): Promise<Execution | null>;
  update(id: string, update: ExecutionUpdate): Promise<Execution>;
}
