import type { JsonObject } from "../json.js";

/**
 * A root-signed change of a wallet's credentials that is not part of a payment:
 *  - ROTATE_ROOT:   the current root signs one operation that makes a FRESH validator instance the account's root and voids
 *                   everything installed under the old root (the same two calls a recovery runs);
 *  - ENROLL_BACKUP: the current root signs one operation that installs a second, FRESH credential as an additional validator.
 *
 * The server fixes the operation and its challenge (the UserOperation hash); the root signs exactly that. Nothing here holds
 * a secret: the new credential is public data and the signer's proof is verified, never stored.
 */
export const ROOT_CHANGE_KINDS = ["ROTATE_ROOT", "ENROLL_BACKUP"] as const;
export type RootChangeKind = (typeof ROOT_CHANGE_KINDS)[number];

export const ROOT_CHANGE_STATUSES = [
  "PREPARED",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type RootChangeStatus = (typeof ROOT_CHANGE_STATUSES)[number];

export interface RootChange {
  id: string;
  userId: string;
  walletId: string;
  kind: RootChangeKind;
  status: RootChangeStatus;
  /** The PENDING WalletCredential being rotated to or enrolled. */
  newCredentialId: string;
  /** The root credential that must sign. */
  signerCredentialId?: string;
  /** The UserOperation hash (0x + 64 hex) the root signs. */
  challenge: string;
  /** The prepared, UNSIGNED operation. */
  prepared: JsonObject;
  userOpHash?: string;
  expiresAt: Date;
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export type NewRootChange = Pick<
  RootChange,
  | "id"
  | "userId"
  | "walletId"
  | "kind"
  | "newCredentialId"
  | "signerCredentialId"
  | "challenge"
  | "prepared"
  | "expiresAt"
>;

export interface RootChangeRepository {
  /** Creates a PREPARED change. A live one for the wallet is superseded if it expired, otherwise the create is refused (null). */
  create(change: NewRootChange, now: Date): Promise<RootChange | null>;
  findById(id: string): Promise<RootChange | null>;
  /** The wallet's PREPARED or SUBMITTED change, if any. */
  findLive(walletId: string): Promise<RootChange | null>;
  /** One conditional update: only if the change is currently in one of `from`. Null otherwise (someone else moved it). */
  advance(input: {
    id: string;
    from: RootChangeStatus[];
    to: RootChangeStatus;
    patch?: { userOpHash?: string; failureCode?: string; completedAt?: Date };
  }): Promise<RootChange | null>;
  /** PREPARED/SUBMITTED changes past their expiry, oldest first. */
  listExpired(now: Date, limit: number): Promise<RootChange[]>;
}
