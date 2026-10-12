/*
 * Device attestation: how Kaada decides, from PROOF, where a device key lives. Nothing a client says ever raises a tier:
 * the only upgrade source is a verifier's result for a one-time server challenge, and a tier is never raised after the
 * credential exists (an existing key cannot be re-attested: the attestation is made when the key is generated).
 */
import type { DeviceSecurityTier } from "../recovery/credential.js";

export const ATTESTATION_PLATFORMS = ["ANDROID", "IOS"] as const;
export type AttestationPlatform = (typeof ATTESTATION_PLATFORMS)[number];

/** Which enrolment the challenge was issued for. A challenge for one purpose is useless for another. */
export const ATTESTATION_CHALLENGE_PURPOSES = [
  "ROOT_ENROLLMENT",
  "BACKUP_ENROLLMENT",
  "RECOVERY_ROOT",
] as const;
export type AttestationChallengePurpose = (typeof ATTESTATION_CHALLENGE_PURPOSES)[number];

/**
 * - VERIFIED_QUALIFIED:     authentic evidence for this key and challenge, and it meets the accepted hardware policy.
 * - VERIFIED_NOT_QUALIFIED: authentic evidence, but the policy is not met (software key, unlocked bootloader, unknown app...).
 * - REJECTED:               not authentic evidence for this key and challenge (bad chain, wrong challenge, wrong key, revoked...).
 */
export const ATTESTATION_RESULTS = [
  "VERIFIED_QUALIFIED",
  "VERIFIED_NOT_QUALIFIED",
  "REJECTED",
] as const;
export type AttestationResult = (typeof ATTESTATION_RESULTS)[number];

/** Where an Android key lives. Absent where the platform does not prove it (iOS). */
export type HardwareLevel = "STRONGBOX" | "TEE" | "SOFTWARE";

export interface AttestationChallenge {
  id: string;
  userId: string;
  /** Absent only for the very first wallet of a person (it does not exist yet). */
  walletId?: string;
  platform: AttestationPlatform;
  purpose: AttestationChallengePurpose;
  /** 32 random bytes, hex. The value the device passes to the platform attestation API. */
  nonce: string;
  expiresAt: Date;
  /** Set exactly once, by the single caller that wins the consumption. */
  consumedAt?: Date;
  /** The hash of the public key the evidence was presented for, recorded at consumption. */
  consumedPublicKeyHash?: string;
  createdAt: Date;
}

export type NewAttestationChallenge = Omit<
  AttestationChallenge,
  "consumedAt" | "consumedPublicKeyHash" | "createdAt"
>;

export interface ConsumeAttestationChallenge {
  id: string;
  userId: string;
  walletId?: string | undefined;
  platform: AttestationPlatform;
  purpose: AttestationChallengePurpose;
  publicKeyHash: string;
  now: Date;
}

export interface DeviceAttestation {
  id: string;
  userId: string;
  walletId?: string;
  challengeId: string;
  platform: AttestationPlatform;
  /** ANDROID_KEY_ATTESTATION | IOS_APP_ATTEST */
  attestationType: string;
  /** The keyId (0x + 64 hex) of the credential the evidence was presented for. */
  credentialRef: string;
  /** SHA-256 of the public key point (x || y), hex. */
  publicKeyHash: string;
  result: AttestationResult;
  /** The machine-readable reason for REJECTED, or the shortfalls of VERIFIED_NOT_QUALIFIED, comma separated. */
  reason?: string;
  hardwareLevel?: HardwareLevel;
  /** The tier this evidence supports. A result, not a promise: the credential row holds the tier in force. */
  derivedTier: DeviceSecurityTier;
  verifierVersion: number;
  /** Non-sensitive facts the verifier extracted (levels, boot state, app id, hashes). Never the raw chain. */
  facts: Record<string, unknown>;
  /** SHA-256 of each certificate of the chain, leaf first. */
  chainHashes: string[];
  trustAnchor?: string;
  verifiedAt: Date;
  createdAt: Date;
}

