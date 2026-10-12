import { createHash, timingSafeEqual } from "node:crypto";

import { AsnConvert } from "@peculiar/asn1-schema";
import {
  AttestationApplicationId,
  KeyDescription,
  NonStandardKeyDescription,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from "@peculiar/asn1-android";
import type { AuthorizationList } from "@peculiar/asn1-android";

import { extensionValue, sha256Hex, verifyCertificateChain } from "./chain.js";
import type { ChainRejection } from "./chain.js";
import { GOOGLE_ANDROID_ROOTS } from "./roots.js";
import type { TrustAnchor } from "./roots.js";

/** Bump when the rules below change. Stored with every result, so an old result can be re-evaluated against a new policy. */
export const ANDROID_VERIFIER_VERSION = 1;

/** What the hardware says about where the key lives. */
export type AndroidHardwareLevel = "STRONGBOX" | "TEE" | "SOFTWARE";

export interface AndroidApplication {
  packageName: string;
  /** SHA-256 digests (hex) of the app's signing certificates. The attested set must be a non-empty subset of these. */
  signatureDigests: readonly string[];
}

export interface AndroidAttestationPolicy {
  /** The apps whose keys Kaada trusts. Empty means no key can qualify (it can still be authentic). */
  applications: readonly AndroidApplication[];
  /** The weakest hardware level that qualifies. Default TEE. */
  minimumLevel: "TEE" | "STRONGBOX";
  /** Keymaster 3 (attestation version 3) is the first with the properties relied on here. */
  minimumAttestationVersion: number;
  /** Require a locked bootloader and verified boot. Default true. */
  requireVerifiedBoot: boolean;
  /** Trust anchors. Default: Google's. Tests inject their own; production never does. */
  anchors?: readonly TrustAnchor[];
}

export const DEFAULT_ANDROID_POLICY: Omit<AndroidAttestationPolicy, "applications"> = {
  minimumLevel: "TEE",
  minimumAttestationVersion: 3,
  requireVerifiedBoot: true,
};

/** Why evidence was REFUSED: it is not authentic evidence for THIS key and THIS challenge. */
export type AndroidRejection =
  | ChainRejection
  | "CERTIFICATE_REVOKED"
  | "REVOCATION_UNAVAILABLE"
  | "KEY_DESCRIPTION_MISSING"
  | "KEY_DESCRIPTION_MALFORMED"
  | "CHALLENGE_MISMATCH"
  | "PUBLIC_KEY_MISMATCH"
  | "PUBLIC_KEY_NOT_P256"
  | "KEY_PREDATES_CHALLENGE";

/** Why authentic evidence still does not QUALIFY for the trusted tier (recorded; never an upgrade). */
export type AndroidShortfall =
  | "NOT_HARDWARE_BACKED"
  | "BELOW_MINIMUM_LEVEL"
  | "ATTESTATION_VERSION_TOO_OLD"
  | "KEY_NOT_GENERATED_ON_DEVICE"
  | "KEY_PURPOSE_NOT_SIGN_ONLY"
  | "KEY_NOT_EC_P256"
  | "KEY_DIGEST_NOT_SHA256"
  | "KEY_PROPERTIES_NOT_HARDWARE_ENFORCED"
  | "BOOT_NOT_VERIFIED"
  | "BOOTLOADER_UNLOCKED"
  | "APP_IDENTITY_NOT_CONFIGURED"
  | "APP_IDENTITY_MISSING"
  | "APP_NOT_ALLOWED"
  | "APP_SIGNATURE_NOT_ALLOWED";

export interface AndroidAttestationFacts {
  attestationVersion: number;
  attestationSecurityLevel: AndroidHardwareLevel;
  keymasterSecurityLevel: AndroidHardwareLevel;
  /** The weaker of the two: what the key can honestly be said to be protected by. */
  hardwareLevel: AndroidHardwareLevel;
  verifiedBootState: "VERIFIED" | "SELF_SIGNED" | "UNVERIFIED" | "FAILED" | "ABSENT";
  deviceLocked: boolean | null;
  osPatchLevel: number | null;
  packageName: string | null;
  signatureDigests: string[];
  /** SHA-256 of the attested public key point (x || y). */
  publicKeyHash: string;
  /** SHA-256 of each certificate, leaf first, and of the trust anchor that accepted the chain. */
  chainHashes: string[];
  trustAnchor: string;
}

export type AndroidAttestationResult =
  | { verdict: "REJECTED"; code: AndroidRejection }
  | {
      verdict: "VERIFIED";
      facts: AndroidAttestationFacts;
      /** True only when the evidence proves a hardware-backed, sign-only, device-generated P-256 key of an allowed app. */
      qualifies: boolean;
      shortfalls: AndroidShortfall[];
    };

export interface AndroidRevocationSource {
  /** Whether Google has revoked this certificate serial (lower-case hex, no leading zeros). Throws when it cannot be known. */
  isRevoked(serialHex: string): Promise<boolean>;
}

export interface AndroidAttestationInput {
  /** Base64 DER certificates, leaf first, exactly as the device returned them. */
  certificateChain: readonly string[];
  /** The server's nonce, as the raw bytes the device passed to `setAttestationChallenge`. */
  challenge: Uint8Array;
  /** The public key being enrolled. */
  publicKey: { x: string; y: string };
  policy: AndroidAttestationPolicy;
  now: Date;
  /** When the challenge was issued: a key generated before it cannot have been made for it. */
  challengeIssuedAt?: Date;
  revocation?: AndroidRevocationSource;
}

const SECURITY_LEVELS: Record<number, AndroidHardwareLevel> = {
  [SecurityLevel.software]: "SOFTWARE",
  [SecurityLevel.trustedEnvironment]: "TEE",
  [SecurityLevel.strongBox]: "STRONGBOX",
};
const LEVEL_RANK: Record<AndroidHardwareLevel, number> = { SOFTWARE: 0, TEE: 1, STRONGBOX: 2 };
const BOOT_STATES = ["VERIFIED", "SELF_SIGNED", "UNVERIFIED", "FAILED"] as const;

// Android Keystore constants (KeyProperties / keymaster tags).
const PURPOSE_SIGN = 2;
const PURPOSE_VERIFY = 3;
const ALGORITHM_EC = 3;
const CURVE_P256 = 1;
const DIGEST_SHA256 = 4;
const ORIGIN_GENERATED = 0;

/** The schema library yields an OctetString wrapper in some structures and a bare ArrayBuffer in others. */
const bytesOf = (
  value: ArrayBuffer | { buffer: ArrayBuffer } | undefined,
): Uint8Array | undefined => {
  if (value === undefined) return undefined;
  return new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer);
};

