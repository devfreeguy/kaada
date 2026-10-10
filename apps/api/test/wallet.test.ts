import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import {
  ChainBalanceReader,
  DisabledExecutionSigner,
  KERNEL_ENFORCEMENT,
  KernelPolicyAdapter,
  KernelProvisioningAdapter,
} from "@kaada/blockchain";
import type { AccountAddressDeriver, ChainReader } from "@kaada/blockchain";
import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createMoney,
  formatSmallestUnit,
  isKaadaError,
  isPermissionUsable,
  isWalletActive,
} from "@kaada/domain";
import type { Asset, PaymentRoute, PermissionRequest, RootCredential } from "@kaada/domain";

import { PasskeyService } from "../src/core/wallets/passkey-service.js";
import { WalletService } from "../src/core/wallets/wallet-service.js";
import { SimpleWebAuthnVerifier } from "../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { createSoftwareAuthenticator } from "./support/software-authenticator.js";
import { createWalletService, createWalletWorld } from "./support/wallet-memory.js";

/*
 * Offline wallet tests. The wallet stack is faked; no network, no real keys. The only cryptography is a
 * software WebAuthn authenticator whose private key lives in a local variable for one test.
 */

const USER = randomUUID();
const OTHER = randomUUID();
const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";
const NOW = new Date("2026-10-10T12:00:00.000Z");

function setup(options: { credential?: boolean } = {}) {
  const world = createWalletWorld();
  if (options.credential !== false) world.addCredential(USER);
  const made = createWalletService(world, { now: () => NOW });
  return { world, ...made };
}

const token = (symbol: string, address: string, decimals = 6): Asset => ({
  id: randomUUID(),
  symbol,
  name: symbol,
  kind: "USD_STABLECOIN",
  decimals,
  chainId: CELO_CHAIN_ID,
  contractAddress: address,
  fiatCode: "USD",
  isActive: true,
});

const USDT = token("USDT", "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e");
const USDC = token("USDC", "0xceba9300f2b948710d2653dd7b07f33a8b32118c");
const WBRL = token("wBRL", "0xd76f5faf6888e24d9f04bf92a0c8b921fe4390e0", 18);
const REACTOR = "0xa9aa0a64769cbed4d3b1ceb4df01cde915c235b3";

