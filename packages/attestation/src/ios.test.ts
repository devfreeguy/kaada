import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { verifyAppAttest } from "./ios.js";
import type { IosAttestationPolicy } from "./ios.js";
import { APPLE_APP_ATTEST_ROOT } from "./roots.js";
import { createDeviceKey, createTestAuthority } from "./testing/android-fixtures.js";
import type { TestAuthority } from "./testing/android-fixtures.js";
import { createAppAttestObject } from "./testing/ios-fixtures.js";

const NOW = new Date("2026-10-12T12:00:00Z");
const APP_ID = "ABCDE12345.app.kaada.wallet";
const challenge = new Uint8Array(32).fill(9);

describe("apple app attest", () => {
  let authority: TestAuthority;
  let wallet: Awaited<ReturnType<typeof createDeviceKey>>;
  let policy: IosAttestationPolicy;

  before(async () => {
    authority = await createTestAuthority(NOW);
    wallet = await createDeviceKey();
    policy = { appIds: [APP_ID], allowDevelopment: false, anchor: authority.anchor };
  });

  const build = (options: Partial<Parameters<typeof createAppAttestObject>[1]> = {}) =>
    createAppAttestObject(
      authority,
      { appId: APP_ID, challenge, point: wallet.point, ...options },
      NOW,
    );
  const verify = (
    object: { attestationObject: string; keyId: string },
    overrides: Partial<Parameters<typeof verifyAppAttest>[0]> = {},
  ) =>
    verifyAppAttest({
      ...object,
      challenge,
      publicKey: wallet.point,
      policy,
      now: NOW,
      ...overrides,
    });

  it("verifies a genuine app instance, and says it does not prove the wallet key's hardware", async () => {
    const r = verify(await build());
    assert.equal(r.verdict, "VERIFIED");
    if (r.verdict !== "VERIFIED") return;
    assert.equal(r.provesWalletKeyHardware, false);
    assert.equal(r.facts.appId, APP_ID);
    assert.equal(r.facts.environment, "production");
    assert.equal(r.facts.trustAnchor, authority.anchor.sha256);
  });

  it("rejects a different challenge", async () => {
    const r = verify(await build(), { challenge: new Uint8Array(32).fill(1) });
    assert.deepEqual(r, { verdict: "REJECTED", code: "NONCE_MISMATCH" });
  });

  it("rejects when the wallet key presented is not the one the app bound", async () => {
    const other = await createDeviceKey();
    const r = verify(await build(), { publicKey: other.point });
    assert.deepEqual(r, { verdict: "REJECTED", code: "NONCE_MISMATCH" });
  });

  it("rejects a nonce computed over a different challenge", async () => {
    const r = verify(await build({ nonceChallenge: new Uint8Array(32).fill(2) }));
    assert.deepEqual(r, { verdict: "REJECTED", code: "NONCE_MISMATCH" });
  });

  it("rejects another app's attestation", async () => {
    const r = verify(await build({ appId: "ZZZZZ99999.evil.app" }));
    assert.deepEqual(r, { verdict: "REJECTED", code: "APP_NOT_ALLOWED" });
  });

  it("rejects when no app is configured", async () => {
    const r = verify(await build(), { policy: { ...policy, appIds: [] } });
    assert.deepEqual(r, { verdict: "REJECTED", code: "APP_NOT_ALLOWED" });
  });

  it("rejects a keyId that is not the attested key", async () => {
    const r = verify(await build({ wrongKeyId: true }));
    assert.deepEqual(r, { verdict: "REJECTED", code: "KEY_ID_MISMATCH" });
  });

  it("rejects a non-zero counter", async () => {
    const r = verify(await build({ counter: 1 }));
    assert.deepEqual(r, { verdict: "REJECTED", code: "COUNTER_NOT_ZERO" });
  });

  it("rejects the development environment unless allowed", async () => {
    const object = await build({ development: true });
    assert.deepEqual(verify(object), { verdict: "REJECTED", code: "ENVIRONMENT_NOT_ALLOWED" });
    const allowed = verify(object, { policy: { ...policy, allowDevelopment: true } });
    assert.equal(allowed.verdict, "VERIFIED");
    if (allowed.verdict === "VERIFIED") assert.equal(allowed.facts.environment, "development");
  });

  it("rejects a chain not rooted in Apple's pinned root", async () => {
    const r = verify(await build(), { policy: { ...policy, anchor: APPLE_APP_ATTEST_ROOT } });
    assert.deepEqual(r, { verdict: "REJECTED", code: "CHAIN_UNTRUSTED_ROOT" });
  });

  it("rejects another format, and garbage", async () => {
    assert.deepEqual(verify(await build({ fmt: "packed" })), {
      verdict: "REJECTED",
      code: "FORMAT_UNSUPPORTED",
    });
    for (const attestationObject of ["", "!!!", Buffer.from("junk").toString("base64")]) {
      const r = verify({ attestationObject, keyId: "AAAA" });
      assert.equal(r.verdict, "REJECTED");
    }
  });
});
