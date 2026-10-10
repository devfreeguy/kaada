import {
  AUTHORIZATION_AUDIT_EVENTS,
  KaadaError,
  createId,
  validateExecutionAgainstAuthorization,
} from "@kaada/domain";
import type { AuthorizationCheck, ExecutionCandidate, PaymentAuthorization } from "@kaada/domain";

import type { AuthorizationUnitOfWork } from "./ports.js";

/**
 * Answers "can this execution happen under this authorization?" and, when it can, takes the
 * authorization exactly once. It accepts normalized domain values only: a later build converts a
 * firm provider quote into an ExecutionCandidate and calls this; no provider type reaches here.
 *
 * Nothing in this build calls `consume`: there is no execution yet. The state machine exists, and is
 * tested, so that it is already correct when execution arrives.
 */
export class AuthorizationPolicyService {
  private readonly now: () => Date;

  constructor(private readonly deps: { unitOfWork: AuthorizationUnitOfWork; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Pure check, no I/O, nothing consumed. */
  check(authorization: PaymentAuthorization, candidate: ExecutionCandidate): AuthorizationCheck {
    return validateExecutionAgainstAuthorization(authorization, candidate, this.now());
  }

  /**
   * Loads the authorization and checks the candidate against it. NEVER consumes: obtaining or planning
   * a firm price must not burn the person's approval, because a later signing or broadcast can still
   * fail. Consumption (below) belongs immediately before real execution.
   */
  async validate(
    authorizationId: string,
    candidate: ExecutionCandidate,
  ): Promise<AuthorizationCheck> {
    const authorization =
      await this.deps.unitOfWork.read.paymentAuthorizations.findById(authorizationId);
    if (!authorization) return { ok: false, violations: ["NOT_ACTIVE"] };
    return this.check(authorization, candidate);
  }

  /**
   * Validates and then consumes in one go. The consumption is a single conditional UPDATE, so of two
   * concurrent executions exactly one gets the authorization; the other is refused with
   * AUTHORIZATION_REJECTED. A candidate outside the bounds consumes nothing and needs a new
   * authorization.
   */
  async validateAndConsume(
    authorizationId: string,
    candidate: ExecutionCandidate,
  ): Promise<PaymentAuthorization> {
    const repositories = this.deps.unitOfWork.read;
    const authorization = await repositories.paymentAuthorizations.findById(authorizationId);
    if (!authorization) {
      throw new KaadaError("AUTHORIZATION_REJECTED", "no such authorization");
    }
    const check = this.check(authorization, candidate);
    if (!check.ok) {
      await repositories.audit.append({
        id: createId(),
        userId: authorization.userId,
        type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorizationRejected,
        entityType: "payment_authorization",
        entityId: authorization.id,
        data: { violations: check.violations },
      });
      throw new KaadaError("AUTHORIZATION_REJECTED", "the payment is outside what was authorized", {
        details: { violations: check.violations },
      });
    }
    const consumed = await repositories.paymentAuthorizations.consume(authorization.id, this.now());
    if (!consumed) {
      throw new KaadaError("AUTHORIZATION_REJECTED", "this authorization was already used");
    }
    await repositories.audit.append({
      id: createId(),
      userId: consumed.userId,
      type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorizationConsumed,
      entityType: "payment_authorization",
      entityId: consumed.id,
    });
    return consumed;
  }

  /** Withdraws an active authorization (for example when the user cancels). */
  async revoke(authorizationId: string, reason: string): Promise<boolean> {
    const repositories = this.deps.unitOfWork.read;
    const revoked = await repositories.paymentAuthorizations.revoke(
      authorizationId,
      reason,
      this.now(),
    );
    if (!revoked) return false;
    await repositories.audit.append({
      id: createId(),
      userId: revoked.userId,
      type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorizationRevoked,
      entityType: "payment_authorization",
      entityId: revoked.id,
      data: { reason },
    });
    return true;
  }
}
