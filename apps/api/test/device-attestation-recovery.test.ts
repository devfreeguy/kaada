import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { before, describe, it } from "node:test";

import { TEST_APP, createAttestationChain, createTestAuthority } from "@kaada/attestation/testing";
import type { FixtureOptions, TestAuthority } from "@kaada/attestation/testing";

import { DeviceTierService } from "../src/core/attestation/device-tier-service.js";
import type { AttestationEvidence } from "../src/core/attestation/device-tier-service.js";
import { createMemoryDeviceAttestations } from "./support/attestation-memory.js";
import { createRecoveryWorld, newDeviceRoot } from "./support/recovery-world.js";

const publicCryptoKey = (root: { publicKeyX: string; publicKeyY: string }) =>
  webcrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(root.publicKeyX, "hex").toString("base64url"),
      y: Buffer.from(root.publicKeyY, "hex").toString("base64url"),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );

describe("device attestation in recovery", () => {
  let authority: TestAuthority;
  before(async () => {
    authority = await createTestAuthority(new Date("2026-10-20T12:00:00.000Z"));
  });

  function setup() {
    let clock = () => new Date("2026-10-20T12:00:00.000Z");
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
    const world = createRecoveryWorld({ deviceTiers });
    clock = () => new Date("2026-10-20T12:00:00.000Z");
    return { world, deviceTiers };
  }

  /** The recovering device: ask for a nonce, generate a key attested to it. */
  async function recover(options: {
    android?: Partial<FixtureOptions>;
    channel?: "web" | "native-android";
    withEvidence?: boolean;
  }) {
    const { world } = setup();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    const root = await newDeviceRoot();
    let attestation: AttestationEvidence | undefined;
    if (options.withEvidence !== false) {
      const issued = await world.flow.issueAttestationChallenge(token, "ANDROID");
      attestation = {
        platform: "ANDROID",
        challengeId: issued.challengeId,
        certificateChain: await createAttestationChain(
          authority,
          await publicCryptoKey(root),
          { challenge: new Uint8Array(Buffer.from(issued.nonce, "hex")), ...options.android },
          new Date("2026-10-20T12:00:00.000Z"),
        ),
      };
    }
    const run = () =>
      world.flow.proposeDeviceRoot(token, {
        publicKeyX: root.publicKeyX,
        publicKeyY: root.publicKeyY,
        channel: options.channel ?? "native-android",
        attestation,
      });
    return { world, token, run };
  }

  const tierOf = async (r: Awaited<ReturnType<typeof recover>>) => {
    const attempt = await r.world.attemptOf(r.token);
    const credential = await r.world.repositories.walletCredentials.findById(
      attempt.newCredentialId ?? "",
    );
    return credential?.securityTier;
  };

  it("records TRUSTED_DEVICE for a recovery onto an attested hardware key", async () => {
    const r = await recover({ android: { level: "STRONGBOX" } });
    await r.run();
    assert.equal(await tierOf(r), "TRUSTED_DEVICE");
  });

  it("records UNKNOWN, and still proceeds, for software-only or missing evidence", async () => {
    const soft = await recover({ android: { level: "SOFTWARE" } });
    await soft.run();
    assert.equal(await tierOf(soft), "UNKNOWN");
    const none = await recover({ withEvidence: false });
    await none.run();
    assert.equal(await tierOf(none), "UNKNOWN");
  });

  it("refuses evidence that arrives on the web route", async () => {
    const r = await recover({ channel: "web" });
    await assert.rejects(r.run(), /web route/);
  });

  it("will not issue a challenge unless attestation is enabled", async () => {
    const world = createRecoveryWorld();
    const user = await world.createUser();
    const token = await world.startAndVerify(user.email);
    await assert.rejects(world.flow.issueAttestationChallenge(token, "ANDROID"), /not enabled/);
  });
});
