import type {
  AuditRepository,
  DelegatedPermissionRepository,
  EmailVerificationRepository,
  ExecutionSecretRepository,
  IdentityRepository,
  PasskeyRepository,
  RecoveryAttemptRepository,
  RecoveryCleanupRepository,
  RecoveryConfigurationRepository,
  RecoveryEmailChallengeRepository,
  RecoveryTotpRepository,
  TransactionPinRepository,
  WalletCredentialRepository,
  WalletRepository,
  WalletSetupSessionRepository,
} from "@kaada/domain";

/** The repositories the recovery services read and write. All are domain contracts. */
export interface RecoveryRepositories {
  identities: IdentityRepository;
  wallets: WalletRepository;
  passkeys: PasskeyRepository;
  walletCredentials: WalletCredentialRepository;
  recoveryConfigurations: RecoveryConfigurationRepository;
  recoveryAttempts: RecoveryAttemptRepository;
  recoveryEmailChallenges: RecoveryEmailChallengeRepository;
  emailVerifications: EmailVerificationRepository;
  recoveryTotps: RecoveryTotpRepository;
  recoveryCleanup: RecoveryCleanupRepository;
  delegatedPermissions: DelegatedPermissionRepository;
  executionSecrets: ExecutionSecretRepository;
  transactionPins: TransactionPinRepository;
  walletSetupSessions: WalletSetupSessionRepository;
  audit: AuditRepository;
}

/**
 * Storage for the recovery services. `transaction` runs `work` atomically with repositories bound to it. A transaction is
 * never held open across a call to the chain, an email provider or a hasher.
 */
export interface RecoveryUnitOfWork {
  read: RecoveryRepositories;
  transaction<T>(work: (repositories: RecoveryRepositories) => Promise<T>): Promise<T>;
}

/** Tunables of the recovery flow. Defaults are the production policy; tests and the Sepolia harness override them. */
export interface RecoveryPolicy {
  /** The hard floor a configured delay may not go below (the contract enforces 24 h). */
  minDelaySeconds: number;
  /** The delay a new configuration uses unless told otherwise (72 h by default). */
  defaultDelaySeconds: number;
  /** How long a session token lives before the chain is involved. */
  tokenTtlMs: number;
  /** How long the Recovery Code signatures stay valid (the `deadline` of the typed message). */
  proofTtlMs: number;
  /** How long the person keeps access to post-recovery steps after the root changed. */
  postRecoveryTtlMs: number;
  emailCodeTtlMs: number;
  emailMaxAttempts: number;
  /** How many challenges one attempt may be issued, and the minimum gap between them. */
  emailMaxIssues: number;
  emailResendCooldownMs: number;
  /** Wrong Recovery Code signatures tolerated before the attempt fails. */
  maxProofFailures: number;
  /** Starts per user per 24 h, and the quiet period after a completed recovery. */
  maxStartsPerDay: number;
  cooldownAfterCompletionMs: number;
  /** How long a finalizer holds its lease. */
  leaseMs: number;
  /** How long an INITIATING attempt may stay unresolved before it is declared failed. */
  initiatingGraceMs: number;
  /** How long to wait for a recovery UserOperation to be included before leaving it to the next pass. */
  inclusionWaitMs: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  minDelaySeconds: 24 * 60 * 60,
  defaultDelaySeconds: 72 * 60 * 60,
  tokenTtlMs: 2 * 60 * 60 * 1000,
  proofTtlMs: 30 * 60 * 1000,
  postRecoveryTtlMs: 60 * 60 * 1000,
  emailCodeTtlMs: 10 * 60 * 1000,
  emailMaxAttempts: 5,
  emailMaxIssues: 4,
  emailResendCooldownMs: 60 * 1000,
  maxProofFailures: 5,
  maxStartsPerDay: 3,
  cooldownAfterCompletionMs: 24 * 60 * 60 * 1000,
  leaseMs: 2 * 60 * 1000,
  initiatingGraceMs: 10 * 60 * 1000,
  inclusionWaitMs: 60 * 1000,
};
