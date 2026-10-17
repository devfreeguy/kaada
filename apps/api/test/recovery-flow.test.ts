import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateRecoveryCode,
  recoveryCommitmentHash,
  recoveryDomain,
  recoveryInitiateTypes,
} from "@kaada/contracts";
import type { Address } from "viem";

import {
  createRecoveryWorld,
  expectKaada,
  newDeviceRoot,
  newPasskeyRoot,
} from "./support/recovery-world.js";

/*
 * From a verified email to a recovery pending on chain: the new root, the two factors (Recovery Code and authenticator code),
 * the commitment, and everything that must refuse.
 */

describe("proposing the new root", () => {
  it("for a passkey: a fresh clone, the exact commitment, and a typed message to sign", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = newPasskeyRoot();
    const { proposal } = await world.proposeAndSign(user, token, root);
    assert.equal(proposal.account, user.account);
    assert.equal(proposal.chainId, world.chain.chainId);
    assert.equal(proposal.recoveryAddress, user.recoveryKey.address.toLowerCase());
    assert.equal(proposal.root.kind, "PASSKEY");
    assert.match(proposal.root.validator, /^0x[0-9a-f]{40}$/);
    assert.equal(proposal.root.rootId, `0x01${proposal.root.validator.slice(2)}`);
    assert.equal(proposal.typedData.domain.verifyingContract, world.chain.recoveryValidator);
    assert.equal(proposal.typedData.message["account"], user.account);
    const attempt = await world.attemptOf(token);
    assert.equal(attempt.status, "ROOT_PROPOSED");
    // NOTHING is deployed or sent yet: a proposal costs the platform nothing.
    assert.equal(world.chain.instances.get(proposal.root.validator)?.deployed, false);
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("binds chain, account, nonce, validator, data, hook and hook data in the commitment", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = newPasskeyRoot();
    const { proposal } = await world.proposeAndSign(user, token, root);
    const attempt = await world.attemptOf(token);
    assert.equal(attempt.newRootKind, "PASSKEY");
    assert.equal(attempt.newValidator, proposal.root.validator);
    assert.equal(attempt.newHook, "0x0000000000000000000000000000000000000000");
    assert.equal(attempt.newHookData, "0x");
    assert.equal(attempt.recoveryNonce, "0");
    // The stored commitment is exactly keccak256(abi.encode(account, rootId, hook, validatorDataHash, hookDataHash)).
    const independent = recoveryCommitmentHash(user.account as Address, {
      validator: proposal.root.validator as Address,
      hook: "0x0000000000000000000000000000000000000000",
      validatorData: attempt.newValidatorData as `0x${string}`,
      hookData: "0x",
    });
    assert.equal(attempt.commitmentHash, independent);
    // The typed message the person signs carries the SAME hashes.
    assert.equal(proposal.typedData.message["rootId"], proposal.root.rootId);
    assert.equal(proposal.typedData.message["validatorDataHash"], attempt.newValidatorDataHash);
    assert.equal(proposal.typedData.message["hookDataHash"], attempt.newHookDataHash);
    assert.equal(proposal.typedData.domain.chainId, world.chain.chainId);
  });

  it("for a device key: validates the point, derives the key id, records the tier, and never trusts a client claim", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = await newDeviceRoot();
    const { proposal } = await world.proposeAndSign(user, token, root, { channel: "native-ios" });
    assert.equal(proposal.root.kind, "DEVICE_KEY");
    const attempt = await world.attemptOf(token);
    const credential = (await world.repositories.walletCredentials.findById(
      attempt.newCredentialId ?? "",
    ))!;
    assert.equal(
      credential.credentialRef,
      root.credentialRef,
      "the id the server derived from the point",
    );
    // A native claim without a server-side attestation verifier is NOT trusted.
    assert.equal(credential.securityTier, "UNKNOWN");
    assert.equal(credential.status, "PENDING");
    assert.equal(credential.isRoot, false);
  });

  it("a web device key is recorded as the weaker web tier, never as trusted", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, await newDeviceRoot(), {
      channel: "web",
    });
    const attempt = await world.attemptOf(token);
    const credential = (await world.repositories.walletCredentials.findById(
      attempt.newCredentialId ?? "",
    ))!;
    assert.equal(credential.securityTier, "WEB_NON_EXTRACTABLE");
    assert.ok(proposal.root.validator);
  });

  it("refuses a device key that is not a valid P-256 point or is malformed", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const good = await newDeviceRoot();
    for (const bad of [
      { ...good, publicKeyY: "00".repeat(32) },
      { ...good, publicKeyX: "0".repeat(64) },
      { ...good, publicKeyX: good.publicKeyX.slice(2) },
      { ...good, publicKeyY: good.publicKeyY.replace(/.$/, "z") },
      { ...good, publicKeyY: (BigInt(`0x${good.publicKeyY}`) + 1n).toString(16).padStart(64, "0") },
    ]) {
      await expectKaada(
        world.flow.proposeDeviceRoot(token, {
          publicKeyX: bad.publicKeyX,
          publicKeyY: bad.publicKeyY,
          channel: "web",
        }),
        "CREDENTIAL_REJECTED",
      );
    }
    assert.equal((await world.attemptOf(token)).status, "EMAIL_VERIFIED", "nothing was proposed");
  });

  it("refuses a passkey registration the verifier rejects, or a challenge that was not issued", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const begin = await world.flow.beginNewPasskey(token);
    const root = newPasskeyRoot();
    const clientData = (challenge: string) =>
      Buffer.from(JSON.stringify({ challenge })).toString("base64url");
    await expectKaada(
      world.flow.proposePasskeyRoot(token, {
        id: root.credentialRef,
        x: root.publicKeyX,
        y: root.publicKeyY,
        response: { clientDataJSON: clientData("forged") },
      }),
      "CREDENTIAL_REJECTED",
    );
    await expectKaada(
      world.flow.proposePasskeyRoot(token, {
        reject: true,
        id: root.credentialRef,
        x: root.publicKeyX,
        y: root.publicKeyY,
        response: { clientDataJSON: clientData(begin.challenge) },
      }),
      "CREDENTIAL_REJECTED",
    );
    // The challenge was spent by the failed attempt: it cannot be replayed.
    await expectKaada(
      world.flow.proposePasskeyRoot(token, {
        id: root.credentialRef,
        x: root.publicKeyX,
        y: root.publicKeyY,
        response: { clientDataJSON: clientData(begin.challenge) },
      }),
      "CREDENTIAL_REJECTED",
    );
    assert.equal((await world.attemptOf(token)).status, "EMAIL_VERIFIED");
  });

  it("refuses to register a credential another account already holds", async () => {
    const world = createRecoveryWorld();
    const owner = await world.createUser();
    const user = await world.createUser();
    const stolen = (await world.repositories.passkeys.listActiveForUser(owner.userId))[0]!;
    const token = await world.startAndVerify(user.email);
    const begin = await world.flow.beginNewPasskey(token);
    await expectKaada(
      world.flow.proposePasskeyRoot(token, {
        id: stolen.credentialId,
        x: stolen.publicKeyX,
        y: stolen.publicKeyY,
        response: {
          clientDataJSON: Buffer.from(JSON.stringify({ challenge: begin.challenge })).toString(
            "base64url",
          ),
        },
      }),
      "CREDENTIAL_REJECTED",
    );
  });
});

