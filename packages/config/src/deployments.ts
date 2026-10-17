/*
 * Per-network facts about Kaada's recovery and device-key contracts. Public data (addresses and chain ids hold no secret), so it
 * is committed and reviewed, not supplied through the environment. A deployment selects one with RECOVERY_NETWORK.
 */

export const RECOVERY_NETWORKS = ["celo-mainnet", "celo-sepolia"] as const;
export type RecoveryNetwork = (typeof RECOVERY_NETWORKS)[number];

export const NETWORK_CHAIN_IDS: Readonly<Record<RecoveryNetwork, number>> = {
  "celo-mainnet": 42220,
  "celo-sepolia": 11142220,
};

/**
 * The recovery delay for each network, in seconds. The recovery contract itself enforces 24 hours as a floor, so mainnet's
 * floor is 24 hours and cannot be lowered from the environment. A short delay is only ever sensible on a test network, and
 * only by editing this file.
 */
export const RECOVERY_DELAYS: Readonly<
  Record<RecoveryNetwork, { delaySeconds: number; minDelaySeconds: number }>
> = {
  "celo-mainnet": { delaySeconds: 259_200, minDelaySeconds: 86_400 },
  "celo-sepolia": { delaySeconds: 259_200, minDelaySeconds: 86_400 },
};

export interface RecoveryContracts {
  /** The recovery validator (the Kernel module the Recovery Code key signs for). */
  validator: string;
  /**
   * The recovery relayer the validator was deployed with: the ONLY address its `initiate` accepts (immutable on chain). Public.
   * The key file in RECOVERY_RELAYER_KEY_FILE must derive to exactly this address or recovery refuses to start.
   */
  relayer: string;
  /** The passkey validator clone factory and its implementation. */
  passkeyFactory: string;
  passkeyImplementation: string;
  /** The device-key validator clone factory and its implementation. */
  deviceFactory: string;
  deviceImplementation: string;
}

/**
 * The deployed contracts per network, or null when they are not deployed there yet. Recovery and device-key roots refuse to
 * start on a network with null here, with a message that says so. After deploying, paste the six addresses in and commit.
 */
export const RECOVERY_DEPLOYMENTS: Readonly<Record<RecoveryNetwork, RecoveryContracts | null>> = {
  "celo-mainnet": null,
  "celo-sepolia": null,
};
