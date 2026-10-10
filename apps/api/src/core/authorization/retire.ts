import { AUTHORIZATION_AUDIT_EVENTS, createId } from "@kaada/domain";

import type { AuthorizationRepositories } from "./ports.js";

type Repositories = Pick<
  AuthorizationRepositories,
  "authorizationSessions" | "paymentAuthorizations" | "audit"
>;

/**
 * Retires what was built for a payment that has changed: pending sessions are CANCELLED and active
 * approvals REVOKED, except those matching `keep` (the current revision and route). Rows are kept as
 * history; nothing is deleted. Safe to call repeatedly.
 */
export async function retireAuthorization(
  repositories: Repositories,
  intentId: string,
  keep: { revision: number; routeId: string } | null,
  reason: "INTENT_REVISED" | "ROUTE_REPLACED",
  now: Date,
): Promise<void> {
  for (const session of await repositories.authorizationSessions.cancelPendingExcept(
    intentId,
    keep,
    reason,
  )) {
    await repositories.audit.append({
      id: createId(),
      userId: session.userId,
      type: AUTHORIZATION_AUDIT_EVENTS.sessionCancelled,
      entityType: "authorization_session",
      entityId: session.id,
      data: { reason },
    });
  }
  for (const authorization of await repositories.paymentAuthorizations.revokeActiveExcept(
    intentId,
    keep,
    reason,
    now,
  )) {
    await repositories.audit.append({
      id: createId(),
      userId: authorization.userId,
      type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorizationRevoked,
      entityType: "payment_authorization",
      entityId: authorization.id,
      data: { reason },
    });
  }
}
