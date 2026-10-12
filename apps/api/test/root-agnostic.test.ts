import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import { buildPrimaryRoot, deviceKeyPayload, primaryRootDeploymentSalt } from "@kaada/contracts";
import type { ValidatorDeployments } from "@kaada/contracts";
import { PIN_ATTEMPT_POLICY, isKaadaError } from "@kaada/domain";
import type {
  RootCredential,
  RootValidatorDeployer,
  RootValidatorInstance,
  WalletCredential,
} from "@kaada/domain";
import type { Address, Hex } from "viem";

import { PinEnrollmentService } from "../src/core/authorization/pin-enrollment.js";
import { TransactionPinService } from "../src/core/authorization/pin-service.js";
import type { AuthorizationUnitOfWork } from "../src/core/authorization/ports.js";
import { DeviceKeyRootAdapter } from "../src/core/roots/adapters.js";
import { verifyP256 } from "../src/core/roots/p256.js";
import { RootCredentialService } from "../src/core/roots/root-credentials.js";
import { RootProofService } from "../src/core/roots/root-proof-service.js";
import { PasskeyService } from "../src/core/wallets/passkey-service.js";
import { WalletSetupService } from "../src/core/wallets/setup-service.js";
import { SimpleWebAuthnVerifier } from "../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { createAuthorizationStores } from "./support/authorization-memory.js";
import { TestPinHasher } from "./support/payment-world.js";
import { SoftDeviceKey } from "./support/soft-device-key.js";
import { createSoftwareAuthenticator } from "./support/software-authenticator.js";
import { createWalletService, createWalletWorld } from "./support/wallet-memory.js";

const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";
const CHAIN = 42220;
const PIN = "735142";
const NEW_PIN = "246813";
const ACCOUNT: Address = "0x2222222222222222222222222222222222222222";
const VALIDATOR: Address = "0x3333333333333333333333333333333333333333";

const deployments: ValidatorDeployments = {
  passkey: {
    factory: "0x1000000000000000000000000000000000000f01",
    implementation: "0x1000000000000000000000000000000000000a01",
  },
  device: {
    factory: "0x1000000000000000000000000000000000000f02",
    implementation: "0x1000000000000000000000000000000000000a02",
  },
};

const reject = (code: string) => (error: unknown) => isKaadaError(error, code as never);

describe("verifyP256 (the server's check of a device key signature)", () => {
  const key = new SoftDeviceKey();
  const message = Buffer.from("kaada test payload");
  const sig = key.sign(`0x${message.toString("hex")}`);

  it("accepts a low-s signature by the key over exactly the message", () => {
    assert.equal(verifyP256({ x: key.publicKeyX, y: key.publicKeyY, message, ...sig }), true);
  });

  it("refuses another message, another key, a high-s form and malformed input", () => {
    const base = { x: key.publicKeyX, y: key.publicKeyY, message, ...sig };
    assert.equal(verifyP256({ ...base, message: Buffer.from("other") }), false);
    const other = new SoftDeviceKey();
    assert.equal(verifyP256({ ...base, x: other.publicKeyX, y: other.publicKeyY }), false);
    const high = key.sign(`0x${message.toString("hex")}`, { highS: true });
    assert.equal(verifyP256({ ...base, ...high }), false, "the on-chain validator refuses high-s");
    assert.equal(verifyP256({ ...base, r: "00".repeat(32) }), false);
    assert.equal(verifyP256({ ...base, s: "00".repeat(32) }), false);
    assert.equal(verifyP256({ ...base, r: "zz" }), false);
    assert.equal(verifyP256({ ...base, x: "12" }), false);
  });
});

