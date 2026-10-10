import type { AuditEvent } from "../execution/index.js";

/** Append-only audit trail. Entries never contain secrets: identifiers, statuses and reason codes only. */
export type NewAuditEvent = Omit<AuditEvent, "createdAt">;

export interface AuditRepository {
  append(event: NewAuditEvent): Promise<AuditEvent>;
  /** Newest first. For tests and operators. */
  listForUser(userId: string, limit?: number): Promise<AuditEvent[]>;
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
} as const;
