import type { DeviceAttestationRepository } from "@kaada/domain";

import type { Prisma } from "../generated/prisma/client.js";
import { toAttestationChallenge, toDeviceAttestation } from "../mappers/attestation.js";
import type { Db } from "./db.js";

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "P2002";

export function createDeviceAttestationRepository(db: Db): DeviceAttestationRepository {
  return {
    async issueChallenge(challenge, now) {
      const row = await db.deviceAttestationChallenge.create({
        data: {
          id: challenge.id,
          userId: challenge.userId,
          ...(challenge.walletId && { walletId: challenge.walletId }),
          platform: challenge.platform,
          purpose: challenge.purpose,
          nonce: challenge.nonce,
          expiresAt: challenge.expiresAt,
          createdAt: now,
        },
      });
      return toAttestationChallenge(row);
    },

    async consumeChallenge(input) {
      // One conditional UPDATE decides the winner: of any number of concurrent callers exactly one matches the row.
      const { count } = await db.deviceAttestationChallenge.updateMany({
        where: {
          id: input.id,
          userId: input.userId,
          walletId: input.walletId ?? null,
          platform: input.platform,
          purpose: input.purpose,
          consumedAt: null,
          expiresAt: { gt: input.now },
        },
        data: { consumedAt: input.now, consumedPublicKeyHash: input.publicKeyHash },
      });
      if (count !== 1) return null;
      const row = await db.deviceAttestationChallenge.findUnique({ where: { id: input.id } });
      return row ? toAttestationChallenge(row) : null;
    },

    async record(attestation, now) {
      try {
        const row = await db.deviceAttestation.create({
          data: {
            id: attestation.id,
            userId: attestation.userId,
            ...(attestation.walletId && { walletId: attestation.walletId }),
            challengeId: attestation.challengeId,
            platform: attestation.platform,
            attestationType: attestation.attestationType,
            credentialRef: attestation.credentialRef,
            publicKeyHash: attestation.publicKeyHash,
            result: attestation.result,
            ...(attestation.reason && { reason: attestation.reason }),
            ...(attestation.hardwareLevel && { hardwareLevel: attestation.hardwareLevel }),
            derivedTier: attestation.derivedTier,
            verifierVersion: attestation.verifierVersion,
            facts: attestation.facts as Prisma.InputJsonObject,
            chainHashes: attestation.chainHashes,
            ...(attestation.trustAnchor && { trustAnchor: attestation.trustAnchor }),
            verifiedAt: attestation.verifiedAt,
            createdAt: now,
          },
        });
        return toDeviceAttestation(row);
      } catch (error) {
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    async findById(id) {
      const row = await db.deviceAttestation.findUnique({ where: { id } });
      return row ? toDeviceAttestation(row) : null;
    },

    async listForKey(userId, publicKeyHash) {
      const rows = await db.deviceAttestation.findMany({
        where: { userId, publicKeyHash },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toDeviceAttestation);
    },

    async deleteChallengesExpiredBefore(before, limit) {
      const stale = await db.deviceAttestationChallenge.findMany({
        where: { expiresAt: { lt: before }, attestation: null },
        select: { id: true },
        take: limit,
      });
      if (stale.length === 0) return 0;
      const { count } = await db.deviceAttestationChallenge.deleteMany({
        where: { id: { in: stale.map((row) => row.id) }, attestation: null },
      });
      return count;
    },
  };
}
