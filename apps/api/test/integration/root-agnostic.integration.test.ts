/*
 * The root-agnostic wallet and the six-digit PIN on the REAL database: root changes through the real repositories and
 * transactions, the constraints that protect them, device-key wallets, and the PIN hash rows. Every row belongs to uniquely
 * named test users and is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { buildPrimaryRoot, primaryRootDeploymentSalt } from "@kaada/contracts";
import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database } from "@kaada/database";
import { CELO_CHAIN_ID, isKaadaError } from "@kaada/domain";
import type { Hex } from "viem";

import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import { RootCredentialService } from "../../src/core/roots/root-credentials.js";
import { WalletService } from "../../src/core/wallets/wallet-service.js";
import { KernelPolicyAdapter } from "@kaada/blockchain";
import { TestPinHasher } from "../support/payment-world.js";
import { build, deployments, withPermission } from "../support/root-change-world.js";
import { SoftDeviceKey } from "../support/soft-device-key.js";
import { FakeProvisioningAdapter } from "../support/wallet-memory.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";
const reject = (code: string) => (error: unknown) => isKaadaError(error, code as never);

describe("root-agnostic wallets on the real database", { skip }, () => {
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
    await client.rootChange.deleteMany({ where });
    await client.walletCredential.deleteMany({ where });
    await client.delegatedPermission.deleteMany({ where });
    await client.executionSecret.deleteMany({
      where: {
        id: {
          in: permissions
            .flatMap((p) => [p.sessionKeySecretId, p.approvalSecretId])
            .filter((id): id is string => id !== null),
        },
      },
    });
    await client.passkeyCredential.deleteMany({ where });
    await client.passkeyChallenge.deleteMany({ where });
    await client.transactionPinSecurity.deleteMany({ where });
    await client.wallet.deleteMany({ where });
    await client.user.deleteMany({ where: { id: { in: users } } });
    await database.close();
  });

  const world = async (rootType: "PASSKEY" | "DEVICE_KEY") => {
    const w = await build(rootType, { database });
    users.push(w.userId);
    return w;
  };

  it("rotates a root through real repositories: the new credential becomes the ONLY root, the old one is replaced", async () => {
    const w = await world("PASSKEY");
    const asset = await database.client.asset.findFirst({ where: { isActive: true } });
    assert.ok(asset, "run `pnpm db:seed` first");
    const { permission, secretId } = await withPermission(w, asset.id);

    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    const view = await w.service.complete(w.userId, prepared.changeId, w.sign(prepared));
    assert.equal(view.status, "CONFIRMED");

    const rows = await database.client.walletCredential.findMany({
      where: { walletId: w.wallet.id },
    });
    assert.equal(rows.filter((row) => row.isRoot && row.status === "ACTIVE").length, 1);
    assert.equal(rows.find((row) => row.kind === "PASSKEY")?.status, "REPLACED");
    assert.equal((await w.root()).type, "DEVICE_KEY");
    assert.equal(
      (await database.client.delegatedPermission.findUnique({ where: { id: permission.id } }))
        ?.status,
      "REVOKED",
    );
    const secret = await database.client.executionSecret.findUnique({ where: { id: secretId } });
    assert.equal(secret?.ciphertext, null, "the session key was destroyed");
    assert.ok(secret?.tombstonedAt);
  });

  it("allows one live change per wallet, refuses parallel starts, and a finished change frees the wallet", async () => {
    const w = await world("DEVICE_KEY");
    const inputs = await Promise.all(Array.from({ length: 4 }, () => w.newPasskey()));
    const results = await Promise.allSettled(
      inputs.map((input) => w.service.prepare(w.userId, "ROTATE_ROOT", input)),
    );
    assert.equal(
      results.filter((r) => r.status === "fulfilled").length,
      1,
      "the partial unique index admits one",
    );
    const winner = results.find((r) => r.status === "fulfilled");
    assert.ok(winner && winner.status === "fulfilled");
    const pending = await database.client.walletCredential.count({
      where: { walletId: w.wallet.id, status: "PENDING" },
    });
    // The losers' credentials were created in rolled-back transactions: only the winner's remains pending.
    assert.equal(pending, 1);
    await w.service.complete(w.userId, winner.value.changeId, w.sign(winner.value));
    const again = await w.service.prepare(w.userId, "ENROLL_BACKUP", (await w.newDevice()).input);
    assert.ok(again.changeId);
  });

  it("completes exactly once when two callers race, and sends exactly once", async () => {
    const w = await world("PASSKEY");
    const prepared = await w.service.prepare(w.userId, "ROTATE_ROOT", (await w.newDevice()).input);
    const proof = w.sign(prepared);
    const results = await Promise.allSettled([
      w.service.complete(w.userId, prepared.changeId, proof),
      w.service.complete(w.userId, prepared.changeId, proof),
      w.service.complete(w.userId, prepared.changeId, proof),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(w.network.sent.length, 1);
  });

  it("refuses a validator instance twice for one wallet, and a malformed operation hash", async () => {
    const w = await world("DEVICE_KEY");
    const row = (await w.credentials())[0];
    assert.ok(row);
    await assert.rejects(
      database.client.walletCredential.create({
        data: {
          id: randomUUID(),
          userId: w.userId,
          walletId: w.wallet.id,
          kind: "DEVICE_KEY",
          role: "BACKUP",
          status: "PENDING",
          isRoot: false,
          validatorAddress: row.validatorAddress,
          validatorPurpose: 2,
          deploymentSalt: `0x${"00".repeat(32)}`,
          credentialRef: `0x${"ab".repeat(32)}`,
          publicKeyX: "11".repeat(32),
          publicKeyY: "22".repeat(32),
        },
      }),
      /Unique constraint/,
    );
    await assert.rejects(
      database.client.rootChange.create({
        data: {
          id: randomUUID(),
          userId: w.userId,
          walletId: w.wallet.id,
          kind: "ROTATE_ROOT",
          newCredentialId: row.id,
          challenge: "not-a-hash",
          prepared: {},
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
      /check constraint|violates/i,
    );
  });

  it("onboards a device-key wallet: a PRIMARY DEVICE_KEY root on a fresh deterministic clone", async () => {
    const userId = randomUUID();
    users.push(userId);
    await createRepositories(database).users.create({ id: userId });
    const repositories = createRepositories(database);
    const wallets = new WalletService({
      unitOfWork: {
        read: repositories,
        transaction: (work) => withTransaction(database, work),
      },
      provisioning: new FakeProvisioningAdapter(),
      policy: new KernelPolicyAdapter(),
      rpId: "kaada.test",
    });
    const key = new SoftDeviceKey();
    const primary = buildPrimaryRoot({
      deployments,
      credential: {
        kind: "DEVICE_KEY",
        keyId: key.keyId as Hex,
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
      },
      deploymentSalt: primaryRootDeploymentSalt(userId),
    });
    const enrollment = {
      keyId: key.keyId,
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
      validatorAddress: primary.instance,
      deploymentSalt: primary.deploymentSalt,
      securityTier: "WEB_NON_EXTRACTABLE" as const,
    };
    const started = await wallets.beginDeviceKeyWallet(userId, enrollment);
    assert.equal(started.status, "PROVISIONING");
    // Idempotent for the same key, refused for a different one.
    await wallets.beginDeviceKeyWallet(userId, enrollment);
    await assert.rejects(
      wallets.beginDeviceKeyWallet(userId, { ...enrollment, keyId: `0x${"cd".repeat(32)}` }),
      reject("WALLET_ALREADY_SETUP"),
    );
    const wallet = await wallets.ensureEmbeddedWallet(userId);
    assert.equal(wallet.status, "ACTIVE");
    assert.equal(wallet.chainId, CELO_CHAIN_ID);
    const root = await new RootCredentialService({ repositories, rpId: "kaada.test" }).activeRoot(
      wallet,
    );
    assert.equal(root.type, "DEVICE_KEY");
    assert.equal(
      root.type === "DEVICE_KEY" && root.validatorAddress,
      primary.instance.toLowerCase(),
    );
    const rows = await database.client.walletCredential.findMany({
      where: { walletId: wallet.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.securityTier, "WEB_NON_EXTRACTABLE");
    assert.equal(
      await database.client.passkeyCredential.count({ where: { userId } }),
      0,
      "no passkey exists",
    );
    await assert.rejects(
      wallets.beginDeviceKeyWallet(userId, enrollment),
      reject("WALLET_ALREADY_SETUP"),
    );
  });

  it("stores only six-digit PIN hashes; four, five and seven digits never reach the hasher or the table", async () => {
    const userId = randomUUID();
    users.push(userId);
    const repositories = createRepositories(database);
    await repositories.users.create({ id: userId });
    const hasher = new TestPinHasher();
    const pins = new TransactionPinService({
      unitOfWork: {
        read: repositories,
        transaction: (work) => withTransaction(database, work),
      },
      hasher,
    });
    for (const bad of ["1234", "12345", "1234567", "12345a", ""]) {
      await assert.rejects(pins.setPin(userId, bad), reject("PIN_REJECTED"));
    }
    assert.equal(await database.client.transactionPinSecurity.count({ where: { userId } }), 0);
    assert.equal(await pins.setPin(userId, "735142"), "CREATED");
    const row = await database.client.transactionPinSecurity.findUnique({ where: { userId } });
    assert.ok(row?.pinHash);
    assert.equal(row.pinHash.includes("735142"), false, "no plaintext digits in the column");
    assert.equal((await pins.verify(userId, "735142")).status, "VERIFIED");
    // A four-digit value is not a guess: it neither costs an attempt nor can it ever verify.
    assert.equal((await pins.verify(userId, "1234")).status, "INVALID_FORMAT");
    assert.equal(
      (await database.client.transactionPinSecurity.findUnique({ where: { userId } }))
        ?.failedAttempts,
      0,
    );
  });

  it("a leftover four-digit hash can never verify: nothing accepts both lengths", async () => {
    const userId = randomUUID();
    users.push(userId);
    const repositories = createRepositories(database);
    await repositories.users.create({ id: userId });
    const hasher = new TestPinHasher();
    // A hash made from a retired four-digit PIN, as an old row would hold.
    await database.client.transactionPinSecurity.create({
      data: {
        id: randomUUID(),
        userId,
        pinHash: await hasher.hash("1234"),
        changedAt: new Date(),
      },
    });
    const pins = new TransactionPinService({
      unitOfWork: { read: repositories, transaction: (work) => withTransaction(database, work) },
      hasher,
    });
    assert.equal((await pins.verify(userId, "1234")).status, "INVALID_FORMAT");
    for (const guess of ["123400", "001234", "000000", "123456"]) {
      assert.notEqual((await pins.verify(userId, guess)).status, "VERIFIED", guess);
    }
  });
});
