import type { JsonObject } from "../json.js";

export const WALLET_TYPES = ["EMBEDDED", "EXTERNAL"] as const;
/**
 * - EMBEDDED: a smart account Kaada provisions for the user. The root authority is the user's passkey; Kaada holds
 *             no root secret.
 * - EXTERNAL: an address the user brought. A row implies no custody and no ability to act.
 */
export type WalletType = (typeof WALLET_TYPES)[number];

export const WALLET_STATUSES = [
  "PROVISIONING",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
  "RECOVERY_REQUIRED",
] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

/**
 * Whether the account contract exists on chain. A smart-account address is stable before deployment
 * (counterfactual), and tokens sent to it earlier are safe; it is never reported deployed until it is.
 */
export const WALLET_DEPLOYMENTS = [
  "NOT_APPLICABLE",
  "COUNTERFACTUAL",
  "DEPLOYING",
  "DEPLOYED",
] as const;
export type WalletDeployment = (typeof WALLET_DEPLOYMENTS)[number];

/**
 * A wallet linked to a user. Holds identifiers only: never a private key, seed, session secret or
 * provider credential.
 */
export interface Wallet {
  id: string;
  userId: string;
  chainId: number;
  /** Lower-case EVM address. Absent only while PROVISIONING has not derived it yet. */
  address?: string;
  label?: string;
  isPrimary: boolean;
  type: WalletType;
  status: WalletStatus;
  deployment: WalletDeployment;
  /** The wallet stack that provisioned it, e.g. "zerodev-kernel-v3.3". */
  provider?: string;
  /** The stack's own identifier for the account, if it has one. Never a secret. */
  providerAccountId?: string;
  /** Why a wallet is not ACTIVE (e.g. a failed provisioning attempt). A code, never provider output. */
  statusReason?: string;
  provisionedAt?: Date;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** True when the wallet can be used as someone's address: ACTIVE and with an address. */
export function isWalletActive(wallet: Wallet): wallet is Wallet & { address: string } {
  return wallet.status === "ACTIVE" && wallet.address !== undefined;
}

export type NewWallet = Omit<Wallet, "createdAt" | "updatedAt">;

export interface WalletRepository {
  findById(id: string): Promise<Wallet | null>;
  /** The user's EMBEDDED wallet on the chain that is not REVOKED, if any. */
  findEmbedded(userId: string, chainId: number): Promise<Wallet | null>;
  /**
   * Takes a row lock on the user until the transaction ends, so provisioning decisions for one user
   * are serialised. Only meaningful inside a transaction.
   */
  lockUser(userId: string): Promise<void>;
  /** Inserts a wallet. The database allows one non-revoked EMBEDDED wallet per user and chain. */
  create(wallet: NewWallet): Promise<Wallet>;
  /** PROVISIONING -> ACTIVE with the derived account. Returns null if the wallet was not PROVISIONING. */
  activate(
    id: string,
    account: {
      address: string;
      deployment: WalletDeployment;
      provider: string;
      providerAccountId?: string;
      at: Date;
    },
  ): Promise<Wallet | null>;
  /** Records why a PROVISIONING wallet could not be completed; it stays PROVISIONING for a retry. */
  recordFailure(id: string, reason: string): Promise<void>;
  setStatus(id: string, status: WalletStatus, reason?: string): Promise<Wallet>;
  setDeployment(id: string, deployment: WalletDeployment): Promise<Wallet>;
  listByUser(userId: string): Promise<Wallet[]>;
}
