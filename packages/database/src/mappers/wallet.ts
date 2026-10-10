import { createMoney } from "@kaada/domain";
import type {
  DelegatedPermission,
  Enforcement,
  NewDelegatedPermission,
  PasskeyChallenge,
  PasskeyCredential,
  PermissionConstraint,
  PermissionOperation,
  Wallet,
} from "@kaada/domain";
import { PERMISSION_CONSTRAINTS, PERMISSION_OPERATIONS } from "@kaada/domain";

import type {
  DelegatedPermission as PermissionRow,
  PasskeyChallenge as ChallengeRow,
  PasskeyCredential as CredentialRow,
  Prisma,
  Wallet as WalletRow,
} from "../generated/prisma/client.js";
import { DataIntegrityError, maybe, readJsonObject } from "./support.js";

export function toWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    userId: row.userId,
    chainId: row.chainId,
    ...maybe("address", row.address),
    ...maybe("label", row.label),
    isPrimary: row.isPrimary,
    type: row.type,
    status: row.status,
    deployment: row.deployment,
    ...maybe("provider", row.provider),
    ...maybe("providerAccountId", row.providerAccountId),
    ...maybe("statusReason", row.statusReason),
    ...maybe("provisionedAt", row.provisionedAt),
    ...maybe("metadata", readJsonObject(row.metadata, "Wallet.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPasskeyCredential(row: CredentialRow): PasskeyCredential {
  return {
    id: row.id,
    userId: row.userId,
    credentialId: row.credentialId,
    publicKeyX: row.publicKeyX,
    publicKeyY: row.publicKeyY,
    rpId: row.rpId,
    signCount: row.signCount,
    ...maybe("label", row.label),
    createdAt: row.createdAt,
    ...maybe("lastUsedAt", row.lastUsedAt),
    ...maybe("revokedAt", row.revokedAt),
  };
}

export function toPasskeyChallenge(row: ChallengeRow): PasskeyChallenge {
  return {
    id: row.id,
    userId: row.userId,
    purpose: row.purpose,
    challenge: row.challenge,
    expiresAt: row.expiresAt,
    ...maybe("usedAt", row.usedAt),
    createdAt: row.createdAt,
  };
}

const operations = new Set<string>(PERMISSION_OPERATIONS);

function readEnforcement(value: unknown, id: string): Record<PermissionConstraint, Enforcement> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DataIntegrityError(`DelegatedPermission ${id} enforcement is not an object`);
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<PermissionConstraint, Enforcement>;
  for (const constraint of PERMISSION_CONSTRAINTS) {
    const entry = record[constraint];
    if (entry !== "ONCHAIN" && entry !== "KAADA_POLICY") {
      throw new DataIntegrityError(
        `DelegatedPermission ${id} has no enforcement for ${constraint}`,
      );
    }
    result[constraint] = entry;
  }
  return result;
}

export function toDelegatedPermission(row: PermissionRow): DelegatedPermission {
  const allowedOperations = row.allowedOperations.map((operation): PermissionOperation => {
    if (!operations.has(operation)) {
      throw new DataIntegrityError(
        `DelegatedPermission ${row.id} has unknown operation ${operation}`,
      );
    }
    return operation as PermissionOperation;
  });
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    provider: row.provider,
    ...maybe("providerPermissionId", row.providerPermissionId),
    chainId: row.chainId,
    status: row.status,
    allowedOperations,
    allowedContracts: row.allowedContracts,
    allowedAssetIds: row.allowedAssetIds,
    perTransactionLimit: createMoney(row.perTransactionAmount, row.perTransactionAssetId),
    ...(row.cumulativeAmount !== null &&
      row.cumulativeAssetId !== null && {
        cumulativeLimit: createMoney(row.cumulativeAmount, row.cumulativeAssetId),
      }),
    enforcement: readEnforcement(row.enforcement, row.id),
    validFrom: row.validFrom,
    expiresAt: row.expiresAt,
    ...maybe("revokedAt", row.revokedAt),
    ...maybe("revocationReason", row.revocationReason),
    createdAt: row.createdAt,
  };
}

export function permissionCreateData(
  permission: NewDelegatedPermission,
): Prisma.DelegatedPermissionUncheckedCreateInput {
  return {
    id: permission.id,
    userId: permission.userId,
    walletId: permission.walletId,
    provider: permission.provider,
    providerPermissionId: permission.providerPermissionId ?? null,
    chainId: permission.chainId,
    status: permission.status,
    allowedOperations: permission.allowedOperations,
    allowedContracts: permission.allowedContracts,
    allowedAssetIds: permission.allowedAssetIds,
    perTransactionAmount: permission.perTransactionLimit.amount,
    perTransactionAssetId: permission.perTransactionLimit.assetId,
    cumulativeAmount: permission.cumulativeLimit?.amount ?? null,
    cumulativeAssetId: permission.cumulativeLimit?.assetId ?? null,
    enforcement: permission.enforcement,
    validFrom: permission.validFrom,
    expiresAt: permission.expiresAt,
  };
}
