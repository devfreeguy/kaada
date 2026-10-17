import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Address } from "viem";

import {
  createRecoveryWorld,
  expectKaada,
  newDeviceRoot,
  newPasskeyRoot,
} from "./support/recovery-world.js";
import type { NewRoot, RecoveryWorld, TestUser } from "./support/recovery-world.js";

/*
 * After the proof: the timelock, finalization (one exact batch), what is confirmed before success is claimed, cancellation by
 * the existing root (the only party that can stop a recovery), and the cleanup that retires everything the old root could reach.
 */

const MATURE_MS = 72 * 3600 * 1000 + 10_000;

async function pending(world: RecoveryWorld, user: TestUser, root: NewRoot = newPasskeyRoot()) {
  return world.startRecovery(user, root);
}

describe("the timelock", () => {
  it("cannot be finalized before maturity: no batch is built or sent", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
    world.advance(72 * 3600 * 1000 - 60_000);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
    assert.equal(world.chain.submittedBatches, 0);
    assert.equal(
      (await world.repositories.recoveryAttempts.findById(attempt.id))?.status,
      "PENDING",
    );
  });

  it("the chain itself refuses the exact batch before maturity (AA22)", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    const wallet = (await world.repositories.wallets.findById(attempt.walletId))!;
    const root = await world.flow.rebuildRoot(attempt, wallet as never);
    const op = await world.chain.prepareRecoveryBatch({
      account: user.account,
      root,
      nonceBefore: 1,
    });
    await expectKaada(world.chain.submitOperation({ operation: op.operation }), "BUNDLER_REJECTED");
  });
});

