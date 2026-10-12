// A software WebAuthn authenticator for tests: a P-256 key that signs the shape of assertion the ZeroDev passkey
// validator verifies, with the challenge being the UserOperation hash.
import { createHash, randomBytes } from "node:crypto";

import { p256 } from "@noble/curves/p256";
import { bytesToHex, encodeAbiParameters, keccak256, toHex } from "viem";
import type { Hex } from "viem";

import type { PasskeyCredential } from "../passkey-factory.js";

export const TEST_RP_ID = "kaada.test";
export const TEST_ORIGIN = "https://kaada.test";

export class SoftPasskey {
  readonly credentialId: Uint8Array;
  readonly credential: PasskeyCredential;
  private readonly privateKey: Uint8Array;
  private counter = 0;

  constructor() {
    this.privateKey = p256.utils.randomPrivateKey();
    this.credentialId = randomBytes(32);
    const point = p256.ProjectivePoint.fromPrivateKey(this.privateKey).toAffine();
    this.credential = {
      x: point.x,
      y: point.y,
      authenticatorIdHash: keccak256(toHex(this.credentialId)),
    };
  }

  /** The validator signature over `challenge` (the UserOperation hash). `usePrecompiled` = RIP-7212 available. */
  sign(challenge: Hex, usePrecompiled = true): Hex {
    this.counter += 1;
    const authenticatorData = Buffer.concat([
      createHash("sha256").update(TEST_RP_ID).digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, this.counter]),
    ]);
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
      origin: TEST_ORIGIN,
      crossOrigin: false,
    });
    const digest = createHash("sha256")
      .update(
        Buffer.concat([
          authenticatorData,
          createHash("sha256").update(Buffer.from(clientData)).digest(),
        ]),
      )
      .digest();
    const signature = p256.sign(digest, this.privateKey, { lowS: true });
    return encodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
      ],
      [bytesToHex(authenticatorData), clientData, 1n, signature.r, signature.s, usePrecompiled],
    );
  }
}
