import { canTransitionRecovery } from "@kaada/domain";
import type {
  RecoveryAttemptRepository,
  RecoveryAttemptStatus,
  RecoveryCleanupRepository,
  RecoveryClearable,
  RecoveryConfigurationRepository,
  RecoveryEmailChallengeRepository,
  RecoveryTotpRepository,
  WalletCredentialRepository,
} from "@kaada/domain";

import {
  attemptPatchData,
  toRecoveryAttempt,
  toRecoveryConfiguration,
  toRecoveryEmailChallenge,
  toRecoveryTotp,
  toWalletCredential,
} from "../mappers/recovery.js";
import type { Db } from "./db.js";

/** A unique-constraint violation (a second live attempt, a repeated validator instance ...). */
function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

const TERMINAL: RecoveryAttemptStatus[] = ["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"];
const PRE_CHAIN: RecoveryAttemptStatus[] = ["EMAIL_PENDING", "EMAIL_VERIFIED", "ROOT_PROPOSED"];

export function createWalletCredentialRepository(db: Db): WalletCredentialRepository {
  return {
    async create(credential) {
      return toWalletCredential(
        await db.walletCredential.create({
          data: {
            id: credential.id,
            userId: credential.userId,
            walletId: credential.walletId,
            kind: credential.kind,
            role: credential.role,
            status: credential.status,
            isRoot: credential.isRoot,
            validatorAddress: credential.validatorAddress,
            validatorPurpose: credential.validatorPurpose,
            deploymentSalt: credential.deploymentSalt,
            credentialRef: credential.credentialRef,
            publicKeyX: credential.publicKeyX,
            publicKeyY: credential.publicKeyY,
            rpId: credential.rpId ?? null,
            passkeyCredentialId: credential.passkeyCredentialId ?? null,
            securityTier: credential.securityTier,
            label: credential.label ?? null,
            ...(credential.status === "ACTIVE" && { activatedAt: new Date() }),
          },
        }),
      );
    },

    async findById(id) {
      const row = await db.walletCredential.findUnique({ where: { id } });
      return row ? toWalletCredential(row) : null;
    },

    async validatorEverUsed(walletId, validatorAddress) {
      const count = await db.walletCredential.count({
        where: { walletId, validatorAddress: validatorAddress.toLowerCase() },
      });
      return count > 0;
    },

    async findRoot(walletId) {
      const row = await db.walletCredential.findFirst({
        where: { walletId, isRoot: true, status: "ACTIVE" },
      });
      return row ? toWalletCredential(row) : null;
    },

    async listForWallet(walletId) {
      const rows = await db.walletCredential.findMany({
        where: { walletId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toWalletCredential);
    },

    /** Must run inside a transaction: the old root is demoted before the new one is promoted. */
    async promoteToRoot({ walletId, newId, at }) {
      const candidate = await db.walletCredential.findFirst({
        where: { id: newId, walletId, status: "PENDING" },
      });
      if (!candidate) return null;
      const current = await db.walletCredential.findFirst({
        where: { walletId, isRoot: true, status: "ACTIVE" },
      });
      if (current) {
        await db.walletCredential.updateMany({
          where: { id: current.id, isRoot: true, status: "ACTIVE" },
          data: {
            isRoot: false,
            status: "REPLACED",
            replacedAt: at,
            replacedByCredentialId: newId,
          },
        });
      }
      const { count } = await db.walletCredential.updateMany({
        where: { id: newId, status: "PENDING" },
        data: { isRoot: true, status: "ACTIVE", activatedAt: at },
      });
      if (count === 0) throw new Error("the credential is no longer pending");
      const promoted = await db.walletCredential.findUniqueOrThrow({ where: { id: newId } });
      const replaced = current
        ? await db.walletCredential.findUnique({ where: { id: current.id } })
        : null;
      return {
        promoted: toWalletCredential(promoted),
        replaced: replaced ? toWalletCredential(replaced) : null,
      };
    },

    async activate(id, at) {
      const { count } = await db.walletCredential.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "ACTIVE", activatedAt: at },
      });
      if (count !== 1) return null;
      const row = await db.walletCredential.findUnique({ where: { id } });
      return row ? toWalletCredential(row) : null;
    },

    async linkPasskey(id, passkeyCredentialId) {
      await db.walletCredential.updateMany({ where: { id }, data: { passkeyCredentialId } });
    },

    async revoke(id, at) {
      const { count } = await db.walletCredential.updateMany({
        where: { id, status: { in: ["PENDING", "ACTIVE"] } },
        data: { status: "REVOKED", isRoot: false, revokedAt: at },
      });
      if (count === 0) return null;
      const row = await db.walletCredential.findUnique({ where: { id } });
      return row ? toWalletCredential(row) : null;
    },
  };
}