describe("wallet provisioning", () => {
  it("provisions a first embedded Celo wallet from the user's passkey", async () => {
    const { service, world, adapter } = setup();
    const wallet = await service.ensureEmbeddedWallet(USER);

    assert.equal(wallet.status, "ACTIVE");
    assert.equal(wallet.type, "EMBEDDED");
    assert.equal(wallet.chainId, CELO_CHAIN_ID);
    assert.match(wallet.address ?? "", /^0x[0-9a-f]{40}$/);
    assert.equal(
      wallet.deployment,
      "COUNTERFACTUAL",
      "an undeployed account is never reported deployed",
    );
    assert.equal(wallet.provider, "fake-kernel");
    assert.ok(wallet.provisionedAt);
    assert.equal(adapter.calls, 1);
    assert.deepEqual(
      world.audit.map((e) => e.type),
      ["wallet.provisioning_started", "wallet.provisioned"],
    );
  });

  it("returns the same wallet on repeated calls without provisioning again", async () => {
    const { service, adapter, world } = setup();
    const first = await service.ensureEmbeddedWallet(USER);
    const again = await service.ensureEmbeddedWallet(USER);
    assert.equal(again.id, first.id);
    assert.equal(again.address, first.address);
    assert.equal(adapter.calls, 1);
    assert.equal(world.wallets.size, 1);
  });

  it("produces ONE logical wallet when calls arrive at the same time", async () => {
    const { service, adapter, world } = setup();
    adapter.delayMs = 25;
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(() => service.ensureEmbeddedWallet(USER)),
    );

    assert.equal(new Set(results.map((w) => w.id)).size, 1);
    assert.equal(new Set(results.map((w) => w.address)).size, 1);
    assert.equal(world.wallets.size, 1);
    assert.equal(
      world.audit.filter((e) => e.type === "wallet.provisioned").length,
      1,
      "provisioned is recorded once",
    );
    assert.ok(results.every((w) => w.status === "ACTIVE"));
  });

  it("a provider failure leaves the wallet PROVISIONING with a reason, and shows no provider text", async () => {
    const { service, adapter, world, logs } = setup();
    adapter.failNext = 1;
    await assert.rejects(service.ensureEmbeddedWallet(USER), (error) => {
      assert.ok(isKaadaError(error, "WALLET_PROVISIONING_FAILED"));
      assert.equal(String(error.message).includes("secret-looking"), false);
      assert.equal(JSON.stringify(error.details).includes("secret-looking"), false);
      return true;
    });
    const [wallet] = [...world.wallets.values()];
    assert.equal(wallet?.status, "PROVISIONING");
    assert.equal(wallet?.statusReason, "PROVIDER_ERROR");
    assert.equal(wallet?.address, undefined);
    assert.ok(world.audit.some((e) => e.type === "wallet.provisioning_failed"));
    assert.equal(JSON.stringify(logs).includes("secret-looking"), false);
  });

  it("retries after a failure by resuming the same wallet", async () => {
    const { service, adapter, world } = setup();
    adapter.failNext = 1;
    await assert.rejects(service.ensureEmbeddedWallet(USER));
    const failedId = [...world.wallets.keys()][0];

    const wallet = await service.ensureEmbeddedWallet(USER);
    assert.equal(wallet.id, failedId, "no second wallet was created");
    assert.equal(wallet.status, "ACTIVE");
    assert.equal(wallet.statusReason, undefined);
    assert.equal(world.wallets.size, 1);
    assert.equal(adapter.calls, 2);
  });

  it("stores a normalised lower-case address and refuses an invalid one", async () => {
    const { service, adapter, world } = setup();
    adapter.override = () => ({
      address: "0x2C49C73C5FD842cEF1393bD242BE5dE6b907267A",
      provider: "fake-kernel",
      deployment: "COUNTERFACTUAL",
    });
    const wallet = await service.ensureEmbeddedWallet(USER);
    assert.equal(wallet.address, "0x2c49c73c5fd842cef1393bd242be5de6b907267a");

    const second = setup();
    second.adapter.override = () => ({
      address: "0xnot-an-address",
      provider: "x",
      deployment: "COUNTERFACTUAL",
    });
    await assert.rejects(second.service.ensureEmbeddedWallet(USER), (e) =>
      isKaadaError(e, "WALLET_PROVISIONING_FAILED"),
    );
    assert.equal([...second.world.wallets.values()][0]?.address, undefined);
    assert.ok(world.wallets.size === 1);
  });

  it("needs a registered passkey: there is no wallet without a user-controlled root authority", async () => {
    const { service, world } = setup({ credential: false });
    await assert.rejects(service.ensureEmbeddedWallet(USER), (e) =>
      isKaadaError(e, "ROOT_CREDENTIAL_REQUIRED"),
    );
    assert.equal(world.wallets.size, 0);
  });

  it("gives different users different wallets, one each", async () => {
    const world = createWalletWorld();
    world.addCredential(USER, { publicKeyX: "aa".repeat(32) });
    world.addCredential(OTHER, { publicKeyX: "bb".repeat(32) });
    const { service } = createWalletService(world, { now: () => NOW });
    const [a, b] = await Promise.all([
      service.ensureEmbeddedWallet(USER),
      service.ensureEmbeddedWallet(OTHER),
    ]);
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.address, b.address);
  });

  it("holds no private key, seed or secret in a wallet record", async () => {
    const { service } = setup();
    const wallet = await service.ensureEmbeddedWallet(USER);
    const text = JSON.stringify(wallet).toLowerCase();
    for (const forbidden of ["privatekey", "mnemonic", "seed", "secret", "encrypted", "pin"]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(
      Object.keys(wallet).sort(),
      [
        "address",
        "chainId",
        "createdAt",
        "deployment",
        "id",
        "isPrimary",
        "provider",
        "provisionedAt",
        "status",
        "type",
        "updatedAt",
        "userId",
      ].sort(),
    );
  });
});