describe("a successful recovery", () => {
  for (const [name, from, to] of [
    ["passkey root to a new passkey", "PASSKEY", "PASSKEY"],
    ["passkey root to a device key", "PASSKEY", "DEVICE_KEY"],
    ["device-key root to a passkey", "DEVICE_KEY", "PASSKEY"],
    ["device-key root to a different device key", "DEVICE_KEY", "DEVICE_KEY"],
  ] as const) {
    it(`${name}: root changed on chain, confirmed, then completed with proof, a new PIN and a new Recovery Code`, async () => {
      const world = createRecoveryWorld();
      const user = await world.createUser({ rootKind: from, telegram: true });
      await world.pins.setPin(user.userId, "735142");
      const permission = await world.addPermission(user);
      world.addPaymentArtifacts(user);
      const newRoot = to === "PASSKEY" ? newPasskeyRoot() : await newDeviceRoot();
      const { attempt, token } = await world.startRecovery(user, newRoot);
      const oldRoot = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;

      world.advance(MATURE_MS);
      const finalizer = world.finalizer();
      assert.deepEqual(await finalizer.finalize(attempt.id), { outcome: "ROOT_CHANGED" });

      // The chain says so, not just the database.
      const account = await world.chain.accountState(user.account);
      assert.equal(account.rootValidator, attempt.newValidator);
      assert.ok(account.currentNonce >= 2, "the nonce advanced");
      assert.equal(
        await world.chain.laneVoided(
          user.account,
          world.chain.validatorLaneId(oldRoot.validatorAddress),
        ),
        true,
      );
      assert.equal(
        await world.chain.laneVoided(
          user.account,
          world.chain.permissionLaneId(permission.providerPermissionId),
        ),
        true,
      );
      assert.equal(world.chain.submittedBatches, 1);

      // The database follows, atomically.
      const after = await world.attemptOf(token);
      assert.equal(after.status, "ROOT_CHANGED");
      assert.ok(after.rootConfirmedAt && after.finalizeUserOpHash);
      const credentials = await world.repositories.walletCredentials.listForWallet(user.wallet.id);
      const nextRoot = credentials.find((c) => c.isRoot)!;
      assert.equal(nextRoot.id, after.newCredentialId);
      assert.equal(nextRoot.status, "ACTIVE");
      assert.equal(nextRoot.kind, to);
      assert.equal(credentials.find((c) => c.id === oldRoot.id)?.status, "REPLACED");
      assert.equal(
        credentials.find((c) => c.id === oldRoot.id)?.replacedByCredentialId,
        nextRoot.id,
      );
      assert.equal(
        world.recovery.configurations.find((c) => c.walletId === user.wallet.id)?.status,
        "CONSUMED",
      );
      if (to === "PASSKEY") {
        const mirror = (await world.repositories.passkeys.listActiveForUser(user.userId)).map(
          (p) => p.credentialId,
        );
        assert.deepEqual(
          mirror,
          [newRoot.credentialRef],
          "only the new passkey is a root passkey now",
        );
      } else {
        assert.deepEqual(await world.repositories.passkeys.listActiveForUser(user.userId), []);
      }

      // The email says nothing is complete until the new credential proves itself.
      assert.equal((await world.flow.status(token)).nextStep, "PROVE_NEW_CREDENTIAL");
      await expectKaada(finalizer.resetPin(token, "246813"), "RECOVERY_REJECTED");
      const request = await finalizer.beginSigningProof(token);
      assert.equal(request.rootKind, to);
      if (to === "DEVICE_KEY") assert.equal(request.device?.keyId, newRoot.credentialRef);
      // A wrong signature (the OLD root) proves nothing.
      await expectKaada(
        finalizer.completeSigningProof(
          token,
          world.rootSigns(oldRoot.credentialRef, request.challenge),
        ),
        "CREDENTIAL_REJECTED",
      );
      assert.equal((await world.attemptOf(token)).status, "ROOT_CHANGED");
      const done = await finalizer.completeSigningProof(
        token,
        world.rootSigns(newRoot.credentialRef, request.challenge),
      );
      assert.equal(done.status, "COMPLETED");
      assert.equal(done.nextStep, "RESET_PIN");

      // PIN reset through the verified session, once.
      assert.equal((await world.pins.verify(user.userId, "735142")).status, "RESET_REQUIRED");
      const pinDone = await finalizer.resetPin(token, "246813");
      assert.equal(pinDone.nextStep, "CREATE_RECOVERY_CODE");
      assert.equal((await world.pins.verify(user.userId, "246813")).status, "VERIFIED");
      assert.equal((await world.pins.verify(user.userId, "735142")).status, "INVALID");
      await expectKaada(finalizer.resetPin(token, "135790"), "RECOVERY_REJECTED");

      // The recovery spent the authenticator app together with the Recovery Code: both must be set up again.
      assert.equal(
        await world.totp.isEnrolled(user.wallet.id),
        false,
        "the old authenticator is retired",
      );
      assert.equal((await world.flow.status(token)).authenticatorRequired, true);
      const { generateRecoveryCode, deriveRecoveryKey } = await import("@kaada/contracts");
      const early = deriveRecoveryKey(generateRecoveryCode(), {
        chainId: world.chain.chainId,
        account: user.account as Address,
      });
      await expectKaada(
        world.configuration.prepare({ userId: user.userId, recoveryAddress: early.address }),
        "RECOVERY_TOTP_REQUIRED",
      );
      // A fresh authenticator enrolment (a new secret), confirmed with a real code from the app.
      const enrolment = await world.configuration.beginAuthenticator(user.userId);
      assert.notEqual(
        enrolment.secret,
        user.authenticatorSecret,
        "a NEW secret, never the retired one",
      );
      assert.match(enrolment.otpauthUri, /^otpauth:\/\/totp\/Kaada:/);
      const { totpAtStep, stepAt } = await import("../src/core/recovery/totp.js");
      await world.configuration.confirmAuthenticator(
        user.userId,
        totpAtStep(enrolment.secret, stepAt(world.now().getTime())),
      );

      // A NEW Recovery Code is required, and the new root arms it.
      const nextCode = generateRecoveryCode();
      const verifier = deriveRecoveryKey(nextCode, {
        chainId: world.chain.chainId,
        account: user.account as Address,
      });
      const arm = await world.configuration.prepare({
        userId: user.userId,
        recoveryAddress: verifier.address,
      });
      assert.equal(arm.signing.rootKind, to);
      const armed = await world.configuration.submit({
        userId: user.userId,
        configurationId: arm.configurationId,
        material: world.rootSigns(newRoot.credentialRef, arm.signing.challenge),
      });
      assert.equal(armed.status, "ACTIVE");
      assert.equal(armed.recoveryAddress, verifier.address.toLowerCase());
      const finished = await world.flow.status(token);
      assert.equal(finished.nextStep, "DONE");
      // The old Recovery Code is spent and can never be used again.
      assert.ok(
        world.chain.accounts
          .get(user.account)!
          .usedKeys.has(user.recoveryKey.address.toLowerCase()),
      );
    });
  }

  it("notifies every channel when the wallet was recovered", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    await world.finalizer().finalize(attempt.id);
    assert.ok(world.email.sent.some((m) => m.subject.includes("wallet recovered")));
    assert.ok(world.telegram.sent.some((m) => m.message.subject.includes("wallet recovered")));
  });

  it("sends the EXACT committed batch: committed root, nonce + 1, nothing else", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const root = newPasskeyRoot();
    const { attempt } = await pending(world, user, root);
    world.advance(MATURE_MS);
    let seen: Record<string, unknown> | undefined;
    const real = world.chain.submitOperation.bind(world.chain);
    world.chain.submitOperation = (input) => {
      seen = input.operation;
      return real(input);
    };
    await world.finalizer().finalize(attempt.id);
    assert.equal(seen?.["kind"], "RECOVERY_BATCH");
    assert.equal(seen?.["rootId"], `0x01${attempt.newValidator?.slice(2)}`);
    assert.equal(seen?.["validatorData"], attempt.newValidatorData);
    assert.equal(seen?.["hook"], "0x0000000000000000000000000000000000000000");
    assert.equal(seen?.["hookData"], "0x");
    assert.equal(seen?.["nonceBefore"], 1);
    assert.deepEqual(Object.keys(seen ?? {}).sort(), [
      "account",
      "hash",
      "hook",
      "hookData",
      "kind",
      "nonceBefore",
      "rootId",
      "validatorData",
    ]);
  });
});

