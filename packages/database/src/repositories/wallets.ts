import type {
  AuditRepository,
  DelegatedPermissionRepository,
  PasskeyRepository,
  WalletRepository,
  WalletSetupSessionRepository,
} from "@kaada/domain";

import {
  permissionCreateData,
  toAuditEvent,
  toDelegatedPermission,
  toPasskeyChallenge,
  toPasskeyCredential,
  toWallet,
  toWalletSetupSession,
} from "../mappers/index.js";
import { jsonInput, maybe } from "../mappers/support.js";
import type { Db } from "./db.js";

export function createWalletRepository(db: Db): WalletRepository {
  return {
    async findById(id) {
      const row = await db.wallet.findUnique({ where: { id } });
      return row ? toWallet(row) : null;
    },

    async findEmbedded(userId, chainId) {
      const row = await db.wallet.findFirst({
        where: { userId, chainId, type: "EMBEDDED", status: { not: "REVOKED" } },
      });
      return row ? toWallet(row) : null;
    },

    async lockUser(userId) {
      await db.$queryRaw`SELECT id FROM "User" WHERE id = ${userId}::uuid FOR UPDATE`;
    },

    async create(wallet) {
      return toWallet(
        await db.wallet.create({
          data: {
            id: wallet.id,
            userId: wallet.userId,
            chainId: wallet.chainId,
            address: wallet.address ?? null,
            label: wallet.label ?? null,
            isPrimary: wallet.isPrimary,
            type: wallet.type,
            status: wallet.status,
            deployment: wallet.deployment,
            provider: wallet.provider ?? null,
            providerAccountId: wallet.providerAccountId ?? null,
            statusReason: wallet.statusReason ?? null,
            provisionedAt: wallet.provisionedAt ?? null,
          },
        }),
      );
    },

    async activate(id, account) {
      // One conditional UPDATE: only a PROVISIONING wallet can become ACTIVE, and only once.
      const { count } = await db.wallet.updateMany({
        where: { id, status: "PROVISIONING" },
        data: {
          status: "ACTIVE",
          address: account.address,
          deployment: account.deployment,
          provider: account.provider,
          providerAccountId: account.providerAccountId ?? null,
          provisionedAt: account.at,
          statusReason: null,
        },
      });
      if (count === 0) return null;
      const row = await db.wallet.findUnique({ where: { id } });
      return row ? toWallet(row) : null;
    },

    async recordFailure(id, reason) {
      await db.wallet.updateMany({
        where: { id, status: "PROVISIONING" },
        data: { statusReason: reason },
      });
    },

    async setStatus(id, status, reason) {
      return toWallet(
        await db.wallet.update({ where: { id }, data: { status, statusReason: reason ?? null } }),
      );
    },

    async setDeployment(id, deployment) {
      return toWallet(await db.wallet.update({ where: { id }, data: { deployment } }));
    },

    async listByUser(userId) {
      const rows = await db.wallet.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
      return rows.map(toWallet);
    },
  };
}

