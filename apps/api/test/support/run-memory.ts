import { randomUUID } from "node:crypto";

import type {
  DelegatedPermission,
  DelegatedPermissionRepository,
  ExecutionTransactionRepository,
  RootActionSession,
  RootActionSessionRepository,
  Transaction,
} from "@kaada/domain";

/*
 * In-memory implementations of the Build 13 repository contracts for offline tests. Each method is
 * synchronous inside, so every conditional transition is atomic like the single SQL statement it stands
 * in for: two racing callers are decided by who runs first, never both.
 */

export interface RunStores {
  transactions: Transaction[];
  rootSessions: RootActionSession[];
  permissions: Map<string, DelegatedPermission>;
  repositories: {
    executionTransactions: ExecutionTransactionRepository;
    rootActions: RootActionSessionRepository;
    delegatedPermissions: DelegatedPermissionRepository;
  };
}

export function createRunStores(): RunStores {
  const transactions: Transaction[] = [];
  const rootSessions: RootActionSession[] = [];
  const permissions = new Map<string, DelegatedPermission>();
  const copy = <T extends object>(value: T): T => ({ ...value });

  const executionTransactions: ExecutionTransactionRepository = {
    begin: (input) => {
      const existing = transactions.find((t) => t.idempotencyKey === input.idempotencyKey);
      if (existing) return Promise.resolve({ transaction: copy(existing), created: false });
      const now = new Date();
      const created: Transaction = {
        id: randomUUID(),
        executionId: input.executionId,
        type: input.type,
        status: "CREATED",
        chainId: input.chainId,
        fromAddress: input.fromAddress,
        ...(input.toAddress && { toAddress: input.toAddress }),
        ...(input.assetId && { assetId: input.assetId }),
        ...(input.amount && { amount: input.amount }),
        idempotencyKey: input.idempotencyKey,
        ...(input.metadata && { metadata: input.metadata }),
        createdAt: now,
        updatedAt: now,
      };
      transactions.push(created);
      return Promise.resolve({ transaction: copy(created), created: true });
    },
    findByKey: (key) => {
      const found = transactions.find((t) => t.idempotencyKey === key);
      return Promise.resolve(found ? copy(found) : null);
    },
    listByExecution: (executionId) =>
      Promise.resolve(transactions.filter((t) => t.executionId === executionId).map(copy)),
    markSubmitted: (id, { userOpHash, now }) => {
      const t = transactions.find((x) => x.id === id);
      if (!t || t.status !== "CREATED") return Promise.resolve(null);
      Object.assign(t, { status: "SUBMITTED", userOpHash, submittedAt: now });
      return Promise.resolve(copy(t));
    },
    markIncluded: (id, { hash, blockNumber, success, now }) => {
      const t = transactions.find((x) => x.id === id);
      if (!t || !["SUBMITTED", "CONFIRMING", "UNKNOWN"].includes(t.status)) {
        return Promise.resolve(null);
      }
      Object.assign(t, {
        status: success ? "CONFIRMED" : "FAILED",
        hash,
        blockNumber,
        confirmedAt: now,
        ...(success ? {} : { failureCode: "REVERTED" }),
      });
      return Promise.resolve(copy(t));
    },
    markUnknown: (id) => {
      const t = transactions.find((x) => x.id === id);
      if (!t || !["CREATED", "SUBMITTED", "CONFIRMING"].includes(t.status)) {
        return Promise.resolve(null);
      }
      t.status = "UNKNOWN";
      return Promise.resolve(copy(t));
    },
    markNotSent: (id, code) => {
      const t = transactions.find((x) => x.id === id);
      if (!t || t.status !== "CREATED") return Promise.resolve(null);
      Object.assign(t, { status: "FAILED", failureCode: code });
      return Promise.resolve(copy(t));
    },
    listUnsettled: (limit) =>
      Promise.resolve(
        transactions
          .filter((t) => ["SUBMITTED", "CONFIRMING", "UNKNOWN"].includes(t.status))
          .slice(0, limit)
          .map(copy),
      ),
  };

  const rootActions: RootActionSessionRepository = {
    createOrGetPending: (input, now) => {
      const live = rootSessions.find(
        (s) => s.executionId === input.executionId && s.status === "PENDING",
      );
      if (live) {
        if (live.expiresAt.getTime() > now.getTime()) {
          return Promise.resolve({ session: copy(live), created: false });
        }
        live.status = "EXPIRED";
      }
      const session: RootActionSession = { ...input, status: "PENDING", createdAt: now };
      rootSessions.push(session);
      return Promise.resolve({ session: copy(session), created: true });
    },
    findById: (id) => {
      const found = rootSessions.find((s) => s.id === id);
      return Promise.resolve(found ? copy(found) : null);
    },
    findByTokenHash: (hash) => {
      const found = rootSessions.find((s) => s.tokenHash === hash);
      return Promise.resolve(found ? copy(found) : null);
    },
    issueToken: ({ id, tokenHash, now }) => {
      const s = rootSessions.find((x) => x.id === id);
      if (!s || s.status !== "PENDING" || s.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(null);
      }
      s.tokenHash = tokenHash;
      return Promise.resolve(copy(s));
    },
    complete: (id, now) => {
      const s = rootSessions.find((x) => x.id === id);
      if (!s || s.status !== "PENDING" || s.expiresAt.getTime() <= now.getTime()) {
        return Promise.resolve(null);
      }
      Object.assign(s, { status: "COMPLETED", usedAt: now });
      return Promise.resolve(copy(s));
    },
    close: (id, status) => {
      const s = rootSessions.find((x) => x.id === id);
      if (!s || s.status !== "PENDING") return Promise.resolve(null);
      s.status = status;
      return Promise.resolve(copy(s));
    },
    findPendingByExecution: (executionId) => {
      const found = rootSessions.find(
        (s) => s.executionId === executionId && s.status === "PENDING",
      );
      return Promise.resolve(found ? copy(found) : null);
    },
  };

  const delegatedPermissions: DelegatedPermissionRepository = {
    create: (input) => {
      const permission: DelegatedPermission = { ...input, createdAt: new Date() };
      permissions.set(permission.id, permission);
      return Promise.resolve(copy(permission));
    },
    findById: (id) => {
      const found = permissions.get(id);
      return Promise.resolve(found ? copy(found) : null);
    },
    listForWallet: (walletId) =>
      Promise.resolve([...permissions.values()].filter((p) => p.walletId === walletId).map(copy)),
    attachSessionKey: (id, keys) => {
      const p = permissions.get(id);
      if (!p || p.status !== "PENDING" || p.sessionKeySecretId) return Promise.resolve(null);
      p.sessionKeyAddress = keys.address.toLowerCase();
      p.sessionKeySecretId = keys.sessionKeySecretId;
      if (keys.approvalSecretId) p.approvalSecretId = keys.approvalSecretId;
      return Promise.resolve(copy(p));
    },
    attachApproval: (id, approvalSecretId) => {
      const p = permissions.get(id);
      if (!p || p.status !== "PENDING") return Promise.resolve(null);
      p.approvalSecretId = approvalSecretId;
      return Promise.resolve(copy(p));
    },
    activate: (id, providerPermissionId) => {
      const p = permissions.get(id);
      if (!p || p.status !== "PENDING") return Promise.resolve(null);
      Object.assign(p, { status: "ACTIVE", providerPermissionId, installedAt: new Date() });
      return Promise.resolve(copy(p));
    },
    revoke: (id, reason, at) => {
      const p = permissions.get(id);
      if (!p || !["PENDING", "ACTIVE"].includes(p.status)) return Promise.resolve(null);
      Object.assign(p, { status: "REVOKED", revokedAt: at, revocationReason: reason });
      return Promise.resolve(copy(p));
    },
    expireDue: (now) => {
      let count = 0;
      for (const p of permissions.values()) {
        if (["PENDING", "ACTIVE"].includes(p.status) && p.expiresAt <= now) {
          p.status = "EXPIRED";
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
  };

  return {
    transactions,
    rootSessions,
    permissions,
    repositories: { executionTransactions, rootActions, delegatedPermissions },
  };
}
