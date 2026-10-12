import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";

import { fromHex, generateDeviceKey, signDevicePayload } from "./device-key";

const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function verifies(x: string, y: string, payloadHex: string, r: string, s: string): boolean {
  const key = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(x, "hex").toString("base64url"),
      y: Buffer.from(y, "hex").toString("base64url"),
    },
    format: "jwk",
  });
  return verify(
    "sha256",
    Buffer.from(payloadHex.slice(2), "hex"),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(r + s, "hex"),
  );
}

describe("device key (WebCrypto)", () => {
  it("generates a non-extractable key and exposes only the public coordinates", async () => {
    const key = await generateDeviceKey();
    assert.match(key.publicKeyX, /^[0-9a-f]{64}$/);
    assert.match(key.publicKeyY, /^[0-9a-f]{64}$/);
    assert.equal(key.privateKey.extractable, false);
    await assert.rejects(globalThis.crypto.subtle.exportKey("pkcs8", key.privateKey));
    await assert.rejects(globalThis.crypto.subtle.exportKey("jwk", key.privateKey));
  });

  it("signs exactly the payload, always low-s, and the signature verifies against the public key", async () => {
    const key = await generateDeviceKey();
    for (let i = 0; i < 40; i += 1) {
      const payload = `0x${Buffer.from(`payload ${String(i)}`).toString("hex")}`;
      const { r, s } = await signDevicePayload(key.privateKey, payload);
      assert.ok(BigInt(`0x${s}`) <= N / 2n, "s is low");
      assert.equal(verifies(key.publicKeyX, key.publicKeyY, payload, r, s), true);
      assert.equal(
        verifies(key.publicKeyX, key.publicKeyY, `${payload}00`, r, s),
        false,
        "a different payload does not verify",
      );
    }
  });

  it("rejects malformed hex before anything is signed", async () => {
    assert.throws(() => fromHex("0xabc"));
    assert.throws(() => fromHex("0xzz"));
    const key = await generateDeviceKey();
    await assert.rejects(signDevicePayload(key.privateKey, "0xabc"));
  });
});
