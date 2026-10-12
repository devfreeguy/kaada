export {
  ATTESTATION_CHALLENGE_PURPOSES,
  ATTESTATION_PLATFORMS,
  ATTESTATION_RESULTS,
  DEVICE_TIER_LABELS,
  canChangeTier,
  deriveDeviceTier,
  tierRank,
} from "./attestation.js";
export type {
  AttestationChallenge,
  AttestationChallengePurpose,
  AttestationOutcome,
  AttestationPlatform,
  AttestationResult,
  ConsumeAttestationChallenge,
  DeviceAttestation,
  DeviceAttestationRepository,
  HardwareLevel,
  NewAttestationChallenge,
  NewDeviceAttestation,
} from "./attestation.js";