export function createPasskeyRepository(db: Db): PasskeyRepository {
  return {
    async create(credential) {
      return toPasskeyCredential(
        await db.passkeyCredential.create({
          data: {
            id: credential.id,
            userId: credential.userId,
            credentialId: credential.credentialId,
            publicKeyX: credential.publicKeyX,
            publicKeyY: credential.publicKeyY,
            rpId: credential.rpId,
            signCount: credential.signCount ?? 0,
            label: credential.label ?? null,
          },
        }),
      );
    },

    async findByCredentialId(credentialId) {
      const row = await db.passkeyCredential.findUnique({ where: { credentialId } });
      return row ? toPasskeyCredential(row) : null;
    },

    async listActiveForUser(userId) {
      const rows = await db.passkeyCredential.findMany({
        where: { userId, revokedAt: null },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toPasskeyCredential);
    },

    async advanceCounter(id, signCount, at) {
      // A counter that does not move forward is refused; authenticators that always send 0 are
      // handled by the caller (it passes the same 0 and treats "no change" as acceptable only then).
      const { count } = await db.passkeyCredential.updateMany({
        where: { id, revokedAt: null, signCount: { lt: signCount } },
        data: { signCount, lastUsedAt: at },
      });
      return count === 1;
    },

    async revoke(id, at) {
      const { count } = await db.passkeyCredential.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: at },
      });
      return count === 1;
    },

    async issueChallenge(challenge) {
      return toPasskeyChallenge(
        await db.passkeyChallenge.create({
          data: {
            id: challenge.id,
            userId: challenge.userId,
            purpose: challenge.purpose,
            challenge: challenge.challenge,
            expiresAt: challenge.expiresAt,
          },
        }),
      );
    },

    async consumeChallenge({ userId, purpose, challenge, now }) {
      const { count } = await db.passkeyChallenge.updateMany({
        where: { userId, purpose, challenge, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (count !== 1) return null;
      const row = await db.passkeyChallenge.findUnique({ where: { challenge } });
      return row ? toPasskeyChallenge(row) : null;
    },
  };
}

export function createDelegatedPermissionRepository(db: Db): DelegatedPermissionRepository {
  return {
    async create(permission) {
      return toDelegatedPermission(
        await db.delegatedPermission.create({ data: permissionCreateData(permission) }),
      );
    },

    async findById(id) {
      const row = await db.delegatedPermission.findUnique({ where: { id } });
      return row ? toDelegatedPermission(row) : null;
    },

    async listForWallet(walletId) {
      const rows = await db.delegatedPermission.findMany({
        where: { walletId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toDelegatedPermission);
    },

    async activate(id, providerPermissionId) {
      const { count } = await db.delegatedPermission.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "ACTIVE", providerPermissionId },
      });
      if (count === 0) return null;
      const row = await db.delegatedPermission.findUnique({ where: { id } });
      return row ? toDelegatedPermission(row) : null;
    },

    async revoke(id, reason, at) {
      const { count } = await db.delegatedPermission.updateMany({
        where: { id, status: { in: ["PENDING", "ACTIVE"] } },
        data: { status: "REVOKED", revokedAt: at, revocationReason: reason },
      });
      if (count === 0) return null;
      const row = await db.delegatedPermission.findUnique({ where: { id } });
      return row ? toDelegatedPermission(row) : null;
    },

    async expireDue(now) {
      const { count } = await db.delegatedPermission.updateMany({
        where: { status: { in: ["PENDING", "ACTIVE"] }, expiresAt: { lte: now } },
        data: { status: "EXPIRED" },
      });
      return count;
    },
  };
}

export function createAuditRepository(db: Db): AuditRepository {
  return {
    async append(event) {
      return toAuditEvent(
        await db.auditEvent.create({
          data: {
            id: event.id,
            userId: event.userId ?? null,
            executionId: event.executionId ?? null,
            type: event.type,
            entityType: event.entityType ?? null,
            entityId: event.entityId ?? null,
            ...maybe("data", jsonInput(event.data, "AuditEvent.data")),
          },
        }),
      );
    },

    async listForUser(userId, limit = 50) {
      const rows = await db.auditEvent.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit,
      });
      return rows.map(toAuditEvent);
    },
  };
}

export function createWalletSetupSessionRepository(db: Db): WalletSetupSessionRepository {
  return {
    async create(session) {
      return toWalletSetupSession(
        await db.walletSetupSession.create({
          data: {
            id: session.id,
            userId: session.userId,
            tokenHash: session.tokenHash,
            expiresAt: session.expiresAt,
          },
        }),
      );
    },

    async findByTokenHash(tokenHash) {
      const row = await db.walletSetupSession.findUnique({ where: { tokenHash } });
      return row ? toWalletSetupSession(row) : null;
    },

    async revokePending(userId) {
      const { count } = await db.walletSetupSession.updateMany({
        where: { userId, status: "PENDING" },
        data: { status: "REVOKED" },
      });
      return count;
    },

    async complete(id, now) {
      // One conditional UPDATE: only a still-PENDING, unexpired session can be consumed, once.
      const { count } = await db.walletSetupSession.updateMany({
        where: { id, status: "PENDING", expiresAt: { gt: now } },
        data: { status: "COMPLETED", usedAt: now },
      });
      if (count !== 1) return null;
      const row = await db.walletSetupSession.findUnique({ where: { id } });
      return row ? toWalletSetupSession(row) : null;
    },
  };
}
