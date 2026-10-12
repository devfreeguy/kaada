import "reflect-metadata";

import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { before, describe, it } from "node:test";

import { BadRequestException } from "@nestjs/common";
import {
  TEST_APP,
  createAppAttestObject,
  createAttestationChain,
  createTestAuthority,
} from "@kaada/attestation/testing";
import type { FixtureOptions, TestAuthority } from "@kaada/attestation/testing";
import type { RootValidatorDeployer } from "@kaada/domain";

import { DeviceTierService } from "../src/core/attestation/device-tier-service.js";
import type { AttestationEvidence } from "../src/core/attestation/device-tier-service.js";
import { PasskeyService } from "../src/core/wallets/passkey-service.js";
import { WalletSetupService } from "../src/core/wallets/setup-service.js";
import { SimpleWebAuthnVerifier } from "../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { WalletController } from "../src/wallet/wallet.controller.js";
import { createMemoryDeviceAttestations } from "./support/attestation-memory.js";
import { SoftDeviceKey } from "./support/soft-device-key.js";
import { createWalletService, createWalletWorld } from "./support/wallet-memory.js";

const RP_ID = "kaada.test";
const ORIGIN = "https://app.kaada.test";
const CHAIN = 42220;
const T0 = new Date("2026-10-12T12:00:00.000Z");
const APP_ID = "ABCDE12345.app.kaada.wallet";
const deployments = {
  passkey: {
    factory: "0x1000000000000000000000000000000000000f01",
    implementation: "0x1000000000000000000000000000000000000a01",
  },
  device: {
    factory: "0x1000000000000000000000000000000000000f02",
    implementation: "0x1000000000000000000000000000000000000a02",
  },
} as const;

/** A CryptoKey for the public half of a software device key, as the Android keystore would certify it. */
const publicCryptoKey = (key: SoftDeviceKey) =>
  webcrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(key.publicKeyX, "hex").toString("base64url"),
      y: Buffer.from(key.publicKeyY, "hex").toString("base64url"),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );

