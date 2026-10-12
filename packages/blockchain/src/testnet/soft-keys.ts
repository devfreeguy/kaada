/*
 * TESTNET ONLY. Software authenticators for the Celo Sepolia proofs built on kernel-probe-lib: a WebAuthn-shaped passkey and a raw P-256
 * device key. They hold their private key in memory; real clients keep it in the platform keystore.
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { deviceKeyIdFromPoint, deviceKeyPayload } from "@kaada/contracts";
import type { DeviceKeyPoint, PasskeyCredential } from "@kaada/contracts";
import { bytesToHex, concat, encodeAbiParameters, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";

/** The only chain these test keys are used on: Celo Sepolia. */
export const SEPOLIA_CHAIN_ID = 11142220;
const RP_ID = "kaada.test";
const ORIGIN = "https://kaada.test";
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A software WebAuthn authenticator: signs the assertion shape the ZeroDev validator checks. */
export class SoftPasskey {
  readonly credential: PasskeyCredential;
  private readonly privateKeyPem: string;
  private counter = 0;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.credential = {
      x: BigInt(`0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`),
      y: BigInt(`0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`),
      authenticatorIdHash: keccak256(toHex(randomBytes(32))),
    };
  }

  sign = (challenge: Hex): Hex => {
    this.counter += 1;
    const authData = Buffer.concat([
      createHash("sha256").update(RP_ID).digest(),
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, this.counter]),
    ]);
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challenge.slice(2), "hex").toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    });
    const digestInput = Buffer.concat([
      authData,
      createHash("sha256").update(Buffer.from(clientData)).digest(),
    ]);
    const raw = sign("sha256", digestInput, { key: this.privateKeyPem, dsaEncoding: "ieee-p1363" });
    const r = BigInt(bytesToHex(raw.subarray(0, 32)));
    let s = BigInt(bytesToHex(raw.subarray(32)));
    if (s > P256_N / 2n) s = P256_N - s; // low-s
    return encodeAbiParameters(
      [
        { type: "bytes" },
        { type: "string" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bool" },
      ],
      [bytesToHex(authData), clientData, 1n, r, s, true],
    );
  };
}

/** A raw P-256 device key: signs the exact Kaada device-key payload (SHA256withECDSA), low-s, keyId || r || s. */
export class SoftDevice {
  readonly point: DeviceKeyPoint;
  readonly keyId: Hex;
  private readonly privateKeyPem: string;

  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    this.privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    this.point = {
      x: BigInt(`0x${Buffer.from(jwk.x ?? "", "base64url").toString("hex")}`),
      y: BigInt(`0x${Buffer.from(jwk.y ?? "", "base64url").toString("hex")}`),
    };
    this.keyId = deviceKeyIdFromPoint(this.point);
  }

  /** A signer for one (chain, validator instance, account): the Kernel hands it the userOpHash. */
  signer =
    (chainId: number, validator: Address, account: Address) =>
    (userOpHash: Hex): Hex => {
      const payload = deviceKeyPayload({
        chainId,
        validator,
        account,
        keyId: this.keyId,
        userOpHash,
      });
      const raw = sign("sha256", Buffer.from(payload.slice(2), "hex"), {
        key: this.privateKeyPem,
        dsaEncoding: "ieee-p1363",
      });
      const r = BigInt(bytesToHex(raw.subarray(0, 32)));
      let s = BigInt(bytesToHex(raw.subarray(32)));
      if (s > P256_N / 2n) s = P256_N - s;
      return concat([this.keyId, pad(toHex(r), { size: 32 }), pad(toHex(s), { size: 32 })]);
    };
}