export function createRecoveryConfigurationRepository(db: Db): RecoveryConfigurationRepository {
  return {
    async create(configuration) {
      return toRecoveryConfiguration(
        await db.recoveryConfiguration.create({
          data: {
            id: configuration.id,
            userId: configuration.userId,
            walletId: configuration.walletId,
            chainId: configuration.chainId,
            validatorAddress: configuration.validatorAddress,
            recoveryAddress: configuration.recoveryAddress,
            delaySeconds: configuration.delaySeconds,
            status: configuration.status,
            armedByCredentialId: configuration.armedByCredentialId ?? null,
            recoveryNonce: configuration.recoveryNonce,
            installUserOpHash: configuration.installUserOpHash ?? null,
            ...(configuration.preparedOperation && {
              preparedOperation: configuration.preparedOperation,
            }),
            ...(configuration.status === "ACTIVE" && { configuredAt: new Date() }),
          },
        }),
      );
    },

    async findById(id) {
      const row = await db.recoveryConfiguration.findUnique({ where: { id } });
      return row ? toRecoveryConfiguration(row) : null;
    },

    async findActive(walletId) {
      const row = await db.recoveryConfiguration.findFirst({
        where: { walletId, status: "ACTIVE" },
      });
      return row ? toRecoveryConfiguration(row) : null;
    },

    async listForWallet(walletId) {
      const rows = await db.recoveryConfiguration.findMany({
        where: { walletId },
        orderBy: { createdAt: "desc" },
      });
      return rows.map(toRecoveryConfiguration);
    },

    /** Must run inside a transaction: the previous ACTIVE one is superseded first (one ACTIVE per wallet). */
    async activate({ id, recoveryNonce, at }) {
      const row = await db.recoveryConfiguration.findFirst({
        where: { id, status: "PENDING_INSTALL" },
      });
      if (!row) return null;
      await db.recoveryConfiguration.updateMany({
        where: { walletId: row.walletId, status: "ACTIVE", id: { not: id } },
        data: { status: "SUPERSEDED" },
      });
      const { count } = await db.recoveryConfiguration.updateMany({
        where: { id, status: "PENDING_INSTALL" },
        data: { status: "ACTIVE", recoveryNonce, configuredAt: at },
      });
      if (count === 0) return null;
      return toRecoveryConfiguration(
        await db.recoveryConfiguration.findUniqueOrThrow({ where: { id } }),
      );
    },

    async close(id, status) {
      const { count } = await db.recoveryConfiguration.updateMany({
        where: { id, status: { in: ["ACTIVE", "PENDING_INSTALL"] } },
        data: { status },
      });
      if (count === 0) return null;
      return toRecoveryConfiguration(
        await db.recoveryConfiguration.findUniqueOrThrow({ where: { id } }),
      );
    },

    async recordNonce(id, recoveryNonce) {
      await db.recoveryConfiguration.updateMany({ where: { id }, data: { recoveryNonce } });
    },
  };
}

