import type { RootChange } from "@kaada/domain";

import type { RootChange as RootChangeRow } from "../generated/prisma/client.js";
import { maybe, readJsonObjectOrEmpty } from "./support.js";

export function toRootChange(row: RootChangeRow): RootChange {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    kind: row.kind,
    status: row.status,
    newCredentialId: row.newCredentialId,
    ...maybe("signerCredentialId", row.signerCredentialId),
    challenge: row.challenge,
    prepared: readJsonObjectOrEmpty(row.prepared, "RootChange.prepared"),
    ...maybe("userOpHash", row.userOpHash),
    expiresAt: row.expiresAt,
    ...maybe("failureCode", row.failureCode),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...maybe("completedAt", row.completedAt),
  };
}
