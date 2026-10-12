import { RECOVERY_AUDIT_EVENTS, createId } from "@kaada/domain";
import type { RecoveryAttempt } from "@kaada/domain";

import { audit } from "./context.js";
import type { RecoveryContext } from "./context.js";

export interface CleanupSummary {
  permissionsRevoked: number;
  secretsDestroyed: number;
  authorizationSessionsCancelled: number;
  paymentAuthorizationsRevoked: number;
  rootActionsCancelled: number;
  setupSessionsRevoked: number;
  webSessionsRevoked: number;
  passkeysRevoked: number;
  pinResetRequired: boolean;
}

const REASON = "ACCOUNT_RECOVERY";

/**
 * What must die the moment the root changes. Every step is a conditional update that touches only what is still live, so the
 * whole thing is safe to repeat (a crash halfway just runs it again). Rows stay as history; secrets are tombstoned.
 *
 *  - delegated permissions: REVOKED, and the encrypted session key and approval destroyed, so an old session signer cannot
 *    be decrypted by anyone (on chain the lane is already void: invalidateNonce was part of the recovery batch);
 *  - authorization sessions, payment authorizations, root-action sessions and setup links of the wallet: cancelled/revoked,
 *    so nothing prepared under the old root can be revived;
 *  - web sessions of the user: revoked;
 *  - the old passkey credentials: revoked (the new one is recorded as the root);
 *  - the PIN: marked reset-required, so the old PIN cannot authorize anything until the person sets a new one.
 */
export class RecoveryCleanup {
  constructor(private readonly ctx: RecoveryContext) {}

  async run(attemptId: string): Promise<CleanupSummary | null> {
    const read = this.ctx.uow.read;
    const attempt = await read.recoveryAttempts.findById(attemptId);
    if (!attempt || (attempt.status !== "ROOT_CHANGED" && attempt.status !== "COMPLETED"))
      return null;
    const first = attempt.cleanupCompletedAt === undefined;
    if (first) await audit(read, attempt, RECOVERY_AUDIT_EVENTS.cleanupStarted);

    const now = this.ctx.now();
    const summary: CleanupSummary = {
      permissionsRevoked: 0,
      secretsDestroyed: 0,
      authorizationSessionsCancelled: 0,
      paymentAuthorizationsRevoked: 0,
      rootActionsCancelled: 0,
      setupSessionsRevoked: 0,
      webSessionsRevoked: 0,
      passkeysRevoked: 0,
      pinResetRequired: false,
    };

    for (const permission of await read.delegatedPermissions.listForWallet(attempt.walletId)) {
      if (permission.status === "PENDING" || permission.status === "ACTIVE") {
        if (await read.delegatedPermissions.revoke(permission.id, REASON, now)) {
          summary.permissionsRevoked += 1;
          await audit(read, attempt, RECOVERY_AUDIT_EVENTS.permissionRevoked, {
            permissionId: permission.id,
          });
        }
      }
      // Whatever its status, the session key and approval of a permission under the old root must not stay decryptable.
      for (const secretId of [permission.sessionKeySecretId, permission.approvalSecretId]) {
        if (secretId && (await read.executionSecrets.get(secretId))) {
          await read.executionSecrets.tombstone(secretId, now);
          summary.secretsDestroyed += 1;
        }
      }
    }

    summary.authorizationSessionsCancelled = (
      await read.recoveryCleanup.cancelAuthorizationSessions(attempt.walletId, REASON, now)
    ).length;
    summary.paymentAuthorizationsRevoked = (
      await read.recoveryCleanup.revokePaymentAuthorizations(attempt.walletId, REASON, now)
    ).length;
    summary.rootActionsCancelled = await read.recoveryCleanup.cancelRootActionSessions(
      attempt.walletId,
    );
    summary.setupSessionsRevoked = await read.walletSetupSessions.revokePending(attempt.userId);
    summary.webSessionsRevoked = await read.recoveryCleanup.revokeWebSessions(attempt.userId, now);

    // Old passkeys are no longer a root of this wallet: revoke every one except the credential recorded as the new root.
    const newRoot = attempt.newCredentialId
      ? await read.walletCredentials.findById(attempt.newCredentialId)
      : null;
    for (const passkey of await read.passkeys.listActiveForUser(attempt.userId)) {
      if (newRoot?.passkeyCredentialId === passkey.id) continue;
      if (await read.passkeys.revoke(passkey.id, now)) {
        summary.passkeysRevoked += 1;
        await audit(read, attempt, RECOVERY_AUDIT_EVENTS.oldCredentialReplaced, {
          passkeyId: passkey.id,
        });
      }
    }

    // The old PIN cannot authorize anything until it is replaced through this recovery session.
    if (await read.transactionPins.findByUserId(attempt.userId)) {
      summary.pinResetRequired = await read.transactionPins.markResetRequired(attempt.userId);
      if (summary.pinResetRequired)
        await audit(read, attempt, RECOVERY_AUDIT_EVENTS.pinResetRequired);
    }

    if (first) {
      await read.recoveryAttempts.patch(
        attempt.id,
        { cleanupCompletedAt: now },
        { status: ["ROOT_CHANGED", "COMPLETED"] },
      );
      await read.audit.append({
        id: createId(),
        userId: attempt.userId,
        type: RECOVERY_AUDIT_EVENTS.cleanupCompleted,
        entityType: "recovery_attempt",
        entityId: attempt.id,
        data: { ...summary },
      });
    }
    return summary;
  }

  /** Attempts whose root changed but whose cleanup did not finish (a crash): run it again. */
  async runPending(limit = 20): Promise<number> {
    let done = 0;
    for (const attempt of await this.ctx.uow.read.recoveryAttempts.listNeedingCleanup(limit)) {
      await this.run(attempt.id);
      done += 1;
    }
    return done;
  }
}

export type { RecoveryAttempt };