export function createRecoveryAttemptRepository(db: Db): RecoveryAttemptRepository {
  const fetch = async (id: string) => {
    const row = await db.recoveryAttempt.findUnique({ where: { id } });
    return row ? toRecoveryAttempt(row) : null;
  };
  const clearData = (clear: RecoveryClearable[] | undefined) => ({
    ...(clear?.includes("blockedReason") && { blockedReason: null }),
    ...(clear?.includes("lease") && { lockedBy: null, lockedUntil: null }),
    ...(clear?.includes("finalizeSubmission") && { finalizeUserOpHash: null, nonceBefore: null }),
  });

  return {
    async create(attempt) {
      try {
        return toRecoveryAttempt(
          await db.recoveryAttempt.create({
            data: {
              id: attempt.id,
              userId: attempt.userId,
              walletId: attempt.walletId,
              configurationId: attempt.configurationId ?? null,
              tokenHash: attempt.tokenHash,
              tokenExpiresAt: attempt.tokenExpiresAt,
            },
          }),
        );
      } catch (error) {
        // The partial unique index: this wallet already has a live attempt.
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    findById: fetch,

    async findByTokenHash(tokenHash) {
      const row = await db.recoveryAttempt.findUnique({ where: { tokenHash } });
      return row ? toRecoveryAttempt(row) : null;
    },

    async findByCancelTokenHash(tokenHash) {
      const row = await db.recoveryAttempt.findUnique({ where: { cancelTokenHash: tokenHash } });
      return row ? toRecoveryAttempt(row) : null;
    },

    async recordProofFailure(id) {
      const row = await db.recoveryAttempt.update({
        where: { id },
        data: { proofFailures: { increment: 1 } },
        select: { proofFailures: true },
      });
      return row.proofFailures;
    },

    async findActiveByWallet(walletId) {
      const row = await db.recoveryAttempt.findFirst({
        where: { walletId, status: { notIn: TERMINAL } },
      });
      return row ? toRecoveryAttempt(row) : null;
    },

    async advance({ id, from, to, patch, clear }) {
      const legalFrom = from.filter((status) => canTransitionRecovery(status, to));
      if (legalFrom.length === 0) return null;
      const { count } = await db.recoveryAttempt.updateMany({
        where: { id, status: { in: legalFrom } },
        data: { ...attemptPatchData(patch ?? {}), ...clearData(clear), status: to },
      });
      return count === 0 ? null : fetch(id);
    },

    async patch(id, patch, guard) {
      const { count } = await db.recoveryAttempt.updateMany({
        where: {
          id,
          ...(guard?.status && { status: { in: guard.status } }),
          ...(guard?.lockedBy && { lockedBy: guard.lockedBy }),
        },
        data: { ...attemptPatchData(patch), ...clearData(guard?.clear) },
      });
      return count === 0 ? null : fetch(id);
    },

    async claimFinalization({ id, owner, now, leaseUntil }) {
      // ONE conditional update decides the winner: a matured PENDING attempt, or a FINALIZING one whose lease ran out.
      const { count } = await db.recoveryAttempt.updateMany({
        where: {
          id,
          OR: [
            { status: "PENDING", executeAfter: { lte: now } },
            { status: "FINALIZING", lockedUntil: { lt: now } },
          ],
        },
        data: {
          status: "FINALIZING",
          lockedBy: owner,
          lockedUntil: leaseUntil,
          blockedReason: null,
        },
      });
      return count === 0 ? null : fetch(id);
    },

    async releaseFinalization({ id, owner, blockedReason }) {
      const { count } = await db.recoveryAttempt.updateMany({
        where: { id, status: "FINALIZING", lockedBy: owner },
        data: { status: "PENDING", lockedBy: null, lockedUntil: null, blockedReason },
      });
      return count === 0 ? null : fetch(id);
    },

    async findCompletedAwaitingConfiguration(walletId) {
      const row = await db.recoveryAttempt.findFirst({
        where: { walletId, status: "COMPLETED", newConfigurationId: null },
        orderBy: { completedAt: "desc" },
      });
      return row ? toRecoveryAttempt(row) : null;
    },

    async listByStatus(statuses, limit) {
      const rows = await db.recoveryAttempt.findMany({
        where: { status: { in: statuses } },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows.map(toRecoveryAttempt);
    },

    async listMatured(now, limit) {
      const rows = await db.recoveryAttempt.findMany({
        where: { status: "PENDING", executeAfter: { lte: now } },
        orderBy: { executeAfter: "asc" },
        take: limit,
      });
      return rows.map(toRecoveryAttempt);
    },

    async listAbandoned(now, limit) {
      const rows = await db.recoveryAttempt.findMany({
        where: { status: "FINALIZING", lockedUntil: { lt: now } },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows.map(toRecoveryAttempt);
    },

    async listNeedingCleanup(limit) {
      const rows = await db.recoveryAttempt.findMany({
        where: { status: { in: ["ROOT_CHANGED", "COMPLETED"] }, cleanupCompletedAt: null },
        orderBy: { updatedAt: "asc" },
        take: limit,
      });
      return rows.map(toRecoveryAttempt);
    },

    async expireStale(now) {
      const { count } = await db.recoveryAttempt.updateMany({
        where: { status: { in: PRE_CHAIN }, tokenExpiresAt: { lt: now } },
        data: {
          status: "EXPIRED",
          terminatedBy: "SYSTEM",
          terminatedAt: now,
          failureCode: "EXPIRED",
        },
      });
      return count;
    },

    countStartedSince(userId, since) {
      return db.recoveryAttempt.count({ where: { userId, createdAt: { gte: since } } });
    },

    async lastCompletedAt(userId) {
      const row = await db.recoveryAttempt.findFirst({
        where: { userId, status: "COMPLETED", completedAt: { not: null } },
        orderBy: { completedAt: "desc" },
        select: { completedAt: true },
      });
      return row?.completedAt ?? null;
    },
  };
}

/**
 * The authenticator-app factor. Every state change is ONE conditional statement: a replayed step, a second activation or a
 * second enrolment cannot win. The partial unique indexes (one PENDING and one ACTIVE per wallet) back the same rules.
 */
export function createRecoveryTotpRepository(db: Db): RecoveryTotpRepository {
  return {
    async createPending(totp) {
      if (
        await db.recoveryTotp.findFirst({ where: { walletId: totp.walletId, status: "ACTIVE" } })
      ) {
        return null;
      }
      // An unconfirmed enrolment never protected anything: replace it.
      await db.recoveryTotp.updateMany({
        where: { walletId: totp.walletId, status: "PENDING" },
        data: { status: "DISABLED", disabledAt: new Date() },
      });
      try {
        return toRecoveryTotp(
          await db.recoveryTotp.create({
            data: {
              id: totp.id,
              userId: totp.userId,
              walletId: totp.walletId,
              encryptedSecret: totp.encryptedSecret,
              keyVersion: totp.keyVersion,
            },
          }),
        );
      } catch (error) {
        // A concurrent enrolment won the unique index.
        if (isUniqueViolation(error)) return null;
        throw error;
      }
    },

    async findById(id) {
      const row = await db.recoveryTotp.findUnique({ where: { id } });
      return row ? toRecoveryTotp(row) : null;
    },

    async findPending(walletId) {
      const row = await db.recoveryTotp.findFirst({ where: { walletId, status: "PENDING" } });
      return row ? toRecoveryTotp(row) : null;
    },

    async findActive(walletId) {
      const row = await db.recoveryTotp.findFirst({ where: { walletId, status: "ACTIVE" } });
      return row ? toRecoveryTotp(row) : null;
    },

    async activate({ id, step, at }) {
      try {
        const { count } = await db.recoveryTotp.updateMany({
          where: { id, status: "PENDING" },
          data: { status: "ACTIVE", enabledAt: at, lastUsedStep: step },
        });
        if (count === 0) return null;
      } catch (error) {
        // Another enrolment of the wallet became ACTIVE first (the partial unique index).
        if (isUniqueViolation(error)) return null;
        throw error;
      }
      return toRecoveryTotp(await db.recoveryTotp.findUniqueOrThrow({ where: { id } }));
    },

    async consumeStep({ id, step }) {
      // The step must be newer than every step used before: one winner per step, and an older one never wins.
      const { count } = await db.recoveryTotp.updateMany({
        where: {
          id,
          status: "ACTIVE",
          OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
        },
        data: { lastUsedStep: step },
      });
      return count === 1;
    },

    async disableForWallet(walletId, at) {
      const { count } = await db.recoveryTotp.updateMany({
        where: { walletId, status: { in: ["ACTIVE", "PENDING"] } },
        data: { status: "DISABLED", disabledAt: at },
      });
      return count;
    },
  };
}

export function createRecoveryEmailChallengeRepository(db: Db): RecoveryEmailChallengeRepository {
  return {
    async create(challenge) {
      return toRecoveryEmailChallenge(
        await db.recoveryEmailChallenge.create({
          data: {
            id: challenge.id,
            attemptId: challenge.attemptId,
            sessionTokenHash: challenge.sessionTokenHash,
            codeHash: challenge.codeHash,
            expiresAt: challenge.expiresAt,
            maxAttempts: challenge.maxAttempts,
          },
        }),
      );
    },

    async findLatestBySessionTokenHash(sessionTokenHash) {
      const row = await db.recoveryEmailChallenge.findFirst({
        where: { sessionTokenHash },
        orderBy: { createdAt: "desc" },
      });
      return row ? toRecoveryEmailChallenge(row) : null;
    },

    async reserveAttempt(id, now) {
      const latest = await db.recoveryEmailChallenge.findUnique({ where: { id } });
      if (!latest) return { state: "NONE" };
      // The guess is counted in ONE conditional update, so parallel guesses cannot exceed the budget.
      const { count } = await db.recoveryEmailChallenge.updateMany({
        where: {
          id: latest.id,
          usedAt: null,
          expiresAt: { gt: now },
          attempts: { lt: latest.maxAttempts },
        },
        data: { attempts: { increment: 1 } },
      });
      if (count === 1) {
        const row = await db.recoveryEmailChallenge.findUniqueOrThrow({ where: { id: latest.id } });
        return { state: "ADMITTED", challenge: toRecoveryEmailChallenge(row) };
      }
      const row = await db.recoveryEmailChallenge.findUniqueOrThrow({ where: { id: latest.id } });
      if (row.usedAt) return { state: "USED" };
      if (row.expiresAt.getTime() <= now.getTime()) return { state: "EXPIRED" };
      return { state: "EXHAUSTED" };
    },

    async markUsed(id, now) {
      const { count } = await db.recoveryEmailChallenge.updateMany({
        where: { id, usedAt: null },
        data: { usedAt: now },
      });
      return count === 1;
    },

    countForAttempt(attemptId) {
      return db.recoveryEmailChallenge.count({ where: { attemptId } });
    },

    async lastIssuedAt(attemptId) {
      const row = await db.recoveryEmailChallenge.findFirst({
        where: { attemptId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      return row?.createdAt ?? null;
    },
  };
}

/** Statuses of an execution that may already have reached the chain or the provider. */
const IN_FLIGHT = [
  "SIGNING",
  "SUBMITTING",
  "SUBMITTED",
  "AWAITING_CONFIRMATION",
  "CONFIRMED",
  "EXECUTING",
  "SETTLING",
] as const;

export function createRecoveryCleanupRepository(db: Db): RecoveryCleanupRepository {
  return {
    async cancelAuthorizationSessions(walletId, reason) {
      const rows = await db.authorizationSession.findMany({
        where: { walletId, status: "PENDING" },
        select: { id: true },
      });
      if (rows.length === 0) return [];
      await db.authorizationSession.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: "PENDING" },
        data: { status: "CANCELLED", cancelReason: reason },
      });
      return rows.map((row) => row.id);
    },

    async revokePaymentAuthorizations(walletId, reason, now) {
      const rows = await db.paymentAuthorization.findMany({
        where: { walletId, status: "ACTIVE" },
        select: { id: true },
      });
      if (rows.length === 0) return [];
      await db.paymentAuthorization.updateMany({
        where: { id: { in: rows.map((row) => row.id) }, status: "ACTIVE" },
        data: { status: "REVOKED", revokedAt: now, revocationReason: reason },
      });
      return rows.map((row) => row.id);
    },

    async cancelRootActionSessions(walletId) {
      const { count } = await db.rootActionSession.updateMany({
        where: { walletId, status: "PENDING" },
        data: { status: "CANCELLED" },
      });
      return count;
    },

    async revokeWebSessions(userId, at) {
      const { count } = await db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: at },
      });
      return count;
    },

    countInFlightExecutions(walletId) {
      return db.execution.count({ where: { walletId, status: { in: [...IN_FLIGHT] } } });
    },
  };
}
