import { randomBytes } from "node:crypto";

import {
  ANDROID_VERIFIER_VERSION,
  DEFAULT_ANDROID_POLICY,
  IOS_VERIFIER_VERSION,
  sha256Hex,
  verifyAndroidKeyAttestation,
  verifyAppAttest,
} from "@kaada/attestation";
import type { AndroidApplication, AndroidRevocationSource, TrustAnchor } from "@kaada/attestation";
import { deviceKeyIdFromPoint } from "@kaada/contracts";
import { KaadaError, canChangeTier, createId, deriveDeviceTier } from "@kaada/domain";
import type {
  AttestationChallengePurpose,
  AttestationOutcome,
  AttestationPlatform,
  AttestationResult,
  DeviceAttestation,
  DeviceAttestationRepository,
  DeviceSecurityTier,
  HardwareLevel,
} from "@kaada/domain";

/**
 * Platform evidence a native client sends with a device-key enrolment. It is a CLAIM until verified here; the server
 * decides the tier and never reads one from the client.
 */
export type AttestationEvidence =
  | {
      platform: "ANDROID";
      challengeId: string;
      /** Base64 DER certificates, leaf first, from `KeyStore.getCertificateChain`. */
      certificateChain: string[];
    }
  | {
      platform: "IOS";
      challengeId: string;
      /** Base64 CBOR attestation object from `DCAppAttestService.attestKey`. */
      attestationObject: string;
      /** Base64 App Attest key id. */
      keyId: string;
    };

/** Where the request arrived, decided by the ROUTE and never by the body. */
export type EnrolmentRoute = "web" | "native";

export interface IssuedAttestationChallenge {
  challengeId: string;
  platform: AttestationPlatform;
  /** Hex. Android: pass these 32 bytes to `setAttestationChallenge`. iOS: hashed into the App Attest client data. */
  nonce: string;
  expiresAt: Date;
}

export type TierOutcome = "NONE" | "VERIFIED" | "REJECTED" | "CHALLENGE_INVALID";

export interface ResolvedTier {
  tier: DeviceSecurityTier;
  attestationId?: string;
  outcome: TierOutcome;
  /** Why evidence did not raise the tier (machine-readable, non-sensitive). Safe to return to the caller. */
  reason?: string;
}

export interface DeviceTierServiceDeps {
  attestations: DeviceAttestationRepository;
  android?: {
    applications: readonly AndroidApplication[];
    minimumLevel: "TEE" | "STRONGBOX";
    revocation?: AndroidRevocationSource;
    /** Tests only. Production uses Google's pinned roots. */
    anchors?: readonly TrustAnchor[];
  };
  ios?: {
    appIds: readonly string[];
    allowDevelopment: boolean;
    /** Tests only. Production uses Apple's pinned root. */
    anchor?: TrustAnchor;
  };
  challengeTtlMs?: number;
  now?: () => Date;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const ATTESTATION_TYPES: Record<AttestationPlatform, string> = {
  ANDROID: "ANDROID_KEY_ATTESTATION",
  IOS: "IOS_APP_ATTEST",
};

const reject = (message: string) => new KaadaError("CREDENTIAL_REJECTED", message);

/**
 * The only place a device-key tier is derived from evidence. Every enrolment path (setup, root change, recovery) asks it for
 * the tier of the key it is about to record; none of them reads a tier from a request.
 */
export class DeviceTierService {
  private readonly now: () => Date;

