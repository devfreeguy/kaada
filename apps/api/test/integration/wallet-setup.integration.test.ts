/*
 * Passkey onboarding on the real database: setup-session persistence, one-time semantics under
 * concurrency, passkey storage and wallet activation. The wallet provider is a fake (no key material
 * exists) and the authenticator is a software one. Every row belongs to uniquely named test users and
 * is deleted afterwards. Skipped without DATABASE_URL.
 * Run with: pnpm --filter @kaada/api test:integration
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { KernelPolicyAdapter } from "@kaada/blockchain";
import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import { createId, isKaadaError } from "@kaada/domain";

import { PasskeyService } from "../../src/core/wallets/passkey-service.js";
import type { WalletUnitOfWork } from "../../src/core/wallets/ports.js";
import { WalletSetupService, hashSetupToken } from "../../src/core/wallets/setup-service.js";
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

describe("wallet setup sessions on the real database", { skip }, () => {
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
      transaction: (work) =>
        withTransaction(database, work, { timeoutMs: 60_000, maxWaitMs: 30_000 }),
    };
  });

  after(async () => {
    const where = { in: createdUsers };
    await database.client.walletSetupSession.deleteMany({ where: { userId: where } });
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

  function services(options: { now?: () => Date } = {}) {
    const adapter = new FakeProvisioningAdapter();
    const now = options.now ?? (() => new Date());
    const wallets = new WalletService({
      unitOfWork,
      provisioning: adapter,
      policy: new KernelPolicyAdapter(),
      now,
    });
    const passkeys = new PasskeyService({
      unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now,
    });
    const setup = new WalletSetupService({
      unitOfWork,
      users: repositories.users,
      passkeys,
      wallets,
      origin: ORIGIN,
      rpId: RP_ID,
      rpName: "Kaada",
      now,
    });
    return { adapter, setup };
  }

  it("persists a hashed session and never the token", async () => {
    const user = await newUser("persist");
    const { setup } = services();
    const session = await setup.createSession(user.id);

    const rows = await database.client.walletSetupSession.findMany({ where: { userId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.tokenHash, hashSetupToken(session.token));
    assert.equal(rows[0]?.status, "PENDING");
    assert.equal(JSON.stringify(rows).includes(session.token), false);
    const audit = await database.client.auditEvent.findMany({ where: { userId: user.id } });
    assert.equal(JSON.stringify(audit).includes(session.token), false);

    // The database itself refuses a token that is not a SHA-256 digest.
    await assert.rejects(
      database.client.walletSetupSession.create({
        data: {
          id: createId(),
          userId: user.id,
          tokenHash: session.token.padEnd(64, "x"),
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    );
  });

  it("consumes a session exactly once, even when many callers race", async () => {
    const user = await newUser("once");
    const { setup } = services();
    const session = await setup.createSession(user.id);
    const row = await repositories.walletSetupSessions.findByTokenHash(
      hashSetupToken(session.token),
    );
    assert.ok(row);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repositories.walletSetupSessions.complete(row.id, new Date()),
      ),
    );
    assert.equal(results.filter((result) => result !== null).length, 1);
    const after = await repositories.walletSetupSessions.findByTokenHash(
      hashSetupToken(session.token),
    );
    assert.equal(after?.status, "COMPLETED");
    assert.ok(after?.usedAt);
  });

  it("does not consume an expired or revoked session", async () => {
    const user = await newUser("expiry");
    const { setup } = services();
    const first = await setup.createSession(user.id);
    const second = await setup.createSession(user.id); // retires the first
    const firstRow = await repositories.walletSetupSessions.findByTokenHash(
      hashSetupToken(first.token),
    );
    const secondRow = await repositories.walletSetupSessions.findByTokenHash(
      hashSetupToken(second.token),
    );
    assert.equal(firstRow?.status, "REVOKED");
    assert.equal(
      await repositories.walletSetupSessions.complete(firstRow?.id ?? "", new Date()),
      null,
    );
    assert.equal(
      await repositories.walletSetupSessions.complete(
        secondRow?.id ?? "",
        new Date(Date.now() + 16 * 60_000),
      ),
      null,
      "past its expiry",
    );
    const pending = await database.client.walletSetupSession.count({
      where: { userId: user.id, status: "PENDING" },
    });
    assert.equal(pending, 1);
  });

  it("keeps one live link when several are requested at once", async () => {
    const user = await newUser("links");
    const { setup } = services();
    await Promise.all(Array.from({ length: 4 }, () => setup.createSession(user.id)));
    const live = await database.client.walletSetupSession.count({
      where: { userId: user.id, status: "PENDING" },
    });
    assert.equal(live, 1, "concurrent requests leave exactly one live link");
  });

  it("registers a real passkey, activates the wallet and spends the link once", async () => {
    const user = await newUser("flow");
    const { setup, adapter } = services();
    const session = await setup.createSession(user.id);
    const options = await setup.beginRegistration(session.token);
    const authenticator = createSoftwareAuthenticator();
    const response = authenticator.register({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });

    // The same response submitted twice at once: one wins.
    const results = await Promise.allSettled([
      setup.completeRegistration(session.token, response),
      setup.completeRegistration(session.token, response),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

    const credential = await database.client.passkeyCredential.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(credential.publicKeyX, authenticator.x);
    assert.equal(await database.client.passkeyCredential.count({ where: { userId: user.id } }), 1);

    const wallet = await database.client.wallet.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(wallet.status, "ACTIVE");
    assert.equal(wallet.deployment, "COUNTERFACTUAL");
    assert.equal(wallet.type, "EMBEDDED");
    assert.match(wallet.address ?? "", /^0x[0-9a-f]{40}$/);
    assert.equal(await database.client.wallet.count({ where: { userId: user.id } }), 1);
    assert.ok(adapter.calls >= 1);

    const row = await database.client.walletSetupSession.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(row.status, "COMPLETED");
    assert.ok(row.usedAt);

    // The spent link opens nothing for registration, and a finished user gets no new link.
    await assert.rejects(setup.beginRegistration(session.token), (e) =>
      isKaadaError(e, "SETUP_SESSION_INVALID"),
    );
    await assert.rejects(setup.createSession(user.id), (e) =>
      isKaadaError(e, "WALLET_ALREADY_SETUP"),
    );

    const types = (await database.client.auditEvent.findMany({ where: { userId: user.id } })).map(
      (e) => e.type,
    );
    for (const type of [
      "wallet.setup_session_created",
      "wallet.passkey_registration_started",
      "wallet.credential_registered",
      "wallet.provisioned",
      "wallet.setup_session_consumed",
    ]) {
      assert.ok(types.includes(type), type);
    }
    const audit = JSON.stringify(
      await database.client.auditEvent.findMany({ where: { userId: user.id } }),
    );
    assert.equal(audit.includes(options.challenge), false);
    assert.equal(audit.includes(authenticator.x), false);
  });

  it("resumes the same wallet after a provisioning failure", async () => {
    const user = await newUser("resume");
    const { setup, adapter } = services();
    const session = await setup.createSession(user.id);
    const options = await setup.beginRegistration(session.token);
    const response = createSoftwareAuthenticator().register({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    adapter.failNext = 1;
    await assert.rejects(setup.completeRegistration(session.token, response), (e) =>
      isKaadaError(e, "WALLET_PROVISIONING_FAILED"),
    );
    const pending = await database.client.walletSetupSession.findFirstOrThrow({
      where: { userId: user.id },
    });
    assert.equal(pending.status, "PENDING");

    const done = await setup.finalize(session.token);
    assert.equal(done.wallet?.status, "ACTIVE");
    assert.equal(await database.client.wallet.count({ where: { userId: user.id } }), 1);
    assert.equal(await database.client.passkeyCredential.count({ where: { userId: user.id } }), 1);
  });
});
