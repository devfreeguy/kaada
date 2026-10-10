import { createMoney } from "@kaada/domain";
import type {
  ExecutionPlanRecord,
  FirmQuoteAttempt,
  JsonObject,
  UnsignedTransactions,
} from "@kaada/domain";
import { z } from "zod";

import type {
  Execution as ExecutionRow,
  FirmQuoteAttempt as AttemptRow,
} from "../generated/prisma/client.js";
import { DataIntegrityError, maybe, readJsonObject } from "./support.js";

const unsignedTransaction = z.object({
  to: z.string().min(1),
  data: z.string().min(1),
  value: z.string().regex(/^(0|[1-9][0-9]*)$/),
  chainId: z.number().int().positive(),
});
const unsignedTransactions = z.object({ approval: unsignedTransaction, swap: unsignedTransaction });

export function toFirmQuoteAttempt(row: AttemptRow): FirmQuoteAttempt {
  const transactions = row.unsignedTransactions
    ? unsignedTransactions.safeParse(row.unsignedTransactions)
    : undefined;
  if (transactions && !transactions.success) {
    throw new DataIntegrityError(`firm quote attempt ${row.id} has malformed transactions`);
  }
  return {
    id: row.id,
    paymentAuthorizationId: row.paymentAuthorizationId,
    userId: row.userId,
    walletId: row.walletId,
    providerId: row.providerId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    amountMode: row.amountMode,
    exactAmount: createMoney(row.exactAmount, row.exactAssetId),
    takerAddress: row.takerAddress,
    ...maybe("providerQuoteId", row.providerQuoteId),
    ...(row.inputAmount &&
      row.inputAssetId && { input: createMoney(row.inputAmount, row.inputAssetId) }),
    ...(row.outputAmount &&
      row.outputAssetId && { output: createMoney(row.outputAmount, row.outputAssetId) }),
    ...(row.feeAmount && row.feeAssetId && { fee: createMoney(row.feeAmount, row.feeAssetId) }),
    ...maybe("reactor", row.reactor),
    ...maybe("spender", row.spender),
    ...maybe("expiresAt", row.expiresAt),
    ...maybe("orderDeadline", row.orderDeadline),
    ...maybe("latestOrderDeadline", row.latestOrderDeadline),
    ...(transactions?.success && {
      unsignedTransactions: transactions.data satisfies UnsignedTransactions,
    }),
    ...maybe("claimSecretId", row.claimSecretId),
    ...(row.failureCode && {
      failureCode: row.failureCode as NonNullable<FirmQuoteAttempt["failureCode"]>,
    }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const PLAN_STATUSES = new Set([
  "PREPARING",
  "READY",
  "BLOCKED",
  "EXPIRED",
  "FAILED",
  "REQUIRES_USER_ACTION",
  "SIGNING",
  "SUBMITTING",
  "SUBMITTED",
  "SETTLING",
  "COMPLETED",
]);

export function toExecutionPlanRecord(row: ExecutionRow): ExecutionPlanRecord {
  if (!row.paymentAuthorizationId || !row.walletId || !PLAN_STATUSES.has(row.status)) {
    throw new DataIntegrityError(`execution ${row.id} is not a payment execution plan`);
  }
  const plan = readJsonObject(row.plan, "Execution.plan");
  return {
    id: row.id,
    userId: row.userId,
    intentId: row.intentId,
    routeId: row.routeId,
    paymentAuthorizationId: row.paymentAuthorizationId,
    walletId: row.walletId,
    ...maybe("firmQuoteAttemptId", row.firmQuoteAttemptId),
    status: row.status as ExecutionPlanRecord["status"],
    ...(plan && { plan: plan satisfies JsonObject }),
    ...maybe("failureCode", row.failureCode),
    ...maybe("authorizationConsumedAt", row.authorizationConsumedAt),
    ...maybe("userActionKind", row.userActionKind),
    ...(row.providerSubmitState && {
      providerSubmitState: row.providerSubmitState as NonNullable<
        ExecutionPlanRecord["providerSubmitState"]
      >,
    }),
    ...maybe("settledInputAmount", row.settledInputAmount),
    ...maybe("settledOutputAmount", row.settledOutputAmount),
    ...maybe("claimTombstonedAt", row.claimTombstonedAt),
    ...maybe("lastReconciledAt", row.lastReconciledAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
