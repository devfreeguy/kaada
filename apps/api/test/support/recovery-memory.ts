import { randomUUID } from "node:crypto";

import { canTransitionRecovery, isRecoveryAttemptActive } from "@kaada/domain";
import { createMemoryWalletCredentials } from "./credential-memory.js";
import type {
  EmailChallengeReservation,
  Identity,
  IdentityRepository,
  RecoveryAttempt,
  RecoveryAttemptRepository,
  RecoveryCleanupRepository,
  RecoveryConfiguration,
  RecoveryConfigurationRepository,
  RecoveryEmailChallenge,
  RecoveryEmailChallengeRepository,
  WalletCredential,
  WalletCredentialRepository,
} from "@kaada/domain";

/*
 * In-memory implementations of the recovery repository contracts. Every method is synchronous inside, so each conditional
 * transition is atomic exactly like the single SQL statement it stands in for: two racing callers are decided by who runs
 * first, never both. The "one live attempt per wallet", "one ACTIVE root per wallet" and "one validator instance per wallet"
 * rules are enforced like the partial unique indexes.
 */

const copy = <T extends object>(value: T): T => ({ ...value });
const DUPLICATE = (what: string) => new Error(`unique violation: ${what}`);

export interface RecoveryStores {
  identities: Identity[];
  credentials: WalletCredential[];
  configurations: RecoveryConfiguration[];
  attempts: RecoveryAttempt[];
  challenges: RecoveryEmailChallenge[];
  /** Rows the cleanup repository acts on. Tests add to these. */
  extras: {
    inFlightExecutions: Map<string, number>;
    webSessions: { userId: string; revokedAt?: Date }[];
    authorizationSessions: { id: string; walletId: string; status: string }[];
    paymentAuthorizations: { id: string; walletId: string; status: string }[];
    rootActions: { walletId: string; status: string }[];
  };
  repositories: {
    identities: IdentityRepository;
    walletCredentials: WalletCredentialRepository;
    recoveryConfigurations: RecoveryConfigurationRepository;
    recoveryAttempts: RecoveryAttemptRepository;
    recoveryEmailChallenges: RecoveryEmailChallengeRepository;
    recoveryCleanup: RecoveryCleanupRepository;
  };
}

