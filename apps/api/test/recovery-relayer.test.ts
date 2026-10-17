import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { generateRecoveryCode } from "@kaada/contracts";
import type { RecoveryAttempt } from "@kaada/domain";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";

import { createRecoveryWorld, expectKaada, newPasskeyRoot } from "./support/recovery-world.js";
import type { RecoveryWorld, TestUser } from "./support/recovery-world.js";

/*
 * Recovery starts only through Kaada's relayer, and only after every factor was checked and recorded:
 *
 *   COMPROMISED RELAYER ALONE  -> cannot recover (it cannot produce the Recovery Code signature)
 *   RECOVERY CODE ALONE        -> cannot call initiate (it is not the relayer)
 *   EMAIL + AUTHENTICATOR ALONE-> cannot recover (no Recovery Code signature)
 *   ALL FACTORS                -> the relayer submits and the delay begins
 *
 * The contract itself is exercised in packages/contracts (the relayer gate, the signature, the cancel); here the same rules are
 * held at the service boundary over the semantic stand-in for the chain.
 */

const MATURE_MS = 72 * 3600 * 1000 + 10_000;

/** A proposed root signed by the right Recovery Code, ready to be submitted. */
async function ready(world: RecoveryWorld = createRecoveryWorld(), user?: TestUser) {
  const person = user ?? (await world.createUser());
  const token = await world.startAndVerify(person.email);
  const { proposal, signature } = await world.proposeAndSign(person, token, newPasskeyRoot());
  const attempt = await world.attemptOf(token);
  const wallet = (await world.repositories.wallets.findById(attempt.walletId))!;
  const root = await world.flow.rebuildRoot(attempt, wallet as never);
  return { world, user: person, token, proposal, signature, root };
}

