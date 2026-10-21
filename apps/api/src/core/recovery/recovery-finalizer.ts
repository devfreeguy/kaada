import { deviceKeyPayload } from "@kaada/contracts";
import { randomBytes, randomUUID } from "node:crypto";

import {
  KaadaError,
  RECOVERY_AUDIT_EVENTS,
  createId,
  isKaadaError,
  isValidPinFormat,
  isWalletActive,
} from "@kaada/domain";
import type { RecoveryAttempt, RecoveryAttemptStatus, Wallet } from "@kaada/domain";

import {
  audit,
  logBundlerRejection,
  logFeeUnavailable,
  resolveAttempt,
  statusView,
} from "./context.js";
import type { RecoveryContext, RecoveryStatusView } from "./context.js";
import { recoveryCompletedMessage } from "./messages.js";
import type { RecoveryCleanup } from "./recovery-cleanup.js";
import type { RecoveryFlowService } from "./recovery-flow.js";

export type FinalizeOutcome =
  | { outcome: "NOT_ELIGIBLE" }
  | { outcome: "DEFERRED"; reason: string }
  | { outcome: "SUBMITTED" }
  | { outcome: "ROOT_CHANGED" }
  | { outcome: "STOPPED"; status: RecoveryAttemptStatus }
  | { outcome: "FAILED"; code: string };

export interface SigningProofRequest {
  challenge: string;
  rootKind: "PASSKEY" | "DEVICE_KEY";
  chainId: number;
  passkey?: { challenge: string; rpId: string; userVerification: "required" };
  device?: {
    chainId: number;
    validator: string;
    account: string;
    keyId: string;
    payload: string;
  };
}

export interface RecoveryFinalizerDeps {
  context: RecoveryContext;
  flow: RecoveryFlowService;
  cleanup: RecoveryCleanup;
  /** Sets the new PIN through the verified recovery session (the PIN only ever confirms one payment). */
  pins: { setPin(userId: string, pin: string): Promise<"CREATED" | "CHANGED"> };
  /** Names this process in the finalizer lease. */
  owner?: string;
  /** How long to wait between polls of the bundler while waiting for inclusion. */
  pollMs?: number;
}

/**
 * Finalization: after the timelock, and only when nothing is mid-payment, submit the ONE exact batch the recovery validator
 * accepts, then believe only what the chain says: the root, the nonce and the voided lanes. Many processes may run this; one
 * conditional update gives a single winner the lease, and everything it does is safe to repeat.
 */
export class RecoveryFinalizer {
  private readonly ctx: RecoveryContext;
  private readonly owner: string;
  private readonly pollMs: number;

  constructor(private readonly deps: RecoveryFinalizerDeps) {
    this.ctx = deps.context;
    this.owner = deps.owner ?? `finalizer:${randomUUID()}`;
    this.pollMs = deps.pollMs ?? 1_000;
  }

  /** One pass over everything that may need attention. Returns what it did, for logs and tests. */
  async runDue(limit = 20): Promise<{
    finalized: FinalizeOutcome[];
    reconciled: number;
    expired: number;
    cleaned: number;
  }> {
    const read = this.ctx.uow.read;
    const now = this.ctx.now();
    const expired = await read.recoveryAttempts.expireStale(now);
    let reconciled = 0;
    for (const attempt of await read.recoveryAttempts.listByStatus(["INITIATING"], limit)) {
      await this.deps.flow.reconcileInitiating(attempt);
      reconciled += 1;
    }
    for (const attempt of await read.recoveryAttempts.listByStatus(["PENDING"], limit)) {
      // Catches a cancel that happened outside this process.
      const after = await this.deps.flow.reconcilePending(attempt.id);
      if (after && after.status !== "PENDING") reconciled += 1;
    }
    const finalized: FinalizeOutcome[] = [];
    const due = [
      ...(await read.recoveryAttempts.listMatured(now, limit)),
      ...(await read.recoveryAttempts.listAbandoned(now, limit)),
    ];
    for (const attempt of due) finalized.push(await this.finalize(attempt.id));
    const cleaned = await this.deps.cleanup.runPending(limit);
    return { finalized, reconciled, expired, cleaned };
  }