describe("wallet status", () => {
  it("suspends, reactivates and marks recovery, blocking the address while not active", async () => {
    const { service, world } = setup();
    const wallet = await service.ensureEmbeddedWallet(USER);
    assert.equal(await service.requireActiveAddress(USER), wallet.address);

    const suspended = await service.suspend(wallet.id, "OPERATOR_REVIEW");
    assert.equal(suspended.status, "SUSPENDED");
    assert.equal(isWalletActive(suspended), false);
    await assert.rejects(service.requireActiveAddress(USER), (e) =>
      isKaadaError(e, "WALLET_NOT_ACTIVE"),
    );

    assert.equal((await service.reactivate(wallet.id)).status, "ACTIVE");
    const recovery = await service.markRecoveryRequired(wallet.id, "DEVICE_LOST");
    assert.equal(recovery.status, "RECOVERY_REQUIRED");
    await assert.rejects(service.requireActiveAddress(USER), (e) =>
      isKaadaError(e, "WALLET_NOT_ACTIVE"),
    );
    await assert.rejects(service.reactivate(wallet.id), (e) =>
      isKaadaError(e, "WALLET_NOT_ACTIVE"),
    );

    assert.deepEqual(world.audit.map((e) => e.type).slice(2), [
      "wallet.suspended",
      "wallet.reactivated",
      "wallet.recovery_required",
    ]);
  });

  it("email possession cannot reactivate or authorise anything: there is no such path", async () => {
    const { service } = setup();
    const wallet = await service.ensureEmbeddedWallet(USER);
    await service.markRecoveryRequired(wallet.id, "DEVICE_LOST");
    // Recovery can only be opened. The service exposes no way to move a wallet out of RECOVERY_REQUIRED,
    // to sign, or to accept an email proof.
    for (const method of Object.getOwnPropertyNames(WalletService.prototype)) {
      assert.ok(!/email|otp|sign/i.test(method) && method !== "spend", method);
    }
    await assert.rejects(service.reactivate(wallet.id), (e) =>
      isKaadaError(e, "WALLET_NOT_ACTIVE"),
    );
  });
});