const equal = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && timingSafeEqual(a, b);

const level = (value: number): AndroidHardwareLevel => SECURITY_LEVELS[value] ?? "SOFTWARE";

function parseKeyDescription(value: Uint8Array): KeyDescription | null {
  try {
    return AsnConvert.parse(value, KeyDescription);
  } catch {
    try {
      // Some devices emit the authorization lists in a non-standard order.
      const odd = AsnConvert.parse(value, NonStandardKeyDescription);
      const pick = (
        list: { items?: unknown[] } & Iterable<AuthorizationList>,
      ): AuthorizationList => {
        const merged: Record<string, unknown> = {};
        for (const entry of list) Object.assign(merged, entry);
        return merged;
      };
      return {
        attestationVersion: odd.attestationVersion,
        attestationSecurityLevel: odd.attestationSecurityLevel,
        keymasterVersion: odd.keymasterVersion,
        keymasterSecurityLevel: odd.keymasterSecurityLevel,
        attestationChallenge: odd.attestationChallenge,
        uniqueId: odd.uniqueId,
        softwareEnforced: pick(odd.softwareEnforced),
        teeEnforced: pick(odd.teeEnforced),
      };
    } catch {
      return null;
    }
  }
}

function serialHex(serialNumber: string): string {
  return serialNumber.replace(/^0+/, "").toLowerCase() || "0";
}

