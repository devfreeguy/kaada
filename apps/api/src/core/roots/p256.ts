import { createPublicKey, verify } from "node:crypto";

import { P256_HALF_N } from "@kaada/contracts";

const HEX_32 = /^[0-9a-f]{64}$/;

/**
 * Verifies an ECDSA P-256 / SHA-256 signature over `message` with a PUBLIC key given as 32-byte coordinates (hex, no 0x).
 * r and s are 32-byte hex. A signature whose s is above half the curve order is refused (the on-chain validator refuses it
 * too, so accepting it here would only send a doomed operation). Never throws on a malformed input: it is simply false.
 */
export function verifyP256(input: {
  x: string;
  y: string;
  message: Uint8Array;
  r: string;
  s: string;
}): boolean {
  if (![input.x, input.y, input.r, input.s].every((part) => HEX_32.test(part))) return false;
  const r = BigInt(`0x${input.r}`);
  const s = BigInt(`0x${input.s}`);
  if (r === 0n || s === 0n || s > P256_HALF_N) return false;
  try {
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: Buffer.from(input.x, "hex").toString("base64url"),
        y: Buffer.from(input.y, "hex").toString("base64url"),
      },
      format: "jwk",
    });
    return verify(
      "sha256",
      input.message,
      { key, dsaEncoding: "ieee-p1363" },
      Buffer.from(input.r + input.s, "hex"),
    );
  } catch {
    return false;
  }
}