describe("fresh validator instances", () => {
  it("every attempt gets a different instance, even for the same credential", async () => {
    const world = createRecoveryWorld({ policy: { maxStartsPerDay: 10 } });
    const user = await world.createUser();
    const root = newPasskeyRoot();
    const first = await world.startAndVerify(user.email);
    const a = await world.proposeAndSign(user, first, root);
    await world.repositories.recoveryAttempts.advance({
      id: (await world.attemptOf(first)).id,
      from: ["ROOT_PROPOSED"],
      to: "EXPIRED",
      patch: { terminatedBy: "SYSTEM", terminatedAt: world.now() },
    });
    world.advance(2_000);
    const second = await world.startAndVerify(user.email);
    const b = await world.proposeAndSign(user, second, root);
    assert.notEqual(a.proposal.root.validator, b.proposal.root.validator);
  });

  it("refuses an instance that is already initialized for the account", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = newPasskeyRoot();
    const attempt = await world.attemptOf(token);
    // Someone already installed this exact instance for the wallet.
    const predicted = world.chain.proposeRoot({
      account: user.account,
      credential: {
        kind: "PASSKEY",
        credentialId: root.credentialRef,
        publicKeyX: root.publicKeyX,
        publicKeyY: root.publicKeyY,
      },
      attemptId: attempt.id,
    });
    const instance = world.chain.instances.get(predicted.validator)!;
    instance.deployed = true;
    instance.initializedFor.add(user.account);
    await expectKaada(world.proposeAndSign(user, token, root), "RECOVERY_REJECTED");
    assert.equal((await world.attemptOf(token)).status, "EMAIL_VERIFIED");
  });

  it("refuses an instance that was ever recorded for the wallet, whatever its status", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = newPasskeyRoot();
    const attempt = await world.attemptOf(token);
    const predicted = world.chain.proposeRoot({
      account: user.account,
      credential: {
        kind: "PASSKEY",
        credentialId: root.credentialRef,
        publicKeyX: root.publicKeyX,
        publicKeyY: root.publicKeyY,
      },
      attemptId: attempt.id,
    });
    await world.repositories.walletCredentials.create({
      id: crypto.randomUUID(),
      userId: user.userId,
      walletId: user.wallet.id,
      kind: "PASSKEY",
      role: "BACKUP",
      status: "REVOKED",
      isRoot: false,
      validatorAddress: predicted.validator,
      validatorPurpose: 1,
      deploymentSalt: predicted.deploymentSalt,
      credentialRef: "old",
      publicKeyX: "11".repeat(32),
      publicKeyY: "22".repeat(32),
      rpId: "kaada.test",
      securityTier: "UNKNOWN",
    });
    await expectKaada(world.proposeAndSign(user, token, root), "RECOVERY_REJECTED");
  });
});