describe("finalizer races and restarts", () => {
  it("two finalizers at once: one drives, the other gets nothing, and one batch is sent", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    const results = await Promise.all([
      world.finalizer("a").finalize(attempt.id),
      world.finalizer("b").finalize(attempt.id),
    ]);
    assert.deepEqual(results.map((r) => r.outcome).sort(), ["NOT_ELIGIBLE", "ROOT_CHANGED"]);
    assert.equal(world.chain.submittedBatches, 1);
  });

  it("a sweep (runDue) over the same attempt from many processes sends one batch in total", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await pending(world, user);
    world.advance(MATURE_MS);
    await Promise.all(Array.from({ length: 4 }, (_, i) => world.finalizer(`p${i}`).runDue()));
    assert.equal(world.chain.submittedBatches, 1);
  });

  it("restart after submit: the hash was stored first, the new process asks the bundler and does NOT resend", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    world.advance(MATURE_MS);
    world.chain.inject.holdInclusion = true;
    assert.deepEqual(await world.finalizer("old").finalize(attempt.id), { outcome: "SUBMITTED" });
    const mid = await world.attemptOf(token);
    assert.equal(mid.status, "FINALIZING");
    assert.ok(mid.finalizeUserOpHash, "persisted before sending");
    assert.equal(mid.nonceBefore, 1);
    // The process "dies". Its lease expires; the operation lands; a brand-new process picks it up.
    world.advance(world.policy.leaseMs + 1_000);
    world.chain.includePending();
    const outcome = await world.finalizer("new").runDue();
    assert.deepEqual(
      outcome.finalized.map((r) => r.outcome),
      ["ROOT_CHANGED"],
    );
    assert.equal(world.chain.submittedBatches, 1, "no second send");
    assert.equal((await world.attemptOf(token)).status, "ROOT_CHANGED");
  });

  it("restart when the bundler still has it: waits, never resends", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    world.chain.inject.holdInclusion = true;
    await world.finalizer("old").finalize(attempt.id);
    world.advance(world.policy.leaseMs + 1_000);
    const outcome = await world.finalizer("new").finalize(attempt.id);
    assert.deepEqual(outcome, { outcome: "SUBMITTED" });
    assert.equal(world.chain.submittedBatches, 1);
  });

  it("crash after the chain executed but before the database: the next pass sees the root and finishes", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    world.advance(MATURE_MS);
    // Execute the batch directly on the chain, as if the previous process died right after sending.
    const wallet = (await world.repositories.wallets.findById(attempt.walletId))!;
    const root = await world.flow.rebuildRoot(attempt, wallet as never);
    const op = await world.chain.prepareRecoveryBatch({
      account: user.account,
      root,
      nonceBefore: 1,
    });
    await world.chain.submitOperation({ operation: op.operation });
    assert.equal((await world.attemptOf(token)).status, "PENDING");
    // The attempt is still PENDING in the database; the chain has already moved.
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "ROOT_CHANGED" });
    assert.equal((await world.attemptOf(token)).status, "ROOT_CHANGED");
  });

  it("a batch that reverts AFTER consuming the recovery is a loud failure, never a success", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    world.advance(MATURE_MS);
    world.chain.inject.revertExecution = true;
    const outcome = await world.finalizer().finalize(attempt.id);
    assert.deepEqual(outcome, { outcome: "FAILED", code: "BATCH_REVERTED" });
    assert.equal((await world.attemptOf(token)).status, "FAILED");
    assert.ok(world.logs.some((l) => l.event === "recovery.batch_reverted"));
    // The root did NOT change.
    assert.equal(
      (await world.chain.accountState(user.account)).rootValidator,
      "0x6cf0c0a61f0a3aa76d4886b455eed781aa8f9cb6",
    );
  });
});

