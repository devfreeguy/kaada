export const RECOVERY_AUDIT_EVENTS = {
  /** The relayer paid for something on a wallet (opening its account, or gas for its first recovery step); `data.wei` says how much. */
  relayerSponsored: "recovery.relayer_sponsored",
  /** The sponsoring ledger: what a spend may cost at most, then what it really cost. See SponsorshipLedger. */
  sponsorReserved: "recovery.sponsor_reserved",
  sponsorSettled: "recovery.sponsor_settled",
  configurationRequested: "recovery.configuration_requested",
  configurationActivated: "recovery.configuration_activated",
  configurationSuperseded: "recovery.configuration_superseded",
  configurationConsumed: "recovery.configuration_consumed",
  started: "recovery.started",
  startRejected: "recovery.start_rejected",
  emailChallengeSent: "recovery.email_challenge_sent",
  emailVerified: "recovery.email_verified",
  emailVerificationFailed: "recovery.email_verification_failed",
  rootProposed: "recovery.root_proposed",
  proofRejected: "recovery.proof_rejected",
  totpEnrolmentStarted: "recovery.totp_enrolment_started",
  totpEnrolmentRejected: "recovery.totp_enrolment_rejected",
  totpEnabled: "recovery.totp_enabled",
  totpDisabled: "recovery.totp_disabled",
  totpVerified: "recovery.totp_verified",
  totpRejected: "recovery.totp_rejected",
  totpReplayRejected: "recovery.totp_replay_rejected",
  proofRefused: "recovery.proof_refused",
  initiated: "recovery.initiated",
  initiationFailed: "recovery.initiation_failed",
  notificationSent: "recovery.notification_sent",
  notificationFailed: "recovery.notification_failed",
  cancelPrepared: "recovery.cancel_prepared",
  cancelled: "recovery.cancelled",
  finalizationDeferred: "recovery.finalization_deferred",
  finalizationSubmitted: "recovery.finalization_submitted",
  finalizationFailed: "recovery.finalization_failed",
  rootConfirmed: "recovery.root_confirmed",
  proofOfSigningVerified: "recovery.proof_of_signing_verified",
  completed: "recovery.completed",
  expired: "recovery.expired",
  cleanupStarted: "recovery.cleanup_started",
  cleanupCompleted: "recovery.cleanup_completed",
  oldCredentialReplaced: "recovery.old_credential_replaced",
  permissionRevoked: "recovery.permission_revoked",
  pinResetRequired: "recovery.pin_reset_required",
  pinReset: "recovery.pin_reset",
  newRecoveryCodeRequested: "recovery.new_recovery_code_requested",
  newRecoveryCodeConfigured: "recovery.new_recovery_code_configured",
  credentialRecorded: "recovery.credential_recorded",
  recoveryEmailRegistered: "recovery.email_registered",
  deviceTierAssigned: "recovery.device_tier_assigned",
} as const;

export {
  DEVICE_SECURITY_TIERS,
  WALLET_CREDENTIAL_KINDS,
  WALLET_CREDENTIAL_ROLES,
  WALLET_CREDENTIAL_STATUSES,
} from "./credential.js";
export type {
  DeviceSecurityTier,
  NewWalletCredential,
  WalletCredential,
  WalletCredentialKind,
  WalletCredentialRepository,
  WalletCredentialRole,
  WalletCredentialStatus,
} from "./credential.js";
export { RECOVERY_CONFIGURATION_STATUSES } from "./configuration.js";
export type {
  NewRecoveryConfiguration,
  RecoveryConfiguration,
  RecoveryConfigurationRepository,
  RecoveryConfigurationStatus,
} from "./configuration.js";
export {
  RECOVERY_ATTEMPT_STATUSES,
  RECOVERY_TERMINAL_STATUSES,
  RECOVERY_TERMINATORS,
  RECOVERY_TRANSITIONS,
  canTransitionRecovery,
  isRecoveryAttemptActive,
} from "./attempt.js";
export type {
  NewRecoveryAttempt,
  RecoveryAttempt,
  RecoveryAttemptPatch,
  RecoveryAttemptRepository,
  RecoveryAttemptStatus,
  RecoveryClearable,
  RecoveryTerminator,
} from "./attempt.js";
export { RECOVERY_TOTP_STATUSES } from "./totp.js";
export { depositValueUsdMicros } from "./sponsorship.js";
export type {
  DepositItem,
  SponsorLimit,
  SponsorReservation,
  SponsorshipLedger,
} from "./sponsorship.js";
export type {
  NewRecoveryTotp,
  RecoveryTotp,
  RecoveryTotpRepository,
  RecoveryTotpStatus,
} from "./totp.js";
export type {
  EmailChallengeReservation,
  NewRecoveryEmailChallenge,
  RecoveryEmailChallenge,
  RecoveryEmailChallengeRepository,
} from "./email-challenge.js";
export type {
  ChainCall,
  ChannelMessage,
  ChannelMessenger,
  InstanceStatus,
  PreparedOperation,
  ProposedRoot,
  RecoveryAccountState,
  RecoveryChainPort,
  RecoveryEmailSender,
  RecoveryRiskDecision,
  RecoveryRiskInput,
  RecoveryRiskPolicy,
  RecoveryTypedData,
  RecoveryTypedMessage,
  RecoveryValidatorState,
  RootCredentialData,
  UserOperationStatus,
} from "./ports.js";
export type { RecoveryCleanupRepository } from "./cleanup.js";