/**
 * Verifies Android hardware key attestation for ONE P-256 key and ONE server challenge.
 *
 * What a VERIFIED result proves: a certificate chain to a pinned Google root vouches (and no certificate is revoked) that a key
 * with exactly this public point exists in the Android Keystore, that it was attested for exactly this challenge, and what the
 * secure hardware says about it (security level, how it was made, what it may do, the boot state, which app holds it).
 * `qualifies` adds the Kaada policy on top of that. It proves nothing about the person, and nothing here is taken from the
 * client but the chain itself.
 */
export async function verifyAndroidKeyAttestation(
  input: AndroidAttestationInput,
): Promise<AndroidAttestationResult> {
  const reject = (code: AndroidRejection): AndroidAttestationResult => ({
    verdict: "REJECTED",
    code,
  });

  let ders: Uint8Array[];
  try {
    ders = input.certificateChain.map((b64) => {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("not base64");
      return new Uint8Array(Buffer.from(b64, "base64"));
    });
  } catch {
    return reject("CHAIN_MALFORMED");
  }

  const chain = verifyCertificateChain({
    chain: ders,
    anchors: input.policy.anchors ?? GOOGLE_ANDROID_ROOTS,
    now: input.now,
  });
  if (!chain.ok) return reject(chain.code);
  const [leaf] = chain.certificates;
  if (!leaf) return reject("CHAIN_MALFORMED");

  if (input.revocation) {
    for (const certificate of chain.certificates) {
      try {
        if (await input.revocation.isRevoked(serialHex(certificate.serialNumber))) {
          return reject("CERTIFICATE_REVOKED");
        }
      } catch {
        // Not knowing is not "not revoked": the evidence cannot be trusted until it can be checked.
        return reject("REVOCATION_UNAVAILABLE");
      }
    }
  }

  const raw = extensionValue(leaf, id_ce_keyDescription);
  if (raw === undefined || raw === null) return reject("KEY_DESCRIPTION_MISSING");
  const description = parseKeyDescription(raw);
  if (!description) return reject("KEY_DESCRIPTION_MALFORMED");

  // The leaf's own public key is THE attested key: it must be the one being enrolled, and a P-256 point.
  const jwk = leaf.publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y)
    return reject("PUBLIC_KEY_NOT_P256");
  const attested = Buffer.concat([
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]);
  const expected = Buffer.from(`${input.publicKey.x}${input.publicKey.y}`, "hex");
  if (expected.length !== 64 || !equal(attested, expected)) return reject("PUBLIC_KEY_MISMATCH");

  const challenge = bytesOf(description.attestationChallenge);
  if (!challenge || !equal(challenge, input.challenge)) return reject("CHALLENGE_MISMATCH");

  const soft = description.softwareEnforced;
  const tee = description.teeEnforced;
  if (input.challengeIssuedAt) {
    const created = tee.creationDateTime ?? soft.creationDateTime;
    // A key that already existed when the challenge was issued was not made for it (a generous minute for clock skew).
    if (created !== undefined && created < input.challengeIssuedAt.getTime() - 60_000) {
      return reject("KEY_PREDATES_CHALLENGE");
    }
  }

  const attestationLevel = level(description.attestationSecurityLevel);
  const keymasterLevel = level(description.keymasterSecurityLevel);
  const hardwareLevel =
    LEVEL_RANK[attestationLevel] <= LEVEL_RANK[keymasterLevel] ? attestationLevel : keymasterLevel;

  const shortfalls: AndroidShortfall[] = [];
  if (hardwareLevel === "SOFTWARE") shortfalls.push("NOT_HARDWARE_BACKED");
  else if (LEVEL_RANK[hardwareLevel] < LEVEL_RANK[input.policy.minimumLevel]) {
    shortfalls.push("BELOW_MINIMUM_LEVEL");
  }
  const version = Number(description.attestationVersion);
  if (version < input.policy.minimumAttestationVersion)
    shortfalls.push("ATTESTATION_VERSION_TOO_OLD");

  // The properties that matter are read from the HARDWARE-enforced list only: a property in the software list was enforced by
  // Android code, not by the secure hardware, however it is worded.
  const purposes = [...(tee.purpose ?? [])];
  if (
    !purposes.includes(PURPOSE_SIGN) ||
    purposes.some((p) => p !== PURPOSE_SIGN && p !== PURPOSE_VERIFY)
  ) {
    shortfalls.push(
      soft.purpose !== undefined
        ? "KEY_PROPERTIES_NOT_HARDWARE_ENFORCED"
        : "KEY_PURPOSE_NOT_SIGN_ONLY",
    );
  }
  if (tee.algorithm !== ALGORITHM_EC || (tee.ecCurve !== CURVE_P256 && tee.keySize !== 256)) {
    shortfalls.push(
      tee.algorithm === undefined ? "KEY_PROPERTIES_NOT_HARDWARE_ENFORCED" : "KEY_NOT_EC_P256",
    );
  }
  if (tee.digest !== undefined && ![...tee.digest].includes(DIGEST_SHA256)) {
    shortfalls.push("KEY_DIGEST_NOT_SHA256");
  }
  if (tee.origin !== ORIGIN_GENERATED) shortfalls.push("KEY_NOT_GENERATED_ON_DEVICE");

  const root = tee.rootOfTrust;
  const bootState = root ? (BOOT_STATES[root.verifiedBootState] ?? "FAILED") : "ABSENT";
  if (input.policy.requireVerifiedBoot) {
    if (bootState !== "VERIFIED") shortfalls.push("BOOT_NOT_VERIFIED");
    if (root?.deviceLocked !== true) shortfalls.push("BOOTLOADER_UNLOCKED");
  }

  let packageName: string | null = null;
  let signatureDigests: string[] = [];
  const appId = bytesOf(soft.attestationApplicationId) ?? bytesOf(tee.attestationApplicationId);
  if (appId) {
    try {
      const parsed = AsnConvert.parse(appId, AttestationApplicationId);
      const packages = [...parsed.packageInfos].map((p) =>
        Buffer.from(bytesOf(p.packageName) ?? []).toString("utf8"),
      );
      packageName = packages.length === 1 ? (packages[0] ?? null) : null;
      signatureDigests = [...parsed.signatureDigests].map((d) =>
        Buffer.from(bytesOf(d) ?? []).toString("hex"),
      );
    } catch {
      packageName = null;
    }
  }
  if (input.policy.applications.length === 0) shortfalls.push("APP_IDENTITY_NOT_CONFIGURED");
  else if (!packageName || signatureDigests.length === 0) shortfalls.push("APP_IDENTITY_MISSING");
  else {
    const app = input.policy.applications.find((a) => a.packageName === packageName);
    if (!app) shortfalls.push("APP_NOT_ALLOWED");
    else if (!signatureDigests.every((d) => app.signatureDigests.includes(d))) {
      shortfalls.push("APP_SIGNATURE_NOT_ALLOWED");
    }
  }

  return {
    verdict: "VERIFIED",
    qualifies: shortfalls.length === 0,
    shortfalls,
    facts: {
      attestationVersion: version,
      attestationSecurityLevel: attestationLevel,
      keymasterSecurityLevel: keymasterLevel,
      hardwareLevel,
      verifiedBootState: bootState,
      deviceLocked: root ? root.deviceLocked : null,
      osPatchLevel: tee.osPatchLevel ?? soft.osPatchLevel ?? null,
      packageName,
      signatureDigests,
      publicKeyHash: createHash("sha256").update(expected).digest("hex"),
      chainHashes: chain.certificates.map((c) => sha256Hex(c.raw)),
      trustAnchor: chain.anchor.sha256,
    },
  };
}

export { VerifiedBootState };