describe("an in-flight payment", () => {
  it("defers the finalization until the payment is reconciled, then proceeds; nothing is submitted meanwhile", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    world.recovery.extras.inFlightExecutions.set(user.wallet.id, 1);
    world.advance(MATURE_MS);
    const first = await world.finalizer().finalize(attempt.id);
    assert.deepEqual(first, { outcome: "DEFERRED", reason: "PAYMENT_IN_FLIGHT" });
    assert.equal((await world.attemptOf(token)).status, "PENDING");
    assert.equal(world.chain.submittedBatches, 0);
    const view = await world.flow.status(token);
    assert.equal(view.nextStep, "WAITING_FOR_PAYMENT");
    assert.equal(view.blockedReason, "PAYMENT_IN_FLIGHT");
    // Still blocked on the next sweep.
    await world.finalizer().runDue();
    assert.equal(world.chain.submittedBatches, 0);
    // The payment settles (the execution reconciler's job): recovery goes ahead.
    world.recovery.extras.inFlightExecutions.set(user.wallet.id, 0);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "ROOT_CHANGED" });
    assert.equal(world.chain.submittedBatches, 1);
    assert.equal((await world.attemptOf(token)).blockedReason, undefined);
  });

  it("a wallet with no gas waits instead of failing", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    world.chain.accounts.get(user.account)!.gasShort = true;
    assert.deepEqual(await world.finalizer().finalize(attempt.id), {
      outcome: "DEFERRED",
      reason: "GAS_FUNDING_REQUIRED",
    });
    world.chain.accounts.get(user.account)!.gasShort = false;
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "ROOT_CHANGED" });
  });

  it("a bundler refusal defers and the retry builds a fresh operation", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    world.advance(MATURE_MS);
    const { KaadaError } = await import("@kaada/domain");
    world.chain.inject.submit = new KaadaError("BUNDLER_REJECTED", "no");
    assert.deepEqual(await world.finalizer().finalize(attempt.id), {
      outcome: "DEFERRED",
      reason: "BUNDLER_REJECTED",
    });
    assert.equal(
      (await world.attemptOf(token)).finalizeUserOpHash,
      undefined,
      "a rejected operation is forgotten",
    );
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "ROOT_CHANGED" });
  });
});

describe("confirmation comes from the chain", () => {
  it("does not mark the root changed while an old lane is still usable", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const permission = await world.addPermission(user);
    const { attempt, token } = await pending(world, user);
    world.advance(MATURE_MS);
    const finalizer = world.finalizer();
    // Break the invariant: the old permission lane claims a nonce far in the future (still usable).
    const lane = world.chain.permissionLaneId(permission.providerPermissionId);
    const originalLaneVoided = world.chain.laneVoided.bind(world.chain);
    world.chain.laneVoided = (account, id) =>
      id === lane ? Promise.resolve(false) : originalLaneVoided(account, id);
    const first = await finalizer.finalize(attempt.id);
    assert.deepEqual(first, { outcome: "DEFERRED", reason: "OLD_LANE_NOT_VOIDED" });
    assert.notEqual((await world.attemptOf(token)).status, "ROOT_CHANGED");
    assert.equal(
      (await world.repositories.walletCredentials.findRoot(user.wallet.id))?.validatorAddress,
      "0x6cf0c0a61f0a3aa76d4886b455eed781aa8f9cb6",
    );
    // Fixed: the next pass sees the root already moved and confirms.
    world.chain.laneVoided = originalLaneVoided;
    assert.deepEqual(await finalizer.finalize(attempt.id), { outcome: "ROOT_CHANGED" });
  });
});