describe("delegated permissions", () => {
  async function activeWallet() {
    const s = setup();
    s.world.assets.push(USDT, USDC);
    const wallet = await s.service.ensureEmbeddedWallet(USER);
    const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
      userId: USER,
      walletId: wallet.id,
      chainId: CELO_CHAIN_ID,
      allowedOperations: ["APPROVE_TOKEN", "EXECUTE_SWAP"],
      allowedContracts: [USDT.contractAddress as string, REACTOR],
      allowedAssetIds: [USDT.id],
      perTransactionLimit: createMoney("50000000", USDT.id),
      cumulativeLimit: createMoney("200000000", USDT.id),
      validFrom: NOW,
      expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
      ...over,
    });
    return { ...s, wallet, request };
  }

  it("creates a bounded PENDING permission without issuing any key, and records who enforces what", async () => {
    const { service, request, world } = await activeWallet();
    const permission = await service.createDelegatedPermission(request());

    assert.equal(permission.status, "PENDING", "nothing is activated or installed");
    assert.equal(permission.providerPermissionId, undefined);
    assert.deepEqual(permission.allowedContracts, [USDT.contractAddress, REACTOR]);
    assert.deepEqual(permission.enforcement, { ...KERNEL_ENFORCEMENT });
    assert.equal(
      permission.enforcement.cumulativeLimit,
      "KAADA_POLICY",
      "no on-chain cumulative policy exists",
    );
    assert.equal(permission.enforcement.contracts, "ONCHAIN");
    assert.equal(permission.enforcement.validity, "ONCHAIN");
    assert.equal(isPermissionUsable(permission, NOW), false, "pending is not usable");
    assert.ok(world.audit.some((e) => e.type === "wallet.permission_created"));
    assert.equal(JSON.stringify(permission).toLowerCase().includes("sessionkey"), false);
  });

  it("cannot represent an unlimited permission: every bound is mandatory", async () => {
    const { service, request } = await activeWallet();
    const rejected = async (over: Partial<PermissionRequest>, label: string) =>
      assert.rejects(
        service.createDelegatedPermission(request(over)),
        (e) => isKaadaError(e, "PERMISSION_REJECTED"),
        label,
      );

    await rejected({ allowedOperations: [] }, "no operations");
    await rejected({ allowedContracts: [] }, "no contracts");
    await rejected({ allowedAssetIds: [] }, "no assets");
    await rejected({ perTransactionLimit: createMoney("0", USDT.id) }, "zero limit");
    await rejected(
      { perTransactionLimit: createMoney("1", USDC.id) },
      "limit in a non-allowed asset",
    );
    await rejected(
      { cumulativeLimit: createMoney("1", USDT.id) },
      "cumulative below per-transaction",
    );
    await rejected({ expiresAt: new Date(NOW.getTime() - 1) }, "already expired");
    await rejected(
      { expiresAt: new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000) },
      "longer than 30 days",
    );
    await rejected({ allowedContracts: ["not-an-address"] }, "bad contract");
    await rejected({ chainId: 1 }, "not Celo");
    await rejected({ allowedAssetIds: [USDT.id, randomUUID()] }, "unknown asset");
  });

  it("is only for the wallet's own owner and only while the wallet is active", async () => {
    const { service, request, wallet } = await activeWallet();
    await assert.rejects(service.createDelegatedPermission(request({ userId: OTHER })), (e) =>
      isKaadaError(e, "PERMISSION_REJECTED"),
    );
    await service.suspend(wallet.id, "REVIEW");
    await assert.rejects(service.createDelegatedPermission(request()), (e) =>
      isKaadaError(e, "WALLET_NOT_ACTIVE"),
    );
  });

  it("walks PENDING -> ACTIVE -> usable only inside its window", async () => {
    const { service, request } = await activeWallet();
    const created = await service.createDelegatedPermission(request());
    const active = await service.activatePermission(created.id, "provider-permission-1");
    assert.equal(active.status, "ACTIVE");
    assert.equal(active.providerPermissionId, "provider-permission-1");
    assert.equal(isPermissionUsable(active, NOW), true);
    assert.equal(
      isPermissionUsable(active, new Date(NOW.getTime() - 1)),
      false,
      "before validFrom",
    );
    assert.equal(isPermissionUsable(active, active.expiresAt), false, "at expiry");
    await assert.rejects(service.activatePermission(created.id, "again"), (e) =>
      isKaadaError(e, "PERMISSION_REJECTED"),
    );
    assert.ok((await service.getUsablePermission(created.id)) !== null);
  });

  it("revokes, idempotently, and a revoked permission is never usable", async () => {
    const { service, request, world } = await activeWallet();
    const created = await service.createDelegatedPermission(request());
    await service.activatePermission(created.id, "p1");

    const revoked = await service.revokePermission(created.id, "USER_REQUEST");
    assert.equal(revoked.status, "REVOKED");
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revocationReason, "USER_REQUEST");
    assert.equal(isPermissionUsable(revoked, NOW), false);
    assert.equal(await service.getUsablePermission(created.id), null);

    const again = await service.revokePermission(created.id, "AGAIN");
    assert.equal(again.revocationReason, "USER_REQUEST", "the first reason stands");
    assert.equal(world.audit.filter((e) => e.type === "wallet.permission_revoked").length, 1);
  });

  it("expires permissions past their expiry", async () => {
    const world = createWalletWorld();
    world.addCredential(USER);
    world.assets.push(USDT);
    let now = NOW;
    const { service } = createWalletService(world, { now: () => now });
    const wallet = await service.ensureEmbeddedWallet(USER);
    const created = await service.createDelegatedPermission({
      userId: USER,
      walletId: wallet.id,
      chainId: CELO_CHAIN_ID,
      allowedOperations: ["APPROVE_TOKEN"],
      allowedContracts: [USDT.contractAddress as string],
      allowedAssetIds: [USDT.id],
      perTransactionLimit: createMoney("1000000", USDT.id),
      validFrom: NOW,
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    await service.activatePermission(created.id, "p1");

    now = new Date(NOW.getTime() + 61_000);
    assert.equal(
      await service.getUsablePermission(created.id),
      null,
      "unusable the moment it expires",
    );
    assert.equal(await service.expireDuePermissions(), 1);
    assert.equal(world.permissions.get(created.id)?.status, "EXPIRED");
    assert.equal(await service.expireDuePermissions(), 0);
  });
});

