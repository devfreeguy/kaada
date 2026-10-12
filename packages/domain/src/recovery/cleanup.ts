/**
 * The bulk operations account recovery needs on payment and session state, each one a single conditional statement so
 * it is safe to repeat. Rows are kept as history; nothing is deleted.
 */
export interface RecoveryCleanupRepository {
  /** PENDING authorization sessions of the wallet -> CANCELLED. Returns their ids. */
  cancelAuthorizationSessions(walletId: string, reason: string, now: Date): Promise<string[]>;
  /** ACTIVE payment authorizations of the wallet -> REVOKED, so none can be revived. Returns their ids. */
  revokePaymentAuthorizations(walletId: string, reason: string, now: Date): Promise<string[]>;
  /** PENDING root-action sessions of the wallet -> CANCELLED. Returns how many. */
  cancelRootActionSessions(walletId: string): Promise<number>;
  /** Every live web session of the user -> revoked. Returns how many. */
  revokeWebSessions(userId: string, at: Date): Promise<number>;
  /**
   * Executions of the wallet that may already have reached the chain or the provider: SIGNING, SUBMITTING, SUBMITTED,
   * AWAITING_CONFIRMATION, CONFIRMED, EXECUTING, SETTLING. A recovery waits for these to resolve.
   */
  countInFlightExecutions(walletId: string): Promise<number>;
}