  constructor(private readonly deps: DeviceTierServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  supports(platform: AttestationPlatform): boolean {
    return platform === "ANDROID" ? this.deps.android !== undefined : this.deps.ios !== undefined;
  }

  /**
   * Issues the one-time nonce a device must pass to the platform when it generates its key. Bound to the user, the wallet
   * (absent for a first wallet), the platform and the purpose; the public key is bound when the evidence is presented.
   */
  async issueChallenge(input: {
    userId: string;
    walletId?: string;
    platform: AttestationPlatform;
    purpose: AttestationChallengePurpose;
  }): Promise<IssuedAttestationChallenge> {
    if (!this.supports(input.platform)) throw reject("device attestation is not enabled");
    const now = this.now();
    const challenge = await this.deps.attestations.issueChallenge(
      {
        id: createId(),
        userId: input.userId,
        ...(input.walletId && { walletId: input.walletId }),
        platform: input.platform,
        purpose: input.purpose,
        nonce: randomBytes(32).toString("hex"),
        expiresAt: new Date(now.getTime() + (this.deps.challengeTtlMs ?? DEFAULT_TTL_MS)),
      },
      now,
    );
    return {
      challengeId: challenge.id,
      platform: challenge.platform,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    };
  }

  /**
   * The tier of the key being enrolled. No evidence → what the route implies (web: WEB_NON_EXTRACTABLE, native: UNKNOWN).
   * Evidence on the web route is refused outright: the web can never carry platform proof, so a claim there is a bug or an
   * attack, not a weaker credential. A failure to verify never blocks the enrolment: the key is just not upgraded.
   */
  async resolveTier(input: {
    route: EnrolmentRoute;
    userId: string;
    walletId?: string;
    purpose: AttestationChallengePurpose;
    point: { x: string; y: string };
    evidence?: AttestationEvidence | undefined;
  }): Promise<ResolvedTier> {
    const none: AttestationOutcome = { verdict: "NONE" };
    if (!input.evidence) {
      return { tier: deriveDeviceTier({ channel: input.route, outcome: none }), outcome: "NONE" };
    }
    if (input.route === "web")
      throw reject("attestation evidence is not accepted on the web route");

    const evidence = input.evidence;
    const publicKeyHash = sha256Hex(Buffer.from(`${input.point.x}${input.point.y}`, "hex"));
    const keyId = deviceKeyIdFromPoint({
      x: BigInt(`0x${input.point.x}`),
      y: BigInt(`0x${input.point.y}`),
    });
    const now = this.now();

    // Consume FIRST: a challenge buys exactly one verification attempt, however it ends.
    const challenge = await this.deps.attestations.consumeChallenge({
      id: evidence.challengeId,
      userId: input.userId,
      walletId: input.walletId,
      platform: evidence.platform,
      purpose: input.purpose,
      publicKeyHash,
      now,
    });
    if (!challenge) {
      return {
        tier: deriveDeviceTier({ channel: "native", outcome: none }),
        outcome: "CHALLENGE_INVALID",
        reason: "CHALLENGE_UNKNOWN_EXPIRED_OR_USED",
      };
    }

    const verified = await this.verify(evidence, challenge, input.point, now);
    const tier = deriveDeviceTier({ channel: "native", outcome: verified.outcome });
    const record = await this.deps.attestations.record(
      {
        id: createId(),
        userId: input.userId,
        ...(input.walletId && { walletId: input.walletId }),
        challengeId: challenge.id,
        platform: evidence.platform,
        attestationType: ATTESTATION_TYPES[evidence.platform],
        credentialRef: keyId,
        publicKeyHash,
        result: verified.result,
        ...(verified.reason && { reason: verified.reason }),
        ...(verified.hardwareLevel && { hardwareLevel: verified.hardwareLevel }),
        derivedTier: tier,
        verifierVersion: verified.version,
        facts: verified.facts,
        chainHashes: verified.chainHashes,
        ...(verified.trustAnchor && { trustAnchor: verified.trustAnchor }),
        verifiedAt: now,
      },
      now,
    );
    if (!record) {
      // The same key already holds a verified attestation: evidence cannot be presented twice. Not an upgrade.
      return {
        tier: deriveDeviceTier({ channel: "native", outcome: none }),
        outcome: "REJECTED",
        reason: "KEY_ALREADY_ATTESTED",
      };
    }
    return {
      tier,
      attestationId: record.id,
      outcome: verified.result === "REJECTED" ? "REJECTED" : "VERIFIED",
      ...(verified.reason && { reason: verified.reason }),
    };
  }

  /**
   * Re-derives the tier a stored attestation supports under the CURRENT policy. A tier only ever falls: re-checking can
   * lower it (a revocation, a tightened policy) but evidence can never raise a credential that already exists.
   */
  reevaluate(attestation: DeviceAttestation, current: DeviceSecurityTier): DeviceSecurityTier {
    const outcome = this.outcomeOf(attestation);
    const derived = deriveDeviceTier({ channel: "native", outcome });
    return canChangeTier(current, derived) ? derived : current;
  }

  private outcomeOf(attestation: DeviceAttestation): AttestationOutcome {
    if (attestation.result === "REJECTED") {
      return { verdict: "REJECTED", reason: attestation.reason ?? "REJECTED" };
    }
    if (attestation.platform === "ANDROID") {
      const config = this.deps.android;
      const level = attestation.hardwareLevel ?? "SOFTWARE";
      const rank = { SOFTWARE: 0, TEE: 1, STRONGBOX: 2 } as const;
      // Evaluated against today's minimum, not the one in force when the evidence was verified.
      const meetsMinimum = config ? rank[level] >= rank[config.minimumLevel] : false;
      return {
        verdict: "VERIFIED",
        platform: "ANDROID",
        qualifies: attestation.result === "VERIFIED_QUALIFIED" && meetsMinimum,
        hardwareLevel: attestation.hardwareLevel ?? null,
        appInstanceProven: false,
        shortfalls: attestation.reason ? attestation.reason.split(",") : [],
      };
    }
    return {
      verdict: "VERIFIED",
      platform: "IOS",
      qualifies: false,
      hardwareLevel: null,
      appInstanceProven: attestation.result === "VERIFIED_QUALIFIED" && this.deps.ios !== undefined,
      shortfalls: [],
    };
  }

  private async verify(
    evidence: AttestationEvidence,
    challenge: { nonce: string; createdAt: Date },
    point: { x: string; y: string },
    now: Date,
  ): Promise<{
    outcome: AttestationOutcome;
    result: AttestationResult;
    reason?: string;
    hardwareLevel?: HardwareLevel;
    version: number;
    facts: Record<string, unknown>;
    chainHashes: string[];
    trustAnchor?: string;
  }> {
    const nonce = new Uint8Array(Buffer.from(challenge.nonce, "hex"));
    if (!HEX64.test(challenge.nonce)) throw new Error("stored challenge nonce is malformed");

    try {
      if (evidence.platform === "ANDROID") {
        const config = this.deps.android;
        if (!config) return this.refused("ANDROID_NOT_ENABLED", ANDROID_VERIFIER_VERSION);
        const result = await verifyAndroidKeyAttestation({
          certificateChain: evidence.certificateChain,
          challenge: nonce,
          publicKey: point,
          now,
          challengeIssuedAt: challenge.createdAt,
          ...(config.revocation && { revocation: config.revocation }),
          policy: {
            ...DEFAULT_ANDROID_POLICY,
            minimumLevel: config.minimumLevel,
            applications: config.applications,
            ...(config.anchors && { anchors: config.anchors }),
          },
        });
        if (result.verdict === "REJECTED") {
          return this.refused(result.code, ANDROID_VERIFIER_VERSION);
        }
        const { facts } = result;
        return {
          outcome: {
            verdict: "VERIFIED",
            platform: "ANDROID",
            qualifies: result.qualifies,
            hardwareLevel: facts.hardwareLevel,
            appInstanceProven: false,
            shortfalls: result.shortfalls,
          },
          result: result.qualifies ? "VERIFIED_QUALIFIED" : "VERIFIED_NOT_QUALIFIED",
          ...(result.shortfalls.length > 0 && { reason: result.shortfalls.join(",") }),
          hardwareLevel: facts.hardwareLevel,
          version: ANDROID_VERIFIER_VERSION,
          facts: {
            attestationVersion: facts.attestationVersion,
            attestationSecurityLevel: facts.attestationSecurityLevel,
            keymasterSecurityLevel: facts.keymasterSecurityLevel,
            verifiedBootState: facts.verifiedBootState,
            deviceLocked: facts.deviceLocked,
            osPatchLevel: facts.osPatchLevel,
            packageName: facts.packageName,
            signatureDigests: facts.signatureDigests,
          },
          chainHashes: facts.chainHashes,
          trustAnchor: facts.trustAnchor,
        };
      }

      const config = this.deps.ios;
      if (!config) return this.refused("IOS_NOT_ENABLED", IOS_VERIFIER_VERSION);
      const result = verifyAppAttest({
        attestationObject: evidence.attestationObject,
        keyId: evidence.keyId,
        challenge: nonce,
        publicKey: point,
        now,
        policy: {
          appIds: config.appIds,
          allowDevelopment: config.allowDevelopment,
          ...(config.anchor && { anchor: config.anchor }),
        },
      });
      if (result.verdict === "REJECTED") return this.refused(result.code, IOS_VERIFIER_VERSION);
      return {
        outcome: {
          verdict: "VERIFIED",
          platform: "IOS",
          qualifies: false,
          hardwareLevel: null,
          appInstanceProven: true,
          shortfalls: [],
        },
        result: "VERIFIED_QUALIFIED",
        version: IOS_VERIFIER_VERSION,
        facts: {
          environment: result.facts.environment,
          appId: result.facts.appId,
          appAttestKeyHash: result.facts.appAttestKeyHash,
          // What this does NOT prove, recorded with the evidence so no later reader mistakes it.
          provesWalletKeyHardware: result.provesWalletKeyHardware,
        },
        chainHashes: result.facts.chainHashes,
        trustAnchor: result.facts.trustAnchor,
      };
    } catch {
      // A verifier fault is never an upgrade, and never the client's problem to retry blindly.
      return this.refused(
        "VERIFIER_ERROR",
        evidence.platform === "ANDROID" ? ANDROID_VERIFIER_VERSION : IOS_VERIFIER_VERSION,
      );
    }
  }

  private refused(reason: string, version: number) {
    return {
      outcome: { verdict: "REJECTED", reason } as const,
      result: "REJECTED" as const,
      reason,
      version,
      facts: {},
      chainHashes: [],
    };
  }
}

/** The part of the service the enrolment paths depend on (a fake in tests, the real service in production). */
export type DeviceTierResolver = Pick<DeviceTierService, "issueChallenge" | "resolveTier">;

/**
 * Resolves the tier of a key being enrolled. With no resolver configured nothing can be proven, so the route alone decides
 * (web: WEB_NON_EXTRACTABLE, native: UNKNOWN) and evidence is never trusted; on the web route it is refused as everywhere.
 */
export async function resolveDeviceTier(
  resolver: DeviceTierResolver | undefined,
  input: Parameters<DeviceTierService["resolveTier"]>[0],
): Promise<ResolvedTier> {
  if (resolver) return resolver.resolveTier(input);
  if (input.evidence && input.route === "web") {
    throw reject("attestation evidence is not accepted on the web route");
  }
  return {
    tier: deriveDeviceTier({ channel: input.route, outcome: { verdict: "NONE" } }),
    outcome: "NONE",
    ...(input.evidence && { reason: "ATTESTATION_NOT_ENABLED" }),
  };
}
