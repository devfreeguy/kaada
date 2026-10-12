// Off-chain half of KaadaDeviceKeyValidator: the exact signing payload, the install data, the signature layout,
// signature normalisation for platform keystores, and the security tier a backend assigns to an enrolled key.
import {
  concat,
  encodeAbiParameters,
  getAddress,
  keccak256,
  pad,
  sha256,
  stringToHex,
  toHex,
} from "viem";
import type { Address, Hex } from "viem";

/** ASCII domain tag and version: the first 17 bytes of every signed payload. */
export const DEVICE_KEY_DOMAIN_TAG = "KaadaDeviceKey/v1";
export const DEVICE_KEY_VERSION = 1;
export const DEVICE_KEY_MAX_KEYS = 16;
/** P-256 group order and its half (the low-s bound). */
export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N = P256_N / 2n;

export interface DeviceKeyPoint {
  x: bigint;
  y: bigint;
}

export interface DeviceSigningInput {
  chainId: bigint | number;
  /** The validator instance (the clone address when the root is a clone). */
  validator: Address;
  /** The Kernel account. */
  account: Address;
  keyId: Hex;
  /** The ERC-4337 userOpHash. */
  userOpHash: Hex;
}

/**
 * The exact 153 bytes a device key signs with ECDSA P-256 / SHA-256:
 *   "KaadaDeviceKey/v1" (17) || chainId (32, big-endian) || validator (20) || account (20) || keyId (32) || userOpHash (32)
 * Every platform keystore hashes the message with SHA-256 itself, so clients pass THIS payload as the message.
 */
export function deviceKeyPayload(input: DeviceSigningInput): Hex {
  const payload = concat([
    stringToHex(DEVICE_KEY_DOMAIN_TAG),
    pad(toHex(BigInt(input.chainId)), { size: 32 }),
    getAddress(input.validator),
    getAddress(input.account),
    pad(input.keyId, { size: 32 }),
    pad(input.userOpHash, { size: 32 }),
  ]);
  return payload;
}

/** What the contract hands the RIP-7212 precompile: sha256(payload). */
export const deviceKeyDigest = (input: DeviceSigningInput): Hex => sha256(deviceKeyPayload(input));

/** The validator's `onInstall` data: abi.encode(x, y, keyId) (96 bytes; same shape as the passkey install data). */
export function deviceKeyInstallData(point: DeviceKeyPoint, keyId: Hex): Hex {
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
    [point.x, point.y, keyId],
  );
}

/** `userOp.signature`: keyId (32) || r (32) || s (32). `s` must already be low-s. */
export function deviceKeySignature(keyId: Hex, r: bigint, s: bigint): Hex {
  if (s > P256_HALF_N) throw new Error("s must be low-s: normalise it first");
  return concat([
    pad(keyId, { size: 32 }),
    pad(toHex(r), { size: 32 }),
    pad(toHex(s), { size: 32 }),
  ]);
}

/** Platform signers (WebCrypto, Secure Enclave, Keystore) can return a high-s signature: flip it. */
export const normalizeLowS = (s: bigint): bigint => (s > P256_HALF_N ? P256_N - s : s);

/** Parses an ASN.1 DER ECDSA signature (iOS SecKey, Android Signature) into r and s. */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  let i = 0;
  const expect = (value: number, what: string) => {
    if (der[i++] !== value) throw new Error(`malformed DER signature: ${what}`);
  };
  const length = () => {
    const first = der[i++];
    if (first === undefined) throw new Error("malformed DER signature: truncated");
    if (first < 0x80) return first;
    if (first !== 0x81) throw new Error("malformed DER signature: length");
    const next = der[i++];
    if (next === undefined) throw new Error("malformed DER signature: truncated");
    return next;
  };
  expect(0x30, "sequence");
  if (length() !== der.length - i) throw new Error("malformed DER signature: total length");
  const integer = (): bigint => {
    expect(0x02, "integer");
    const size = length();
    if (size === 0 || i + size > der.length) throw new Error("malformed DER signature: integer");
    const bytes = der.subarray(i, i + size);
    i += size;
    return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
  };
  const r = integer();
  const s = integer();
  if (i !== der.length) throw new Error("malformed DER signature: trailing bytes");
  return { r, s };
}

/** A convenient keyId: a hash of the public point, so the same device key always gets the same id. */
export function deviceKeyIdFromPoint(point: DeviceKeyPoint): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }],
      [keccak256(stringToHex("kaada.device-key-id")), point.x, point.y],
    ),
  );
}

// ── security tier ──────────────────────────────────────────────────────────────────────────────────

/**
 * How much the backend can vouch for where a device key lives. Never taken from a client claim.
 *  - `trusted-device`: a platform attestation (Apple App Attest / Android Key Attestation) was VERIFIED by the backend
 *    and it binds exactly this public key to a hardware-backed, non-exportable key.
 *  - `web-non-extractable`: enrolled through the web flow with a non-extractable WebCrypto key. Not attested: browser
 *    JavaScript (or an XSS) on the origin can still ask the key to sign, and the browser storage is not hardware.
 *  - `unknown`: anything else, including a native client whose attestation was missing or failed to verify.
 */
export type DeviceKeyTier = "trusted-device" | "web-non-extractable" | "unknown";

export const DEVICE_KEY_TIER_RANK: Readonly<Record<DeviceKeyTier, number>> = {
  unknown: 0,
  "web-non-extractable": 1,
  "trusted-device": 2,
};

/** Where the enrolment request came from, as observed by the SERVER (the route it arrived on), not as claimed. */
export type EnrolmentChannel = "native-ios" | "native-android" | "web" | "unknown";

export interface AttestationEvidence {
  platform: "ios" | "android";
  /** Opaque platform evidence (App Attest object, Android certificate chain), verified only by the verifier. */
  payload: string;
  /** The server-issued challenge the evidence must be bound to. */
  challenge: Hex;
}

/** What a real verifier reports. Only a verifier can produce it; the flags a client sends are never used. */
export interface VerifiedAttestation {
  /** The attested public key equals the key being enrolled. */
  publicKeyMatches: boolean;
  /** The key is generated and held in secure hardware (Secure Enclave, TEE or StrongBox) and cannot be exported. */
  hardwareBacked: boolean;
  /** The evidence was bound to the server's challenge (freshness). */
  challengeMatches: boolean;
}

export interface AttestationVerifier {
  verify(evidence: AttestationEvidence, point: DeviceKeyPoint): Promise<VerifiedAttestation | null>;
}

/**
 * Assigns the tier. Without a verifier, without evidence, on a verifier error or on any mismatch the key is NOT
 * `trusted-device`; a web enrolment is `web-non-extractable` and everything else `unknown`.
 */
export async function classifyDeviceKey(input: {
  channel: EnrolmentChannel;
  point: DeviceKeyPoint;
  evidence?: AttestationEvidence | undefined;
  verifier?: AttestationVerifier | undefined;
}): Promise<DeviceKeyTier> {
  const fallback: DeviceKeyTier = input.channel === "web" ? "web-non-extractable" : "unknown";
  const native = input.channel === "native-ios" || input.channel === "native-android";
  if (!native || !input.evidence || !input.verifier) return fallback;
  const expected = input.channel === "native-ios" ? "ios" : "android";
  if (input.evidence.platform !== expected) return fallback;
  try {
    const result = await input.verifier.verify(input.evidence, input.point);
    if (result?.publicKeyMatches && result.hardwareBacked && result.challengeMatches) {
      return "trusted-device";
    }
  } catch {
    // a verifier failure is never an upgrade
  }
  return fallback;
}
