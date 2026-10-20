import type { AuditEvent } from "../execution/index.js";

/** Append-only audit trail. Entries never contain secrets: identifiers, statuses and reason codes only. */
export type NewAuditEvent = Omit<AuditEvent, "createdAt">;

export interface AuditRepository {
  append(event: NewAuditEvent): Promise<AuditEvent>;
  /** Newest first. For tests and operators. */
  listForUser(userId: string, limit?: number): Promise<AuditEvent[]>;
  /** Every event of one type for a person, newest first (not limited by how busy their trail is). */
  listByType(userId: string, type: string, limit?: number): Promise<AuditEvent[]>;
}

export const WALLET_AUDIT_EVENTS = {
  provisioningStarted: "wallet.provisioning_started",
  provisioned: "wallet.provisioned",
  provisioningFailed: "wallet.provisioning_failed",
  credentialRegistered: "wallet.credential_registered",
  credentialRevoked: "wallet.credential_revoked",
  permissionCreated: "wallet.permission_created",
  permissionActivated: "wallet.permission_activated",
  permissionRevoked: "wallet.permission_revoked",
  suspended: "wallet.suspended",
  reactivated: "wallet.reactivated",
  recoveryRequired: "wallet.recovery_required",
  setupSessionCreated: "wallet.setup_session_created",
  passkeyRegistrationStarted: "wallet.passkey_registration_started",
  setupSessionConsumed: "wallet.setup_session_consumed",
  setupFailed: "wallet.setup_failed",
  rootChangePrepared: "wallet.root_change_prepared",
  rootChangeConfirmed: "wallet.root_change_confirmed",
  rootChangeFailed: "wallet.root_change_failed",
} as const;
