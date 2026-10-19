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
  // Deployed 2026-10-19 with packages/blockchain/deploy-recovery-contracts.ts, which checked on chain that the code equals
  // the compiled production code (not the short-delay test build), the relayer and implementations read back as intended, the delay
  // floor is 24 hours and a stranger cannot call `initiate`. The recovery validator includes the gas-cost bound (MAX_OPERATION_COST).
  // The passkey implementation is ZeroDev's own validator, at its canonical address, with the exact expected code hash.
  "celo-mainnet": {
    validator: "0xd60997aeaD07583D4325C8dB4c0dc4092F376058",
    relayer: "0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4",
    passkeyFactory: "0x959234caAeBA2bbF300B85548C86544A748d7Ee5",
    passkeyImplementation: "0x7ab16Ff354AcB328452F1D445b3Ddee9a91e9e69",
    deviceFactory: "0x317eAa61c11D660AFaa61451C2fae0e22686766D",
    deviceImplementation: "0x793fBCd2daf3BdD65F0B1f5dacEBb66c7e6ab4aF",
  },
  // The same build on Celo Sepolia, where every end-to-end harness in packages/blockchain/src/testnet was run against it.
  // The passkey implementation here is an identical copy of ZeroDev's validator (the canonical one is absent on Sepolia).
  "celo-sepolia": {
    validator: "0x959234caAeBA2bbF300B85548C86544A748d7Ee5",
    relayer: "0x2B48a48785aee12dc03DC36569432c890C1833c6",
    passkeyFactory: "0x0b43FDd477C8bb12C8954A049C1E3b9e019c4503",
    passkeyImplementation: "0x793fBCd2daf3BdD65F0B1f5dacEBb66c7e6ab4aF",
    deviceFactory: "0x01016919722aee4Dca27dC8f490ec1a3f562db89",
    deviceImplementation: "0x317eAa61c11D660AFaa61451C2fae0e22686766D",
  },
};
