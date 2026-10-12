import type {
  AttestationChallenge,
  DeviceAttestation,
  DeviceAttestationRepository,
} from "@kaada/domain";

/** The same contract as the Prisma repository: atomic one-time consumption, one attestation per challenge and per key. */
export function createMemoryDeviceAttestations(): DeviceAttestationRepository & {
  challenges: Map<string, AttestationChallenge>;
  attestations: Map<string, DeviceAttestation>;
} {
  const challenges = new Map<string, AttestationChallenge>();
  const attestations = new Map<string, DeviceAttestation>();
  return {
    challenges,
    attestations,
    issueChallenge(challenge, now) {
      const created: AttestationChallenge = { ...challenge, createdAt: now };
      challenges.set(created.id, created);
      return Promise.resolve(created);
    },
    consumeChallenge(input) {
      const challenge = challenges.get(input.id);
      if (
        !challenge ||
        challenge.consumedAt ||
        challenge.userId !== input.userId ||
        (challenge.walletId ?? null) !== (input.walletId ?? null) ||
        challenge.platform !== input.platform ||
        challenge.purpose !== input.purpose ||
        challenge.expiresAt <= input.now
      ) {
        return Promise.resolve(null);
      }
      // Synchronous check-and-set: of concurrent callers exactly one gets here first.
      const consumed = {
        ...challenge,
        consumedAt: input.now,
        consumedPublicKeyHash: input.publicKeyHash,
      };
      challenges.set(consumed.id, consumed);
      return Promise.resolve(consumed);
    },
    record(attestation, now) {
      const rows = [...attestations.values()];
      const verified = (row: DeviceAttestation) => row.result !== "REJECTED";
      if (
        rows.some((row) => row.challengeId === attestation.challengeId) ||
        (attestation.result !== "REJECTED" &&
          rows.some(
            (row) =>
              verified(row) &&
              row.platform === attestation.platform &&
              row.publicKeyHash === attestation.publicKeyHash,
          ))
      ) {
        return Promise.resolve(null);
      }
      const created: DeviceAttestation = { ...attestation, createdAt: now };
      attestations.set(created.id, created);
      return Promise.resolve(created);
    },
    findById: (id) => Promise.resolve(attestations.get(id) ?? null),
    listForKey: (userId, publicKeyHash) =>
      Promise.resolve(
        [...attestations.values()].filter(
          (row) => row.userId === userId && row.publicKeyHash === publicKeyHash,
        ),
      ),
    deleteChallengesExpiredBefore(before, limit) {
      const used = new Set([...attestations.values()].map((row) => row.challengeId));
      let removed = 0;
      for (const [id, challenge] of challenges) {
        if (removed >= limit) break;
        if (challenge.expiresAt < before && !used.has(id)) {
          challenges.delete(id);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}
