import type { Money } from "../money/index.js";

/** What a delegated permission may do. There is deliberately no "anything" operation. */
export const PERMISSION_OPERATIONS = ["APPROVE_TOKEN", "EXECUTE_SWAP", "TRANSFER_TOKEN"] as const;
export type PermissionOperation = (typeof PERMISSION_OPERATIONS)[number];

export const PERMISSION_STATUSES = ["PENDING", "ACTIVE", "REVOKED", "EXPIRED"] as const;
export type PermissionStatus = (typeof PERMISSION_STATUSES)[number];

/**
 * Who enforces a constraint. This distinction is the point of the model:
 * - ONCHAIN:      the smart account itself rejects a violating operation (a policy contract the account calls),
 *                 so it holds even if Kaada's servers are compromised.
 * - KAADA_POLICY: only Kaada's own code checks it. A compromised Kaada could bypass it.
 */
export type Enforcement = "ONCHAIN" | "KAADA_POLICY";

export const PERMISSION_CONSTRAINTS = [
  "contracts",
  "operations",
  "assets",
  "perTransactionLimit",
  "cumulativeLimit",
  "validity",
] as const;
export type PermissionConstraint = (typeof PERMISSION_CONSTRAINTS)[number];

/** What a caller asks for. Every field that bounds authority is required. */
export interface PermissionRequest {
  userId: string;
  walletId: string;
  chainId: number;
  allowedOperations: PermissionOperation[];
  /** Contract addresses the permission may call (token contracts, a swap reactor). Never empty. */
  allowedContracts: string[];
  /** Assets it may move. Never empty. */
  allowedAssetIds: string[];
  /** The most one transaction may move. Required. */
  perTransactionLimit: Money;
  /** The most it may move in total. Enforced by Kaada only (no on-chain cumulative policy exists). */
  cumulativeLimit?: Money;
  validFrom: Date;
  expiresAt: Date;
}

/**
 * A constraint set stored with the permission. `enforcement` records, per constraint, who enforces it
 * for the stack that will carry it, so an application-side check is never reported as cryptographic.
 */
export interface DelegatedPermission {
  id: string;
  userId: string;
  walletId: string;
  provider: string;
  /** The stack's id for the installed permission, once it exists on chain. */
  providerPermissionId?: string;
  chainId: number;
  status: PermissionStatus;
  allowedOperations: PermissionOperation[];
  allowedContracts: string[];
  allowedAssetIds: string[];
  perTransactionLimit: Money;
  cumulativeLimit?: Money;
  enforcement: Record<PermissionConstraint, Enforcement>;
  validFrom: Date;
  expiresAt: Date;
  revokedAt?: Date;
  revocationReason?: string;
  /** The restricted session key's public address. Its private half is encrypted in ExecutionSecret. */
  sessionKeyAddress?: string;
  sessionKeySecretId?: string;
  /** The passkey-signed enable data needed to use the permission, encrypted in ExecutionSecret. */
  approvalSecretId?: string;
  /** Set only after the permission was read back from the chain. PENDING is never installed. */
  installedAt?: Date;
  createdAt: Date;
}

export type NewDelegatedPermission = Omit<
  DelegatedPermission,
  "createdAt" | "revokedAt" | "revocationReason"
>;

/** Usable means ACTIVE, inside its validity window and not revoked. */
export function isPermissionUsable(permission: DelegatedPermission, now: Date): boolean {
  return (
    permission.status === "ACTIVE" &&
    permission.revokedAt === undefined &&
    permission.validFrom.getTime() <= now.getTime() &&
    now.getTime() < permission.expiresAt.getTime()
  );
}

export interface DelegatedPermissionRepository {
  create(permission: NewDelegatedPermission): Promise<DelegatedPermission>;
  findById(id: string): Promise<DelegatedPermission | null>;
  listForWallet(walletId: string): Promise<DelegatedPermission[]>;
  /** Stores the session key address and the encrypted key / approval references (PENDING only). */
  attachSessionKey(
    id: string,
    keys: { address: string; sessionKeySecretId: string; approvalSecretId?: string },
  ): Promise<DelegatedPermission | null>;
  /** Stores the encrypted approval after the root signature produced it. */
  attachApproval(id: string, approvalSecretId: string): Promise<DelegatedPermission | null>;
  /** PENDING -> ACTIVE once it exists on chain. Returns null if it was not PENDING. */
  activate(id: string, providerPermissionId: string): Promise<DelegatedPermission | null>;
  /** PENDING or ACTIVE -> REVOKED. Returns null if it was already REVOKED or EXPIRED. */
  revoke(id: string, reason: string, at: Date): Promise<DelegatedPermission | null>;
  /** Marks every PENDING or ACTIVE permission past its expiry EXPIRED; returns how many. */
  expireDue(now: Date): Promise<number>;
}