describe("cancellation by the existing root", () => {
  it("the root signs a cancel; the attempt is CANCELLED, recorded, announced, and can never be reused", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    const { attempt, token, signature } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    assert.equal(request.rootKind, "PASSKEY");
    assert.equal(request.passkey?.userVerification, "required");
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const view = await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    assert.equal(view.status, "CANCELLED");
    const after = await world.attemptOf(token);
    assert.equal(after.terminatedBy, "ROOT");
    assert.ok(after.cancelUserOpHash && after.terminatedAt);
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.ok(world.email.sent.some((m) => m.subject.includes("recovery cancelled")));
    assert.ok(world.telegram.sent.some((m) => m.message.subject.includes("recovery cancelled")));
    // Dead: no finalization, no second cancel, no proof replay.
    world.advance(MATURE_MS);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
    await expectKaada(
      world.flow.submitCancel(cancelToken, world.rootSigns(root.credentialRef, request.challenge)),
      "RECOVERY_SESSION_INVALID",
    );
    world.advance(31_000);
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    // The recovery nonce moved: the old signatures can never start anything on the chain.
    assert.equal((await world.chain.validatorState(user.account)).recoveryNonce, "1");
    assert.equal(world.chain.submittedBatches, 0);
  });

  it("a cancel signed by someone who is NOT the root is refused and the recovery stays pending", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    await expectKaada(
      world.flow.submitCancel(cancelToken, world.rootSigns("not-the-root", request.challenge)),
      "CREDENTIAL_REJECTED",
    );
    await expectKaada(
      world.flow.submitCancel(cancelToken, world.rootSigns("anything", `0x${"00".repeat(32)}`)),
      "CREDENTIAL_REJECTED",
    );
    assert.equal((await world.attemptOf(token)).status, "PENDING");
    assert.ok((await world.chain.validatorState(user.account)).pending);
  });

  it("submit needs a prepared cancel, and the cancel token is useless for anything else", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    await expectKaada(
      world.flow.submitCancel(cancelToken, world.rootSigns("x", "0x")),
      "RECOVERY_REJECTED",
    );
    // The cancel token is not a session token: it cannot read status or advance the flow.
    await expectKaada(world.flow.status(cancelToken), "RECOVERY_SESSION_INVALID");
    await expectKaada(world.flow.prepareCancel(token), "RECOVERY_SESSION_INVALID");
  });

  it("a cancel that is still in the bundler is settled by the reconciler once it lands", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    world.chain.inject.holdInclusion = true;
    const view = await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    assert.equal(view.status, "PENDING");
    world.chain.includePending();
    // The chain already shows the recovery gone: the sweep records WHO ended it.
    await world.finalizer().runDue();
    assert.equal((await world.attemptOf(token)).status, "CANCELLED");
  });

  it("cancel and finalize racing: whichever the chain applied first wins, the other stops", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt, token } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    world.advance(MATURE_MS);
    // The cancel reaches the chain a moment before the finalizer builds its batch.
    world.chain.inject.holdInclusion = true;
    await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    world.chain.includePending();
    world.chain.inject.holdInclusion = false;
    const outcome = await world.finalizer().finalize(attempt.id);
    assert.deepEqual(outcome, { outcome: "STOPPED", status: "CANCELLED" });
    assert.equal(world.chain.submittedBatches, 0);
    assert.equal((await world.attemptOf(token)).terminatedBy, "ROOT");
  });
});

