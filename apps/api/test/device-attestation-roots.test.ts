import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { before, describe, it } from "node:test";

import { TEST_APP, createAttestationChain, createTestAuthority } from "@kaada/attestation/testing";
import type { TestAuthority } from "@kaada/attestation/testing";

import { DeviceTierService } from "../src/core/attestation/device-tier-service.js";
import type { AttestationEvidence } from "../src/core/attestation/device-tier-service.js";
import type { NewCredentialInput } from "../src/core/roots/root-change-service.js";
import { createMemoryDeviceAttestations } from "./support/attestation-memory.js";
import { build } from "./support/root-change-world.js";
import type { SoftDeviceKey } from "./support/soft-device-key.js";

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

describe("device attestation in root changes", () => {
  let authority: TestAuthority;
  before(async () => {
    authority = await createTestAuthority(new Date("2026-10-21T12:00:00.000Z"));
  });

  async function world() {
    let clock = () => new Date("2026-10-21T12:00:00.000Z");
    const deviceTiers = new DeviceTierService({
      attestations: createMemoryDeviceAttestations(),
      android: {
        applications: [
          { packageName: TEST_APP.packageName, signatureDigests: [TEST_APP.signatureDigest] },
        ],
        minimumLevel: "TEE",
        anchors: [authority.anchor],
      },
      now: () => clock(),
    });
    const w = await build("DEVICE_KEY", { deviceTiers });
    clock = w.now;
    return { w, deviceTiers };
  }

  /** The device side: ask for a nonce for this change, generate a key attested to it, prove possession. */
  async function nativeCredential(
    w: Awaited<ReturnType<typeof world>>["w"],
    kind: "ROTATE_ROOT" | "ENROLL_BACKUP",
    issuedFor: "ROTATE_ROOT" | "ENROLL_BACKUP" = kind,
  ): Promise<NewCredentialInput> {
    const issued = await w.service.issueAttestationChallenge(w.userId, issuedFor, "ANDROID");
    const { input, key } = await w.newDevice();
    if (input.type !== "DEVICE_KEY") throw new Error("expected a device key");
    const evidence: AttestationEvidence = {
      platform: "ANDROID",
      challengeId: issued.challengeId,
      certificateChain: await createAttestationChain(
        authority,
        await publicCryptoKey(key),
        { challenge: new Uint8Array(Buffer.from(issued.nonce, "hex")), level: "STRONGBOX" },
        w.now(),
      ),
    };
    return { ...input, attestation: evidence };
  }

  const tierOfNewest = async (w: Awaited<ReturnType<typeof world>>["w"]) => {
    const rows = await w.credentials();
    return rows.find((row) => row.status === "PENDING")?.securityTier;
  };

  it("records TRUSTED_DEVICE for a rotation to an attested native key", async () => {
    const { w } = await world();
    const input = await nativeCredential(w, "ROTATE_ROOT");
    await w.service.prepare(w.userId, "ROTATE_ROOT", input, "native");
    assert.equal(await tierOfNewest(w), "TRUSTED_DEVICE");
  });

  it("records TRUSTED_DEVICE for an attested backup", async () => {
    const { w } = await world();
    const input = await nativeCredential(w, "ENROLL_BACKUP");
    await w.service.prepare(w.userId, "ENROLL_BACKUP", input, "native");
    assert.equal(await tierOfNewest(w), "TRUSTED_DEVICE");
  });

  it("keeps a challenge issued for a rotation useless for a backup (bound to its purpose)", async () => {
    const { w } = await world();
    const input = await nativeCredential(w, "ENROLL_BACKUP", "ROTATE_ROOT");
    await w.service.prepare(w.userId, "ENROLL_BACKUP", input, "native");
    assert.equal(await tierOfNewest(w), "UNKNOWN");
  });

  it("is not blocked by a native key with no evidence: it is UNKNOWN", async () => {
    const { w } = await world();
    const { input } = await w.newDevice();
    await w.service.prepare(w.userId, "ROTATE_ROOT", input, "native");
    assert.equal(await tierOfNewest(w), "UNKNOWN");
  });

  it("refuses evidence on the web route before spending the enrolment challenge", async () => {
    const { w } = await world();
    const input = await nativeCredential(w, "ROTATE_ROOT");
    await assert.rejects(w.service.prepare(w.userId, "ROTATE_ROOT", input), /web route/);
    // Nothing was spent: the same credential, without the claim, still enrols (on the web, at the web tier).
    const { attestation: _claim, ...plain } = input as Extract<
      NewCredentialInput,
      { type: "DEVICE_KEY" }
    >;
    await w.service.prepare(w.userId, "ROTATE_ROOT", plain);
    assert.equal(await tierOfNewest(w), "WEB_NON_EXTRACTABLE");
  });

  it("a plain web rotation is unchanged", async () => {
    const { w } = await world();
    const { input } = await w.newDevice();
    await w.service.prepare(w.userId, "ROTATE_ROOT", input);
    assert.equal(await tierOfNewest(w), "WEB_NON_EXTRACTABLE");
  });
});