  /** The user of a COMPLETED recovery session: who may arm a new Recovery Code. */
  async completedSessionUser(token: unknown): Promise<string> {
    return (await resolveAttempt(this.ctx, token, { allow: ["COMPLETED"] })).userId;
  }

  /** The person asks to finalize now. It only does something once the timelock has passed. */
  async finalizeForSession(token: unknown): Promise<FinalizeOutcome> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["PENDING", "FINALIZING"] });
    return this.finalize(attempt.id);
  }

  /** Claims the lease and drives one matured attempt as far as the chain allows. */
  async finalize(attemptId: string): Promise<FinalizeOutcome> {
    const now = this.ctx.now();
    const claimed = await this.ctx.uow.read.recoveryAttempts.claimFinalization({
      id: attemptId,
      owner: this.owner,
      now,
      leaseUntil: new Date(now.getTime() + this.ctx.policy.leaseMs),
    });
    if (!claimed) return { outcome: "NOT_ELIGIBLE" };
    try {
      return await this.drive(claimed);
    } catch (error) {
      this.ctx.log("error", "recovery.finalize_error", {
        attemptId,
        code: isKaadaError(error) ? error.code : "UNEXPECTED",
      });
      // The lease expires on its own; the next pass resumes from what the chain shows.
      return { outcome: "DEFERRED", reason: isKaadaError(error) ? error.code : "ERROR" };
    }
  }

  private async drive(attempt: RecoveryAttempt): Promise<FinalizeOutcome> {
    const read = this.ctx.uow.read;
    const wallet = await read.wallets.findById(attempt.walletId);
    if (!wallet || !isWalletActive(wallet)) {
      return this.defer(attempt, "WALLET_NOT_ACTIVE");
    }
    const account = wallet.address;

    // 1. The chain is the truth: has it already moved, or has the recovery gone away?
    const [accountState, validatorState] = await Promise.all([
      this.ctx.chain.accountState(account),
      this.ctx.chain.validatorState(account),
    ]);
    if (accountState.rootValidator && accountState.rootValidator === attempt.newValidator) {
      return this.confirm(attempt, wallet);
    }
    if (!validatorState.pending) {
      const after = await this.deps.flow.reconcilePending(attempt.id);
      if (after && after.status === "FINALIZING") {
        // Nobody cancelled and the root did not change: the recovery is simply gone.
        await this.deps.flow.failAttempt(after, ["FINALIZING"], "PENDING_VANISHED");
        return { outcome: "FAILED", code: "PENDING_VANISHED" };
      }
      return { outcome: "STOPPED", status: after?.status ?? "FAILED" };
    }
    if (validatorState.pending.commitment.toLowerCase() !== attempt.commitmentHash?.toLowerCase()) {
      await this.deps.flow.failAttempt(attempt, ["FINALIZING"], "COMMITMENT_MISMATCH");
      return { outcome: "FAILED", code: "COMMITMENT_MISMATCH" };
    }

    // 2. A payment that may already have been sent is reconciled first; recovery never races it.
    const inFlight = await read.recoveryCleanup.countInFlightExecutions(wallet.id);
    if (inFlight > 0) {
      await audit(read, attempt, RECOVERY_AUDIT_EVENTS.finalizationDeferred, {
        reason: "PAYMENT_IN_FLIGHT",
        inFlight,
      });
      return this.defer(attempt, "PAYMENT_IN_FLIGHT");
    }

    // 3. Something already submitted? Ask the bundler, do not blindly send again.
    if (attempt.finalizeUserOpHash) {
      const known = await this.ctx.chain.operationStatus(attempt.finalizeUserOpHash);
      if (known.state === "INCLUDED") {
        const state = await this.ctx.chain.accountState(account);
        if (state.rootValidator === attempt.newValidator) return this.confirm(attempt, wallet);
        // Included but the root did not change: the batch reverted AFTER validation consumed the recovery.
        await this.deps.flow.failAttempt(attempt, ["FINALIZING"], "BATCH_REVERTED");
        this.ctx.log("error", "recovery.batch_reverted", { attemptId: attempt.id });
        return { outcome: "FAILED", code: "BATCH_REVERTED" };
      }
      if (known.state === "PENDING") return { outcome: "SUBMITTED" };
      // UNKNOWN: it never reached the bundler, or was dropped. A fresh submission is safe: the Kernel nonce lets at most
      // ONE operation of this lane execute, and the recovery is consumed once.
    }

    // 4. Build the exact batch from the stored PUBLIC credential data, and persist its hash BEFORE sending.
    const root = await this.deps.flow.rebuildRoot(attempt, wallet);
    if (root.commitmentHash !== attempt.commitmentHash) {
      await this.deps.flow.failAttempt(attempt, ["FINALIZING"], "COMMITMENT_MISMATCH");
      return { outcome: "FAILED", code: "COMMITMENT_MISMATCH" };
    }
    let prepared;
    try {
      prepared = await this.ctx.chain.prepareRecoveryBatch({
        account,
        root,
        nonceBefore: accountState.currentNonce,
      });
    } catch (error) {
      if (isKaadaError(error, "RECOVERY_BLOCKED")) {
        logFeeUnavailable(this.ctx, "recovery_batch", error, { attemptId: attempt.id });
        const detail = error.details?.["reason"];
        const reason = typeof detail === "string" ? detail : "BLOCKED";
        await audit(read, attempt, RECOVERY_AUDIT_EVENTS.finalizationDeferred, { reason });
        return this.defer(attempt, reason);
      }
      throw error;
    }
    const stored = await read.recoveryAttempts.patch(
      attempt.id,
      {
        finalizeUserOpHash: prepared.userOpHash.toLowerCase(),
        nonceBefore: accountState.currentNonce,
      },
      { status: ["FINALIZING"], lockedBy: this.owner },
    );
    if (!stored) return { outcome: "NOT_ELIGIBLE" }; // the lease was taken over

    // 5. Send it.
    try {
      await this.ctx.chain.submitOperation({ operation: prepared.operation });
    } catch (error) {
      if (isKaadaError(error, "BUNDLER_REJECTED")) {
        logBundlerRejection(this.ctx, "recovery_batch", error, { attemptId: attempt.id });
        await read.recoveryAttempts.patch(
          attempt.id,
          {},
          { lockedBy: this.owner, clear: ["finalizeSubmission"] },
        );
        await audit(read, attempt, RECOVERY_AUDIT_EVENTS.finalizationFailed, {
          reason: "BUNDLER_REJECTED",
        });
        return this.defer(attempt, "BUNDLER_REJECTED");
      }
      // Ambiguous: the operation may be in the bundler. Keep the hash; the next pass asks about it.
      throw error;
    }
    await audit(read, attempt, RECOVERY_AUDIT_EVENTS.finalizationSubmitted);

    // 6. Wait (bounded) for inclusion, then believe the chain, not the return value.
    const deadline = this.ctx.now().getTime() + this.ctx.policy.inclusionWaitMs;
    for (;;) {
      const status = await this.ctx.chain.operationStatus(prepared.userOpHash);
      if (status.state === "INCLUDED") {
        const state = await this.ctx.chain.accountState(account);
        if (state.rootValidator === attempt.newValidator) {
          return this.confirm(
            { ...stored, ...(status.txHash && { finalizeTxHash: status.txHash }) },
            wallet,
          );
        }
        await this.deps.flow.failAttempt(stored, ["FINALIZING"], "BATCH_REVERTED");
        this.ctx.log("error", "recovery.batch_reverted", { attemptId: attempt.id });
        return { outcome: "FAILED", code: "BATCH_REVERTED" };
      }
      if (this.ctx.now().getTime() >= deadline) return { outcome: "SUBMITTED" };
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /**
   * ROOT_CHANGED only after the chain shows: the root is the committed validator, the nonce advanced, and the old lanes
   * (the old root validator and every installed permission) are void. Then the database follows, atomically.
   */
  private async confirm(
    attempt: RecoveryAttempt,
    wallet: Wallet & { address: string },
  ): Promise<FinalizeOutcome> {
    const read = this.ctx.uow.read;
    const state = await this.ctx.chain.accountState(wallet.address);
    if (state.rootValidator !== attempt.newValidator) {
      return this.defer(attempt, "ROOT_NOT_CONFIRMED");
    }
    if (attempt.nonceBefore !== undefined && state.currentNonce < attempt.nonceBefore + 1) {
      return this.defer(attempt, "NONCE_NOT_ADVANCED");
    }
    const lanes: string[] = [];
    if (attempt.previousRootValidator)
      lanes.push(this.ctx.chain.validatorLaneId(attempt.previousRootValidator));
    for (const permission of await read.delegatedPermissions.listForWallet(wallet.id)) {
      if (
        permission.providerPermissionId &&
        (permission.status === "ACTIVE" || permission.status === "PENDING")
      ) {
        lanes.push(this.ctx.chain.permissionLaneId(permission.providerPermissionId));
      }
    }
    for (const lane of lanes) {
      if (!(await this.ctx.chain.laneVoided(wallet.address, lane))) {
        this.ctx.log("error", "recovery.lane_not_voided", { attemptId: attempt.id });
        return this.defer(attempt, "OLD_LANE_NOT_VOIDED");
      }
    }

    const now = this.ctx.now();
    const moved = await this.ctx.uow.transaction(async (tx) => {
      const advanced = await tx.recoveryAttempts.advance({
        id: attempt.id,
        from: ["FINALIZING"],
        to: "ROOT_CHANGED",
        patch: {
          rootConfirmedAt: now,
          ...(attempt.finalizeTxHash && { finalizeTxHash: attempt.finalizeTxHash }),
          tokenExpiresAt: new Date(
            Math.max(
              attempt.tokenExpiresAt.getTime(),
              now.getTime() + this.ctx.policy.postRecoveryTtlMs,
            ),
          ),
        },
        clear: ["lease", "blockedReason"],
      });
      if (!advanced) return null;
      if (!advanced.newCredentialId)
        throw new KaadaError("RECOVERY_REJECTED", "no new credential was recorded");
      const promoted = await tx.walletCredentials.promoteToRoot({
        walletId: wallet.id,
        newId: advanced.newCredentialId,
        at: now,
      });
      if (!promoted) throw new KaadaError("RECOVERY_REJECTED", "the new credential is not pending");
      if (promoted.promoted.kind === "PASSKEY") {
        // From now on the existing passkey flows (PIN confirmation, root actions) recognise the new root.
        const mirror = await tx.passkeys.create({
          id: createId(),
          userId: wallet.userId,
          credentialId: promoted.promoted.credentialRef,
          publicKeyX: promoted.promoted.publicKeyX,
          publicKeyY: promoted.promoted.publicKeyY,
          rpId: promoted.promoted.rpId ?? this.ctx.rpId,
          signCount: 0,
        });
        await tx.walletCredentials.linkPasskey(promoted.promoted.id, mirror.id);
      }
      if (advanced.configurationId)
        await tx.recoveryConfigurations.close(advanced.configurationId, "CONSUMED");
      await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.rootConfirmed);
      await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.oldCredentialReplaced, {
        walletCredentialId: promoted.replaced?.id ?? "none",
      });
      return advanced;
    });
    if (!moved) return { outcome: "ROOT_CHANGED" }; // another process already recorded it

    await this.deps.cleanup.run(moved.id);
    await this.ctx.notifier.notify(moved.userId, moved.id, recoveryCompletedMessage(now));
    return { outcome: "ROOT_CHANGED" };
  }

  private async defer(attempt: RecoveryAttempt, reason: string): Promise<FinalizeOutcome> {
    // Hand the lease back and wait in PENDING; a deferral is never a failure.
    await this.ctx.uow.read.recoveryAttempts.releaseFinalization({
      id: attempt.id,
      owner: this.owner,
      blockedReason: reason,
    });
    return { outcome: "DEFERRED", reason };
  }

  // ───────────────────── after the root changed: prove it, reset the PIN ─────────────────────

  /** A fresh random challenge the NEW credential must sign, so "it works" is shown, not assumed. */
  async beginSigningProof(token: unknown): Promise<SigningProofRequest> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["ROOT_CHANGED"] });
    const credential = attempt.newCredentialId
      ? await this.ctx.uow.read.walletCredentials.findById(attempt.newCredentialId)
      : null;
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    if (!credential || !wallet?.address)
      throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now");
    const challenge = `0x${randomBytes(32).toString("hex")}`;
    const stored = await this.ctx.uow.read.recoveryAttempts.patch(
      attempt.id,
      { proofChallenge: challenge },
      { status: ["ROOT_CHANGED"] },
    );
    if (!stored) throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now");
    return {
      challenge,
      rootKind: credential.kind,
      chainId: this.ctx.chain.chainId,
      ...(credential.kind === "PASSKEY" && {
        passkey: {
          challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
          rpId: this.ctx.rpId,
          userVerification: "required" as const,
        },
      }),
      ...(credential.kind === "DEVICE_KEY" && {
        device: {
          chainId: this.ctx.chain.chainId,
          validator: credential.validatorAddress,
          account: wallet.address,
          keyId: credential.credentialRef,
          payload: deviceKeyPayload({
            chainId: this.ctx.chain.chainId,
            validator: credential.validatorAddress as `0x${string}`,
            account: wallet.address as `0x${string}`,
            keyId: credential.credentialRef as `0x${string}`,
            userOpHash: challenge as `0x${string}`,
          }),
        },
      }),
    };
  }

  /** The new credential signed the challenge: the validator (not Kaada) says whether that signature is valid. */
  async completeSigningProof(token: unknown, material: unknown): Promise<RecoveryStatusView> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["ROOT_CHANGED"] });
    const credential = attempt.newCredentialId
      ? await this.ctx.uow.read.walletCredentials.findById(attempt.newCredentialId)
      : null;
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    if (!credential || !wallet?.address || !attempt.proofChallenge || !attempt.newValidator) {
      throw new KaadaError("RECOVERY_REJECTED", "begin the signing check first");
    }
    const signature = this.ctx.chain.encodeRootSignature({ kind: credential.kind, material });
    const valid = await this.ctx.chain.checkSignature({
      account: wallet.address,
      validator: attempt.newValidator,
      kind: credential.kind,
      hash: attempt.proofChallenge,
      signature,
    });
    if (!valid) throw new KaadaError("CREDENTIAL_REJECTED", "the signature was not accepted");
    const now = this.ctx.now();
    const done = await this.ctx.uow.transaction(async (tx) => {
      const advanced = await tx.recoveryAttempts.advance({
        id: attempt.id,
        from: ["ROOT_CHANGED"],
        to: "COMPLETED",
        patch: {
          proofVerifiedAt: now,
          completedAt: now,
          tokenExpiresAt: new Date(now.getTime() + this.ctx.policy.postRecoveryTtlMs),
        },
      });
      if (advanced) {
        await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.proofOfSigningVerified);
        await audit(tx, advanced, RECOVERY_AUDIT_EVENTS.completed);
      }
      return advanced;
    });
    if (!done) throw new KaadaError("RECOVERY_REJECTED", "this step is not available right now");
    return statusView(this.ctx, done, wallet, undefined);
  }

  /** Sets a new PIN through the verified recovery session. Once. The PIN never becomes a wallet key. */
  async resetPin(token: unknown, pin: unknown): Promise<RecoveryStatusView> {
    const attempt = await resolveAttempt(this.ctx, token, { allow: ["COMPLETED"] });
    if (attempt.pinResetAt) throw new KaadaError("RECOVERY_REJECTED", "the PIN was already reset");
    if (!isValidPinFormat(pin)) throw new KaadaError("PIN_REJECTED", "a PIN is exactly six digits");
    await this.deps.pins.setPin(attempt.userId, pin);
    const now = this.ctx.now();
    const done = await this.ctx.uow.read.recoveryAttempts.patch(
      attempt.id,
      { pinResetAt: now },
      { status: ["COMPLETED"] },
    );
    await audit(this.ctx.uow.read, attempt, RECOVERY_AUDIT_EVENTS.pinReset);
    const wallet = await this.ctx.uow.read.wallets.findById(attempt.walletId);
    return statusView(this.ctx, done ?? attempt, wallet, undefined);
  }
}