describe("nobody but the existing root can stop a recovery", () => {
  it('there is no veto and no "report" API: the flow offers no way for Kaada to stop a recovery', () => {
    const world = createRecoveryWorld();
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(world.flow));
    assert.equal(
      names.some((name) => /veto|report|attestor/i.test(name)),
      false,
    );
  });

  it("a cancel from the root that did not go through Kaada is still recorded: the chain says who ended it", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    const { token, attempt } = await pending(world, user);
    // The person cancels with their own wallet app, straight on chain, never touching Kaada's cancel route.
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const prepared = await world.chain.prepareRootOperation({
      account: user.account,
      rootValidator: root.validatorAddress,
      rootKind: root.kind,
      calls: world.chain.cancelCalls(),
    });
    const signature = world.chain.encodeRootSignature({
      kind: root.kind,
      material: world.rootSigns(root.credentialRef, prepared.userOpHash),
    });
    await world.chain.submitOperation({ operation: prepared.operation, signature });
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    await world.finalizer().runDue();
    const after = await world.attemptOf(token);
    assert.equal(after.status, "CANCELLED");
    assert.equal(after.terminatedBy, "ROOT");
    assert.ok(world.telegram.sent.some((m) => m.message.text.includes("cancelled")));
    world.advance(MATURE_MS);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
  });

  it("a node that still answers from an older block for a moment does not leave a cancelled attempt PENDING", async () => {
    const world = createRecoveryWorld({ policy: { inclusionWaitMs: 5_000 } });
    const user = await world.createUser();
    const { token } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    world.chain.inject.staleReads = 3;
    const view = await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    assert.equal(view.status, "CANCELLED");
    assert.equal((await world.attemptOf(token)).terminatedBy, "ROOT");
  });

  it("after a cancel a new attempt needs a fresh email, a fresh root and a fresh proof (nothing is reused)", async () => {
    const world = createRecoveryWorld({ policy: { maxStartsPerDay: 10 } });
    const user = await world.createUser();
    const first = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    const request = await world.flow.prepareCancel(cancelToken);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    world.advance(2_000);
    const second = await world.startRecovery(user);
    assert.notEqual(second.attempt.id, first.attempt.id);
    assert.notEqual(second.attempt.newValidator, first.attempt.newValidator);
    assert.equal(second.view.status, "PENDING");
    world.advance(31_000);
    await expectKaada(
      world.flow.submitProof(first.token, first.signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
  });
});

describe("cleanup after the root changed", () => {
  it("retires every permission, secret, session, authorization and old passkey, and locks the old PIN", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await world.pins.setPin(user.userId, "735142");
    const permission = await world.addPermission(user);
    world.addPaymentArtifacts(user);
    world.repositories.walletSetupSessions.create({
      id: crypto.randomUUID(),
      userId: user.userId,
      tokenHash: "a".repeat(64),
      expiresAt: new Date(world.now().getTime() + 3600_000),
    });
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    await world.finalizer().finalize(attempt.id);

    const stored = await world.repositories.delegatedPermissions.findById(permission.permissionId);
    assert.equal(stored?.status, "REVOKED");
    assert.equal(
      await world.repositories.executionSecrets.get(permission.sessionSecretId),
      null,
      "the session key is destroyed",
    );
    assert.equal(await world.repositories.executionSecrets.get(permission.approvalSecretId), null);
    assert.ok(world.recovery.extras.authorizationSessions.every((s) => s.status !== "PENDING"));
    assert.deepEqual(
      world.recovery.extras.paymentAuthorizations.map((p) => p.status),
      ["REVOKED", "CONSUMED"],
      "active ones revoked, consumed ones left as history",
    );
    assert.ok(world.recovery.extras.rootActions.every((r) => r.status === "CANCELLED"));
    assert.ok(world.recovery.extras.webSessions.every((s) => s.revokedAt));
    assert.ok(world.wallet.setupSessions.every((s) => s.status === "REVOKED"));
    assert.equal((await world.pins.status(user.userId)).resetRequired, true);
    assert.equal((await world.pins.verify(user.userId, "735142")).status, "RESET_REQUIRED");
    const done = await world.repositories.recoveryAttempts.findById(attempt.id);
    assert.ok(done?.cleanupCompletedAt);
  });

  it("is idempotent and resumes after a crash", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    await world.addPermission(user);
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    // The process dies in the middle of cleanup: a secret store call throws once.
    const real = world.repositories.executionSecrets.tombstone.bind(
      world.repositories.executionSecrets,
    );
    let failed = false;
    world.repositories.executionSecrets.tombstone = (id, now) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("db blip"));
      }
      return real(id, now);
    };
    await world
      .finalizer()
      .finalize(attempt.id)
      .catch(() => undefined);
    assert.equal(
      (await world.repositories.recoveryAttempts.findById(attempt.id))?.status,
      "ROOT_CHANGED",
    );
    assert.equal(
      (await world.repositories.recoveryAttempts.findById(attempt.id))?.cleanupCompletedAt,
      undefined,
    );
    // A later sweep finishes it, twice is harmless.
    assert.equal((await world.finalizer().runDue()).cleaned, 1);
    assert.equal((await world.finalizer().runDue()).cleaned, 0);
    assert.ok((await world.repositories.recoveryAttempts.findById(attempt.id))?.cleanupCompletedAt);
  });
});