describe("DeviceKeyRootAdapter", () => {
  const adapter = new DeviceKeyRootAdapter();
  const key = new SoftDeviceKey();
  const root: Extract<RootCredential, { type: "DEVICE_KEY" }> = {
    type: "DEVICE_KEY",
    keyId: key.keyId,
    publicKeyX: key.publicKeyX,
    publicKeyY: key.publicKeyY,
    validatorAddress: VALIDATOR,
    purpose: 0,
    deploymentSalt: `0x${"00".repeat(32)}`,
  };
  const context = { account: ACCOUNT, chainId: CHAIN };
  const userOpHash = `0x${"ab".repeat(32)}`;

  it("tells the client to sign the documented KaadaDeviceKey/v1 payload, nothing else", () => {
    const challenge = adapter.prepareOperationChallenge(root, context, userOpHash);
    assert.equal(challenge.action, "ROOT_DEVICE_KEY_REQUIRED");
    assert.equal(challenge.type, "DEVICE_KEY");
    assert.equal(challenge.type === "DEVICE_KEY" && challenge.format, "KaadaDeviceKey/v1");
    const payload = challenge.type === "DEVICE_KEY" ? challenge.payload : "";
    assert.equal(
      payload,
      deviceKeyPayload({
        chainId: CHAIN,
        validator: VALIDATOR,
        account: ACCOUNT,
        keyId: key.keyId as Hex,
        userOpHash: userOpHash as Hex,
      }),
    );
    assert.equal((payload.length - 2) / 2, 153);
    assert.equal(Buffer.from(payload.slice(2, 36), "hex").toString(), "KaadaDeviceKey/v1");
  });

  it("accepts the key's signature over that payload, and only that", async () => {
    const challenge = adapter.prepareOperationChallenge(root, context, userOpHash);
    const payload = challenge.type === "DEVICE_KEY" ? challenge.payload : "";
    await adapter.verifyOperationProof(root, context, userOpHash, key.proof(payload));
    // A signature over another operation, another account, another chain or another validator is a different payload.
    for (const [label, other] of [
      ["operation", { ...context, userOpHash: `0x${"cd".repeat(32)}` }],
      ["account", { account: VALIDATOR, chainId: CHAIN, userOpHash }],
      ["chain", { account: ACCOUNT, chainId: 1, userOpHash }],
    ] as const) {
      const otherHash = "userOpHash" in other ? other.userOpHash : userOpHash;
      await assert.rejects(
        adapter.verifyOperationProof(
          root,
          { account: other.account, chainId: other.chainId },
          otherHash,
          key.proof(payload),
        ),
        reject("CREDENTIAL_REJECTED"),
        label,
      );
    }
    await assert.rejects(
      adapter.verifyOperationProof(
        { ...root, validatorAddress: ACCOUNT },
        context,
        userOpHash,
        key.proof(payload),
      ),
      reject("CREDENTIAL_REJECTED"),
      "another validator instance",
    );
  });

  it("rejects the wrong proof type, another key, a high-s signature and a revoked-looking key id", async () => {
    const payload = (() => {
      const c = adapter.prepareOperationChallenge(root, context, userOpHash);
      return c.type === "DEVICE_KEY" ? c.payload : "";
    })();
    await assert.rejects(
      adapter.verifyOperationProof(root, context, userOpHash, {
        type: "PASSKEY",
        assertion: { id: "x" },
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    const stranger = new SoftDeviceKey();
    await assert.rejects(
      adapter.verifyOperationProof(root, context, userOpHash, stranger.proof(payload)),
      reject("CREDENTIAL_REJECTED"),
    );
    await assert.rejects(
      adapter.verifyOperationProof(root, context, userOpHash, key.proof(payload, { highS: true })),
      reject("CREDENTIAL_REJECTED"),
    );
  });

  it("an off-chain proof can never be a UserOperation signature, nor a proof for another purpose", () => {
    const nonce = `0x${"12".repeat(32)}`;
    const proofPayload = adapter.proofPayload(root, context, "PIN_ENROLLMENT", nonce);
    const operationPayload = adapter.operationPayload(root, context, nonce);
    assert.notEqual(proofPayload, operationPayload);
    const proof = key.proof(proofPayload);
    assert.equal(adapter.verifyProof(root, context, "PIN_ENROLLMENT", nonce, proof), true);
    assert.equal(adapter.verifyProof(root, context, "ROOT_ENROLLMENT", nonce, proof), false);
    // The same signature does not pass as an operation signature.
    assert.equal(
      adapter.verifyProof(root, context, "PIN_ENROLLMENT", `0x${"13".repeat(32)}`, proof),
      false,
    );
  });
});

describe("RootCredentialService", () => {
  function credentialRow(over: Partial<WalletCredential>): WalletCredential {
    return {
      id: randomUUID(),
      userId: "u",
      walletId: "w",
      kind: "DEVICE_KEY",
      role: "PRIMARY",
      status: "ACTIVE",
      isRoot: true,
      validatorAddress: VALIDATOR,
      validatorPurpose: 0,
      deploymentSalt: `0x${"00".repeat(32)}`,
      credentialRef: `0x${"ab".repeat(32)}`,
      publicKeyX: "11".repeat(32),
      publicKeyY: "22".repeat(32),
      securityTier: "WEB_NON_EXTRACTABLE",
      createdAt: new Date(),
      ...over,
    };
  }
  const wallet = { id: "w", userId: "u" } as never;

  it("returns the recorded root as the right type", async () => {
    const service = new RootCredentialService({
      repositories: {
        walletCredentials: { findRoot: () => Promise.resolve(credentialRow({})) },
        passkeys: { listActiveForUser: () => Promise.resolve([]) },
      },
      rpId: RP_ID,
    });
    const root = await service.activeRoot(wallet);
    assert.equal(root.type, "DEVICE_KEY");
    assert.equal(root.type === "DEVICE_KEY" && root.validatorAddress, VALIDATOR);
  });

  it("maps a passkey row, and falls back to the oldest passkey for a wallet with no recorded root", async () => {
    const recorded = new RootCredentialService({
      repositories: {
        walletCredentials: {
          findRoot: () =>
            Promise.resolve(
              credentialRow({ kind: "PASSKEY", credentialRef: "AQID", rpId: "rp.example" }),
            ),
        },
        passkeys: { listActiveForUser: () => Promise.resolve([]) },
      },
      rpId: RP_ID,
    });
    const passkeyRoot = await recorded.activeRoot(wallet);
    assert.equal(passkeyRoot.type, "PASSKEY");
    assert.equal(passkeyRoot.type === "PASSKEY" && passkeyRoot.rpId, "rp.example");

    const legacy = new RootCredentialService({
      repositories: {
        walletCredentials: { findRoot: () => Promise.resolve(null) },
        passkeys: {
          listActiveForUser: () =>
            Promise.resolve([
              {
                id: "p",
                userId: "u",
                credentialId: "legacy",
                publicKeyX: "aa".repeat(32),
                publicKeyY: "bb".repeat(32),
                rpId: RP_ID,
                signCount: 0,
                createdAt: new Date(),
              },
            ]),
        },
      },
      rpId: RP_ID,
    });
    const fallback = await legacy.activeRoot(wallet);
    assert.equal(fallback.type, "PASSKEY");
    assert.equal(fallback.type === "PASSKEY" && fallback.validatorAddress, undefined);
  });

  it("a wallet with no root at all is ROOT_CREDENTIAL_REQUIRED (a revoked or replaced root is not a root)", async () => {
    const service = new RootCredentialService({
      repositories: {
        walletCredentials: { findRoot: () => Promise.resolve(null) },
        passkeys: { listActiveForUser: () => Promise.resolve([]) },
      },
      rpId: RP_ID,
    });
    await assert.rejects(service.activeRoot(wallet), reject("ROOT_CREDENTIAL_REQUIRED"));
  });
});

// ───────────────────────────── device-key onboarding ─────────────────────────────

function buildSetup(options: { deviceKeys?: boolean } = { deviceKeys: true }) {
  const deployed: RootValidatorInstance[] = [];
  const faults = { deployFails: 0 };
  const validators: RootValidatorDeployer = {
    ensureDeployed: (instance) => {
      if (faults.deployFails > 0) {
        faults.deployFails -= 1;
        return Promise.reject(new Error("relayer has no gas"));
      }
      deployed.push(instance);
      return Promise.resolve({ created: true });
    },
  };
  const world = createWalletWorld();
  const clock = { now: new Date("2026-10-10T12:00:00.000Z") };
  const now = () => clock.now;
  const { service: wallets, adapter } = createWalletService(world, { now });
  const passkeys = new PasskeyService({
    unitOfWork: world.unitOfWork,
    verifier: new SimpleWebAuthnVerifier(),
    rpId: RP_ID,
    origin: ORIGIN,
    now,
  });
  const users = new Set<string>();
  const setup = new WalletSetupService({
    unitOfWork: world.unitOfWork,
    users: {
      findById: (id) =>
        Promise.resolve(
          users.has(id)
            ? { id, createdAt: clock.now, updatedAt: clock.now, status: "ACTIVE" as const }
            : null,
        ),
    },
    passkeys,
    wallets,
    origin: ORIGIN,
    rpId: RP_ID,
    rpName: "Kaada",
    ...(options.deviceKeys && { deviceKeys: { deployments, onChainId: CHAIN, validators } }),
    now,
  });
  return {
    world,
    clock,
    setup,
    wallets,
    adapter,
    passkeys,
    deployed,
    faults,
    newUser() {
      const id = randomUUID();
      users.add(id);
      return id;
    },
  };
}

/** Enrols a device key through the real two-step flow, as the browser would. */
async function enrol(
  s: ReturnType<typeof buildSetup>,
  userId = s.newUser(),
  key = new SoftDeviceKey(),
) {
  const session = await s.setup.createSession(userId);
  const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
    publicKeyX: key.publicKeyX,
    publicKeyY: key.publicKeyY,
  });
  const { r, s: sValue } = key.sign(challenge.payload);
  const view = await s.setup.completeDeviceKeyRegistration(session.token, {
    publicKeyX: key.publicKeyX,
    publicKeyY: key.publicKeyY,
    challenge: challenge.challenge,
    r,
    s: sValue,
  });
  return { userId, session, key, challenge, view };
}

describe("device-key onboarding", () => {
  it("creates a wallet whose root is a FRESH clone holding the device key, and records it as the PRIMARY root", async () => {
    const s = buildSetup();
    const { userId, key, view } = await enrol(s);
    assert.equal(view.status, "COMPLETED");
    assert.equal(view.rootType, "DEVICE_KEY");
    assert.equal(view.passkeyRegistered, false);
    assert.equal(view.wallet?.status, "ACTIVE");

    const wallet = await s.wallets.getWallet(userId);
    assert.ok(wallet?.address);
    const row = await s.world.unitOfWork.read.walletCredentials.findRoot(wallet.id);
    assert.ok(row);
    assert.equal(row.kind, "DEVICE_KEY");
    assert.equal(row.role, "PRIMARY");
    assert.equal(row.status, "ACTIVE");
    assert.equal(row.isRoot, true);
    assert.equal(row.credentialRef, key.keyId, "the key id is derived by the server from the key");
    assert.equal(row.validatorPurpose, 0);
    const expected = buildPrimaryRoot({
      deployments,
      credential: {
        kind: "DEVICE_KEY",
        keyId: key.keyId as Hex,
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
      },
      deploymentSalt: primaryRootDeploymentSalt(userId),
    });
    assert.equal(row.validatorAddress, expected.instance.toLowerCase());
    assert.equal(row.deploymentSalt, expected.deploymentSalt);
    // Public data only: nothing like a private key is in what was stored.
    assert.equal(/private|secret|seed/i.test(JSON.stringify(row)), false);
  });

  it("never lets a client claim a trusted tier: a web enrolment is WEB_NON_EXTRACTABLE", async () => {
    const s = buildSetup();
    const { userId } = await enrol(s);
    const wallet = await s.wallets.getWallet(userId);
    const row = await s.world.unitOfWork.read.walletCredentials.findRoot(wallet?.id ?? "");
    assert.equal(row?.securityTier, "WEB_NON_EXTRACTABLE");
    assert.notEqual(row?.securityTier, "TRUSTED_DEVICE");
  });

  it("the same key for another person gets another validator instance (an instance is never shared)", async () => {
    const s = buildSetup();
    const key = new SoftDeviceKey();
    const a = await enrol(s, undefined, key);
    const b = await enrol(s, undefined, key);
    const rows = await Promise.all(
      [a.userId, b.userId].map(async (userId) => {
        const wallet = await s.wallets.getWallet(userId);
        return s.world.unitOfWork.read.walletCredentials.findRoot(wallet?.id ?? "");
      }),
    );
    assert.notEqual(rows[0]?.validatorAddress, rows[1]?.validatorAddress);
  });

  it("a clone that could not be deployed leaves the wallet PROVISIONING with its root recorded, and finalize completes it", async () => {
    const s = buildSetup();
    s.faults.deployFails = 1;
    const userId = s.newUser();
    const key = new SoftDeviceKey();
    const session = await s.setup.createSession(userId);
    const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    await assert.rejects(
      s.setup.completeDeviceKeyRegistration(session.token, {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        ...key.sign(challenge.payload),
      }),
      /relayer has no gas/,
    );
    const stuck = await s.wallets.getWallet(userId);
    assert.equal(
      stuck?.status,
      "PROVISIONING",
      "no address was derived for a clone that does not exist",
    );
    assert.equal(stuck?.address, undefined);
    assert.ok(await s.world.unitOfWork.read.walletCredentials.findRoot(stuck?.id ?? ""));
    // The same setup link finishes it (the key is not asked for again).
    const view = await s.setup.finalize(session.token);
    assert.equal(view.wallet?.status, "ACTIVE");
    assert.equal(view.rootType, "DEVICE_KEY");
    assert.equal(s.deployed.length, 1);
  });

  it("is refused when device keys are not enabled", async () => {
    const s = buildSetup({});
    const userId = s.newUser();
    const session = await s.setup.createSession(userId);
    assert.equal(s.setup.deviceKeysEnabled, false);
    const key = new SoftDeviceKey();
    await assert.rejects(
      s.setup.beginDeviceKeyRegistration(session.token, {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
      }),
      reject("WALLET_PROVISIONING_FAILED"),
    );
  });

  it("refuses a malformed key, a point that is not on the curve, a wrong signature and a replayed challenge", async () => {
    const s = buildSetup();
    const userId = s.newUser();
    const session = await s.setup.createSession(userId);
    const key = new SoftDeviceKey();
    await assert.rejects(
      s.setup.beginDeviceKeyRegistration(session.token, { publicKeyX: "12", publicKeyY: "34" }),
      reject("CREDENTIAL_REJECTED"),
    );
    await assert.rejects(
      s.setup.beginDeviceKeyRegistration(session.token, {
        publicKeyX: "01".repeat(32),
        publicKeyY: "02".repeat(32),
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    // A signature by ANOTHER key does not prove possession of this one (and it spends the challenge).
    const stranger = new SoftDeviceKey().sign(challenge.payload);
    await assert.rejects(
      s.setup.completeDeviceKeyRegistration(session.token, {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        ...stranger,
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    const good = key.sign(challenge.payload);
    await assert.rejects(
      s.setup.completeDeviceKeyRegistration(session.token, {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        ...good,
      }),
      reject("CREDENTIAL_REJECTED"),
      "a challenge is single-use",
    );
    assert.equal(await s.wallets.getWallet(userId), null, "nothing was created");
  });

  it("a signature over the challenge for ANOTHER public key is refused (the proof is bound to the key)", async () => {
    const s = buildSetup();
    const userId = s.newUser();
    const session = await s.setup.createSession(userId);
    const key = new SoftDeviceKey();
    const other = new SoftDeviceKey();
    const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    await assert.rejects(
      s.setup.completeDeviceKeyRegistration(session.token, {
        publicKeyX: other.publicKeyX,
        publicKeyY: other.publicKeyY,
        challenge: challenge.challenge,
        ...key.sign(challenge.payload),
      }),
      reject("CREDENTIAL_REJECTED"),
    );
  });

  it("a user who already has a wallet root cannot enrol another through the setup link", async () => {
    const s = buildSetup();
    const { userId } = await enrol(s);
    const again = await s.setup.createSession(userId, { existingWallet: true });
    const key = new SoftDeviceKey();
    await assert.rejects(
      s.setup.beginDeviceKeyRegistration(again.token, {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
      }),
      reject("WALLET_ALREADY_SETUP"),
    );
  });

  it("leaves the passkey path unchanged: a passkey wallet still registers and reports a PASSKEY root", async () => {
    const s = buildSetup();
    const userId = s.newUser();
    const session = await s.setup.createSession(userId);
    const options = await s.setup.beginRegistration(session.token);
    const authenticator = createSoftwareAuthenticator();
    const view = await s.setup.completeRegistration(
      session.token,
      authenticator.register({ challenge: options.challenge, origin: ORIGIN, rpId: RP_ID }),
    );
    assert.equal(view.rootType, "PASSKEY");
    assert.equal(view.passkeyRegistered, true);
    assert.equal(view.wallet?.status, "ACTIVE");
  });

  it("derives the account from the DEVICE root (the provisioning adapter receives a device-key credential)", async () => {
    const s = buildSetup();
    const seen: RootCredential[] = [];
    const clonesWhenDerived: number[] = [];
    const original = s.adapter.deriveAccount.bind(s.adapter);
    s.adapter.deriveAccount = (input) => {
      seen.push(input.root);
      clonesWhenDerived.push(s.deployed.length);
      return original(input);
    };
    const { key } = await enrol(s);
    assert.equal(seen.length, 1);
    assert.deepEqual(
      clonesWhenDerived,
      [1],
      "the fresh clone was deployed BEFORE the account was derived (the derivation installs it)",
    );
    assert.equal(s.deployed[0]?.account, null, "a creation-time root is scoped to no account");
    assert.equal(s.deployed[0]?.purpose, 0);
    assert.equal(seen[0]?.type, "DEVICE_KEY");
    assert.equal(seen[0]?.type === "DEVICE_KEY" && seen[0].keyId, key.keyId);
  });
});

// ───────────────────────── the PIN, vouched for by either root ─────────────────────────

describe("PIN enrolment by a device-key root", () => {
  async function ready() {
    const s = buildSetup();
    const { userId, key } = await enrol(s);
    const clock = s.clock;
    const stores = createAuthorizationStores(() => clock.now);
    const uow = {
      read: stores.repositories,
      transaction: (work: (r: typeof stores.repositories) => Promise<unknown>) =>
        work(stores.repositories),
    } as unknown as AuthorizationUnitOfWork;
    const pins = new TransactionPinService({
      unitOfWork: uow,
      hasher: new TestPinHasher(),
      now: () => clock.now,
    });
    const device = new DeviceKeyRootAdapter();
    const roots = new RootCredentialService({
      repositories: s.world.unitOfWork.read,
      rpId: RP_ID,
    });
    const proofs = new RootProofService({
      roots,
      passkeys: s.passkeys,
      challenges: s.world.unitOfWork.read.passkeys,
      device,
      wallets: s.wallets,
      onChainId: CHAIN,
      now: () => clock.now,
    });
    const enrollment = new PinEnrollmentService({ proofs, pins, wallets: s.wallets });
    const prove = async (purposeOverride?: boolean) => {
      const challenge = await enrollment.begin(userId);
      assert.equal(challenge.action, "ROOT_DEVICE_KEY_REQUIRED");
      assert.equal(challenge.type, "DEVICE_KEY");
      if (challenge.type !== "DEVICE_KEY") throw new Error("not a device challenge");
      assert.equal(challenge.format, "KaadaRootProof/v1");
      return {
        challenge,
        proof: key.proof(challenge.payload, {
          ...(challenge.challenge && { challenge: challenge.challenge }),
          ...(purposeOverride && {}),
        }),
      };
    };
    return { s, userId, key, pins, enrollment, prove };
  }

  it("creates and then changes the PIN with a fresh device proof, six digits only", async () => {
    const { userId, pins, enrollment, prove } = await ready();
    assert.equal(
      await enrollment.complete(userId, { pin: PIN, proof: (await prove()).proof }),
      "CREATED",
    );
    assert.equal((await pins.verify(userId, PIN)).status, "VERIFIED");
    assert.equal(
      await enrollment.complete(userId, { pin: NEW_PIN, proof: (await prove()).proof }),
      "CHANGED",
    );
    assert.equal((await pins.verify(userId, NEW_PIN)).status, "VERIFIED");
    assert.equal((await pins.verify(userId, PIN)).status, "INVALID");
  });

  it("refuses 4, 5 and 7 digits and non-digits, without spending the challenge", async () => {
    const { userId, enrollment, prove } = await ready();
    const { proof } = await prove();
    for (const bad of ["1234", "12345", "1234567", "12345a", "", " 12345"]) {
      await assert.rejects(
        enrollment.complete(userId, { pin: bad, proof }),
        reject("PIN_REJECTED"),
      );
    }
    // The challenge survived every malformed PIN: the same proof still works once.
    assert.equal(await enrollment.complete(userId, { pin: PIN, proof }), "CREATED");
  });

  it("refuses a replayed proof, a missing challenge, another key's proof and a passkey proof", async () => {
    const { userId, enrollment, prove } = await ready();
    const { challenge, proof } = await prove();
    await enrollment.complete(userId, { pin: PIN, proof });
    await assert.rejects(
      enrollment.complete(userId, { pin: NEW_PIN, proof }),
      reject("CREDENTIAL_REJECTED"),
      "single use",
    );
    const fresh = await prove();
    if (fresh.proof.type !== "DEVICE_KEY") throw new Error("expected a device proof");
    const { challenge: _dropped, ...withoutChallenge } = fresh.proof;
    await assert.rejects(
      enrollment.complete(userId, { pin: NEW_PIN, proof: withoutChallenge }),
      reject("CREDENTIAL_REJECTED"),
      "a device proof must name its challenge",
    );
    const third = await prove();
    const stranger = new SoftDeviceKey();
    await assert.rejects(
      enrollment.complete(userId, {
        pin: NEW_PIN,
        proof: stranger.proof(third.challenge.payload, {
          ...(third.challenge.challenge && { challenge: third.challenge.challenge }),
        }),
      }),
      reject("CREDENTIAL_REJECTED"),
    );
    await assert.rejects(
      enrollment.complete(userId, {
        pin: NEW_PIN,
        proof: { type: "PASSKEY", assertion: { id: "x" } },
      }),
      reject("CREDENTIAL_REJECTED"),
      "this wallet's root is a device key",
    );
    assert.ok(challenge);
  });

  it("a proof made for the PIN cannot be used for another purpose (the purpose is part of what is signed)", async () => {
    const { s, userId, key } = await ready();
    const wallet = await s.wallets.getWallet(userId);
    const root = await new RootCredentialService({
      repositories: s.world.unitOfWork.read,
      rpId: RP_ID,
    }).activeRoot(wallet as never);
    if (root.type !== "DEVICE_KEY") throw new Error("expected a device root");
    const adapter = new DeviceKeyRootAdapter();
    const nonce = `0x${"77".repeat(32)}`;
    const context = { account: wallet?.address ?? "", chainId: CHAIN };
    const forPin = key.proof(adapter.proofPayload(root, context, "PIN_ENROLLMENT", nonce));
    assert.equal(adapter.verifyProof(root, context, "ROOT_ENROLLMENT", nonce, forPin), false);
  });

  it("still locks the PIN after three wrong guesses, whatever the root", async () => {
    const { userId, pins, enrollment, prove } = await ready();
    await enrollment.complete(userId, { pin: PIN, proof: (await prove()).proof });
    for (let i = 0; i < PIN_ATTEMPT_POLICY.maxAttempts; i += 1) {
      assert.equal((await pins.verify(userId, NEW_PIN)).status, i < 2 ? "INVALID" : "INVALID");
    }
    assert.equal((await pins.verify(userId, PIN)).status, "LOCKED");
  });
});