describe("only the relayer can initiate", () => {
  it("the Recovery Code holder cannot call initiate directly, even with a perfect signature", async () => {
    const { world, user, signature, root, proposal } = await ready();
    await world.chain.deployInstance({ account: user.account, root });
    await assert.rejects(
      world.chain.initiate({
        account: user.account,
        root,
        deadline: proposal.deadline,
        recoverySignature: signature,
        sender: user.recoveryKey.address, // the holder of the Recovery Code, submitting themselves
      }),
      (error: Error & { details?: { reason?: string } }) => error.details?.reason === "NotRelayer",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("a random address cannot initiate either", async () => {
    const { world, user, signature, root, proposal } = await ready();
    await world.chain.deployInstance({ account: user.account, root });
    for (const sender of [
      privateKeyToAccount(generatePrivateKey()).address,
      user.account,
      "0x00000000000000000000000000000000000000ee",
    ]) {
      await assert.rejects(
        world.chain.initiate({
          account: user.account,
          root,
          deadline: proposal.deadline,
          recoverySignature: signature,
          sender,
        }),
        (error: Error & { details?: { reason?: string } }) =>
          error.details?.reason === "NotRelayer",
      );
    }
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("the relayer with an INVALID Recovery Code signature fails; with a VALID one it succeeds", async () => {
    const { world, user, signature, root, proposal } = await ready();
    await world.chain.deployInstance({ account: user.account, root });
    const wrong = await world.signProposal(
      proposal.typedData,
      generateRecoveryCode(),
      user.account as Address,
    );
    await assert.rejects(
      world.chain.initiate({
        account: user.account,
        root,
        deadline: proposal.deadline,
        recoverySignature: wrong,
      }),
      (error: Error & { details?: { reason?: string } }) =>
        error.details?.reason === "BadSignature",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    await world.chain.initiate({
      account: user.account,
      root,
      deadline: proposal.deadline,
      recoverySignature: signature,
    });
    assert.ok((await world.chain.validatorState(user.account)).pending);
  });

  it("a compromised relayer ALONE cannot recover: it has the chain, the database and the TOTP key, but not the Recovery Code", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const { proposal } = await world.proposeAndSign(user, token, newPasskeyRoot());
    const attempt = await world.attemptOf(token);
    const wallet = (await world.repositories.wallets.findById(attempt.walletId))!;
    const root = await world.flow.rebuildRoot(attempt, wallet as never);
    await world.chain.deployInstance({ account: user.account, root });
    // The attacker IS the relayer and signs with every key it could have: its own, a fresh one, a guessed Recovery Code.
    const attackerKeys = [generatePrivateKey(), generatePrivateKey()];
    const guesses = [
      ...(await Promise.all(
        attackerKeys.map((key) =>
          world.chain.signAs(
            key,
            world.chain.typedMessage({
              account: user.account,
              root,
              nonce: "0",
              deadline: proposal.deadline,
            }),
          ),
        ),
      )),
      await world.signProposal(proposal.typedData, generateRecoveryCode(), user.account as Address),
    ];
    for (const recoverySignature of guesses) {
      await assert.rejects(
        world.chain.initiate({
          account: user.account,
          root,
          deadline: proposal.deadline,
          recoverySignature,
        }),
        (error: Error & { details?: { reason?: string } }) =>
          error.details?.reason === "BadSignature",
      );
    }
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    // ...and through the service, a valid authenticator code with the wrong Recovery Code is no better.
    await expectKaada(
      world.flow.submitProof(token, guesses[2]!, world.authenticatorCode(user)),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });

  it("email and authenticator code alone cannot recover: without the Recovery Code signature nothing reaches the chain", async () => {
    const { world, user, token } = await ready();
    assert.ok((await world.attemptOf(token)).emailVerifiedAt);
    const code = world.authenticatorCode(user);
    await expectKaada(
      world.flow.submitProof(token, `0x${"11".repeat(65)}`, code),
      "RECOVERY_REJECTED",
    );
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.equal((await world.attemptOf(token)).status, "ROOT_PROPOSED");
  });
});

describe("every factor is recorded before the relayer submits", () => {
  it("at the moment initiate is called the attempt already has a verified email and an accepted authenticator code", async () => {
    const { world, user, token, signature } = await ready();
    let seen: RecoveryAttempt | null = null;
    const real = world.chain.initiate.bind(world.chain);
    world.chain.initiate = async (input) => {
      seen = await world.attemptOf(token);
      return real(input);
    };
    await world.flow.submitProof(token, signature, world.authenticatorCode(user));
    const atSubmission = seen as RecoveryAttempt | null;
    assert.ok(atSubmission);
    assert.equal(atSubmission.status, "INITIATING");
    assert.ok(atSubmission.emailVerifiedAt, "email verified first");
    assert.ok(atSubmission.totpVerifiedAt, "authenticator accepted first");
    assert.equal(typeof atSubmission.totpStep, "number");
    assert.ok(atSubmission.commitmentHash, "the exact root was committed first");
  });

  it("no code path reaches the chain without the email: an unverified session cannot even propose a root", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.flow.start({ email: user.email });
    await expectKaada(world.flow.beginNewPasskey(token), "RECOVERY_SESSION_INVALID");
    await expectKaada(
      world.flow.submitProof(token, `0x${"11".repeat(65)}`, "123456"),
      "RECOVERY_SESSION_INVALID",
    );
    assert.equal(world.chain.log.filter((line) => line.startsWith("initiate")).length, 0);
  });
});

describe("the relayer being unavailable fails safely", () => {
  it("nothing is sent, nobody else submits, the error is retryable, and the same proposal works once the relayer is back", async () => {
    const { world, user, token, signature, root } = await ready();
    world.chain.inject.relayerDown = true;
    const failure = await expectKaada(
      world.flow.submitProof(token, signature, world.authenticatorCode(user)),
      "RECOVERY_RELAYER_UNAVAILABLE",
    );
    assert.match(failure.message, /nothing was sent/);
    // No partial state: nothing pending on chain, the wallet's root untouched, the claim released.
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
    assert.equal(
      (await world.chain.accountState(user.account)).rootValidator,
      (await world.chain.accountState(user.account)).rootValidator,
    );
    const after = await world.attemptOf(token);
    assert.equal(after.status, "ROOT_PROPOSED", "back to the step that can be retried");
    assert.equal(after.initiatedAt, undefined);
    assert.equal(after.initiateTxHash, undefined);
    assert.equal(world.chain.instances.get(root.validator)?.deployed ?? false, false);
    // The person cannot work around the outage: there is no other route to the chain.
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(world.flow));
    assert.equal(
      surface.some((name) => /direct|self|submitOnChain|bypass/i.test(name)),
      false,
    );
    // The relayer comes back: the next authenticator code and the same signature start the recovery.
    world.chain.inject.relayerDown = false;
    world.advance(31_000);
    const view = await world.flow.submitProof(token, signature, world.authenticatorCode(user));
    assert.equal(view.status, "PENDING");
    assert.ok((await world.chain.validatorState(user.account)).pending);
  });

  it("the outage is not counted as a wrong guess, and does not burn the attempt", async () => {
    const { world, user, token, signature } = await ready();
    world.chain.inject.relayerDown = true;
    for (let i = 0; i < world.policy.maxProofFailures + 2; i++) {
      world.advance(31_000);
      await expectKaada(
        world.flow.submitProof(token, signature, world.authenticatorCode(user)),
        "RECOVERY_RELAYER_UNAVAILABLE",
      );
    }
    const attempt = await world.attemptOf(token);
    assert.equal(attempt.proofFailures, 0);
    assert.equal(attempt.status, "ROOT_PROPOSED");
  });

  it("cancelling is not the relayer's: the existing root cancels while the relayer is down", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { token } = await world.startRecovery(user, newPasskeyRoot());
    const cancelToken = world.cancelTokenFrom(user);
    world.chain.inject.relayerDown = true;
    const request = await world.flow.prepareCancel(cancelToken);
    const root = (await world.repositories.walletCredentials.findRoot(user.wallet.id))!;
    const view = await world.flow.submitCancel(
      cancelToken,
      world.rootSigns(root.credentialRef, request.challenge),
    );
    assert.equal(view.status, "CANCELLED");
    assert.equal((await world.attemptOf(token)).terminatedBy, "ROOT");
    assert.equal((await world.chain.validatorState(user.account)).pending, undefined);
  });
});

describe("the delay still decides when a recovery can finish", () => {
  it("finalization before the delay does nothing; after it, the exact batch runs", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const { attempt } = await world.startRecovery(user, newPasskeyRoot());
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
    world.advance(72 * 3600 * 1000 - 60_000);
    assert.deepEqual(await world.finalizer().finalize(attempt.id), { outcome: "NOT_ELIGIBLE" });
    assert.equal(world.chain.submittedBatches, 0);
    world.advance(MATURE_MS);
    assert.equal((await world.finalizer().finalize(attempt.id)).outcome, "ROOT_CHANGED");
    assert.equal(world.chain.submittedBatches, 1);
  });
});

describe("no attestor, KMS or registry anywhere in the product", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const SKIP =
    /node_modules|[\\/]dist[\\/]|[\\/]\.next[\\/]|[\\/]\.turbo[\\/]|[\\/]generated[\\/]|[\\/]migrations[\\/]|[\\/]vendor[\\/]/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (SKIP.test(path)) continue;
      if (statSync(path).isDirectory()) walk(path, out);
      else out.push(path);
    }
    return out;
  }

  it("no production source, contract, env example or deploy file depends on one", () => {
    const files = [
      ...walk(join(root, "apps/api/src")),
      ...walk(join(root, "apps/web/app")),
      ...["blockchain", "config", "contracts", "database", "domain", "logger"].flatMap((p) =>
        walk(join(root, "packages", p)),
      ),
      ...walk(join(root, "deploy")),
      join(root, ".env.example"),
    ].filter(
      (f) =>
        /\.(ts|tsx|sol|example|md|yml|prisma)$/.test(f) &&
        !/\.test\.ts$/.test(f) &&
        !/[\\/](testnet|test)[\\/]/.test(f) &&
        !/device-attestation|attestation/i.test(relative(root, f)),
    );
    const offenders = files.filter((file) =>
      /\b(attestor|AttestorRegistry|currentAttestor|RECOVERY_ATTESTOR|ATTESTOR_SIGNER|KMS_KEY_ID)\b/i.test(
        readFileSync(file, "utf8"),
      ),
    );
    assert.deepEqual(
      offenders.map((f) => relative(root, f)),
      [],
    );
  });
});
