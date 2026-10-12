/*
 * Account recovery on the REAL database: the partial unique indexes, the CHECK constraints, atomic transitions under
 * parallel callers, and the whole flow through the real repositories and real transactions (the chain is the semantic
 * stand-in). Every row belongs to uniquely named test users and is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createDatabase, createRepositories } from "@kaada/database";
import type { Database } from "@kaada/database";

import { createRecoveryWorld, newDeviceRoot, newPasskeyRoot } from "../support/recovery-world.js";
import type { RecoveryWorld, TestUser } from "../support/recovery-world.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";
const MATURE_MS = 72 * 3600 * 1000 + 10_000;

describe("account recovery on the real database", { skip }, () => {
  let database: Database;
  const users: string[] = [];

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
  });

  after(async () => {
    const client = database.client;
    const where = { userId: { in: users } };
    const permissions = await client.delegatedPermission.findMany({
      where,
      select: { sessionKeySecretId: true, approvalSecretId: true },
    });
    await client.auditEvent.deleteMany({ where });
    await client.recoveryAttempt.deleteMany({ where });
    await client.recoveryConfiguration.deleteMany({ where });
    await client.walletCredential.deleteMany({ where });
    await client.delegatedPermission.deleteMany({ where });
    const secrets = permissions
      .flatMap((p) => [p.sessionKeySecretId, p.approvalSecretId])
      .filter((id): id is string => id !== null);
    await client.executionSecret.deleteMany({ where: { id: { in: secrets } } });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await database.close();
  });

  function world(): RecoveryWorld {
    return createRecoveryWorld({ database, policy: { maxStartsPerDay: 50 } });
  }
  async function user(
    w: RecoveryWorld,
    input: Parameters<RecoveryWorld["createUser"]>[0] = {},
  ): Promise<TestUser> {
    const created = await w.createUser(input);
    users.push(created.userId);
    return created;
  }

  it("allows one live attempt per wallet, and a terminal attempt frees the wallet", async () => {
    const w = world();
    const u = await user(w);
    const first = await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    assert.ok(first);
    const second = await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    assert.equal(second, null, "the partial unique index refuses a second live attempt");
    const parallel = await Promise.all(
      Array.from({ length: 5 }, () =>
        w.repositories.recoveryAttempts.create({
          id: randomUUID(),
          userId: u.userId,
          walletId: u.wallet.id,
          tokenHash: randomBytes(32).toString("hex"),
          tokenExpiresAt: new Date(Date.now() + 3600_000),
        }),
      ),
    );
    assert.equal(parallel.filter(Boolean).length, 0);
    await w.repositories.recoveryAttempts.advance({
      id: first.id,
      from: ["EMAIL_PENDING"],
      to: "EXPIRED",
      patch: { terminatedBy: "SYSTEM", terminatedAt: new Date() },
    });
    const third = await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    });
    assert.ok(third);
  });

  it("advances conditionally: parallel callers have exactly one winner, illegal moves do nothing", async () => {
    const w = world();
    const u = await user(w);
    const attempt = (await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    }))!;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        w.repositories.recoveryAttempts.advance({
          id: attempt.id,
          from: ["EMAIL_PENDING"],
          to: "EMAIL_VERIFIED",
          patch: { emailVerifiedAt: new Date() },
        }),
      ),
    );
    assert.equal(results.filter(Boolean).length, 1);
    // PENDING can never be reached from EMAIL_VERIFIED, and the update is a no-op.
    assert.equal(
      await w.repositories.recoveryAttempts.advance({
        id: attempt.id,
        from: ["EMAIL_VERIFIED"],
        to: "PENDING",
      }),
      null,
    );
    assert.equal(
      (await w.repositories.recoveryAttempts.findById(attempt.id))?.status,
      "EMAIL_VERIFIED",
    );
  });

  it("the database itself refuses a chain stage without email verification, a proposal or a proof", async () => {
    const w = world();
    const u = await user(w);
    const attempt = (await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    }))!;
    const raw = (sql: string) => database.client.$executeRawUnsafe(sql);
    // Email first: nothing past EMAIL_PENDING exists without it.
    await assert.rejects(
      raw(`UPDATE "RecoveryAttempt" SET "status" = 'PENDING' WHERE "id" = '${attempt.id}'::uuid`),
      /email_before_anything|check constraint/i,
    );
    await raw(
      `UPDATE "RecoveryAttempt" SET "status" = 'EMAIL_VERIFIED', "emailVerifiedAt" = now() WHERE "id" = '${attempt.id}'::uuid`,
    );
    // A proposal fixes the exact commitment: the stage cannot exist without it.
    await assert.rejects(
      raw(
        `UPDATE "RecoveryAttempt" SET "status" = 'ROOT_PROPOSED' WHERE "id" = '${attempt.id}'::uuid`,
      ),
      /proposal_complete|check constraint/i,
    );
    await assert.rejects(
      raw(
        `UPDATE "RecoveryAttempt" SET "status" = 'COMPLETED', "completedAt" = now() WHERE "id" = '${attempt.id}'::uuid`,
      ),
      /check constraint/i,
    );
    // A cancelled attempt must say the ROOT cancelled it; a token must be a SHA-256 digest; a lease needs a holder AND an expiry.
    await assert.rejects(
      raw(
        `UPDATE "RecoveryAttempt" SET "status" = 'CANCELLED', "terminatedAt" = now(), "terminatedBy" = 'SYSTEM' WHERE "id" = '${attempt.id}'::uuid`,
      ),
      /check constraint/i,
    );
    await assert.rejects(
      raw(
        `UPDATE "RecoveryAttempt" SET "cancelTokenHash" = 'plaintext-token' WHERE "id" = '${attempt.id}'::uuid`,
      ),
      /check constraint/i,
    );
    await assert.rejects(
      raw(`UPDATE "RecoveryAttempt" SET "lockedBy" = 'someone' WHERE "id" = '${attempt.id}'::uuid`),
      /check constraint/i,
    );
    assert.equal(
      (await w.repositories.recoveryAttempts.findById(attempt.id))?.status,
      "EMAIL_VERIFIED",
    );
  });

  it("counts email guesses atomically and lets exactly one caller use a code", async () => {
    const w = world();
    const u = await user(w);
    const attempt = (await w.repositories.recoveryAttempts.create({
      id: randomUUID(),
      userId: u.userId,
      walletId: u.wallet.id,
      tokenHash: randomBytes(32).toString("hex"),
      tokenExpiresAt: new Date(Date.now() + 3600_000),
    }))!;
    const challenge = await w.repositories.recoveryEmailChallenges.create({
      id: randomUUID(),
      attemptId: attempt.id,
      sessionTokenHash: randomBytes(32).toString("hex"),
      codeHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 600_000),
      maxAttempts: 3,
    });
    const reservations = await Promise.all(
      Array.from({ length: 12 }, () =>
        w.repositories.recoveryEmailChallenges.reserveAttempt(challenge.id, new Date()),
      ),
    );
    assert.equal(reservations.filter((r) => r.state === "ADMITTED").length, 3);
    assert.equal(reservations.filter((r) => r.state === "EXHAUSTED").length, 9);
    const used = await Promise.all(
      Array.from({ length: 6 }, () =>
        w.repositories.recoveryEmailChallenges.markUsed(challenge.id, new Date()),
      ),
    );
    assert.equal(used.filter(Boolean).length, 1);
    await assert.rejects(
      w.repositories.recoveryEmailChallenges.create({
        id: randomUUID(),
        attemptId: attempt.id,
        sessionTokenHash: "not-a-digest",
        codeHash: "x",
        expiresAt: new Date(),
        maxAttempts: 1,
      }),
    );
  });

  it("gives the finalizer lease to exactly one process, and a takeover only after it expires", async () => {
    const w = world();
    const u = await user(w);
    const { attempt } = await w.startRecovery(u, newPasskeyRoot());
    const due = new Date(attempt.executeAfter!.getTime() + 1_000);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        w.repositories.recoveryAttempts.claimFinalization({
          id: attempt.id,
          owner: `p${i}`,
          now: due,
          leaseUntil: new Date(due.getTime() + 60_000),
        }),
      ),
    );
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean)!;
    assert.equal(winner.status, "FINALIZING");
    // Before the lease ends nobody can take over; after it, one can.
    assert.equal(
      await w.repositories.recoveryAttempts.claimFinalization({
        id: attempt.id,
        owner: "late",
        now: new Date(due.getTime() + 30_000),
        leaseUntil: new Date(due.getTime() + 90_000),
      }),
      null,
    );
    const taken = await w.repositories.recoveryAttempts.claimFinalization({
      id: attempt.id,
      owner: "late",
      now: new Date(due.getTime() + 61_000),
      leaseUntil: new Date(due.getTime() + 121_000),
    });
    assert.equal(taken?.lockedBy, "late");
    // Only the holder can hand the lease back.
    assert.equal(
      await w.repositories.recoveryAttempts.releaseFinalization({
        id: attempt.id,
        owner: winner.lockedBy ?? "x",
        blockedReason: "X",
      }),
      null,
    );
    assert.equal(
      (
        await w.repositories.recoveryAttempts.releaseFinalization({
          id: attempt.id,
          owner: "late",
          blockedReason: "PAYMENT_IN_FLIGHT",
        })
      )?.status,
      "PENDING",
    );
  });

  it("records a validator instance once per wallet and one root per wallet", async () => {
    const w = world();
    const u = await user(w);
    const base = {
      userId: u.userId,
      walletId: u.wallet.id,
      kind: "DEVICE_KEY" as const,
      role: "BACKUP" as const,
      validatorPurpose: 2,
      deploymentSalt: `0x${"00".repeat(32)}`,
      publicKeyX: "11".repeat(32),
      publicKeyY: "22".repeat(32),
      securityTier: "UNKNOWN" as const,
    };
    const validator = `0x${randomBytes(20).toString("hex")}`;
    await w.repositories.walletCredentials.create({
      ...base,
      id: randomUUID(),
      status: "PENDING",
      isRoot: false,
      validatorAddress: validator,
      credentialRef: `0x${randomBytes(32).toString("hex")}`,
    });
    await assert.rejects(
      w.repositories.walletCredentials.create({
        ...base,
        id: randomUUID(),
        status: "PENDING",
        isRoot: false,
        validatorAddress: validator,
        credentialRef: `0x${randomBytes(32).toString("hex")}`,
      }),
      "the same instance twice",
    );
    // The user already has an ACTIVE root (createUser): a second root is refused by the partial unique index.
    await assert.rejects(
      w.repositories.walletCredentials.create({
        ...base,
        id: randomUUID(),
        status: "ACTIVE",
        isRoot: true,
        validatorAddress: `0x${randomBytes(20).toString("hex")}`,
        credentialRef: `0x${randomBytes(32).toString("hex")}`,
      }),
    );
    // A malformed address or key is refused by the CHECK constraint.
    await assert.rejects(
      w.repositories.walletCredentials.create({
        ...base,
        id: randomUUID(),
        status: "PENDING",
        isRoot: false,
        validatorAddress: "0xABC",
        credentialRef: `0x${randomBytes(32).toString("hex")}`,
      }),
    );
    assert.equal(
      await w.repositories.walletCredentials.validatorEverUsed(u.wallet.id, validator),
      true,
    );
  });

  it("one ACTIVE recovery configuration per wallet; arming supersedes the previous one", async () => {
    const w = world();
    const u = await user(w);
    const arm = await w.configuration.prepare({
      userId: u.userId,
      recoveryAddress: "0x00000000000000000000000000000000000000f9",
    });
    const root = (await w.repositories.walletCredentials.findRoot(u.wallet.id))!;
    const active = await w.configuration.submit({
      userId: u.userId,
      configurationId: arm.configurationId,
      material: w.rootSigns(root.credentialRef, arm.signing.challenge),
    });
    assert.equal(active.status, "ACTIVE");
    const all = await w.repositories.recoveryConfigurations.listForWallet(u.wallet.id);
    assert.equal(all.filter((c) => c.status === "ACTIVE").length, 1);
    assert.equal(
      all.filter((c) => c.status === "SUPERSEDED").length,
      1,
      "the earlier ACTIVE one was superseded",
    );
  });

  it("runs a whole recovery over Postgres: proposal, proof, initiation, finalization, confirmation, cleanup, completion", async () => {
    const w = world();
    const u = await user(w, { telegram: true });
    await w.pins.setPin(u.userId, "735142");
    const permission = await w.addPermission(u);
    const newRoot = await newDeviceRoot();
    const { attempt, token } = await w.startRecovery(u, newRoot);
    assert.equal(attempt.status, "PENDING");
    assert.ok(attempt.executeAfter);

    w.advance(MATURE_MS);
    assert.deepEqual(await w.finalizer().finalize(attempt.id), { outcome: "ROOT_CHANGED" });
    const after = await w.attemptOf(token);
    assert.equal(after.status, "ROOT_CHANGED");
    assert.ok(after.rootConfirmedAt && after.cleanupCompletedAt);

    const credentials = await w.repositories.walletCredentials.listForWallet(u.wallet.id);
    assert.equal(credentials.filter((c) => c.isRoot).length, 1);
    assert.equal(credentials.find((c) => c.isRoot)?.kind, "DEVICE_KEY");
    assert.equal(
      (await w.repositories.delegatedPermissions.findById(permission.permissionId))?.status,
      "REVOKED",
    );
    assert.equal(await w.repositories.executionSecrets.get(permission.sessionSecretId), null);
    assert.equal((await w.repositories.passkeys.listActiveForUser(u.userId)).length, 0);
    assert.equal((await w.pins.status(u.userId)).resetRequired, true);

    const proof = await w.finalizer().beginSigningProof(token);
    await w
      .finalizer()
      .completeSigningProof(token, w.rootSigns(newRoot.credentialRef, proof.challenge));
    const pinDone = await w.finalizer().resetPin(token, "246813");
    assert.equal(pinDone.nextStep, "CREATE_RECOVERY_CODE");
    assert.equal((await w.pins.verify(u.userId, "246813")).status, "VERIFIED");

    const types = new Set(
      (await w.repositories.audit.listForUser(u.userId, 500)).map((e) => e.type),
    );
    for (const expected of [
      "recovery.started",
      "recovery.initiated",
      "recovery.root_confirmed",
      "recovery.cleanup_completed",
      "recovery.completed",
      "recovery.pin_reset",
    ]) {
      assert.ok(types.has(expected), expected);
    }
    // A completed recovery session may arm a new Recovery Code; the database links it to the attempt.
    const { generateRecoveryCode, deriveRecoveryKey } = await import("@kaada/contracts");
    const verifier = deriveRecoveryKey(generateRecoveryCode(), {
      chainId: w.chain.chainId,
      account: u.account as `0x${string}`,
    });
    const arm = await w.configuration.prepare({
      userId: u.userId,
      recoveryAddress: verifier.address,
    });
    await w.configuration.submit({
      userId: u.userId,
      configurationId: arm.configurationId,
      material: w.rootSigns(newRoot.credentialRef, arm.signing.challenge),
    });
    const done = await w.attemptOf(token);
    assert.ok(done.newConfigurationId);
    assert.equal((await w.flow.status(token)).nextStep, "DONE");
  });

  it("two finalizers racing on Postgres send one batch", async () => {
    const w = world();
    const u = await user(w);
    const { attempt } = await w.startRecovery(u, newPasskeyRoot());
    w.advance(MATURE_MS);
    const results = await Promise.all([
      w.finalizer("a").finalize(attempt.id),
      w.finalizer("b").finalize(attempt.id),
      w.finalizer("c").finalize(attempt.id),
    ]);
    assert.equal(results.filter((r) => r.outcome === "ROOT_CHANGED").length, 1);
    assert.equal(w.chain.submittedBatches, 1);
  });

  it("cancellation by the root and the attestor veto are recorded on Postgres", async () => {
    const w = world();
    const cancelled = await user(w);
    const a = await w.startRecovery(cancelled, newPasskeyRoot());
    const cancelToken = w.cancelTokenFrom(cancelled);
    const request = await w.flow.prepareCancel(cancelToken);
    const root = (await w.repositories.walletCredentials.findRoot(cancelled.wallet.id))!;
    const view = await w.flow.submitCancel(
      cancelToken,
      w.rootSigns(root.credentialRef, request.challenge),
    );
    assert.equal(view.status, "CANCELLED");
    assert.equal((await w.attemptOf(a.token)).terminatedBy, "ROOT");

    const vetoed = await user(w);
    const b = await w.startRecovery(vetoed, newPasskeyRoot());
    const report = await w.flow.report(w.cancelTokenFrom(vetoed));
    assert.equal(report.status, "VETOED");
    const stored = await w.attemptOf(b.token);
    assert.equal(stored.terminatedBy, "ATTESTOR");
    assert.match(stored.terminationTxHash ?? "", /^0x[0-9a-f]{64}$/);
  });

  it("an unverified email never produces an on-chain recovery, and the database agrees", async () => {
    const w = world();
    const u = await user(w);
    const token = await w.startAndVerify(u.email);
    const attempt = await w.attemptOf(token);
    assert.equal(attempt.status, "EMAIL_VERIFIED");
    assert.equal((await w.chain.validatorState(u.account)).pending, undefined);
    const rows = await createRepositories(database).recoveryAttempts.findActiveByWallet(
      u.wallet.id,
    );
    assert.equal(rows?.status, "EMAIL_VERIFIED");
  });
});
