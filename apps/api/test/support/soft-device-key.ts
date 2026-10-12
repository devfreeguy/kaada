import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

import { P256_HALF_N, P256_N, deviceKeyIdFromPoint } from "@kaada/contracts";
import type { RootProof } from "@kaada/domain";

/**
 * A software P-256 device key for tests: it does what the browser's WebCrypto key does (sign a payload with ECDSA P-256 /
 * SHA-256, hand back r and a low-s s), with the private key kept in this object only. TEST ONLY.
 */
export class SoftDeviceKey {
  readonly publicKeyX: string;
  readonly publicKeyY: string;
  readonly keyId: string;
  private readonly privateKeyPem: string;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    this.privateKeyPem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const jwk = pair.publicKey.export({ format: "jwk" });
    this.publicKeyX = Buffer.from(jwk.x ?? "", "base64url").toString("hex");
    this.publicKeyY = Buffer.from(jwk.y ?? "", "base64url").toString("hex");
    this.keyId = deviceKeyIdFromPoint({
      x: BigInt(`0x${this.publicKeyX}`),
      y: BigInt(`0x${this.publicKeyY}`),
    });
  }

  /** Signs exactly `payloadHex`. `highS` returns the other (n - s) form, which the validator and the server must refuse. */
  sign(payloadHex: string, options: { highS?: boolean } = {}): { r: string; s: string } {
    const signature = sign("sha256", Buffer.from(payloadHex.replace(/^0x/, ""), "hex"), {
      key: createPrivateKey(this.privateKeyPem),
      dsaEncoding: "ieee-p1363",
    });
    const r = signature.subarray(0, 32).toString("hex");
    let s = BigInt(`0x${signature.subarray(32).toString("hex")}`);
    if (options.highS ? s <= P256_HALF_N : s > P256_HALF_N) s = P256_N - s;
    return { r, s: s.toString(16).padStart(64, "0") };
  }

  /** The proof the server expects for a challenge payload. */
  proof(payloadHex: string, extra: { challenge?: string; highS?: boolean } = {}): RootProof {
    return {
      type: "DEVICE_KEY",
      keyId: this.keyId,
      ...this.sign(payloadHex, extra.highS ? { highS: true } : {}),
      ...(extra.challenge && { challenge: extra.challenge }),
    };
  }
}