describe("the Recovery Code proof and the attestor", () => {
  it("a correct proof makes the attestor sign and starts the recovery on chain, with a delay of 72 hours by default", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { view, attempt } = await world.startRecovery(user);
    assert.equal(view.status, "PENDING");
    assert.equal(view.nextStep, "WAIT");
    const chainState = await world.chain.validatorState(user.account);
    assert.equal(chainState.pending?.commitment, attempt.commitmentHash);
    const startedAt = Math.floor(world.now().getTime() / 1000);
    assert.ok(Math.abs((chainState.pending?.executeAfter ?? 0) - (startedAt + 72 * 3600)) < 5);
    assert.equal(attempt.executeAfter?.getTime(), (chainState.pending?.executeAfter ?? 0) * 1000);
    assert.equal(attempt.previousRootValidator, "0x6cf0c0a61f0a3aa76d4886b455eed781aa8f9cb6");
    assert.ok(attempt.cancelTokenHash);
    // The recovery instance was deployed only now, after the proof.
    assert.equal(world.chain.instances.get(attempt.newValidator ?? "")?.deployed, true);
  });

  it("a wrong Recovery Code is rejected: nothing reaches the chain and the authenticator code is NOT spent", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const wrong = await world.signProposal(
      proposal.typedData,
      generateRecoveryCode(),
      user.account as Address,
    );
    const code = world.authenticatorCode(user);
    await expectKaada(world.flow.submitProof(token, wrong, code), "RECOVERY_REJECTED");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.equal(world.chain.instances.get(proposal.root.validator)?.deployed, false);
    assert.equal((await world.attemptOf(token)).status, "ROOT_PROPOSED");
    assert.equal((await world.attemptOf(token)).proofFailures, 1);
    // The right Recovery Code can still use the very same authenticator code: a wrong guess burnt nothing.
    const right = await world.signProposal(proposal.typedData, user.code, user.account as Address);
    const view = await world.flow.submitProof(token, right, code);
    assert.equal(view.status, "PENDING");
  });

  it("the Recovery Code of ANOTHER account does not work", async () => {
    const world = createRecoveryWorld();
    const victim = await world.createUser();
    const attacker = await world.createUser();
    const token = await world.startAndVerify(victim.email);
    const { proposal } = await world.proposeAndSign(victim, token, newPasskeyRoot());
    const signature = await world.signProposal(
      proposal.typedData,
      attacker.code,
      victim.account as Address,
    );
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(victim)),
      "RECOVERY_REJECTED",
    );
  });

  it("the same Recovery Code derived for another chain or account signs nothing useful", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const { deriveRecoveryKey } = await import("@kaada/contracts");
    const { privateKeyToAccount } = await import("viem/accounts");
    const wrongChain = deriveRecoveryKey(user.code, {
      chainId: 1,
      account: user.account as Address,
    });
    const signature = await privateKeyToAccount(wrongChain.privateKey).signTypedData({
      domain: recoveryDomain(
        proposal.typedData.domain.chainId,
        proposal.typedData.domain.verifyingContract as Address,
      ),
      types: recoveryInitiateTypes,
      primaryType: "Initiate",
      message: {
        account: proposal.typedData.message["account"] as Address,
        nonce: BigInt(proposal.typedData.message["nonce"]!),
        rootId: proposal.typedData.message["rootId"] as `0x${string}`,
        hook: proposal.typedData.message["hook"] as Address,
        validatorDataHash: proposal.typedData.message["validatorDataHash"] as `0x${string}`,
        hookDataHash: proposal.typedData.message["hookDataHash"] as `0x${string}`,
        deadline: BigInt(proposal.typedData.message["deadline"]!),
      },
    });
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
  });

  it("a signature over a DIFFERENT root commitment is rejected", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const swapped = {
      ...proposal.typedData,
      message: { ...proposal.typedData.message, validatorDataHash: `0x${"ab".repeat(32)}` },
    };
    const signature = await world.signProposal(swapped, user.code, user.account as Address);
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("changed validatorData in storage is caught: the rebuilt commitment must equal the stored one", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal, signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    // Someone alters the stored public key of the proposed credential.
    const attempt = await world.attemptOf(token);
    const credential = world.recovery.credentials.find((c) => c.id === attempt.newCredentialId)!;
    credential.publicKeyX = "99".repeat(32);
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.attemptOf(token)).status, "FAILED");
    assert.equal((await world.attemptOf(token)).failureCode, "COMMITMENT_MISMATCH");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    void proposal;
  });

  it("five wrong proofs fail the attempt", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    for (let i = 0; i < world.policy.maxProofFailures; i++) {
      const wrong = await world.signProposal(
        proposal.typedData,
        generateRecoveryCode(),
        user.account as Address,
      );
      await expectKaada(
        world.flow.submitProof(token, wrong, world.authenticatorCode(user)),
        "RECOVERY_REJECTED",
      );
    }
    assert.equal((await world.attemptOf(token)).status, "FAILED");
    assert.equal((await world.attemptOf(token)).failureCode, "PROOF_FAILURES");
  });

  it("the signing window closes", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    world.advance(world.policy.proofTtlMs + 1_000);
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.attemptOf(token)).status, "EXPIRED");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("malformed signatures never reach the verifier", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    await world.proposeAndSign(user, token, newPasskeyRoot());
    for (const bad of ["", "0x", "0x12", 42, null, `0x${"zz".repeat(65)}`]) {
      await expectKaada(
        world.flow.submitProof(token, bad, world.authenticatorCode(user)),
        "RECOVERY_REJECTED",
      );
    }
    assert.equal((await world.attemptOf(token)).proofFailures, 0, "malformed input is not a guess");
  });

  it("the cooldown after a recent recovery stops a new recovery from starting", async () => {
    const world = createRecoveryWorld({ policy: { cooldownAfterCompletionMs: 24 * 3600 * 1000 } });
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    // A recovery of this user completed an hour ago (injected after the attempt began).
    world.recovery.attempts.push({
      id: crypto.randomUUID(),
      userId: user.userId,
      walletId: "other",
      status: "COMPLETED",
      tokenHash: "x".repeat(64),
      tokenExpiresAt: world.now(),
      completedAt: new Date(world.now().getTime() - 3600_000),
      proofFailures: 0,
      createdAt: new Date(world.now().getTime() - 7200_000),
      updatedAt: world.now(),
    });
    const stepBefore = world.recovery.totps.find(
      (t) => t.walletId === user.wallet.id,
    )?.lastUsedStep;
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    // A refusal by the risk policy never spends the person's authenticator code.
    assert.equal(
      world.recovery.totps.find((t) => t.walletId === user.wallet.id)?.lastUsedStep,
      stepBefore,
    );
  });

  it("two simultaneous proofs start exactly one recovery", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const results = await Promise.allSettled([
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await world.attemptOf(token)).status, "PENDING");
    const initiations = world.recovery.attempts.length;
    assert.equal(initiations, 1);
  });

  it("an ambiguous failure after the chain accepted is recovered by reading the chain, not by trusting the error", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    // The chain accepts the recovery but the call "times out" afterwards.
    const real = world.chain.initiate.bind(world.chain);
    world.chain.initiate = async (input) => {
      await real(input);
      throw new Error("socket hang up");
    };
    const view = await world.flow.submitProof(token, signature, world.authenticatorCode(user));
    assert.equal(view.status, "PENDING");
    assert.ok((await world.chain.validatorState(user.account)).pending);
  });

  it("a node still behind by a block right after initiate does not strand the attempt in INITIATING", async () => {
    const world = createRecoveryWorld({ policy: { inclusionWaitMs: 5_000 } });
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    world.chain.inject.hiddenReads = 2;
    const view = await world.flow.submitProof(token, signature, world.authenticatorCode(user));
    assert.equal(view.status, "PENDING");
  });

  it("an ambiguous failure with nothing on chain leaves INITIATING for the reconciler, then fails it after the grace", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    world.chain.inject.initiate = new Error("socket hang up");
    await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_CHAIN_UNAVAILABLE",
    );
    assert.equal((await world.attemptOf(token)).status, "INITIATING");
    const finalizer = world.finalizer();
    await finalizer.runDue();
    assert.equal(
      (await world.attemptOf(token)).status,
      "INITIATING",
      "within the grace: still waiting",
    );
    world.advance(world.policy.initiatingGraceMs + 1_000);
    await finalizer.runDue();
    assert.equal((await world.attemptOf(token)).status, "FAILED");
    assert.equal((await world.attemptOf(token)).failureCode, "INITIATE_NOT_FOUND");
  });
});

