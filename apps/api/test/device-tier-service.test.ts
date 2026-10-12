import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import {
  TEST_APP,
  createAppAttestObject,
  createAttestationChain,
  createDeviceKey,
  createTestAuthority,
} from "@kaada/attestation/testing";
import type { FixtureOptions, TestAuthority } from "@kaada/attestation/testing";
import { canChangeTier, deriveDeviceTier } from "@kaada/domain";
import type { AttestationOutcome, DeviceAttestation } from "@kaada/domain";

import { DeviceTierService } from "../src/core/attestation/device-tier-service.js";
import type {
  AttestationEvidence,
  DeviceTierServiceDeps,
} from "../src/core/attestation/device-tier-service.js";
import { createMemoryDeviceAttestations } from "./support/attestation-memory.js";

const T0 = new Date("2026-10-12T12:00:00Z");
const USER = "00000000-0000-4000-8000-000000000001";
const OTHER_USER = "00000000-0000-4000-8000-000000000002";
const WALLET = "00000000-0000-4000-8000-0000000000aa";
const APP_ID = "ABCDE12345.app.kaada.wallet";

describe("device tier service", () => {
  let authority: TestAuthority;
  let clock = T0;

  before(async () => {
    authority = await createTestAuthority(T0);
  });

  const setup = (overrides: Partial<DeviceTierServiceDeps> & { withoutIos?: boolean } = {}) => {
    clock = T0;
    const attestations = createMemoryDeviceAttestations();
    const { withoutIos, ...rest } = overrides;
    const service = new DeviceTierService({
      attestations,
      android: {
        applications: [
          { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
        ],
        minimumLevel: "TEE",
        anchors: [authority.anchor],
      },
      ...(!withoutIos && {
        ios: { appIds: [APP_ID], allowDevelopment: false, anchor: authority.anchor },
      }),
      now: () => clock,
      ...rest,
    });
    return { service, attestations };
  };

  /** The device side of the Android flow: ask for a nonce, generate a key attested to it, return the evidence. */
  async function androidEvidence(
    service: DeviceTierService,
    options: Partial<FixtureOptions> = {},
    issue: { userId?: string; walletId?: string } = {},
  ) {
    const device = await createDeviceKey();
    const challenge = await service.issueChallenge({
      userId: issue.userId ?? USER,
      ...(issue.walletId && { walletId: issue.walletId }),
      platform: "ANDROID",
      purpose: "ROOT_ENROLLMENT",
    });
    const chain = await createAttestationChain(
      authority,
      device.key.publicKey,
      { challenge: new Uint8Array(Buffer.from(challenge.nonce, "hex")), ...options },
      T0,
    );
    const evidence: AttestationEvidence = {
      platform: "ANDROID",
      challengeId: challenge.challengeId,
      certificateChain: chain,
    };
    return { device, challenge, evidence };
  }

  const resolve = (
    service: DeviceTierService,
    point: { x: string; y: string },
    evidence?: AttestationEvidence,
    extra: { userId?: string; walletId?: string; route?: "web" | "native" } = {},
  ) =>
    service.resolveTier({
      route: extra.route ?? "native",
      userId: extra.userId ?? USER,
      ...(extra.walletId && { walletId: extra.walletId }),
      purpose: "ROOT_ENROLLMENT",
      point,
      evidence,
    });

  describe("android", () => {
    it("derives TRUSTED_DEVICE from a verified StrongBox key and stores hashes, not the chain", async () => {
      const { service, attestations } = setup();
      const { device, evidence } = await androidEvidence(service, { level: "STRONGBOX" });
      const result = await resolve(service, device.point, evidence);
      assert.equal(result.tier, "TRUSTED_DEVICE");
      assert.equal(result.outcome, "VERIFIED");
      const [row] = [...attestations.attestations.values()];
      assert.equal(row?.result, "VERIFIED_QUALIFIED");
      assert.equal(row?.hardwareLevel, "STRONGBOX");
      assert.equal(row?.derivedTier, "TRUSTED_DEVICE");
      assert.equal(row?.verifierVersion, 1);
      assert.equal(row?.chainHashes.length, 3);
      const stored = JSON.stringify(row);
      for (const certificate of evidence.platform === "ANDROID" ? evidence.certificateChain : []) {
        assert.equal(
          stored.includes(certificate),
          false,
          "the raw certificate must not be persisted",
        );
      }
    });

    it("derives TRUSTED_DEVICE from a TEE key, unless the policy demands StrongBox", async () => {
      const lenient = setup();
      const a = await androidEvidence(lenient.service, { level: "TEE" });
      assert.equal(
        (await resolve(lenient.service, a.device.point, a.evidence)).tier,
        "TRUSTED_DEVICE",
      );

      const strict = setup({
        android: {
          applications: [
            { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
          ],
          minimumLevel: "STRONGBOX",
          anchors: [authority.anchor],
        },
      });
      const b = await androidEvidence(strict.service, { level: "TEE" });
      const result = await resolve(strict.service, b.device.point, b.evidence);
      assert.equal(result.tier, "UNKNOWN");
      assert.equal(result.reason, "BELOW_MINIMUM_LEVEL");
    });

    it("keeps a software-only attestation at UNKNOWN", async () => {
      const { service, attestations } = setup();
      const { device, evidence } = await androidEvidence(service, { level: "SOFTWARE" });
      const result = await resolve(service, device.point, evidence);
      assert.equal(result.tier, "UNKNOWN");
      assert.equal([...attestations.attestations.values()][0]?.result, "VERIFIED_NOT_QUALIFIED");
    });

    it("refuses a valid chain made for a different challenge", async () => {
      const { service } = setup();
      const { device, evidence } = await androidEvidence(service, {
        challenge: new Uint8Array(32).fill(1),
      });
      const result = await resolve(service, device.point, evidence);
      assert.equal(result.tier, "UNKNOWN");
      assert.equal(result.outcome, "REJECTED");
      assert.equal(result.reason, "CHALLENGE_MISMATCH");
    });

    it("refuses a valid chain presented for a different public key", async () => {
      const { service } = setup();
      const { evidence } = await androidEvidence(service);
      const other = await createDeviceKey();
      const result = await resolve(service, other.point, evidence);
      assert.equal(result.tier, "UNKNOWN");
      assert.equal(result.reason, "PUBLIC_KEY_MISMATCH");
    });

    it("refuses another app, a revoked certificate and an unreadable revocation list", async () => {
      const { service } = setup();
      const wrongApp = await androidEvidence(service, { packageNames: ["evil.app"] });
      assert.equal(
        (await resolve(service, wrongApp.device.point, wrongApp.evidence)).tier,
        "UNKNOWN",
      );

      const revoking = setup({
        android: {
          applications: [
            { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
          ],
          minimumLevel: "TEE",
          anchors: [authority.anchor],
          revocation: { isRevoked: (serial) => Promise.resolve(serial === "abc") },
        },
      });
      const revoked = await androidEvidence(revoking.service, { serial: "0abc" });
      const r1 = await resolve(revoking.service, revoked.device.point, revoked.evidence);
      assert.deepEqual([r1.tier, r1.reason], ["UNKNOWN", "CERTIFICATE_REVOKED"]);

      const offline = setup({
        android: {
          applications: [
            { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
          ],
          minimumLevel: "TEE",
          anchors: [authority.anchor],
          revocation: { isRevoked: () => Promise.reject(new Error("offline")) },
        },
      });
      const down = await androidEvidence(offline.service);
      const r2 = await resolve(offline.service, down.device.point, down.evidence);
      assert.deepEqual([r2.tier, r2.reason], ["UNKNOWN", "REVOCATION_UNAVAILABLE"]);
    });

    it("refuses a chain that does not lead to Google's pinned roots", async () => {
      // No injected anchors: the production default (Google's roots) is in force.
      const { service } = setup({
        android: {
          applications: [
            { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
          ],
          minimumLevel: "TEE",
        },
      });
      const { device, evidence } = await androidEvidence(service);
      const result = await resolve(service, device.point, evidence);
      assert.deepEqual([result.tier, result.reason], ["UNKNOWN", "CHAIN_UNTRUSTED_ROOT"]);
    });
  });

  describe("challenge binding", () => {
    it("is one-time: replaying the same evidence gets nothing", async () => {
      const { service } = setup();
      const { device, evidence } = await androidEvidence(service);
      assert.equal((await resolve(service, device.point, evidence)).tier, "TRUSTED_DEVICE");
      const replay = await resolve(service, device.point, evidence);
      assert.equal(replay.tier, "UNKNOWN");
      assert.equal(replay.outcome, "CHALLENGE_INVALID");
    });

    it("lets exactly one of many concurrent presentations win", async () => {
      const { service, attestations } = setup();
      const { device, evidence } = await androidEvidence(service);
      const results = await Promise.all(
        Array.from({ length: 12 }, () => resolve(service, device.point, evidence)),
      );
      assert.equal(results.filter((r) => r.outcome === "VERIFIED").length, 1);
      assert.equal(results.filter((r) => r.outcome === "CHALLENGE_INVALID").length, 11);
      assert.equal(results.filter((r) => r.tier === "TRUSTED_DEVICE").length, 1);
      assert.equal(attestations.attestations.size, 1);
    });

    it("refuses an expired challenge", async () => {
      const { service } = setup();
      const { device, evidence } = await androidEvidence(service);
      clock = new Date(T0.getTime() + 5 * 60 * 1000 + 1);
      const result = await resolve(service, device.point, evidence);
      assert.deepEqual([result.tier, result.outcome], ["UNKNOWN", "CHALLENGE_INVALID"]);
    });

    it("is bound to its user, wallet, platform and purpose", async () => {
      const { service } = setup();
      const forWallet = await androidEvidence(service, {}, { walletId: WALLET });
      assert.equal(
        (
          await resolve(service, forWallet.device.point, forWallet.evidence, {
            walletId: "00000000-0000-4000-8000-0000000000bb",
          })
        ).outcome,
        "CHALLENGE_INVALID",
        "another wallet",
      );
      const forUser = await androidEvidence(service);
      assert.equal(
        (await resolve(service, forUser.device.point, forUser.evidence, { userId: OTHER_USER }))
          .outcome,
        "CHALLENGE_INVALID",
        "another user",
      );
      const forPurpose = await androidEvidence(service);
      const wrongPurpose = await service.resolveTier({
        route: "native",
        userId: USER,
        purpose: "RECOVERY_ROOT",
        point: forPurpose.device.point,
        evidence: forPurpose.evidence,
      });
      assert.equal(wrongPurpose.outcome, "CHALLENGE_INVALID", "another purpose");
      const forPlatform = await androidEvidence(service);
      const asIos = await resolve(service, forPlatform.device.point, {
        platform: "IOS",
        challengeId: forPlatform.challenge.challengeId,
        attestationObject: "AAAA",
        keyId: "AAAA",
      });
      assert.equal(asIos.outcome, "CHALLENGE_INVALID", "another platform");
    });

    it("burns the challenge even when verification fails", async () => {
      const { service } = setup();
      const { device, evidence } = await androidEvidence(service, {
        level: "SOFTWARE",
        packageNames: ["x.y"],
      });
      await resolve(service, device.point, evidence);
      const again = await resolve(service, device.point, evidence);
      assert.equal(again.outcome, "CHALLENGE_INVALID");
    });

    it("refuses to attest the same key twice, even with a second valid challenge", async () => {
      const { service } = setup();
      const device = await createDeviceKey();
      const evidenceFor = async () => {
        const challenge = await service.issueChallenge({
          userId: USER,
          platform: "ANDROID",
          purpose: "ROOT_ENROLLMENT",
        });
        return {
          platform: "ANDROID" as const,
          challengeId: challenge.challengeId,
          certificateChain: await createAttestationChain(
            authority,
            device.key.publicKey,
            { challenge: new Uint8Array(Buffer.from(challenge.nonce, "hex")) },
            T0,
          ),
        };
      };
      assert.equal(
        (await resolve(service, device.point, await evidenceFor())).tier,
        "TRUSTED_DEVICE",
      );
      const second = await resolve(service, device.point, await evidenceFor());
      assert.deepEqual([second.tier, second.reason], ["UNKNOWN", "KEY_ALREADY_ATTESTED"]);
    });

    it("issues random, distinct, short-lived nonces and refuses a platform that is not enabled", async () => {
      const { service } = setup({ withoutIos: true });
      const a = await service.issueChallenge({
        userId: USER,
        platform: "ANDROID",
        purpose: "ROOT_ENROLLMENT",
      });
      const b = await service.issueChallenge({
        userId: USER,
        platform: "ANDROID",
        purpose: "ROOT_ENROLLMENT",
      });
      assert.match(a.nonce, /^[0-9a-f]{64}$/);
      assert.notEqual(a.nonce, b.nonce);
      assert.equal(a.expiresAt.getTime() - T0.getTime(), 5 * 60 * 1000);
      await assert.rejects(
        service.issueChallenge({ userId: USER, platform: "IOS", purpose: "ROOT_ENROLLMENT" }),
        /not enabled/,
      );
    });
  });

  describe("routes", () => {
    it("never lets the web route carry evidence, and never upgrades it", async () => {
      const { service, attestations } = setup();
      const { device, evidence } = await androidEvidence(service, { level: "STRONGBOX" });
      await assert.rejects(resolve(service, device.point, evidence, { route: "web" }), /web route/);
      assert.equal(attestations.attestations.size, 0);
      const plain = await resolve(service, device.point, undefined, { route: "web" });
      assert.deepEqual([plain.tier, plain.outcome], ["WEB_NON_EXTRACTABLE", "NONE"]);
    });

    it("leaves a native enrolment without evidence at UNKNOWN (it is not blocked)", async () => {
      const { service } = setup();
      const device = await createDeviceKey();
      const result = await resolve(service, device.point);
      assert.deepEqual([result.tier, result.outcome], ["UNKNOWN", "NONE"]);
    });
  });

  describe("ios", () => {
    const iosEvidence = async (
      service: DeviceTierService,
      options: { appId?: string; development?: boolean } = {},
    ) => {
      const wallet = await createDeviceKey();
      const challenge = await service.issueChallenge({
        userId: USER,
        platform: "IOS",
        purpose: "ROOT_ENROLLMENT",
      });
      const object = await createAppAttestObject(
        authority,
        {
          appId: options.appId ?? APP_ID,
          challenge: new Uint8Array(Buffer.from(challenge.nonce, "hex")),
          point: wallet.point,
          ...(options.development !== undefined && { development: options.development }),
        },
        T0,
      );
      const evidence: AttestationEvidence = {
        platform: "IOS",
        challengeId: challenge.challengeId,
        ...object,
      };
      return { wallet, evidence };
    };

    it("derives APP_ATTESTED_DEVICE, never TRUSTED_DEVICE, and records what it does not prove", async () => {
      const { service, attestations } = setup();
      const { wallet, evidence } = await iosEvidence(service);
      const result = await resolve(service, wallet.point, evidence);
      assert.equal(result.tier, "APP_ATTESTED_DEVICE");
      const [row] = [...attestations.attestations.values()];
      assert.equal(row?.attestationType, "IOS_APP_ATTEST");
      assert.equal(row?.hardwareLevel, undefined);
      assert.equal(row?.facts.provesWalletKeyHardware, false);
    });

    it("refuses another app, the sandbox environment, and the wallet key being swapped", async () => {
      const { service } = setup();
      const wrongApp = await iosEvidence(service, { appId: "ZZZZZ99999.evil.app" });
      assert.equal(
        (await resolve(service, wrongApp.wallet.point, wrongApp.evidence)).tier,
        "UNKNOWN",
      );
      const dev = await iosEvidence(service, { development: true });
      assert.equal((await resolve(service, dev.wallet.point, dev.evidence)).tier, "UNKNOWN");
      const swapped = await iosEvidence(service);
      const other = await createDeviceKey();
      assert.equal((await resolve(service, other.point, swapped.evidence)).tier, "UNKNOWN");
    });
  });

  describe("tier rules", () => {
    const outcome = (
      over: Partial<Extract<AttestationOutcome, { verdict: "VERIFIED" }>>,
    ): AttestationOutcome => ({
      verdict: "VERIFIED",
      platform: "ANDROID",
      qualifies: true,
      hardwareLevel: "TEE",
      appInstanceProven: false,
      shortfalls: [],
      ...over,
    });

    it("maps every proof to exactly one tier", () => {
      const tier = (o: AttestationOutcome, channel: "web" | "native" = "native") =>
        deriveDeviceTier({ channel, outcome: o });
      assert.equal(tier(outcome({ hardwareLevel: "STRONGBOX" })), "TRUSTED_DEVICE");
      assert.equal(tier(outcome({ hardwareLevel: "TEE" })), "TRUSTED_DEVICE");
      assert.equal(tier(outcome({ hardwareLevel: "SOFTWARE" })), "UNKNOWN");
      assert.equal(tier(outcome({ qualifies: false })), "UNKNOWN");
      assert.equal(
        tier(
          outcome({
            platform: "IOS",
            qualifies: false,
            hardwareLevel: null,
            appInstanceProven: true,
          }),
        ),
        "APP_ATTESTED_DEVICE",
      );
      assert.equal(
        tier(
          outcome({
            platform: "IOS",
            qualifies: true,
            hardwareLevel: "STRONGBOX",
            appInstanceProven: false,
          }),
        ),
        "UNKNOWN",
      );
      assert.equal(tier({ verdict: "REJECTED", reason: "X" }), "UNKNOWN");
      assert.equal(tier({ verdict: "NONE" }), "UNKNOWN");
      assert.equal(tier({ verdict: "NONE" }, "web"), "WEB_NON_EXTRACTABLE");
      assert.equal(tier(outcome({ hardwareLevel: "STRONGBOX" }), "web"), "WEB_NON_EXTRACTABLE");
    });

    it("never raises an existing credential", () => {
      assert.equal(canChangeTier("UNKNOWN", "TRUSTED_DEVICE"), false);
      assert.equal(canChangeTier("WEB_NON_EXTRACTABLE", "APP_ATTESTED_DEVICE"), false);
      assert.equal(canChangeTier("APP_ATTESTED_DEVICE", "TRUSTED_DEVICE"), false);
      assert.equal(canChangeTier("TRUSTED_DEVICE", "APP_ATTESTED_DEVICE"), true);
      assert.equal(canChangeTier("TRUSTED_DEVICE", "TRUSTED_DEVICE"), true);
      assert.equal(canChangeTier("TRUSTED_DEVICE", "UNKNOWN"), true);
    });

    const stored = (over: Partial<DeviceAttestation> = {}): DeviceAttestation => ({
      id: "a",
      userId: USER,
      challengeId: "c",
      platform: "ANDROID",
      attestationType: "ANDROID_KEY_ATTESTATION",
      credentialRef: `0x${"11".repeat(32)}`,
      publicKeyHash: "22".repeat(32),
      result: "VERIFIED_QUALIFIED",
      hardwareLevel: "TEE",
      derivedTier: "TRUSTED_DEVICE",
      verifierVersion: 0,
      facts: {},
      chainHashes: [],
      verifiedAt: T0,
      createdAt: T0,
      ...over,
    });

    it("re-evaluates a stored attestation under today's policy: it can fall, never rise", () => {
      const lenient = setup().service;
      const strict = setup({
        android: { applications: [], minimumLevel: "STRONGBOX", anchors: [authority.anchor] },
      }).service;
      const tee = stored();
      assert.equal(lenient.reevaluate(tee, "TRUSTED_DEVICE"), "TRUSTED_DEVICE");
      assert.equal(strict.reevaluate(tee, "TRUSTED_DEVICE"), "UNKNOWN", "policy tightened");
      assert.equal(
        lenient.reevaluate(stored({ hardwareLevel: "STRONGBOX" }), "UNKNOWN"),
        "UNKNOWN",
        "never raised",
      );
      assert.equal(
        lenient.reevaluate(stored({ result: "REJECTED", reason: "X" }), "TRUSTED_DEVICE"),
        "UNKNOWN",
      );
    });

    it("migrates an old verifier version without trusting more than it recorded", () => {
      const service = setup().service;
      const legacy = stored({
        verifierVersion: 0,
        result: "VERIFIED_NOT_QUALIFIED",
        hardwareLevel: "SOFTWARE",
        derivedTier: "UNKNOWN",
      });
      assert.equal(service.reevaluate(legacy, "UNKNOWN"), "UNKNOWN");
      const { hardwareLevel: _level, ...base } = stored();
      const ios: DeviceAttestation = {
        ...base,
        platform: "IOS",
        derivedTier: "APP_ATTESTED_DEVICE",
      };
      assert.equal(service.reevaluate(ios, "APP_ATTESTED_DEVICE"), "APP_ATTESTED_DEVICE");
      assert.equal(
        setup({ withoutIos: true }).service.reevaluate(ios, "APP_ATTESTED_DEVICE"),
        "UNKNOWN",
      );
    });
  });
});