describe("configuring a Recovery Code", () => {
  it("refuses a delay below the minimum, a zero or malformed verifier, and arming while a recovery is pending", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const good = "0x00000000000000000000000000000000000000f9";
    await expectKaada(
      world.configuration.prepare({
        userId: user.userId,
        recoveryAddress: good,
        delaySeconds: 3600,
      }),
      "RECOVERY_REJECTED",
    );
    await expectKaada(
      world.configuration.prepare({
        userId: user.userId,
        recoveryAddress: "0x0000000000000000000000000000000000000000",
      }),
      "RECOVERY_REJECTED",
    );
    await expectKaada(
      world.configuration.prepare({ userId: user.userId, recoveryAddress: "nope" }),
      "RECOVERY_REJECTED",
    );
    const armed = await world.createUser();
    await pending(world, armed);
    await expectKaada(
      world.configuration.prepare({ userId: armed.userId, recoveryAddress: good }),
      "RECOVERY_CONFLICT",
    );
  });

  it("arms a wallet that had no recovery: ACTIVE only after the chain reads back the same verifier and delay", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const verifier = "0x00000000000000000000000000000000000000f9";
    const request = await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: verifier,
    });
    const stored = await world.repositories.recoveryConfigurations.findById(
      request.configurationId,
    );
    assert.equal(stored?.status, "PENDING_INSTALL");
    assert.equal(stored?.delaySeconds, 72 * 3600);
    // A wrong signature is refused before anything is sent.
    await expectKaada(
      world.configuration.submit({
        userId: user.userId,
        configurationId: request.configurationId,
        material: world.rootSigns("someone-else", request.signing.challenge),
      }),
      "CREDENTIAL_REJECTED",
    );
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const active = await world.configuration.submit({
      userId: user.userId,
      configurationId: request.configurationId,
      material: world.rootSigns(root.credentialRef, request.signing.challenge),
    });
    assert.equal(active.status, "ACTIVE");
    assert.equal((await world.chain.validatorState(user.account)).recoveryKey, verifier);
  });

  it("a Recovery Code cannot be armed before the authenticator app is set up", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false });
    await expectKaada(
      world.configuration.prepare({
        userId: user.userId,
        recoveryAddress: "0x00000000000000000000000000000000000000f9",
      }),
      "RECOVERY_TOTP_REQUIRED",
    );
    assert.equal(await world.repositories.recoveryConfigurations.findActive(user.wallet.id), null);
  });

  it("another user cannot submit someone else's configuration", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ armed: false, authenticator: true });
    const other = await world.createUser();
    const request = await world.configuration.prepare({
      userId: user.userId,
      recoveryAddress: "0x00000000000000000000000000000000000000f9",
    });
    await expectKaada(
      world.configuration.submit({
        userId: other.userId,
        configurationId: request.configurationId,
        material: {},
      }),
      "RECOVERY_REJECTED",
    );
  });
});

