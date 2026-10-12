import { createHash, timingSafeEqual } from "node:crypto";

import { decodeCBOR } from "@levischuck/tiny-cbor";

import { extensionValue, sha256Hex, verifyCertificateChain } from "./chain.js";
import type { ChainRejection } from "./chain.js";
import { APPLE_APP_ATTEST_ROOT } from "./roots.js";
import type { TrustAnchor } from "./roots.js";

/** Bump when the rules below change. */
export const IOS_VERIFIER_VERSION = 1;

/**
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * Apple App Attest attests an *App Attest key*: a separate Secure Enclave key whose private half the app can only use to sign
 * assertions. It cannot attest the Secure Enclave wallet key Kaada signs payments with, and iOS offers no attestation for
 * that key. The wallet key's public point is therefore bound by CLAIM: it is hashed into the clientDataHash the genuine app
 * instance asked Apple to attest. A verified result reads: "a genuine Kaada app, on genuine Apple hardware, presented this
 * wallet public key for this challenge". It does NOT read: "this wallet key is in the Secure Enclave". That is why the
 * resulting tier is APP_ATTESTED_DEVICE and never TRUSTED_DEVICE.
 */
export const IOS_CLIENT_DATA_PREFIX = "KaadaAppAttest/v1";

export type IosRejection =
  | ChainRejection
  | "ATTESTATION_MALFORMED"
  | "FORMAT_UNSUPPORTED"
  | "NONCE_MISSING"
  | "NONCE_MISMATCH"
  | "KEY_ID_MISMATCH"
  | "APP_NOT_ALLOWED"
  | "COUNTER_NOT_ZERO"
  | "ENVIRONMENT_NOT_ALLOWED"
  | "CREDENTIAL_ID_MISMATCH";

export interface IosAttestationPolicy {
  /** Allowed App IDs, "TEAMID.com.bundle.id". Empty means nothing is allowed. */
  appIds: readonly string[];
  /** Accept the sandbox (appattestdevelop) environment. Never in production. */
  allowDevelopment: boolean;
  anchor?: TrustAnchor;
}

export interface IosAttestationInput {
  /** Base64 of the CBOR attestation object from `DCAppAttestService.attestKey`. */
  attestationObject: string;
  /** Base64 of the App Attest key identifier (`generateKey`). */
  keyId: string;
  /** The server's nonce. */
  challenge: Uint8Array;
  /** The Secure Enclave wallet public key the app presents (claimed, not attested). */
  publicKey: { x: string; y: string };
  policy: IosAttestationPolicy;
  now: Date;
}

export interface IosAttestationFacts {
  environment: "production" | "development";
  appId: string;
  /** SHA-256 of the App Attest key point (the keyId). Identifies the app instance, NOT the wallet key. */
  appAttestKeyHash: string;
  /** SHA-256 of the claimed wallet key point. */
  publicKeyHash: string;
  chainHashes: string[];
  trustAnchor: string;
}

export type IosAttestationResult =
  | { verdict: "REJECTED"; code: IosRejection }
  | {
      verdict: "VERIFIED";
      facts: IosAttestationFacts;
      /** Always false: App Attest never proves the wallet key's protection. Present so callers cannot forget it. */
      provesWalletKeyHardware: false;
    };

const NONCE_OID = "1.2.840.113635.100.8.2";
const AAGUID_PRODUCTION = Buffer.from("appattest\0\0\0\0\0\0\0", "latin1");
const AAGUID_DEVELOPMENT = Buffer.from("appattestdevelop", "latin1");
// DER of the nonce extension value: SEQUENCE { [1] EXPLICIT OCTET STRING (32 bytes) }.
const NONCE_PREFIX = Buffer.from("3024a1220420", "hex");

const sha256 = (...parts: Uint8Array[]): Buffer => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
};
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

export function iosClientDataHash(challenge: Uint8Array, point: { x: string; y: string }): Buffer {
  return sha256(
    Buffer.from(IOS_CLIENT_DATA_PREFIX, "utf8"),
    challenge,
    Buffer.from(point.x, "hex"),
    Buffer.from(point.y, "hex"),
  );
}

