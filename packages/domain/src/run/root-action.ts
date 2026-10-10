import type { JsonObject } from "../json.js";

/**
 * A short-lived grant to confirm ONE root (passkey) action for ONE execution: deploying the smart
 * account and installing the restricted permission. The root passkey authorizes WALLET SETUP; the PIN
 * authorizes the PAYMENT. Neither can stand in for the other, and the browser never supplies calldata:
 * it only signs the challenge the server fixed when the operation was prepared.
 */
export const ROOT_ACTION_KINDS = ["DEPLOY_AND_INSTALL_PERMISSION"] as const;
export type RootActionKind = (typeof ROOT_ACTION_KINDS)[number];

export type RootActionStatus = "PENDING" | "COMPLETED" | "EXPIRED" | "CANCELLED";

export interface RootActionSession {
  id: string;
  userId: string;
  walletId: string;
  executionId: string;
  kind: RootActionKind;
  /** SHA-256 of the opaque token, once a link has been issued. */
  tokenHash?: string;
  status: RootActionStatus;
  /** The 32-byte hash (hex) the passkey must sign. */
  challenge: string;
  /** The prepared, UNSIGNED operation. Contains no secret. */
  prepared: JsonObject;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
}

export type NewRootActionSession = Pick<
  RootActionSession,
  "id" | "userId" | "walletId" | "executionId" | "kind" | "challenge" | "prepared" | "expiresAt"
>;

export interface RootActionSessionRepository {
  /** At most one PENDING session per execution: an existing live one is returned instead. */
  createOrGetPending(
    session: NewRootActionSession,
    now: Date,
  ): Promise<{ session: RootActionSession; created: boolean }>;
  findById(id: string): Promise<RootActionSession | null>;
  findByTokenHash(tokenHash: string): Promise<RootActionSession | null>;
  /** Sets the token hash of a PENDING, unexpired session. Null otherwise. */
  issueToken(input: {
    id: string;
    tokenHash: string;
    now: Date;
  }): Promise<RootActionSession | null>;
  /** PENDING -> COMPLETED atomically, only if unexpired. Exactly one concurrent caller wins. */
  complete(id: string, now: Date): Promise<RootActionSession | null>;
  /** PENDING -> EXPIRED / CANCELLED. Null if it was not PENDING. */
  close(id: string, status: "EXPIRED" | "CANCELLED"): Promise<RootActionSession | null>;
  findPendingByExecution(executionId: string): Promise<RootActionSession | null>;
}
