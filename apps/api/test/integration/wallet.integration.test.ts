/*
 * Wallet services on the real database, with real transactions so the per-user row lock and the
 * partial unique index are genuinely exercised. The wallet provider and the authenticator are fakes
 * (no key material exists). Every row these tests create belongs to uniquely named test users and is
 * deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { KernelPolicyAdapter } from "@kaada/blockchain";
import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import { CELO_CHAIN_ID, createId, createMoney, isKaadaError } from "@kaada/domain";

import { PasskeyService } from "../../src/core/wallets/passkey-service.js";
import type { WalletUnitOfWork } from "../../src/core/wallets/ports.js";
import { WalletService } from "../../src/core/wallets/wallet-service.js";
import { SimpleWebAuthnVerifier } from "../../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { createSoftwareAuthenticator } from "../support/software-authenticator.js";
import { FakeProvisioningAdapter } from "../support/wallet-memory.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const url = process.env["DATABASE_URL"];
const skip = url ? false : "DATABASE_URL is not set";

const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";

describe("wallet services on the real database", { skip }, () => {
  let database: Database;
  let repositories: Repositories;
  let unitOfWork: WalletUnitOfWork;
  const createdUsers: string[] = [];
  const run = createId().slice(0, 8);

  before(() => {
    database = createDatabase({ url: url ?? "", poolMax: 8, poolTimeoutMs: 30_000 });
    repositories = createRepositories(database);
    unitOfWork = {
      read: repositories,
      transaction: (work) => withTransaction(database, work, { timeoutMs: 60_000 }),
    };
  });

  after(async () => {
    const where = { in: createdUsers };
    await database.client.delegatedPermission.deleteMany({ where: { userId: where } });
    await database.client.auditEvent.deleteMany({ where: { userId: where } });
    await database.client.passkeyChallenge.deleteMany({ where: { userId: where } });
    await database.client.passkeyCredential.deleteMany({ where: { userId: where } });
    await database.client.wallet.deleteMany({ where: { userId: where } });
    await database.client.user.deleteMany({ where: { id: where } });
    await database.close();
  });

  async function newUser(label: string) {
    const user = await repositories.users.create({
      id: createId(),
      username: `${label}-${run}-${createId().slice(0, 4)}`,
    });
    createdUsers.push(user.id);
    return user;
  }

  async function addCredential(userId: string) {
    return repositories.passkeys.create({
      id: createId(),
      userId,
      credentialId: `cred-${randomUUID()}`,
      publicKeyX: randomUUID().replaceAll("-", "").padEnd(64, "a"),
      publicKeyY: randomUUID().replaceAll("-", "").padEnd(64, "b"),
      rpId: RP_ID,
    });
  }

  function walletService(adapter = new FakeProvisioningAdapter()) {
    return {
      adapter,
      service: new WalletService({
        unitOfWork,
        provisioning: adapter,
        policy: new KernelPolicyAdapter(),
      }),
    };
  }

  it("provisions ONE wallet when many calls race, and repeats return it", async () => {
    const user = await newUser("racer");
    await addCredential(user.id);
    const { service, adapter } = walletService();
    adapter.delayMs = 150;

    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => service.ensureEmbeddedWallet(user.id)),
    );
    assert.equal(new Set(wallets.map((w) => w.id)).size, 1);
    assert.ok(
      wallets.every((w) => w.status === "ACTIVE" && /^0x[0-9a-f]{40}$/.test(w.address ?? "")),
    );

    assert.equal(await database.client.wallet.count({ where: { userId: user.id } }), 1);
    const audit = await database.client.auditEvent.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(audit.filter((e) => e.type === "wallet.provisioned").length, 1);
    assert.equal(audit.filter((e) => e.type === "wallet.provisioning_started").length, 1);

    const again = await service.ensureEmbeddedWallet(user.id);
    assert.equal(again.id, wallets[0]?.id);
    assert.equal(adapter.calls <= 6, true);
    // The stored row holds identifiers only.
    const row = await database.client.wallet.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(row.type, "EMBEDDED");
    assert.equal(row.deployment, "COUNTERFACTUAL");
  });

  it("leaves a failed provisioning PROVISIONING with a reason and resumes the same wallet on retry", async () => {
    const user = await newUser("retry");
    await addCredential(user.id);
    const { service, adapter } = walletService();
    adapter.failNext = 1;
    await assert.rejects(service.ensureEmbeddedWallet(user.id), (e) =>
      isKaadaError(e, "WALLET_PROVISIONING_FAILED"),
    );

    const failed = await database.client.wallet.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(failed.status, "PROVISIONING");
    assert.equal(failed.statusReason, "PROVIDER_ERROR");
    assert.equal(failed.address, null);

    const recovered = await service.ensureEmbeddedWallet(user.id);
    assert.equal(recovered.id, failed.id);
    assert.equal(recovered.status, "ACTIVE");
    assert.equal(await database.client.wallet.count({ where: { userId: user.id } }), 1);
  });

  it("creates bounded permissions against real assets and refuses what the database refuses", async () => {
    const user = await newUser("perm");
    await addCredential(user.id);
    const { service } = walletService();
    const wallet = await service.ensureEmbeddedWallet(user.id);
    const [usdt] = await repositories.assets.findBySymbol("USDT", { chainId: CELO_CHAIN_ID });
    assert.ok(usdt, "run `pnpm db:seed` first");
    const now = new Date();

    const permission = await service.createDelegatedPermission({
      userId: user.id,
      walletId: wallet.id,
      chainId: CELO_CHAIN_ID,
      allowedOperations: ["APPROVE_TOKEN"],
      allowedContracts: [usdt.contractAddress as string],
      allowedAssetIds: [usdt.id],
      perTransactionLimit: createMoney("2000000", usdt.id),
      cumulativeLimit: createMoney("10000000", usdt.id),
      validFrom: now,
      expiresAt: new Date(now.getTime() + 3_600_000),
    });
    assert.equal(permission.status, "PENDING");
    assert.equal(permission.enforcement.cumulativeLimit, "KAADA_POLICY");
    const activated = await service.activatePermission(permission.id, "provider-perm-1");
    assert.equal(activated.status, "ACTIVE");
    const revoked = await service.revokePermission(permission.id, "USER_REQUEST");
    assert.equal(revoked.status, "REVOKED");
    assert.equal(
      (await service.revokePermission(permission.id, "AGAIN")).revocationReason,
      "USER_REQUEST",
    );
    assert.equal(await service.getUsablePermission(permission.id), null);

    const types = (await database.client.auditEvent.findMany({ where: { userId: user.id } })).map(
      (e) => e.type,
    );
    for (const type of [
      "wallet.permission_created",
      "wallet.permission_activated",
      "wallet.permission_revoked",
    ]) {
      assert.ok(types.includes(type), type);
    }
  });

  it("registers a real WebAuthn passkey into the database (public data only) and lets a challenge be used once", async () => {
    const user = await newUser("passkey");
    const service = new PasskeyService({
      unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const authenticator = createSoftwareAuthenticator();
    const options = await service.beginRegistration(user.id);
    const response = authenticator.register({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });

    // Two simultaneous submissions of the same response: exactly one can win the single-use challenge.
    const results = await Promise.allSettled([
      service.completeRegistration(user.id, response),
      service.completeRegistration(user.id, response),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);

    const row = await database.client.passkeyCredential.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(row.credentialId, authenticator.credentialId);
    assert.equal(row.publicKeyX, authenticator.x);
    assert.equal(row.publicKeyY, authenticator.y);
    assert.equal(await database.client.passkeyCredential.count({ where: { userId: user.id } }), 1);

    // It can then authenticate, and the counter is enforced in the database.
    const auth = await service.beginAuthentication(user.id);
    const credential = await service.completeAuthentication(
      user.id,
      authenticator.authenticate({
        challenge: auth.challenge,
        origin: ORIGIN,
        rpId: RP_ID,
        counter: 1,
      }),
    );
    assert.equal(credential.credentialId, authenticator.credentialId);
    const replay = await service.beginAuthentication(user.id);
    await assert.rejects(
      service.completeAuthentication(
        user.id,
        authenticator.authenticate({
          challenge: replay.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter: 1,
        }),
      ),
      (e) => isKaadaError(e, "CREDENTIAL_REJECTED"),
    );

    const audit = await database.client.auditEvent.findMany({ where: { userId: user.id } });
    assert.equal(
      audit.some((e) => e.type === "wallet.credential_registered"),
      true,
    );
    assert.equal(
      JSON.stringify(audit).includes(authenticator.x),
      false,
      "the public key is not in the audit trail",
    );
  });
});
