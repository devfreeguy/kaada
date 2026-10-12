import type {
  RecoveryAttempt,
  RecoveryAttemptPatch,
  RecoveryConfiguration,
  RecoveryEmailChallenge,
  WalletCredential,
} from "@kaada/domain";

import type {
  Prisma,
  RecoveryAttempt as AttemptRow,
  RecoveryConfiguration as ConfigurationRow,
  RecoveryEmailChallenge as ChallengeRow,
  WalletCredential as CredentialRow,
} from "../generated/prisma/client.js";
import { maybe, readJsonObject } from "./support.js";

export function toWalletCredential(row: CredentialRow): WalletCredential {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    kind: row.kind,
    role: row.role,
    status: row.status,
    isRoot: row.isRoot,
    validatorAddress: row.validatorAddress,
    validatorPurpose: row.validatorPurpose,
    deploymentSalt: row.deploymentSalt,
    credentialRef: row.credentialRef,
    publicKeyX: row.publicKeyX,
    publicKeyY: row.publicKeyY,
    ...maybe("rpId", row.rpId),
    ...maybe("passkeyCredentialId", row.passkeyCredentialId),
    securityTier: row.securityTier,
    ...maybe("label", row.label),
    ...maybe("replacedByCredentialId", row.replacedByCredentialId),
    createdAt: row.createdAt,
    ...maybe("activatedAt", row.activatedAt),
    ...maybe("replacedAt", row.replacedAt),
    ...maybe("revokedAt", row.revokedAt),
  };
}

export function toRecoveryConfiguration(row: ConfigurationRow): RecoveryConfiguration {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    chainId: row.chainId,
    validatorAddress: row.validatorAddress,
    recoveryAddress: row.recoveryAddress,
    delaySeconds: row.delaySeconds,
    status: row.status,
    ...maybe("armedByCredentialId", row.armedByCredentialId),
    recoveryNonce: row.recoveryNonce,
    ...maybe("installUserOpHash", row.installUserOpHash),
    ...maybe(
      "preparedOperation",
      readJsonObject(row.preparedOperation, "RecoveryConfiguration.preparedOperation"),
    ),
    ...maybe("configuredAt", row.configuredAt),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRecoveryAttempt(row: AttemptRow): RecoveryAttempt {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    ...maybe("configurationId", row.configurationId),
    status: row.status,
    tokenHash: row.tokenHash,
    tokenExpiresAt: row.tokenExpiresAt,
    ...maybe("cancelTokenHash", row.cancelTokenHash),
    ...maybe("emailVerifiedAt", row.emailVerifiedAt),
    ...maybe("newCredentialId", row.newCredentialId),
    ...maybe("newRootKind", row.newRootKind),
    ...maybe("newValidator", row.newValidator),
    ...maybe("newValidatorData", row.newValidatorData),
    ...maybe("newValidatorDataHash", row.newValidatorDataHash),
    ...maybe("newHook", row.newHook),
    ...maybe("newHookData", row.newHookData),
    ...maybe("newHookDataHash", row.newHookDataHash),
    ...maybe("commitmentHash", row.commitmentHash),
    ...maybe("recoveryNonce", row.recoveryNonce),
    ...maybe("proofDeadline", row.proofDeadline),
    ...maybe("proposedAt", row.proposedAt),
    ...maybe("previousRootValidator", row.previousRootValidator),
    ...maybe("initiatedAt", row.initiatedAt),
    ...maybe("executeAfter", row.executeAfter),
    ...maybe("initiateTxHash", row.initiateTxHash),
    ...maybe("nonceBefore", row.nonceBefore),
    ...maybe("finalizeUserOpHash", row.finalizeUserOpHash),
    ...maybe("finalizeTxHash", row.finalizeTxHash),
    ...maybe("blockedReason", row.blockedReason),
    ...maybe("lockedBy", row.lockedBy),
    ...maybe("lockedUntil", row.lockedUntil),
    ...maybe("rootConfirmedAt", row.rootConfirmedAt),
    ...maybe("cancelChallenge", row.cancelChallenge),
    ...maybe(
      "cancelPrepared",
      readJsonObject(row.cancelPrepared, "RecoveryAttempt.cancelPrepared"),
    ),
    ...maybe("cancelUserOpHash", row.cancelUserOpHash),
    ...maybe("proofChallenge", row.proofChallenge),
    proofFailures: row.proofFailures,
    ...maybe("proofVerifiedAt", row.proofVerifiedAt),
    ...maybe("completedAt", row.completedAt),
    ...maybe("terminatedBy", row.terminatedBy),
    ...maybe("terminatedAt", row.terminatedAt),
    ...maybe("terminationTxHash", row.terminationTxHash),
    ...maybe("failureCode", row.failureCode),
    ...maybe("cleanupCompletedAt", row.cleanupCompletedAt),
    ...maybe("pinResetAt", row.pinResetAt),
    ...maybe("newConfigurationId", row.newConfigurationId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The Prisma update data for a patch: only the keys that are present (never `undefined`). */
export function attemptPatchData(
  patch: RecoveryAttemptPatch,
): Prisma.RecoveryAttemptUncheckedUpdateManyInput {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) data[key] = value;
  }
  return data;
}

export function toRecoveryEmailChallenge(row: ChallengeRow): RecoveryEmailChallenge {
  return {
    id: row.id,
    attemptId: row.attemptId,
    sessionTokenHash: row.sessionTokenHash,
    codeHash: row.codeHash,
    expiresAt: row.expiresAt,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    ...maybe("usedAt", row.usedAt),
    createdAt: row.createdAt,
  };
}
