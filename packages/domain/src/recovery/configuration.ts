import type { JsonObject } from "../json.js";

/*
 * The on-chain recovery arrangement of one wallet: which KaadaRecoveryValidator instance guards it and the PUBLIC
 * address of the key derived from the user's Recovery Code. The Recovery Code itself is never stored anywhere.
 */

/**
 * - PENDING_INSTALL: the install operation was prepared / sent but the chain does not show it yet.
 * - ACTIVE:          armed on chain (read back): the validator reports this recovery key and delay.
 * - CONSUMED:        a recovery used it up (the validator deletes its config when a recovery executes).
 * - SUPERSEDED:      replaced by a newer configuration (a new Recovery Code).
 * - DISABLED:        turned off by the user.
 */
export const RECOVERY_CONFIGURATION_STATUSES = [
  "PENDING_INSTALL",
  "ACTIVE",
  "CONSUMED",
  "SUPERSEDED",
  "DISABLED",
] as const;
export type RecoveryConfigurationStatus = (typeof RECOVERY_CONFIGURATION_STATUSES)[number];

export interface RecoveryConfiguration {
  id: string;
  userId: string;
  walletId: string;
  chainId: number;
  /** The KaadaRecoveryValidator contract (lower-case address). */
  validatorAddress: string;
  /** Address of the key derived from the Recovery Code: the contract's `recoveryKey`. Public. */
  recoveryAddress: string;
  delaySeconds: number;
  status: RecoveryConfigurationStatus;
  /** The wallet credential that armed it (the root at the time). */
  armedByCredentialId?: string;
  /** Last recovery nonce read from the validator. Monotonic; the contract is authoritative. */
  recoveryNonce: string;
  /** UserOperation that installed / updated it. */
  installUserOpHash?: string;
  /** The unsigned install operation the ROOT signs (no secret). Present while PENDING_INSTALL. */
  preparedOperation?: JsonObject;
  configuredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type NewRecoveryConfiguration = Omit<
  RecoveryConfiguration,
  "createdAt" | "updatedAt" | "configuredAt"
>;

export interface RecoveryConfigurationRepository {
  create(configuration: NewRecoveryConfiguration): Promise<RecoveryConfiguration>;
  findById(id: string): Promise<RecoveryConfiguration | null>;
  /** The wallet's ACTIVE configuration, if any. */
  findActive(walletId: string): Promise<RecoveryConfiguration | null>;
  /** Newest first. */
  listForWallet(walletId: string): Promise<RecoveryConfiguration[]>;
  /** PENDING_INSTALL -> ACTIVE once the chain shows it. Supersedes any other ACTIVE one. Null if not PENDING_INSTALL. */
  activate(input: {
    id: string;
    recoveryNonce: string;
    at: Date;
  }): Promise<RecoveryConfiguration | null>;
  /** ACTIVE (or PENDING_INSTALL) -> `status`. Null if it was already in a terminal state. */
  close(
    id: string,
    status: "CONSUMED" | "SUPERSEDED" | "DISABLED",
  ): Promise<RecoveryConfiguration | null>;
  recordNonce(id: string, recoveryNonce: string): Promise<void>;
}
