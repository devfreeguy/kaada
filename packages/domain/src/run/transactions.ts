import type { JsonObject } from "../json.js";
import type { Transaction, TransactionType } from "../transactions/index.js";

/** One irreversible step an execution takes on chain, recorded BEFORE it is sent. */
export interface TransactionStepInput {
  /** Unique per step ("exec:<id>:APPROVAL:1"): a retry finds the row instead of sending again. */
  idempotencyKey: string;
  executionId: string;
  type: TransactionType;
  chainId: number;
  fromAddress: string;
  toAddress?: string;
  assetId?: string;
  amount?: string;
  metadata?: JsonObject;
}

/**
 * Transaction records of an execution. Every transition is a conditional UPDATE, so two workers can
 * never both move a step forward, and `begin` is idempotent on the key.
 *
 * `userOpHash` (ERC-4337) and `hash` (the on-chain transaction) are different values and are stored
 * separately: the UserOperation hash exists from the moment it is accepted by the bundler, the
 * transaction hash only once the bundle is included.
 */
export interface ExecutionTransactionRepository {
  begin(input: TransactionStepInput): Promise<{ transaction: Transaction; created: boolean }>;
  findByKey(idempotencyKey: string): Promise<Transaction | null>;
  listByExecution(executionId: string): Promise<Transaction[]>;
  /** CREATED -> SUBMITTED, storing the UserOperation hash. Null if it was not CREATED. */
  markSubmitted(id: string, fields: { userOpHash: string; now: Date }): Promise<Transaction | null>;
  /** SUBMITTED / CONFIRMING / UNKNOWN -> CONFIRMED or FAILED from an on-chain receipt. */
  markIncluded(
    id: string,
    fields: { hash: string; blockNumber: string; success: boolean; now: Date },
  ): Promise<Transaction | null>;
  /**
   * The outcome is not known (outage, timeout while sending). Valid from CREATED too: a send that may
   * have reached the bundler is never treated as "not sent". Never resent; reconciled later.
   */
  markUnknown(id: string, now: Date): Promise<Transaction | null>;
  /** CREATED -> FAILED: it was never sent. */
  markNotSent(id: string, code: string, now: Date): Promise<Transaction | null>;
  /** Steps still waiting for an outcome (SUBMITTED, CONFIRMING, UNKNOWN). */
  listUnsettled(limit: number): Promise<Transaction[]>;
}
