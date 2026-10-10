export const EXECUTION_AUDIT_EVENTS = {
  firmQuoteRequested: "execution.firm_quote_requested",
  firmQuoteReceived: "execution.firm_quote_received",
  firmQuoteFailed: "execution.firm_quote_failed",
  reauthorizationRequired: "execution.reauthorization_required",
  planReady: "execution.plan_ready",
  planBlocked: "execution.plan_blocked",
  routeUnsupported: "execution.route_unsupported",
} as const;

export { SecretValue } from "./secret.js";
export { FIRM_ATTEMPT_STATUSES } from "./attempt.js";
export type {
  ExecutionSecretRepository,
  FirmAttemptStatus,
  FirmQuoteAttempt,
  FirmQuoteAttemptRepository,
  NewFirmQuoteAttempt,
  QuotedFields,
} from "./attempt.js";
export type {
  FirmExecutionCandidate,
  FirmQuote,
  FirmQuoteFailureCode,
  FirmQuoteProvider,
  FirmQuoteProviderResult,
  FirmQuoteRequest,
  UnsignedTransaction,
  UnsignedTransactions,
} from "./firm-quote.js";
export { PLAN_BLOCKERS } from "./plan.js";
export type {
  AccountRequirements,
  ExecutionPlan,
  ExecutionPlanStatus,
  PermissionRequirement,
  PermissionScope,
  PlanBlocker,
  PlanTransactions,
  SignerKind,
  SwapRequirement,
  TokenApprovalRequirement,
} from "./plan.js";
export type {
  ExecutionPlanRecord,
  ExecutionPlanRepository,
  NewExecutionPlanRecord,
  PlanRecordStatus,
} from "./plan-record.js";
export type { AllowanceReader } from "./readers.js";