export type NewDeviceAttestation = Omit<DeviceAttestation, "createdAt">;

export interface DeviceAttestationRepository {
  issueChallenge(challenge: NewAttestationChallenge, now: Date): Promise<AttestationChallenge>;
  /**
   * Atomic and one-time: returns the challenge to exactly ONE caller, and only while it is unexpired, unconsumed and
   * issued to this user, wallet, platform and purpose. Everything else (and every concurrent loser) gets null.
   */
  consumeChallenge(input: ConsumeAttestationChallenge): Promise<AttestationChallenge | null>;
  /** One attestation per challenge; a VERIFIED attestation per key is also unique. Returns null on either conflict. */
  record(attestation: NewDeviceAttestation, now: Date): Promise<DeviceAttestation | null>;
  findById(id: string): Promise<DeviceAttestation | null>;
  /** Newest first. */
  listForKey(userId: string, publicKeyHash: string): Promise<DeviceAttestation[]>;
  /** Removes challenges that expired before `before`. */
  deleteChallengesExpiredBefore(before: Date, limit: number): Promise<number>;
}

/** What a verifier concluded, as plain data, so the policy below depends on no particular verifier. */
export type AttestationOutcome =
  | { verdict: "NONE" }
  | { verdict: "REJECTED"; reason: string }
  | {
      verdict: "VERIFIED";
      platform: AttestationPlatform;
      /** Android: the evidence meets the accepted hardware policy. iOS: always false (App Attest never proves the wallet key). */
      qualifies: boolean;
      hardwareLevel: HardwareLevel | null;
      /** The evidence proves a genuine app instance on genuine hardware (iOS), without proving the wallet key itself. */
      appInstanceProven: boolean;
      shortfalls: readonly string[];
    };

/**
 * The deterministic tier policy. Evidence can only raise a tier through a VERIFIED outcome, and never on the web route:
 *   Android, StrongBox or TEE key proven by an exact-key chain that meets the policy  → TRUSTED_DEVICE
 *   Android, authentic but not qualifying (software, unlocked, unknown app...)       → UNKNOWN
 *   iOS App Attest (genuine app + hardware, wallet key bound by claim only)          → APP_ATTESTED_DEVICE
 *   No or rejected evidence: web route → WEB_NON_EXTRACTABLE, native route → UNKNOWN.
 */
export function deriveDeviceTier(input: {
  channel: "web" | "native";
  outcome: AttestationOutcome;
}): DeviceSecurityTier {
  if (input.channel === "web") return "WEB_NON_EXTRACTABLE";
  const { outcome } = input;
  if (outcome.verdict !== "VERIFIED") return "UNKNOWN";
  if (outcome.platform === "ANDROID") {
    return outcome.qualifies &&
      (outcome.hardwareLevel === "STRONGBOX" || outcome.hardwareLevel === "TEE")
      ? "TRUSTED_DEVICE"
      : "UNKNOWN";
  }
  return outcome.appInstanceProven ? "APP_ATTESTED_DEVICE" : "UNKNOWN";
}

const RANK: Readonly<Record<DeviceSecurityTier, number>> = {
  UNKNOWN: 0,
  WEB_NON_EXTRACTABLE: 1,
  APP_ATTESTED_DEVICE: 2,
  TRUSTED_DEVICE: 3,
};
export const tierRank = (tier: DeviceSecurityTier): number => RANK[tier];

/** A tier never rises once the credential exists; it may fall (revocation, a tightened policy, a failed re-check). */
export const canChangeTier = (from: DeviceSecurityTier, to: DeviceSecurityTier): boolean =>
  RANK[to] <= RANK[from];

/** Product wording. Internal tiers stay precise; people see these. */
export const DEVICE_TIER_LABELS: Readonly<Record<DeviceSecurityTier, string>> = {
  TRUSTED_DEVICE: "Hardware-verified device",
  APP_ATTESTED_DEVICE: "Verified app on a genuine device",
  WEB_NON_EXTRACTABLE: "Browser-protected key",
  UNKNOWN: "Unverified key",
};
