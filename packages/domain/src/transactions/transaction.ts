import type { JsonObject } from "../json.js";

export const TRANSACTION_TYPES = ["APPROVAL", "TRANSFER", "SWAP", "CONTRACT_CALL", "RAMP"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = [
  "CREATED",
  "SIGNING",
  "SUBMITTED",
  "CONFIRMING",
  "CONFIRMED",
  "FAILED",
  "REPLACED",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

/**
 * One on-chain (or ramp) operation belonging to an execution. `amount`, `gasAmount` and `nonce` are
 * canonical integer strings (never JS numbers); amounts are in the smallest unit of `assetId` /
 * `gasAssetId` respectively.
 */
export interface Transaction {
  id: string;
  executionId: string;
  type: TransactionType;
  status: TransactionStatus;
  chainId: number;
  /** Absent until broadcast; unique per chain once present. */
  hash?: string;
  fromAddress?: string;
  toAddress?: string;
  assetId?: string;
  amount?: string;
  gasAmount?: string;
  gasAssetId?: string;
  nonce?: string;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}
