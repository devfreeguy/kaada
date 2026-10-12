import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { VerifiedBootState } from "@peculiar/asn1-android";

import { GOOGLE_ANDROID_ROOTS } from "./roots.js";
import { sha256Hex } from "./chain.js";
import { verifyAndroidKeyAttestation, DEFAULT_ANDROID_POLICY } from "./android.js";
import type { AndroidAttestationPolicy, AndroidRevocationSource } from "./android.js";
import {
  TEST_APP,
  createAttestationChain,
  createDeviceKey,
  createTestAuthority,
} from "./testing/android-fixtures.js";
import type { FixtureOptions, TestAuthority } from "./testing/android-fixtures.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const challenge = new Uint8Array(32).fill(7);

describe("android key attestation", () => {
  let authority: TestAuthority;
  let device: Awaited<ReturnType<typeof createDeviceKey>>;
  let policy: AndroidAttestationPolicy;

  before(async () => {
    authority = await createTestAuthority(NOW);
    device = await createDeviceKey();
    policy = {
      ...DEFAULT_ANDROID_POLICY,
      applications: [
        { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
      ],
      anchors: [authority.anchor],
    };
  });

  const run = async (
    options: Partial<FixtureOptions> = {},
    overrides: Partial<Parameters<typeof verifyAndroidKeyAttestation>[0]> = {},
  ) => {
    const chain = await createAttestationChain(
      authority,
      device.key.publicKey,
      { challenge, ...options },
      NOW,
    );
    return verifyAndroidKeyAttestation({
      certificateChain: chain,
      challenge,
      publicKey: device.point,
      policy,
      now: NOW,
      ...overrides,
    });
  };

  const verified = <T extends { verdict: string }>(r: T) => {
    assert.equal(r.verdict, "VERIFIED");
    return r as Extract<T, { verdict: "VERIFIED" }>;
  };

  it("qualifies a StrongBox key and reports the level", async () => {
    const r = verified(await run({ level: "STRONGBOX" }));
    assert.equal(r.qualifies, true);
    assert.deepEqual(r.shortfalls, []);
    assert.equal(r.facts.hardwareLevel, "STRONGBOX");
    assert.equal(r.facts.packageName, TEST_APP.packageName);
    assert.equal(r.facts.verifiedBootState, "VERIFIED");
    assert.equal(r.facts.trustAnchor, authority.anchor.sha256);
    assert.equal(r.facts.chainHashes.length, 3);
  });

  it("qualifies a TEE key when the minimum is TEE", async () => {
    const r = verified(await run({ level: "TEE" }));
    assert.equal(r.qualifies, true);
    assert.equal(r.facts.hardwareLevel, "TEE");
  });

  it("does not qualify a TEE key when the policy demands StrongBox", async () => {
    const r = verified(
      await run({ level: "TEE" }, { policy: { ...policy, minimumLevel: "STRONGBOX" } }),
    );
    assert.equal(r.qualifies, false);
    assert.deepEqual(r.shortfalls, ["BELOW_MINIMUM_LEVEL"]);
  });

  it("does not qualify a software-only attestation", async () => {
    const r = verified(await run({ level: "SOFTWARE" }));
    assert.equal(r.qualifies, false);
    assert.ok(r.shortfalls.includes("NOT_HARDWARE_BACKED"));
  });

  it("takes the weaker of the attestation and keymaster levels", async () => {
    const r = verified(await run({ level: "STRONGBOX", attestationLevel: "SOFTWARE" }));
    assert.equal(r.facts.hardwareLevel, "SOFTWARE");
    assert.equal(r.qualifies, false);
  });

  it("rejects a valid chain with the wrong challenge", async () => {
    const r = await run({}, { challenge: new Uint8Array(32).fill(8) });
    assert.deepEqual(r, { verdict: "REJECTED", code: "CHALLENGE_MISMATCH" });
  });

  it("rejects a valid attestation for a different key", async () => {
    const other = await createDeviceKey();
    const r = await run({}, { publicKey: other.point });
    assert.deepEqual(r, { verdict: "REJECTED", code: "PUBLIC_KEY_MISMATCH" });
  });

  it("rejects a self-signed fake chain", async () => {
    const rogue = await createTestAuthority(NOW);
    const chain = await createAttestationChain(rogue, device.key.publicKey, { challenge }, NOW);
    const r = await verifyAndroidKeyAttestation({
      certificateChain: chain,
      challenge,
      publicKey: device.point,
      policy: { ...policy, anchors: GOOGLE_ANDROID_ROOTS },
      now: NOW,
    });
    assert.deepEqual(r, { verdict: "REJECTED", code: "CHAIN_UNTRUSTED_ROOT" });
  });

  it("rejects a chain of another test authority", async () => {
    const rogue = await createTestAuthority(NOW);
    const chain = await createAttestationChain(rogue, device.key.publicKey, { challenge }, NOW);
    const r = await verifyAndroidKeyAttestation({
      certificateChain: chain,
      challenge,
      publicKey: device.point,
      policy,
      now: NOW,
    });
    assert.deepEqual(r, { verdict: "REJECTED", code: "CHAIN_UNTRUSTED_ROOT" });
  });

  it("rejects a tampered certificate", async () => {
    const chain = await createAttestationChain(authority, device.key.publicKey, { challenge }, NOW);
    const bytes = Buffer.from(chain[0] ?? "", "base64");
    bytes[bytes.length - 5] = (bytes[bytes.length - 5] ?? 0) ^ 0xff; // inside the signature
    const r = await verifyAndroidKeyAttestation({
      certificateChain: [bytes.toString("base64"), ...chain.slice(1)],
      challenge,
      publicKey: device.point,
      policy,
      now: NOW,
    });
    assert.equal(r.verdict, "REJECTED");
  });

  it("rejects garbage and empty chains", async () => {
    for (const certificateChain of [
      [],
      ["not base64!"],
      [Buffer.from("junk").toString("base64")],
    ]) {
      const r = await verifyAndroidKeyAttestation({
        certificateChain,
        challenge,
        publicKey: device.point,
        policy,
        now: NOW,
      });
      assert.deepEqual(r, { verdict: "REJECTED", code: "CHAIN_MALFORMED" });
    }
  });

  it("rejects an expired leaf and a not-yet-valid leaf", async () => {
    const expired = await run({ notAfter: new Date(NOW.getTime() - 1000) });
    assert.deepEqual(expired, { verdict: "REJECTED", code: "CHAIN_EXPIRED" });
    const early = await run({ notBefore: new Date(NOW.getTime() + 60_000) });
    assert.deepEqual(early, { verdict: "REJECTED", code: "CHAIN_EXPIRED" });
  });

  it("rejects a chain without a key description", async () => {
    const r = await run({ omitKeyDescription: true });
    assert.deepEqual(r, { verdict: "REJECTED", code: "KEY_DESCRIPTION_MISSING" });
  });

  it("rejects a key generated before the challenge was issued", async () => {
    const r = await run(
      { creationDateTime: NOW.getTime() - 3_600_000 },
      { challengeIssuedAt: NOW },
    );
    assert.deepEqual(r, { verdict: "REJECTED", code: "KEY_PREDATES_CHALLENGE" });
    const ok = verified(
      await run({ creationDateTime: NOW.getTime() + 5000 }, { challengeIssuedAt: NOW }),
    );
    assert.equal(ok.qualifies, true);
  });

  it("does not qualify a key that can do more than sign, or the wrong algorithm", async () => {
    const decrypt = verified(await run({ purposes: [2, 1] }));
    assert.equal(decrypt.qualifies, false);
    assert.ok(decrypt.shortfalls.includes("KEY_PURPOSE_NOT_SIGN_ONLY"));
    const rsa = verified(await run({ algorithm: 1 }));
    assert.ok(rsa.shortfalls.includes("KEY_NOT_EC_P256"));
    const sha1 = verified(await run({ digest: [2] }));
    assert.ok(sha1.shortfalls.includes("KEY_DIGEST_NOT_SHA256"));
    const imported = verified(await run({ origin: 2 }));
    assert.ok(imported.shortfalls.includes("KEY_NOT_GENERATED_ON_DEVICE"));
  });

  it("does not trust key properties that only the software list claims", async () => {
    const r = verified(await run({ propertiesIn: "software" }));
    assert.equal(r.qualifies, false);
    assert.ok(r.shortfalls.includes("KEY_PROPERTIES_NOT_HARDWARE_ENFORCED"));
  });

  it("does not qualify an old attestation version", async () => {
    const r = verified(await run({ attestationVersion: 2 }));
    assert.ok(r.shortfalls.includes("ATTESTATION_VERSION_TOO_OLD"));
  });

  it("does not qualify an unverified boot or an unlocked bootloader", async () => {
    const failed = verified(await run({ bootState: VerifiedBootState.failed }));
    assert.ok(failed.shortfalls.includes("BOOT_NOT_VERIFIED"));
    const unlocked = verified(await run({ deviceLocked: false }));
    assert.ok(unlocked.shortfalls.includes("BOOTLOADER_UNLOCKED"));
    const none = verified(await run({ noRootOfTrust: true }));
    assert.ok(none.shortfalls.includes("BOOT_NOT_VERIFIED"));
    const lenient = verified(
      await run({ deviceLocked: false }, { policy: { ...policy, requireVerifiedBoot: false } }),
    );
    assert.equal(lenient.qualifies, true);
  });

  describe("app identity", () => {
    it("does not qualify another package", async () => {
      const r = verified(await run({ packageNames: ["evil.app"] }));
      assert.deepEqual(r.shortfalls, ["APP_NOT_ALLOWED"]);
    });
    it("does not qualify the right package signed by another key", async () => {
      const r = verified(await run({ signatureDigests: ["cd".repeat(32)] }));
      assert.deepEqual(r.shortfalls, ["APP_SIGNATURE_NOT_ALLOWED"]);
    });
    it("does not qualify when any signer is not allowed", async () => {
      const r = verified(
        await run({ signatureDigests: [TEST_APP.signatureDigest, "cd".repeat(32)] }),
      );
      assert.ok(r.shortfalls.includes("APP_SIGNATURE_NOT_ALLOWED"));
    });
    it("does not qualify a shared-UID attestation with several packages", async () => {
      const r = verified(await run({ packageNames: [TEST_APP.packageName, "other.app"] }));
      assert.ok(r.shortfalls.includes("APP_IDENTITY_MISSING"));
    });
    it("does not qualify when the app identity is absent", async () => {
      const r = verified(await run({ omitApplicationId: true }));
      assert.ok(r.shortfalls.includes("APP_IDENTITY_MISSING"));
    });
    it("fails closed when no application is configured", async () => {
      const r = verified(await run({}, { policy: { ...policy, applications: [] } }));
      assert.equal(r.qualifies, false);
      assert.deepEqual(r.shortfalls, ["APP_IDENTITY_NOT_CONFIGURED"]);
    });
  });

  describe("revocation", () => {
    const revoking = (serials: string[]): AndroidRevocationSource => ({
      isRevoked: (serial) => Promise.resolve(serials.includes(serial)),
    });

    it("rejects a revoked certificate anywhere in the chain", async () => {
      const leaf = await run({ serial: "0abc" }, { revocation: revoking(["abc"]) });
      assert.deepEqual(leaf, { verdict: "REJECTED", code: "CERTIFICATE_REVOKED" });
      const intermediate = await run({}, { revocation: revoking(["2"]) });
      assert.deepEqual(intermediate, { verdict: "REJECTED", code: "CERTIFICATE_REVOKED" });
    });

    it("accepts when nothing is revoked", async () => {
      verified(await run({}, { revocation: revoking([]) }));
    });

    it("fails closed when the revocation list cannot be read", async () => {
      const r = await run(
        {},
        { revocation: { isRevoked: () => Promise.reject(new Error("offline")) } },
      );
      assert.deepEqual(r, { verdict: "REJECTED", code: "REVOCATION_UNAVAILABLE" });
    });
  });

  it("records hashes and never the raw chain", async () => {
    const r = verified(await run());
    assert.equal(
      r.facts.publicKeyHash,
      sha256Hex(Buffer.from(`${device.point.x}${device.point.y}`, "hex")),
    );
    for (const hash of r.facts.chainHashes) assert.match(hash, /^[0-9a-f]{64}$/);
  });
});
