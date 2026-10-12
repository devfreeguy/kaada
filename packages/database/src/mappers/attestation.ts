import type { AttestationChallenge, DeviceAttestation } from "@kaada/domain";

import type {
  DeviceAttestation as DeviceAttestationRow,
  DeviceAttestationChallenge as ChallengeRow,
} from "../generated/prisma/client.js";
import { maybe, readJsonObjectOrEmpty } from "./support.js";

export function toAttestationChallenge(row: ChallengeRow): AttestationChallenge {
  return {
    id: row.id,
    userId: row.userId,
    ...maybe("walletId", row.walletId),
    platform: row.platform,
    purpose: row.purpose,
    nonce: row.nonce,
    expiresAt: row.expiresAt,
    ...maybe("consumedAt", row.consumedAt),
    ...maybe("consumedPublicKeyHash", row.consumedPublicKeyHash),
    createdAt: row.createdAt,
  };
}

export function toDeviceAttestation(row: DeviceAttestationRow): DeviceAttestation {
  return {
    id: row.id,
    userId: row.userId,
    ...maybe("walletId", row.walletId),
    challengeId: row.challengeId,
    platform: row.platform,
    attestationType: row.attestationType,
    credentialRef: row.credentialRef,
    publicKeyHash: row.publicKeyHash,
    result: row.result,
    ...maybe("reason", row.reason),
    ...maybe("hardwareLevel", row.hardwareLevel),
    derivedTier: row.derivedTier,
    verifierVersion: row.verifierVersion,
    facts: readJsonObjectOrEmpty(row.facts, "DeviceAttestation.facts"),
    chainHashes: row.chainHashes,
    ...maybe("trustAnchor", row.trustAnchor),
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
  };
}