describe("Kernel adapters (stack behind Kaada interfaces)", () => {
  const root: RootCredential = {
    credentialId: "AQIDBA",
    publicKeyX: "ab".repeat(32),
    publicKeyY: "cd".repeat(32),
    rpId: RP_ID,
  };

  it("derives a normalised counterfactual account and asks the chain whether it is deployed", async () => {
    const calls: string[] = [];
    const deriver: AccountAddressDeriver = {
      deriveAddress: () => Promise.resolve("0x2C49C73C5FD842cEF1393bD242BE5dE6b907267A"),
      isDeployed: (address) => {
        calls.push(address);
        return Promise.resolve(false);
      },
    };
    const adapter = new KernelProvisioningAdapter(deriver);
    const account = await adapter.deriveAccount({ chainId: CELO_CHAIN_ID, root });
    assert.equal(account.address, "0x2c49c73c5fd842cef1393bd242be5de6b907267a");
    assert.equal(account.deployment, "COUNTERFACTUAL");
    assert.equal(account.provider, "zerodev-kernel-v3.3");
    assert.deepEqual(calls, [account.address]);

    const deployed = new KernelProvisioningAdapter({
      ...deriver,
      isDeployed: () => Promise.resolve(true),
    });
    assert.equal(
      (await deployed.deriveAccount({ chainId: CELO_CHAIN_ID, root })).deployment,
      "DEPLOYED",
    );
  });

  it("accepts Celo only and a well-formed public passkey only", async () => {
    let derived = 0;
    const adapter = new KernelProvisioningAdapter({
      deriveAddress: () => {
        derived += 1;
        return Promise.resolve("0x2c49c73c5fd842cef1393bd242be5de6b907267a");
      },
      isDeployed: () => Promise.resolve(false),
    });
    await assert.rejects(adapter.deriveAccount({ chainId: 1, root }), (e) =>
      isKaadaError(e, "WALLET_PROVISIONING_FAILED"),
    );
    for (const bad of [
      { ...root, publicKeyX: "AB".repeat(32) },
      { ...root, publicKeyY: "ab" },
      { ...root, credentialId: "" },
      { ...root, rpId: "" },
    ]) {
      await assert.rejects(adapter.deriveAccount({ chainId: CELO_CHAIN_ID, root: bad }), (e) =>
        isKaadaError(e, "CREDENTIAL_REJECTED"),
      );
    }
    assert.equal(derived, 0, "nothing was derived for a rejected request");
  });

  it("states which controls are on-chain and which are Kaada policy only", () => {
    const plan = new KernelPolicyAdapter().plan({} as PermissionRequest);
    assert.deepEqual(plan.unsupported, []);
    const kaadaOnly = Object.entries(plan.enforcement)
      .filter(([, v]) => v === "KAADA_POLICY")
      .map(([k]) => k);
    assert.deepEqual(kaadaOnly, ["cumulativeLimit"]);
  });
});

