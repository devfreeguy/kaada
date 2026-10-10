import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

import { isoCBOR } from "@simplewebauthn/server/helpers";

/*
 * A software WebAuthn authenticator for tests: it produces real attestation and assertion responses
 * (ES256 / P-256) that the real verifier accepts. It exists only in tests; its private key is a local
 * variable that is discarded with the test, and nothing here is production code.
 */

const b64u = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | Buffer | string) => createHash("sha256").update(data).digest();

export interface SoftwareAuthenticator {
  credentialId: string;
  /** Public coordinates, lower-case hex. */
  x: string;
  y: string;
  register(options: {
    challenge: string;
    origin: string;
    rpId: string;
    userVerified?: boolean;
    counter?: number;
  }): unknown;
  authenticate(options: {
    challenge: string;
    origin: string;
    rpId: string;
    counter: number;
    userVerified?: boolean;
  }): unknown;
}

export function createSoftwareAuthenticator(): SoftwareAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const xBytes = Buffer.from(jwk.x ?? "", "base64url");
  const yBytes = Buffer.from(jwk.y ?? "", "base64url");
  const credentialIdBytes = randomBytes(32);
  const credentialId = b64u(credentialIdBytes);

  const flags = (userVerified: boolean, attested: boolean) =>
    0x01 | (userVerified ? 0x04 : 0) | (attested ? 0x40 : 0);

  const counterBytes = (counter: number) => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(counter);
    return buffer;
  };

  return {
    credentialId,
    x: xBytes.toString("hex"),
    y: yBytes.toString("hex"),

    register({ challenge, origin, rpId, userVerified = true, counter = 0 }) {
      const cose = isoCBOR.encode(
        new Map<number, number | Uint8Array>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, new Uint8Array(xBytes)],
          [-3, new Uint8Array(yBytes)],
        ]),
      );
      const credentialIdLength = Buffer.alloc(2);
      credentialIdLength.writeUInt16BE(credentialIdBytes.length);
      const authData = Buffer.concat([
        sha256(rpId),
        Buffer.from([flags(userVerified, true)]),
        counterBytes(counter),
        Buffer.alloc(16), // AAGUID
        credentialIdLength,
        credentialIdBytes,
        Buffer.from(cose),
      ]);
      const attestationObject = isoCBOR.encode(
        new Map<string | number, string | Uint8Array | Map<string | number, string>>([
          ["fmt", "none"],
          ["attStmt", new Map<string | number, string>()],
          ["authData", new Uint8Array(authData)],
        ]),
      );
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false }),
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
      };
    },

    authenticate({ challenge, origin, rpId, counter, userVerified = true }) {
      const authenticatorData = Buffer.concat([
        sha256(rpId),
        Buffer.from([flags(userVerified, false)]),
        counterBytes(counter),
      ]);
      const clientDataJSON = Buffer.from(
        JSON.stringify({ type: "webauthn.get", challenge, origin, crossOrigin: false }),
      );
      const signature = sign(
        "sha256",
        Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
        privateKey,
      );
      return {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: b64u(clientDataJSON),
          authenticatorData: b64u(authenticatorData),
          signature: b64u(signature),
        },
      };
    },
  };
}