describe("audit and secrecy", () => {
  it("records the whole lifecycle and never a token, code, signature or key", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    await world.pins.setPin(user.userId, "735142");
    const { token, attempt, signature } = await pending(world, user);
    const cancelToken = world.cancelTokenFrom(user);
    world.advance(MATURE_MS);
    await world.finalizer().finalize(attempt.id);
    const types = new Set(world.wallet.audit.map((e) => e.type));
    for (const expected of [
      "recovery.started",
      "recovery.email_challenge_sent",
      "recovery.email_verified",
      "recovery.root_proposed",
      "recovery.totp_verified",
      "recovery.initiated",
      "recovery.notification_sent",
      "recovery.finalization_submitted",
      "recovery.root_confirmed",
      "recovery.cleanup_started",
      "recovery.cleanup_completed",
    ]) {
      assert.ok(types.has(expected), `missing audit event ${expected}`);
    }
    const everything = JSON.stringify([world.wallet.audit, world.logs]);
    for (const secret of [
      token,
      cancelToken,
      signature,
      user.code.canonical(),
      user.recoveryKey.privateKey,
      "735142",
      user.authenticatorSecret ?? "",
    ]) {
      assert.ok(!everything.includes(secret), "a secret leaked into the audit trail or the logs");
    }
    // The authenticator code that was accepted appears nowhere either.
    const { totpAtStep } = await import("../src/core/recovery/totp.js");
    const accepted = totpAtStep(
      user.authenticatorSecret ?? "",
      (await world.attemptOf(token)).totpStep ?? 0,
    );
    assert.ok(
      !everything.includes(accepted),
      "the authenticator code leaked into the audit trail or the logs",
    );
    for (const mail of world.email.sent.filter((m) => !/verification code/.test(m.text))) {
      assert.ok(!mail.text.includes(token));
      assert.ok(!mail.text.includes(user.code.canonical()));
    }
  });
});

describe("after a completed recovery the old credential has no power", () => {
  it("the old root cannot cancel, arm or sign: the root is the new validator, its lane is void, its passkey is revoked", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const permission = await world.addPermission(user);
    const oldRoot = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const newRoot = newPasskeyRoot();
    const { attempt, token } = await pending(world, user, newRoot);
    world.advance(MATURE_MS);
    await world.finalizer().finalize(attempt.id);

    // On chain: the root is the committed validator; the old root lane and the old permission lane are void.
    const account = await world.chain.accountState(user.account);
    assert.notEqual(account.rootValidator, oldRoot.validatorAddress);
    assert.equal(
      await world.chain.laneVoided(
        user.account,
        world.chain.validatorLaneId(oldRoot.validatorAddress),
      ),
      true,
    );
    assert.equal(
      await world.chain.laneVoided(
        user.account,
        world.chain.permissionLaneId(permission.providerPermissionId),
      ),
      true,
    );
    // The old root signing anything the new root would be asked to sign is refused by the chain.
    const prepared = await world.chain.prepareRootOperation({
      account: user.account,
      rootValidator: account.rootValidator ?? "",
      rootKind: "PASSKEY",
      calls: world.chain.cancelCalls(),
    });
    await expectKaada(
      world.chain.submitOperation({
        operation: prepared.operation,
        signature: world.chain.encodeRootSignature({
          kind: "PASSKEY",
          material: world.rootSigns(oldRoot.credentialRef, prepared.userOpHash),
        }),
      }),
      "BUNDLER_REJECTED",
    );
    // In the database: the old passkey is revoked, the old credential REPLACED, and the old credential cannot be used to
    // prove a signing check for the recovery.
    assert.deepEqual(
      (await world.repositories.passkeys.listActiveForUser(user.userId)).map((p) => p.credentialId),
      [newRoot.credentialRef],
    );
    assert.equal(
      (await world.repositories.walletCredentials.findById(oldRoot.id))?.status,
      "REPLACED",
    );
    const request = await world.finalizer().beginSigningProof(token);
    await expectKaada(
      world
        .finalizer()
        .completeSigningProof(token, world.rootSigns(oldRoot.credentialRef, request.challenge)),
      "CREDENTIAL_REJECTED",
    );
  });

  it("every validator instance of the wallet is distinct and recorded, so none can be reused", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await pending(world, user);
    world.advance(MATURE_MS);
    await world.finalizer().finalize(attempt.id);
    const credentials = await world.repositories.walletCredentials.listForWallet(user.wallet.id);
    assert.equal(new Set(credentials.map((c) => c.validatorAddress)).size, credentials.length);
    for (const credential of credentials) {
      assert.equal(
        await world.repositories.walletCredentials.validatorEverUsed(
          user.wallet.id,
          credential.validatorAddress,
        ),
        true,
      );
    }
  });
});