describe("device attestation through the enrolment paths", () => {
  let authority: TestAuthority;
  before(async () => {
    authority = await createTestAuthority(T0);
  });

  function build() {
    const world = createWalletWorld();
    const now = () => T0;
    const { service: wallets } = createWalletService(world, { now });
    const attestations = createMemoryDeviceAttestations();
    const deviceTiers = new DeviceTierService({
      attestations,
      android: {
        applications: [
          { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
        ],
        minimumLevel: "TEE",
        anchors: [authority.anchor],
      },
      ios: { appIds: [APP_ID], allowDevelopment: false, anchor: authority.anchor },
      now,
    });
    const validators: RootValidatorDeployer = {
      ensureDeployed: () => Promise.resolve({ created: true }),
    };
    const users = new Set<string>();
    const setup = new WalletSetupService({
      unitOfWork: world.unitOfWork,
      users: {
        findById: (id) =>
          Promise.resolve(
            users.has(id) ? { id, createdAt: T0, updatedAt: T0, status: "ACTIVE" as const } : null,
          ),
      },
      passkeys: new PasskeyService({
        unitOfWork: world.unitOfWork,
        verifier: new SimpleWebAuthnVerifier(),
        rpId: RP_ID,
        origin: ORIGIN,
        now,
      }),
      wallets,
      origin: ORIGIN,
      rpId: RP_ID,
      rpName: "Kaada",
      deviceKeys: { deployments, onChainId: CHAIN, validators, deviceTiers },
      now,
    });
    return {
      world,
      wallets,
      setup,
      attestations,
      newUser() {
        const id = randomUUID();
        users.add(id);
        return id;
      },
    };
  }

  /** The native flow end to end: nonce → key attested to it → proof of possession → register. */
  async function enrolNative(
    s: ReturnType<typeof build>,
    options: {
      android?: Partial<FixtureOptions>;
      ios?: boolean;
      evidence?: (e: AttestationEvidence | undefined) => AttestationEvidence | undefined;
      withEvidence?: boolean;
    } = {},
  ) {
    const userId = s.newUser();
    const key = new SoftDeviceKey();
    const session = await s.setup.createSession(userId);
    const platform = options.ios ? "IOS" : "ANDROID";
    const issued = await s.setup.issueAttestationChallenge(session.token, platform);
    const nonce = new Uint8Array(Buffer.from(issued.nonce, "hex"));
    let evidence: AttestationEvidence | undefined;
    if (options.withEvidence !== false) {
      evidence = options.ios
        ? {
            platform: "IOS",
            challengeId: issued.challengeId,
            ...(await createAppAttestObject(
              authority,
              {
                appId: APP_ID,
                challenge: nonce,
                point: { x: key.publicKeyX, y: key.publicKeyY },
              },
              T0,
            )),
          }
        : {
            platform: "ANDROID",
            challengeId: issued.challengeId,
            certificateChain: await createAttestationChain(
              authority,
              await publicCryptoKey(key),
              { challenge: nonce, ...options.android },
              T0,
            ),
          };
    }
    const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    const { r, s: sValue } = key.sign(challenge.payload);
    const view = await s.setup.completeDeviceKeyRegistration(
      session.token,
      {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        r,
        s: sValue,
        attestation: options.evidence ? options.evidence(evidence) : evidence,
      },
      "native",
    );
    const wallet = await s.wallets.getWallet(userId);
    const root = await s.world.unitOfWork.read.walletCredentials.findRoot(wallet?.id ?? "");
    return { view, root, key, userId };
  }

  it("records TRUSTED_DEVICE for a verified hardware-backed Android key", async () => {
    const s = build();
    const { view, root } = await enrolNative(s, { android: { level: "STRONGBOX" } });
    assert.equal(view.status, "COMPLETED");
    assert.equal(root?.securityTier, "TRUSTED_DEVICE");
    assert.equal([...s.attestations.attestations.values()][0]?.hardwareLevel, "STRONGBOX");
  });

  it("records APP_ATTESTED_DEVICE for a verified iOS app instance, never TRUSTED_DEVICE", async () => {
    const s = build();
    const { root } = await enrolNative(s, { ios: true });
    assert.equal(root?.securityTier, "APP_ATTESTED_DEVICE");
  });

  it("does not block enrolment when the evidence is missing, software-only or wrong", async () => {
    const none = await enrolNative(build(), { withEvidence: false });
    assert.equal(none.view.status, "COMPLETED");
    assert.equal(none.root?.securityTier, "UNKNOWN");

    const soft = await enrolNative(build(), { android: { level: "SOFTWARE" } });
    assert.equal(soft.view.status, "COMPLETED");
    assert.equal(soft.root?.securityTier, "UNKNOWN");

    const wrongChallenge = await enrolNative(build(), {
      android: { challenge: new Uint8Array(32).fill(3) },
    });
    assert.equal(wrongChallenge.view.status, "COMPLETED");
    assert.equal(wrongChallenge.root?.securityTier, "UNKNOWN");
  });

  it("never upgrades from a client claim: evidence cannot be swapped for another key's", async () => {
    const s = build();
    const other = new SoftDeviceKey();
    const result = await enrolNative(s, {
      evidence: (e) =>
        e?.platform === "ANDROID"
          ? e // chain is for this key; swap below via a second key's chain
          : e,
    });
    assert.equal(result.root?.securityTier, "TRUSTED_DEVICE");
    // A chain made for ANOTHER key, presented for this one, buys nothing.
    const s2 = build();
    const stolen = await createAttestationChain(
      authority,
      await publicCryptoKey(other),
      { challenge: new Uint8Array(32).fill(5) },
      T0,
    );
    const swapped = await enrolNative(s2, {
      evidence: (e) => (e?.platform === "ANDROID" ? { ...e, certificateChain: stolen } : e),
    });
    assert.equal(swapped.root?.securityTier, "UNKNOWN");
  });

  it("refuses evidence on the web route and keeps a plain web enrolment WEB_NON_EXTRACTABLE", async () => {
    const s = build();
    const userId = s.newUser();
    const key = new SoftDeviceKey();
    const session = await s.setup.createSession(userId);
    const issued = await s.setup.issueAttestationChallenge(session.token, "ANDROID");
    const challenge = await s.setup.beginDeviceKeyRegistration(session.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    const { r, s: sValue } = key.sign(challenge.payload);
    const body = {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
      challenge: challenge.challenge,
      r,
      s: sValue,
    };
    const evidence: AttestationEvidence = {
      platform: "ANDROID",
      challengeId: issued.challengeId,
      certificateChain: await createAttestationChain(
        authority,
        await publicCryptoKey(key),
        { challenge: new Uint8Array(Buffer.from(issued.nonce, "hex")), level: "STRONGBOX" },
        T0,
      ),
    };
    await assert.rejects(
      s.setup.completeDeviceKeyRegistration(session.token, { ...body, attestation: evidence }),
      /web route/,
    );
    const done = await s.setup.completeDeviceKeyRegistration(session.token, body);
    assert.equal(done.status, "COMPLETED");
    const wallet = await s.wallets.getWallet(userId);
    const root = await s.world.unitOfWork.read.walletCredentials.findRoot(wallet?.id ?? "");
    assert.equal(root?.securityTier, "WEB_NON_EXTRACTABLE");
  });

  it("the web HTTP route refuses a body with an attestation or a tier, before any service runs", async () => {
    const calls: string[] = [];
    const setup = {
      deviceKeysEnabled: true,
      completeDeviceKeyRegistration: (...args: unknown[]) => {
        calls.push(JSON.stringify(args));
        return Promise.resolve({ status: "COMPLETED", rootType: "DEVICE_KEY", wallet: null });
      },
    };
    const controller = new WalletController(setup as never, null, {} as never, {} as never);
    const hex = (n: number) => "ab".repeat(n);
    const body = {
      publicKeyX: hex(32),
      publicKeyY: hex(32),
      challenge: `0x${hex(32)}`,
      r: hex(32),
      s: hex(32),
    };
    const auth = "Bearer abc_DEF-123";
    for (const extra of [
      { attestation: { platform: "ANDROID" } },
      { securityTier: "TRUSTED_DEVICE" },
      { tier: "TRUSTED_DEVICE" },
      { hardwareBacked: true },
    ]) {
      await assert.rejects(
        controller.deviceKeyRegister({ ...body, ...extra }, auth),
        BadRequestException,
      );
    }
    assert.deepEqual(calls, []);
    // The native route accepts only well-formed evidence, and nothing like a tier.
    await assert.rejects(
      controller.nativeDeviceKeyRegister({ ...body, tier: "TRUSTED_DEVICE" }, auth),
      BadRequestException,
    );
    await assert.rejects(
      controller.nativeDeviceKeyRegister(
        { ...body, attestation: { platform: "ANDROID", challengeId: "x", certificateChain: [] } },
        auth,
      ),
      BadRequestException,
    );
    assert.deepEqual(calls, []);
  });

  it("a challenge is bound to the person it was issued to", async () => {
    const s = build();
    const alice = s.newUser();
    const bob = s.newUser();
    const aliceSession = await s.setup.createSession(alice);
    const bobSession = await s.setup.createSession(bob);
    const issued = await s.setup.issueAttestationChallenge(aliceSession.token, "ANDROID");
    const key = new SoftDeviceKey();
    const evidence: AttestationEvidence = {
      platform: "ANDROID",
      challengeId: issued.challengeId,
      certificateChain: await createAttestationChain(
        authority,
        await publicCryptoKey(key),
        { challenge: new Uint8Array(Buffer.from(issued.nonce, "hex")) },
        T0,
      ),
    };
    const challenge = await s.setup.beginDeviceKeyRegistration(bobSession.token, {
      publicKeyX: key.publicKeyX,
      publicKeyY: key.publicKeyY,
    });
    const { r, s: sValue } = key.sign(challenge.payload);
    await s.setup.completeDeviceKeyRegistration(
      bobSession.token,
      {
        publicKeyX: key.publicKeyX,
        publicKeyY: key.publicKeyY,
        challenge: challenge.challenge,
        r,
        s: sValue,
        attestation: evidence,
      },
      "native",
    );
    const wallet = await s.wallets.getWallet(bob);
    const root = await s.world.unitOfWork.read.walletCredentials.findRoot(wallet?.id ?? "");
    assert.equal(root?.securityTier, "UNKNOWN", "Alice's challenge buys Bob nothing");
  });

  it("refuses to issue a challenge when attestation is not configured", async () => {
    const s = build();
    const bare = new WalletSetupService({
      unitOfWork: s.world.unitOfWork,
      users: {
        findById: () =>
          Promise.resolve({ id: "u", createdAt: T0, updatedAt: T0, status: "ACTIVE" as const }),
      },
      passkeys: {} as never,
      wallets: s.wallets,
      origin: ORIGIN,
      rpId: RP_ID,
      rpName: "Kaada",
      deviceKeys: {
        deployments,
        onChainId: CHAIN,
        validators: { ensureDeployed: () => Promise.resolve({ created: true }) },
      },
      now: () => T0,
    });
    const session = await bare.createSession(randomUUID());
    await assert.rejects(bare.issueAttestationChallenge(session.token, "ANDROID"), /not enabled/);
  });
});
