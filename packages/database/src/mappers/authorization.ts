import { createMoney } from "@kaada/domain";
import type {
  AuthorizationSession,
  NewPaymentAuthorization,
  PaymentAuthorization,
  TransactionPinSecurity,
} from "@kaada/domain";

import type {
  AuthorizationSession as SessionRow,
  PaymentAuthorization as AuthorizationRow,
  Prisma,
  TransactionPinSecurity as PinRow,
} from "../generated/prisma/client.js";
import { DataIntegrityError, maybe } from "./support.js";

export function toTransactionPinSecurity(row: PinRow): TransactionPinSecurity {
  return {
    id: row.id,
    userId: row.userId,
    pinHash: row.pinHash,
    failedAttempts: row.failedAttempts,
    lockLevel: row.lockLevel,
    ...maybe("lockedUntil", row.lockedUntil),
    changedAt: row.changedAt,
    resetRequired: row.resetRequired,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAuthorizationSession(row: SessionRow): AuthorizationSession {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    intentId: row.intentId,
    intentRevision: row.intentRevision,
    routeId: row.routeId,
    ...maybe("tokenHash", row.tokenHash),
    ...maybe("tokenIssuedAt", row.tokenIssuedAt),
    status: row.status,
    expiresAt: row.expiresAt,
    ...maybe("usedAt", row.usedAt),
    ...maybe("cancelReason", row.cancelReason),
    createdAt: row.createdAt,
  };
}

export function toPaymentAuthorization(row: AuthorizationRow): PaymentAuthorization {
  if (row.operation !== "SEND" && row.operation !== "CONVERT") {
    throw new DataIntegrityError(`authorization ${row.id} has operation ${row.operation}`);
  }
  const maxInput = createMoney(row.maxInputAmount, row.inputAssetId);
  const minOutput = createMoney(row.minOutputAmount, row.outputAssetId);
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    intentId: row.intentId,
    intentRevision: row.intentRevision,
    routeId: row.routeId,
    ...maybe("sessionId", row.sessionId),
    status: row.status,
    operation: row.operation,
    chainId: row.chainId,
    recipient: {
      ...maybe("recipientId", row.recipientId),
      ...maybe("address", row.recipientAddress),
    },
    ...maybe("destinationCountry", row.destinationCountry),
    bounds:
      row.amountMode === "EXACT_INPUT"
        ? { mode: "EXACT_INPUT", authorizedInput: maxInput, minimumOutput: minOutput }
        : { mode: "EXACT_OUTPUT", exactOutput: minOutput, maximumInput: maxInput },
    route: { assetPath: row.routeAssetPath, providers: row.routeProviders },
    expiresAt: row.expiresAt,
    ...maybe("consumedAt", row.consumedAt),
    ...maybe("revokedAt", row.revokedAt),
    ...maybe("revocationReason", row.revocationReason),
    createdAt: row.createdAt,
  };
}

export function paymentAuthorizationCreateData(
  authorization: NewPaymentAuthorization,
): Prisma.PaymentAuthorizationUncheckedCreateInput {
  const { bounds } = authorization;
  const maxInput = bounds.mode === "EXACT_INPUT" ? bounds.authorizedInput : bounds.maximumInput;
  const minOutput = bounds.mode === "EXACT_INPUT" ? bounds.minimumOutput : bounds.exactOutput;
  return {
    id: authorization.id,
    userId: authorization.userId,
    walletId: authorization.walletId,
    intentId: authorization.intentId,
    intentRevision: authorization.intentRevision,
    routeId: authorization.routeId,
    ...(authorization.sessionId !== undefined && { sessionId: authorization.sessionId }),
    operation: authorization.operation,
    chainId: authorization.chainId,
    ...(authorization.recipient.recipientId !== undefined && {
      recipientId: authorization.recipient.recipientId,
    }),
    ...(authorization.recipient.address !== undefined && {
      recipientAddress: authorization.recipient.address,
    }),
    ...(authorization.destinationCountry !== undefined && {
      destinationCountry: authorization.destinationCountry,
    }),
    amountMode: bounds.mode,
    inputAssetId: maxInput.assetId,
    outputAssetId: minOutput.assetId,
    maxInputAmount: maxInput.amount,
    minOutputAmount: minOutput.amount,
    routeAssetPath: authorization.route.assetPath,
    routeProviders: authorization.route.providers,
    expiresAt: authorization.expiresAt,
  };
}