describe("passkeys (real WebAuthn verification, software authenticator)", () => {
  function passkeys() {
    const world = createWalletWorld();
    const service = new PasskeyService({
      unitOfWork: world.unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now: () => NOW,
    });
    return { world, service };
  }
  const rejected = (promise: Promise<unknown>) =>
    assert.rejects(promise, (e) => isKaadaError(e, "CREDENTIAL_REJECTED"));

  it("registers a passkey and stores only its PUBLIC key", async () => {
    const { world, service } = passkeys();
    const authenticator = createSoftwareAuthenticator();
    const options = await service.beginRegistration(USER);
    const stored = await service.completeRegistration(
      USER,
      authenticator.register({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
    );

    assert.equal(stored.credentialId, authenticator.credentialId);
    assert.equal(stored.publicKeyX, authenticator.x);
    assert.equal(stored.publicKeyY, authenticator.y);
    assert.equal(stored.rpId, RP_ID);
    assert.match(stored.publicKeyX, /^[0-9a-f]{64}$/);
    const text = JSON.stringify(stored).toLowerCase();
    assert.equal(/private|secret|seed/.test(text), false);
    assert.ok(world.audit.some((e) => e.type === "wallet.credential_registered"));
    assert.equal(world.credentials.length, 1);
  });

  it("a challenge is single-use, per user and expires", async () => {
    const { service } = passkeys();
    const authenticator = createSoftwareAuthenticator();
    const options = await service.beginRegistration(USER);
    const response = authenticator.register({
      challenge: options.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    await service.completeRegistration(USER, response);
    await rejected(service.completeRegistration(USER, response)); // replay

    const other = await service.beginRegistration(USER);
    await rejected(
      service.completeRegistration(
        OTHER,
        createSoftwareAuthenticator().register({
          challenge: other.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
        }),
      ),
    ); // another user's challenge

    const late = new PasskeyService({
      unitOfWork: passkeys().world.unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now: () => NOW,
    });
    const opts = await late.beginRegistration(USER);
    const expired = new PasskeyService({
      unitOfWork: (late as unknown as { uow: never }).uow,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now: () => new Date(NOW.getTime() + 6 * 60 * 1000),
    });
    await rejected(
      expired.completeRegistration(
        USER,
        createSoftwareAuthenticator().register({
          challenge: opts.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
        }),
      ),
    );
  });

  it("rejects a wrong origin, a wrong relying party, no user verification and a forged challenge", async () => {
    const { service } = passkeys();
    const attempt = async (make: (challenge: string) => unknown) => {
      const options = await service.beginRegistration(USER);
      await rejected(service.completeRegistration(USER, make(options.challenge)));
    };
    const a = createSoftwareAuthenticator();
    await attempt((c) => a.register({ challenge: c, origin: "https://evil.example", rpId: RP_ID }));
    await attempt((c) => a.register({ challenge: c, origin: ORIGIN, rpId: "evil.example" }));
    await attempt((c) =>
      a.register({ challenge: c, origin: ORIGIN, rpId: RP_ID, userVerified: false }),
    );
    await rejected(
      service.completeRegistration(
        USER,
        a.register({ challenge: "never-issued", origin: ORIGIN, rpId: RP_ID }),
      ),
    );
    await rejected(service.completeRegistration(USER, { not: "a response" }));
  });

  it("authenticates with a counter that must move forward", async () => {
    const { service } = passkeys();
    const authenticator = createSoftwareAuthenticator();
    const reg = await service.beginRegistration(USER);
    await service.completeRegistration(
      USER,
      authenticator.register({ challenge: reg.challenge, origin: ORIGIN, rpId: RP_ID }),
    );

    const signIn = async (counter: number) => {
      const options = await service.beginAuthentication(USER);
      return service.completeAuthentication(
        USER,
        authenticator.authenticate({
          challenge: options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter,
        }),
      );
    };
    assert.equal((await signIn(5)).credentialId, authenticator.credentialId);
    await rejected(signIn(5)); // same counter: a possible cloned authenticator
    await rejected(signIn(3));
    assert.equal(
      (await signIn(6)).signCount,
      5,
      "returns the credential as it was before this use",
    );
  });

  it("refuses another user's credential, a revoked credential and a bad signature", async () => {
    const { service } = passkeys();
    const mine = createSoftwareAuthenticator();
    const reg = await service.beginRegistration(USER);
    await service.completeRegistration(
      USER,
      mine.register({ challenge: reg.challenge, origin: ORIGIN, rpId: RP_ID }),
    );

    const options = await service.beginAuthentication(OTHER);
    await rejected(
      service.completeAuthentication(
        OTHER,
        mine.authenticate({
          challenge: options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter: 1,
        }),
      ),
    );

    const stranger = createSoftwareAuthenticator();
    const own = await service.beginAuthentication(USER);
    const forged = stranger.authenticate({
      challenge: own.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
      counter: 1,
    }) as { id: string };
    forged.id = mine.credentialId; // claims to be my credential, signed by someone else's key
    await rejected(service.completeAuthentication(USER, forged));

    await service.revokeCredential(USER, mine.credentialId);
    const afterRevoke = await service.beginAuthentication(USER);
    await rejected(
      service.completeAuthentication(
        USER,
        mine.authenticate({
          challenge: afterRevoke.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter: 2,
        }),
      ),
    );
  });

  it("revoking the last passkey puts the wallet in RECOVERY_REQUIRED: nobody can spend, Kaada cannot substitute", async () => {
    const world = createWalletWorld();
    const service = new PasskeyService({
      unitOfWork: world.unitOfWork,
      verifier: new SimpleWebAuthnVerifier(),
      rpId: RP_ID,
      origin: ORIGIN,
      now: () => NOW,
    });
    const { service: wallets } = createWalletService(world, { now: () => NOW });
    const a = createSoftwareAuthenticator();
    const b = createSoftwareAuthenticator();
    for (const device of [a, b]) {
      const options = await service.beginRegistration(USER);
      await service.completeRegistration(
        USER,
        device.register({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
      );
    }
    const wallet = await wallets.ensureEmbeddedWallet(USER);

    await service.revokeCredential(USER, a.credentialId);
    assert.equal((await wallets.getWallet(USER))?.status, "ACTIVE", "another credential remains");
    await service.revokeCredential(USER, b.credentialId);
    assert.equal((await wallets.getWallet(USER))?.status, "RECOVERY_REQUIRED");
    assert.equal((await wallets.getWallet(USER))?.id, wallet.id);
    assert.ok(world.audit.some((e) => e.type === "wallet.recovery_required"));
  });
});

describe("read-only balances", () => {
  function reader(
    options: {
      balances?: Record<string, bigint>;
      decimals?: Record<string, number>;
      verifyDecimals?: boolean;
    } = {},
  ) {
    const assets = [USDT, USDC, WBRL];
    const log = { balanceCalls: 0, decimalCalls: 0, lastTokens: [] as string[] };
    const chain: ChainReader = {
      getErc20Balances: (_owner, tokens) => {
        log.balanceCalls += 1;
        log.lastTokens = tokens;
        return Promise.resolve(tokens.map((t) => options.balances?.[t] ?? 0n));
      },
      getErc20Decimals: (tokens) => {
        log.decimalCalls += 1;
        return Promise.resolve(
          tokens.map(
            (t) =>
              options.decimals?.[t] ?? assets.find((a) => a.contractAddress === t)?.decimals ?? 0,
          ),
        );
      },
    };
    const registry = createAssetRegistry({
      findById: (id) => Promise.resolve(assets.find((a) => a.id === id) ?? null),
      findBySymbol: () => Promise.resolve([]),
      findByFiatCode: () => Promise.resolve([]),
      findByDenomination: () => Promise.resolve([]),
      listActive: () => Promise.resolve(assets),
      listAll: () => Promise.resolve(assets),
    });
    return {
      log,
      reader: new ChainBalanceReader({
        assets: registry,
        chain,
        ...(options.verifyDecimals && { verifyDecimals: true }),
      }),
    };
  }
  const WALLET = "0x2C49C73C5FD842cEF1393bD242BE5dE6b907267A";

  it("returns canonical smallest-unit Money, untouched by decimals", async () => {
    const { reader: r } = reader({ balances: { [USDT.contractAddress as string]: 1_500_000n } });
    const result = await r.readBalances({
      chainId: CELO_CHAIN_ID,
      address: WALLET,
      assetIds: [USDT.id],
    });
    assert.deepEqual(result.tokens, [createMoney("1500000", USDT.id)]);
    assert.equal(result.address, WALLET.toLowerCase());
    // Decimals only matter for display, through the asset's own decimals.
    assert.equal(formatSmallestUnit(result.tokens[0]?.amount ?? "0", USDT.decimals), "1.500000");
  });

  it("respects each token's own decimals, including 18, with exact integers", async () => {
    const huge = 123_456_789_012_345_678_901n; // does not fit a double
    const { reader: r } = reader({ balances: { [WBRL.contractAddress as string]: huge } });
    const { tokens } = await r.readBalances({
      chainId: CELO_CHAIN_ID,
      address: WALLET,
      assetIds: [WBRL.id],
    });
    assert.equal(tokens[0]?.amount, "123456789012345678901");
    assert.equal(
      formatSmallestUnit(tokens[0]?.amount ?? "0", WBRL.decimals),
      "123.456789012345678901",
    );
  });

  it("reports a zero balance as Money zero, never as absent", async () => {
    const { reader: r } = reader();
    const { tokens } = await r.readBalances({
      chainId: CELO_CHAIN_ID,
      address: WALLET,
      assetIds: [USDT.id, USDC.id],
    });
    assert.deepEqual(tokens, [createMoney("0", USDT.id), createMoney("0", USDC.id)]);
  });

  it("reads several tokens in ONE batched call, in the requested order", async () => {
    const { reader: r, log } = reader({
      balances: {
        [USDT.contractAddress as string]: 7n,
        [USDC.contractAddress as string]: 8n,
        [WBRL.contractAddress as string]: 9n,
      },
    });
    const { tokens } = await r.readBalances({
      chainId: CELO_CHAIN_ID,
      address: WALLET,
      assetIds: [WBRL.id, USDT.id, USDC.id],
    });
    assert.deepEqual(
      tokens.map((m) => m.amount),
      ["9", "7", "8"],
    );
    assert.equal(log.balanceCalls, 1);
    assert.deepEqual(log.lastTokens, [
      WBRL.contractAddress,
      USDT.contractAddress,
      USDC.contractAddress,
    ]);
  });

  it("refuses a token whose on-chain decimals disagree with the registry (when verifying)", async () => {
    const { reader: r } = reader({
      decimals: { [USDT.contractAddress as string]: 18 },
      verifyDecimals: true,
    });
    await assert.rejects(
      r.readBalances({ chainId: CELO_CHAIN_ID, address: WALLET, assetIds: [USDT.id] }),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
    const ok = reader({ verifyDecimals: true });
    await ok.reader.readBalances({
      chainId: CELO_CHAIN_ID,
      address: WALLET,
      assetIds: [USDT.id, WBRL.id],
    });
    assert.equal(ok.log.decimalCalls, 1);
  });

  it("is Celo-only and rejects unknown, inactive or non-token assets, and a bad address", async () => {
    const { reader: r } = reader();
    await assert.rejects(
      r.readBalances({ chainId: 1, address: WALLET, assetIds: [USDT.id] }),
      (e) => isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
    await assert.rejects(
      r.readBalances({ chainId: CELO_CHAIN_ID, address: WALLET, assetIds: [randomUUID()] }),
      (e) => isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
    await assert.rejects(
      r.readBalances({ chainId: CELO_CHAIN_ID, address: "0x1234", assetIds: [USDT.id] }),
    );
    USDC.isActive = false;
    await assert.rejects(
      r.readBalances({ chainId: CELO_CHAIN_ID, address: WALLET, assetIds: [USDC.id] }),
      (e) => isKaadaError(e, "ASSET_NOT_SUPPORTED"),
    );
    USDC.isActive = true;
  });
});

describe("future boundaries", () => {
  it("the only signer refuses everything, and offers no arbitrary signing", async () => {
    const signer = new DisabledExecutionSigner();
    await assert.rejects(signer.signValidatedExecution(randomUUID()), (e) =>
      isKaadaError(e, "EXECUTION_NOT_ENABLED"),
    );
    assert.deepEqual(Object.getOwnPropertyNames(DisabledExecutionSigner.prototype).sort(), [
      "constructor",
      "signValidatedExecution",
    ]);
  });

  it("gives a future Textile firm quote its taker from the wallet, never from input", async () => {
    const { service } = setup();
    const route: PaymentRoute = {
      id: "r",
      intentId: "i",
      intentRevision: 2,
      status: "VALID",
      input: createMoney("1", USDT.id),
      output: createMoney("1", WBRL.id),
      steps: [],
      createdAt: NOW,
    };
    await assert.rejects(
      service.firmQuoteContext({ userId: USER, intentId: "i", intentRevision: 2, route }),
      (e) => isKaadaError(e, "WALLET_NOT_ACTIVE"),
      "no wallet, no taker",
    );
    const wallet = await service.ensureEmbeddedWallet(USER);
    const context = await service.firmQuoteContext({
      userId: USER,
      intentId: "i",
      intentRevision: 2,
      route,
    });
    assert.equal(context.takerAddress, wallet.address);
    assert.equal(context.intentRevision, 2);
    await service.suspend(wallet.id, "REVIEW");
    await assert.rejects(
      service.firmQuoteContext({ userId: USER, intentId: "i", intentRevision: 2, route }),
    );
  });

  it("audit trails hold identifiers and reason codes, never key material", async () => {
    const s = setup();
    s.world.assets.push(USDT);
    const wallet = await s.service.ensureEmbeddedWallet(USER);
    s.adapter.failNext = 0;
    await s.service.suspend(wallet.id, "OPERATOR_REVIEW");
    const text = JSON.stringify(s.world.audit).toLowerCase();
    const credential = s.world.credentials[0];
    for (const forbidden of [
      "privatekey",
      "mnemonic",
      "seed",
      "secret",
      "signature",
      credential?.publicKeyX ?? "",
      credential?.publicKeyY ?? "",
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
    assert.ok(s.world.audit.every((e) => e.userId === USER && e.entityId));
  });
});