export function verifyAppAttest(input: IosAttestationInput): IosAttestationResult {
  const reject = (code: IosRejection): IosAttestationResult => ({ verdict: "REJECTED", code });
  const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
  if (!base64.test(input.attestationObject) || !base64.test(input.keyId)) {
    return reject("ATTESTATION_MALFORMED");
  }

  let decoded: unknown;
  try {
    decoded = decodeCBOR(new Uint8Array(Buffer.from(input.attestationObject, "base64")));
  } catch {
    return reject("ATTESTATION_MALFORMED");
  }
  if (!(decoded instanceof Map)) return reject("ATTESTATION_MALFORMED");
  if (decoded.get("fmt") !== "apple-appattest") return reject("FORMAT_UNSUPPORTED");
  const statement: unknown = decoded.get("attStmt");
  const authData: unknown = decoded.get("authData");
  if (!(statement instanceof Map) || !(authData instanceof Uint8Array)) {
    return reject("ATTESTATION_MALFORMED");
  }
  const x5c: unknown = statement.get("x5c");
  if (
    !Array.isArray(x5c) ||
    x5c.length < 2 ||
    !x5c.every((entry): entry is Uint8Array => entry instanceof Uint8Array)
  ) {
    return reject("ATTESTATION_MALFORMED");
  }

  const anchor = input.policy.anchor ?? APPLE_APP_ATTEST_ROOT;
  const chain = verifyCertificateChain({ chain: x5c, anchors: [anchor], now: input.now });
  if (!chain.ok) return reject(chain.code);
  const [credential] = chain.certificates;
  if (!credential) return reject("ATTESTATION_MALFORMED");

  // The nonce Apple signed into the credential certificate must be SHA256(authData || clientDataHash).
  const expectedNonce = sha256(authData, iosClientDataHash(input.challenge, input.publicKey));
  const nonceValue = extensionValue(credential, NONCE_OID);
  if (nonceValue === undefined || nonceValue === null) return reject("NONCE_MISSING");
  const nonce = Buffer.from(nonceValue);
  if (
    nonce.length !== NONCE_PREFIX.length + 32 ||
    !same(nonce.subarray(0, NONCE_PREFIX.length), NONCE_PREFIX) ||
    !same(nonce.subarray(NONCE_PREFIX.length), expectedNonce)
  ) {
    return reject("NONCE_MISMATCH");
  }

  // keyId is SHA256 of the credential public key (uncompressed point), and must be the key the app named.
  const jwk = credential.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    return reject("ATTESTATION_MALFORMED");
  }
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const keyHash = sha256(point);
  if (!same(keyHash, Buffer.from(input.keyId, "base64"))) return reject("KEY_ID_MISMATCH");

  // authData: rpIdHash(32) flags(1) counter(4) aaguid(16) credentialIdLength(2) credentialId(n) ...
  if (authData.length < 55) return reject("ATTESTATION_MALFORMED");
  const data = Buffer.from(authData);
  const rpIdHash = data.subarray(0, 32);
  const counter = data.readUInt32BE(33);
  const aaguid = data.subarray(37, 53);
  const idLength = data.readUInt16BE(53);
  const credentialId = data.subarray(55, 55 + idLength);
  if (credentialId.length !== idLength) return reject("ATTESTATION_MALFORMED");

  const appId = input.policy.appIds.find((candidate) =>
    same(sha256(Buffer.from(candidate, "utf8")), rpIdHash),
  );
  if (!appId) return reject("APP_NOT_ALLOWED");
  if (counter !== 0) return reject("COUNTER_NOT_ZERO");
  const environment = same(aaguid, AAGUID_PRODUCTION)
    ? "production"
    : same(aaguid, AAGUID_DEVELOPMENT)
      ? "development"
      : null;
  if (!environment) return reject("ENVIRONMENT_NOT_ALLOWED");
  if (environment === "development" && !input.policy.allowDevelopment) {
    return reject("ENVIRONMENT_NOT_ALLOWED");
  }
  if (!same(credentialId, keyHash)) return reject("CREDENTIAL_ID_MISMATCH");

  return {
    verdict: "VERIFIED",
    provesWalletKeyHardware: false,
    facts: {
      environment,
      appId,
      appAttestKeyHash: keyHash.toString("hex"),
      publicKeyHash: sha256(
        Buffer.from(`${input.publicKey.x}${input.publicKey.y}`, "hex"),
      ).toString("hex"),
      chainHashes: chain.certificates.map((c) => sha256Hex(c.raw)),
      trustAnchor: chain.anchor.sha256,
    },
  };
}