describe("the two recovery factors", () => {
  /** A proposed root, signed by the right Recovery Code, ready for the second factor. */
  async function ready() {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal, signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    return { world, user, token, proposal, signature };
  }

  it("a correct Recovery Code with a wrong authenticator code is refused, with the same answer as a wrong Recovery Code", async () => {
    const { world, user, token, proposal, signature } = await ready();
    const wrongCode = world.authenticatorCode(user) === "000000" ? "111111" : "000000";
    const noTotp = await expectKaada(
      world.flow.submitProof(token, signature, wrongCode),
      "RECOVERY_REJECTED",
    );
    const wrongSig = await world.signProposal(
      proposal.typedData,
      generateRecoveryCode(),
      user.account as Address,
    );
    const noCode = await expectKaada(
      world.flow.submitProof(token, wrongSig, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    // Nothing tells the caller WHICH factor failed.
    assert.equal(noTotp.message, noCode.message);
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.equal((await world.attemptOf(token)).proofFailures, 2);
  });

  it("the authenticator code alone, with no valid Recovery Code signature, cannot start a recovery", async () => {
    const { world, user, token, proposal } = await ready();
    const stranger = await world.signProposal(
      proposal.typedData,
      generateRecoveryCode(),
      user.account as Address,
    );
    await expectKaada(
      world.flow.submitProof(token, stranger, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.equal((await world.attemptOf(token)).status, "ROOT_PROPOSED");
  });

  it("an authenticator code cannot be used twice: a replayed time step is refused", async () => {
    const { world, user, token, signature } = await ready();
    const code = world.authenticatorCode(user);
    // Spend the step on the wallet (as a second, concurrent recovery action would).
    await world.totp.verifyAndConsume({ userId: user.userId, walletId: user.wallet.id, code });
    await expectKaada(world.flow.submitProof(token, signature, code), "RECOVERY_REJECTED");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    // The next code (the next time step) works.
    world.advance(31_000);
    const view = await world.flow.submitProof(token, signature, world.authenticatorCode(user));
    assert.equal(view.status, "PENDING");
  });

  it("the attempt records WHEN and for which time step the code was accepted, never the code", async () => {
    const { attempt } = await (async () => {
      const world = createRecoveryWorld();
      const user = await world.createUser();
      return world.startRecovery(user);
    })();
    assert.ok(attempt.totpVerifiedAt);
    assert.equal(typeof attempt.totpStep, "number");
    assert.equal(JSON.stringify(attempt).includes("secret"), false);
  });

  it("a wallet that never set up an authenticator app cannot be recovered through Kaada", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ authenticator: false });
    const token = await world.startAndVerify(user.email);
    const { signature } = await world.proposeAndSign(user, token, newPasskeyRoot());
    await expectKaada(world.flow.submitProof(token, signature, "123456"), "RECOVERY_TOTP_REQUIRED");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("a malformed authenticator code never reaches the verifier and is not a guess", async () => {
    const { world, token, signature } = await ready();
    for (const bad of ["", "12345", "1234567", "abcdef", " 123456", 123456, null]) {
      await expectKaada(world.flow.submitProof(token, signature, bad), "RECOVERY_REJECTED");
    }
    assert.equal((await world.attemptOf(token)).proofFailures, 0);
  });

  it("Kaada alone cannot recover: a full copy of the server state is not enough without the Recovery Code", async () => {
    // Everything the server holds: the database rows, the encryption key, the TOTP secret (it decrypts it), the email inbox.
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const row = world.recovery.totps.find(
      (t) => t.walletId === user.wallet.id && t.status === "ACTIVE",
    )!;
    const secret = world.totpCipher.decrypt(
      row.encryptedSecret,
      `recovery-totp:${row.walletId}:${row.id}`,
    );
    assert.equal(secret, user.authenticatorSecret, "the server can read the authenticator secret");
    const { totpAtStep, stepAt } = await import("../src/core/recovery/totp.js");
    const validCode = totpAtStep(secret, stepAt(world.now().getTime()));
    // ...and the only thing it cannot produce is the Recovery Code key's signature over the committed root.
    const configuration = (await world.repositories.recoveryConfigurations.findActive(
      user.wallet.id,
    ))!;
    assert.equal(configuration.recoveryAddress, user.recoveryKey.address.toLowerCase());
    const forged = await world.signProposal(
      proposal.typedData,
      generateRecoveryCode(),
      user.account as Address,
    );
    await expectKaada(world.flow.submitProof(token, forged, validCode), "RECOVERY_REJECTED");
    // Straight to the chain with the server's own relayer is no better: initiate needs the Recovery Code signature.
    const attempt = await world.attemptOf(token);
    const wallet = (await world.repositories.wallets.findById(attempt.walletId))!;
    const root = await world.flow.rebuildRoot(attempt, wallet as never);
    await world.chain.deployInstance({ account: user.account, root });
    await assert.rejects(
      world.chain.initiate({
        account: user.account,
        root,
        deadline: proposal.deadline,
        recoverySignature: forged,
      }),
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });
});

describe("notifications", () => {
  it("tell every linked channel, with the time and the link that leads to stopping it", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    const { attempt } = await world.startRecovery(user);
    const email = world.email.sent.find((m) => m.subject.includes("recovery requested"))!;
    const telegram = world.telegram.sent[0]!;
    for (const text of [email.text, telegram.message.text]) {
      assert.match(text, /recovery of your Kaada wallet was requested/);
      assert.match(text, /will complete around \d{4}-\d{2}-\d{2} .* UTC/);
      assert.match(text, /in about 3 days/);
      assert.match(text, /https:\/\/app\.kaada\.test\/recovery\/cancel#[A-Za-z0-9_-]{43}/);
      assert.match(text, /If this was NOT you/);
    }
    const cancelToken = world.cancelTokenFrom(user);
    const { hashOpaqueToken } = await import("../src/core/authorization/token.js");
    assert.equal(hashOpaqueToken(cancelToken), attempt.cancelTokenHash);
    // The token appears in a URL FRAGMENT only (never a query string, so it never reaches a server log).
    assert.ok(!/\/recovery\/cancel\?/.test(email.text));
    // The session token and the Recovery Code appear nowhere.
    assert.ok(!email.text.includes(user.code.canonical()));
  });

  it("a failing channel does not undo the recovery or block the other channels", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser({ telegram: true });
    world.telegram.fail = true;
    const { view } = await world.startRecovery(user);
    assert.equal(view.status, "PENDING");
    assert.ok(world.email.sent.some((m) => m.subject.includes("recovery requested")));
    const audit = world.wallet.audit.filter((e) => e.type.startsWith("recovery.notification"));
    assert.ok(audit.some((e) => e.type === "recovery.notification_failed"));
  });
});
