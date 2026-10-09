import { assertSmallestUnitAmount } from "@kaada/domain";
import type {
  AuditEvent,
  Execution,
  ExecutionUpdate,
  NewExecution,
  RampSession,
  Transaction,
} from "@kaada/domain";

import type {
  AuditEvent as AuditEventRow,
  Execution as ExecutionRow,
  Prisma,
  RampSession as RampSessionRow,
  Transaction as TransactionRow,
} from "../generated/prisma/client.js";
import { jsonInput, maybe, readJsonObject, readJsonValue } from "./support.js";

export function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    intentId: row.intentId,
    routeId: row.routeId,
    userId: row.userId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    ...maybe("confirmedAt", row.confirmedAt),
    ...maybe("startedAt", row.startedAt),
    ...maybe("completedAt", row.completedAt),
    ...maybe("failedAt", row.failedAt),
    ...maybe("failureCode", row.failureCode),
    ...maybe("failureMessage", row.failureMessage),
    ...maybe("metadata", readJsonObject(row.metadata, "Execution.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function executionCreateData(execution: NewExecution): Prisma.ExecutionUncheckedCreateInput {
  return {
    id: execution.id,
    intentId: execution.intentId,
    routeId: execution.routeId,
    userId: execution.userId,
    status: execution.status,
    idempotencyKey: execution.idempotencyKey,
    confirmedAt: execution.confirmedAt ?? null,
    startedAt: execution.startedAt ?? null,
    completedAt: execution.completedAt ?? null,
    failedAt: execution.failedAt ?? null,
    failureCode: execution.failureCode ?? null,
    failureMessage: execution.failureMessage ?? null,
    ...maybe("metadata", jsonInput(execution.metadata, "Execution.metadata")),
  };
}

/** Only the fields present in the update are written. */
export function executionUpdateData(update: ExecutionUpdate): Prisma.ExecutionUncheckedUpdateInput {
  return {
    ...maybe("status", update.status),
    ...maybe("confirmedAt", update.confirmedAt),
    ...maybe("startedAt", update.startedAt),
    ...maybe("completedAt", update.completedAt),
    ...maybe("failedAt", update.failedAt),
    ...maybe("failureCode", update.failureCode),
    ...maybe("failureMessage", update.failureMessage),
    ...maybe("metadata", jsonInput(update.metadata, "Execution.metadata")),
  };
}

function optionalAmount(value: string | null, label: string): string | undefined {
  if (value === null) return undefined;
  assertSmallestUnitAmount(value, label);
  return value;
}

export function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    executionId: row.executionId,
    type: row.type,
    status: row.status,
    chainId: row.chainId,
    ...maybe("hash", row.hash),
    ...maybe("fromAddress", row.fromAddress),
    ...maybe("toAddress", row.toAddress),
    ...maybe("assetId", row.assetId),
    ...maybe("amount", optionalAmount(row.amount, "Transaction.amount")),
    ...maybe("gasAmount", optionalAmount(row.gasAmount, "Transaction.gasAmount")),
    ...maybe("gasAssetId", row.gasAssetId),
    ...maybe("nonce", optionalAmount(row.nonce, "Transaction.nonce")),
    ...maybe("metadata", readJsonObject(row.metadata, "Transaction.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRampSession(row: RampSessionRow): RampSession {
  return {
    id: row.id,
    userId: row.userId,
    providerId: row.providerId,
    type: row.type,
    status: row.status,
    assetId: row.assetId,
    ...maybe("amount", optionalAmount(row.amount, "RampSession.amount")),
    ...maybe("countryCode", row.countryCode),
    ...maybe("destinationAddress", row.destinationAddress),
    ...maybe("externalSessionId", row.externalSessionId),
    ...maybe("redirectUrl", row.redirectUrl),
    ...maybe("metadata", readJsonObject(row.metadata, "RampSession.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    ...maybe("userId", row.userId),
    ...maybe("executionId", row.executionId),
    type: row.type,
    ...maybe("entityType", row.entityType),
    ...maybe("entityId", row.entityId),
    ...maybe("data", readJsonValue(row.data, "AuditEvent.data")),
    createdAt: row.createdAt,
  };
}
