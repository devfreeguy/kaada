// A software P-256 device key for tests: signs the exact Kaada device-key payload like a platform keystore would.
import { createHash } from "node:crypto";

import { p256 } from "@noble/curves/p256";
import { concat, keccak256, pad, toHex } from "viem";
import type { Hex } from "viem";

import { deviceKeyIdFromPoint, deviceKeyPayload, deviceKeySignature } from "../device-key.js";
import type { DeviceKeyPoint, DeviceSigningInput } from "../device-key.js";

export class SoftDeviceKey {
  readonly point: DeviceKeyPoint;
  readonly keyId: Hex;
  private readonly privateKey: Uint8Array;

  constructor(keyId?: Hex) {
    this.privateKey = p256.utils.randomPrivateKey();
    const affine = p256.ProjectivePoint.fromPrivateKey(this.privateKey).toAffine();
    this.point = { x: affine.x, y: affine.y };
    this.keyId = keyId ?? deviceKeyIdFromPoint(this.point);
  }

  private rs(input: Omit<DeviceSigningInput, "keyId">): { r: bigint; s: bigint } {
    const payload = deviceKeyPayload({ ...input, keyId: this.keyId });
    const digest = createHash("sha256")
      .update(Buffer.from(payload.slice(2), "hex"))
      .digest();
    // ECDSA P-256 over sha256(payload): the native "SHA256withECDSA"; noble signs low-s.
    const signature = p256.sign(digest, this.privateKey, { lowS: true });
    return { r: signature.r, s: signature.s };
  }

  /** The signature the contract expects: keyId || r || s, low-s. */
  sign(input: Omit<DeviceSigningInput, "keyId">): Hex {
    const { r, s } = this.rs(input);
    return deviceKeySignature(this.keyId, r, s);
  }

  /** The high-s twin of the valid signature: same key, same message, malleable. */
  signHighS(input: Omit<DeviceSigningInput, "keyId">): Hex {
    const { r, s } = this.rs(input);
    return concat([
      pad(this.keyId, { size: 32 }),
      pad(toHex(r), { size: 32 }),
      pad(toHex(p256.CURVE.n - s), { size: 32 }),
    ]);
  }
}

/** A keyId that is not derived from the key (the contract accepts any non-zero bytes32). */
export const labelledKeyId = (label: string): Hex => keccak256(toHex(label));