export function createRecoveryStores(now: () => Date): RecoveryStores {
  const identities: Identity[] = [];
  const credentials: WalletCredential[] = [];
  const configurations: RecoveryConfiguration[] = [];
  const attempts: RecoveryAttempt[] = [];
  const challenges: RecoveryEmailChallenge[] = [];
  const extras: RecoveryStores["extras"] = {
    inFlightExecutions: new Map(),
    webSessions: [],
    authorizationSessions: [],
    paymentAuthorizations: [],
    rootActions: [],
  };

  const identityRepository: IdentityRepository = {
    findByExternalId: (type, externalId) =>
      Promise.resolve(
        copyOrNull(identities.find((i) => i.type === type && i.externalId === externalId)),
      ),
    findByUsername: () => Promise.resolve([]),
    listForUser: (userId) =>
      Promise.resolve(identities.filter((i) => i.userId === userId).map(copy)),
    add: (input) => {
      const identity: Identity = { ...input, createdAt: now(), updatedAt: now() };
      identities.push(identity);
      return Promise.resolve(copy(identity));
    },
  };

  const walletCredentials = createMemoryWalletCredentials(now, credentials);

  const recoveryConfigurations: RecoveryConfigurationRepository = {
    create: (input) => {
      if (
        input.status === "ACTIVE" &&
        configurations.some((c) => c.walletId === input.walletId && c.status === "ACTIVE")
      ) {
        return Promise.reject(DUPLICATE("one ACTIVE configuration per wallet"));
      }
      const configuration: RecoveryConfiguration = {
        ...input,
        createdAt: now(),
        updatedAt: now(),
        ...(input.status === "ACTIVE" && { configuredAt: now() }),
      };
      configurations.push(configuration);
      return Promise.resolve(copy(configuration));
    },
    findById: (id) => Promise.resolve(copyOrNull(configurations.find((c) => c.id === id))),
    findActive: (walletId) =>
      Promise.resolve(
        copyOrNull(configurations.find((c) => c.walletId === walletId && c.status === "ACTIVE")),
      ),
    listForWallet: (walletId) =>
      Promise.resolve(
        configurations
          .filter((c) => c.walletId === walletId)
          .map(copy)
          .reverse(),
      ),
    activate: ({ id, recoveryNonce, at }) => {
      const found = configurations.find((c) => c.id === id && c.status === "PENDING_INSTALL");
      if (!found) return Promise.resolve(null);
      for (const other of configurations) {
        if (other.walletId === found.walletId && other.status === "ACTIVE" && other.id !== id)
          other.status = "SUPERSEDED";
      }
      found.status = "ACTIVE";
      found.recoveryNonce = recoveryNonce;
      found.configuredAt = at;
      found.updatedAt = now();
      return Promise.resolve(copy(found));
    },
    close: (id, status) => {
      const found = configurations.find(
        (c) => c.id === id && (c.status === "ACTIVE" || c.status === "PENDING_INSTALL"),
      );
      if (!found) return Promise.resolve(null);
      found.status = status;
      found.updatedAt = now();
      return Promise.resolve(copy(found));
    },
    recordNonce: (id, recoveryNonce) => {
      const found = configurations.find((c) => c.id === id);
      if (found) found.recoveryNonce = recoveryNonce;
      return Promise.resolve();
    },
  };

  const apply = (
    attempt: RecoveryAttempt,
    patch: object | undefined,
    clear: string[] | undefined,
  ) => {
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value !== undefined) (attempt as unknown as Record<string, unknown>)[key] = value;
    }
    const record = attempt as unknown as Record<string, unknown>;
    if (clear?.includes("blockedReason")) delete record["blockedReason"];
    if (clear?.includes("lease")) {
      delete record["lockedBy"];
      delete record["lockedUntil"];
    }
    if (clear?.includes("finalizeSubmission")) {
      delete record["finalizeUserOpHash"];
      delete record["nonceBefore"];
    }
    attempt.updatedAt = now();
  };

  const recoveryAttempts: RecoveryAttemptRepository = {
    create: (input) => {
      if (
        attempts.some((a) => a.walletId === input.walletId && isRecoveryAttemptActive(a.status))
      ) {
        return Promise.resolve(null);
      }
      const attempt: RecoveryAttempt = {
        ...input,
        status: "EMAIL_PENDING",
        proofFailures: 0,
        createdAt: now(),
        updatedAt: now(),
      };
      attempts.push(attempt);
      return Promise.resolve(copy(attempt));
    },
    findById: (id) => Promise.resolve(copyOrNull(attempts.find((a) => a.id === id))),
    findByTokenHash: (hash) =>
      Promise.resolve(copyOrNull(attempts.find((a) => a.tokenHash === hash))),
    findByCancelTokenHash: (hash) =>
      Promise.resolve(copyOrNull(attempts.find((a) => a.cancelTokenHash === hash))),
    findActiveByWallet: (walletId) =>
      Promise.resolve(
        copyOrNull(
          attempts.find((a) => a.walletId === walletId && isRecoveryAttemptActive(a.status)),
        ),
      ),
    recordProofFailure: (id) => {
      const found = attempts.find((a) => a.id === id);
      if (!found) return Promise.resolve(0);
      found.proofFailures += 1;
      return Promise.resolve(found.proofFailures);
    },
    advance: ({ id, from, to, patch, clear }) => {
      const legal = from.filter((status) => canTransitionRecovery(status, to));
      const found = attempts.find((a) => a.id === id && legal.includes(a.status));
      if (!found) return Promise.resolve(null);
      apply(found, patch, clear);
      found.status = to;
      return Promise.resolve(copy(found));
    },
    patch: (id, patch, guard) => {
      const found = attempts.find(
        (a) =>
          a.id === id &&
          (!guard?.status || guard.status.includes(a.status)) &&
          (!guard?.lockedBy || a.lockedBy === guard.lockedBy),
      );
      if (!found) return Promise.resolve(null);
      apply(found, patch, guard?.clear);
      return Promise.resolve(copy(found));
    },
    claimFinalization: ({ id, owner, now: at, leaseUntil }) => {
      const found = attempts.find(
        (a) =>
          a.id === id &&
          ((a.status === "PENDING" &&
            a.executeAfter !== undefined &&
            a.executeAfter.getTime() <= at.getTime()) ||
            (a.status === "FINALIZING" &&
              a.lockedUntil !== undefined &&
              a.lockedUntil.getTime() < at.getTime())),
      );
      if (!found) return Promise.resolve(null);
      found.status = "FINALIZING";
      found.lockedBy = owner;
      found.lockedUntil = leaseUntil;
      delete found.blockedReason;
      found.updatedAt = now();
      return Promise.resolve(copy(found));
    },
    releaseFinalization: ({ id, owner, blockedReason }) => {
      const found = attempts.find(
        (a) => a.id === id && a.status === "FINALIZING" && a.lockedBy === owner,
      );
      if (!found) return Promise.resolve(null);
      found.status = "PENDING";
      delete found.lockedBy;
      delete found.lockedUntil;
      found.blockedReason = blockedReason;
      found.updatedAt = now();
      return Promise.resolve(copy(found));
    },
    findCompletedAwaitingConfiguration: (walletId) =>
      Promise.resolve(
        copyOrNull(
          [...attempts]
            .reverse()
            .find(
              (a) =>
                a.walletId === walletId &&
                a.status === "COMPLETED" &&
                a.newConfigurationId === undefined,
            ),
        ),
      ),
    listByStatus: (statuses, limit) =>
      Promise.resolve(
        attempts
          .filter((a) => statuses.includes(a.status))
          .slice(0, limit)
          .map(copy),
      ),
    listMatured: (at, limit) =>
      Promise.resolve(
        attempts
          .filter(
            (a) =>
              a.status === "PENDING" && a.executeAfter && a.executeAfter.getTime() <= at.getTime(),
          )
          .slice(0, limit)
          .map(copy),
      ),
    listAbandoned: (at, limit) =>
      Promise.resolve(
        attempts
          .filter(
            (a) =>
              a.status === "FINALIZING" && a.lockedUntil && a.lockedUntil.getTime() < at.getTime(),
          )
          .slice(0, limit)
          .map(copy),
      ),
    listNeedingCleanup: (limit) =>
      Promise.resolve(
        attempts
          .filter(
            (a) =>
              (a.status === "ROOT_CHANGED" || a.status === "COMPLETED") && !a.cleanupCompletedAt,
          )
          .slice(0, limit)
          .map(copy),
      ),
    expireStale: (at) => {
      let count = 0;
      for (const a of attempts) {
        if (
          ["EMAIL_PENDING", "EMAIL_VERIFIED", "ROOT_PROPOSED"].includes(a.status) &&
          a.tokenExpiresAt.getTime() < at.getTime()
        ) {
          a.status = "EXPIRED";
          a.terminatedBy = "SYSTEM";
          a.terminatedAt = at;
          a.failureCode = "EXPIRED";
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    countStartedSince: (userId, since) =>
      Promise.resolve(
        attempts.filter((a) => a.userId === userId && a.createdAt.getTime() >= since.getTime())
          .length,
      ),
    lastCompletedAt: (userId) => {
      const done = attempts
        .filter((a) => a.userId === userId && a.status === "COMPLETED" && a.completedAt)
        .map((a) => a.completedAt as Date)
        .sort((x, y) => y.getTime() - x.getTime());
      return Promise.resolve(done[0] ?? null);
    },
  };

  const recoveryEmailChallenges: RecoveryEmailChallengeRepository = {
    create: (input) => {
      const challenge: RecoveryEmailChallenge = { ...input, attempts: 0, createdAt: now() };
      challenges.push(challenge);
      return Promise.resolve(copy(challenge));
    },
    findLatestBySessionTokenHash: (hash) =>
      Promise.resolve(
        copyOrNull([...challenges].reverse().find((c) => c.sessionTokenHash === hash)),
      ),
    reserveAttempt: (id, at): Promise<EmailChallengeReservation> => {
      const found = challenges.find((c) => c.id === id);
      if (!found) return Promise.resolve({ state: "NONE" });
      if (
        !found.usedAt &&
        found.expiresAt.getTime() > at.getTime() &&
        found.attempts < found.maxAttempts
      ) {
        found.attempts += 1;
        return Promise.resolve({ state: "ADMITTED", challenge: copy(found) });
      }
      if (found.usedAt) return Promise.resolve({ state: "USED" });
      if (found.expiresAt.getTime() <= at.getTime()) return Promise.resolve({ state: "EXPIRED" });
      return Promise.resolve({ state: "EXHAUSTED" });
    },
    markUsed: (id, at) => {
      const found = challenges.find((c) => c.id === id && !c.usedAt);
      if (!found) return Promise.resolve(false);
      found.usedAt = at;
      return Promise.resolve(true);
    },
    countForAttempt: (attemptId) =>
      Promise.resolve(challenges.filter((c) => c.attemptId === attemptId).length),
    lastIssuedAt: (attemptId) => {
      const last = [...challenges].reverse().find((c) => c.attemptId === attemptId);
      return Promise.resolve(last?.createdAt ?? null);
    },
  };

  const recoveryCleanup: RecoveryCleanupRepository = {
    cancelAuthorizationSessions: (walletId) => {
      const ids: string[] = [];
      for (const s of extras.authorizationSessions) {
        if (s.walletId === walletId && s.status === "PENDING") {
          s.status = "CANCELLED";
          ids.push(s.id);
        }
      }
      return Promise.resolve(ids);
    },
    revokePaymentAuthorizations: (walletId) => {
      const ids: string[] = [];
      for (const p of extras.paymentAuthorizations) {
        if (p.walletId === walletId && p.status === "ACTIVE") {
          p.status = "REVOKED";
          ids.push(p.id);
        }
      }
      return Promise.resolve(ids);
    },
    cancelRootActionSessions: (walletId) => {
      let count = 0;
      for (const r of extras.rootActions) {
        if (r.walletId === walletId && r.status === "PENDING") {
          r.status = "CANCELLED";
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    revokeWebSessions: (userId, at) => {
      let count = 0;
      for (const s of extras.webSessions) {
        if (s.userId === userId && !s.revokedAt) {
          s.revokedAt = at;
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    countInFlightExecutions: (walletId) =>
      Promise.resolve(extras.inFlightExecutions.get(walletId) ?? 0),
  };

  return {
    identities,
    credentials,
    configurations,
    attempts,
    challenges,
    extras,
    repositories: {
      identities: identityRepository,
      walletCredentials,
      recoveryConfigurations,
      recoveryAttempts,
      recoveryEmailChallenges,
      recoveryCleanup,
    },
  };
}

function copyOrNull<T extends object>(value: T | undefined): T | null {
  return value ? copy(value) : null;
}

export const newId = (): string => randomUUID();
