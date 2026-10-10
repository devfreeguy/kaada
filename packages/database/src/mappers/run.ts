import type { RootActionKind, RootActionSession, Transaction } from "@kaada/domain";
import { ROOT_ACTION_KINDS } from "@kaada/domain";

import type {
  RootActionSession as RootActionRow,
  Transaction as TransactionRow,
} from "../generated/prisma/client.js";
import { DataIntegrityError, maybe, readJsonObject, readJsonObjectOrEmpty } from "./support.js";

export function toExecutionTransaction(row: TransactionRow): Transaction {
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
    ...maybe("amount", row.amount),
    ...maybe("gasAmount", row.gasAmount),
    ...maybe("gasAssetId", row.gasAssetId),
    ...maybe("nonce", row.nonce),
    ...maybe("userOpHash", row.userOpHash),
    ...maybe("idempotencyKey", row.idempotencyKey),
    ...maybe("blockNumber", row.blockNumber),
    ...maybe("submittedAt", row.submittedAt),
    ...maybe("confirmedAt", row.confirmedAt),
    ...maybe("failureCode", row.failureCode),
    ...maybe("metadata", readJsonObject(row.metadata, "Transaction.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const KINDS = new Set<string>(ROOT_ACTION_KINDS);

export function toRootActionSession(row: RootActionRow): RootActionSession {
  if (!KINDS.has(row.kind)) {
    throw new DataIntegrityError(`root action ${row.id} has unknown kind ${row.kind}`);
  }
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    executionId: row.executionId,
    kind: row.kind as RootActionKind,
    ...maybe("tokenHash", row.tokenHash),
    status: row.status,
    challenge: row.challenge,
    prepared: readJsonObjectOrEmpty(row.prepared, "RootActionSession.prepared"),
    expiresAt: row.expiresAt,
    ...maybe("usedAt", row.usedAt),
    createdAt: row.createdAt,
  };
}
