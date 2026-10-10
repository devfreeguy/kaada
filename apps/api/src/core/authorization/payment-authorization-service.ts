import {
  AUTHORIZATION_AUDIT_EVENTS,
  CELO_CHAIN_ID,
  KaadaError,
  createId,
  isWalletActive,
} from "@kaada/domain";
import type { AuthorizationSession, PaymentAuthorization, Quote } from "@kaada/domain";

import { authorizationBounds, authorizedRoute, totalSlippageBps } from "./bounds.js";
import type { PinVerification, TransactionPinService } from "./pin-service.js";
import type { AuthorizationRepositories, AuthorizationUnitOfWork } from "./ports.js";
import type { AuthorizationSessionService } from "./session-service.js";

export interface PaymentAuthorizationServiceDeps {
  unitOfWork: AuthorizationUnitOfWork;
  sessions: AuthorizationSessionService;
  pins: TransactionPinService;
  /** How long an approved payment stays executable. Short on purpose. */
  authorizationTtlMs: number;
  now?: () => Date;
}

/** What entering a PIN on the secure page produced. No outcome here carries the PIN. */
export type AuthorizeResult =
  | { status: "AUTHORIZED"; authorization: PaymentAuthorization }
  | { status: "INVALID_PIN"; attemptsRemaining: number; lockedUntil?: Date }
  | { status: "LOCKED"; lockedUntil: Date }
  | { status: "PIN_NOT_SET" }
  | { status: "PIN_RESET_REQUIRED" }
  | { status: "INVALID_FORMAT" };

/**
 * Turns "this person entered the right PIN for this priced payment" into a durable, immutable
 * PaymentAuthorization, and consumes the one-time session that carried the entry.
 *
 * Everything that identifies the payment (user, wallet, intent, revision, route) is read from the
 * session row and re-checked against the live intent and route: the browser supplies a token and a
 * PIN and nothing else. The bounds are computed here from the stored route, the same way the screen
 * computed them, never accepted from the caller.
 */
export class PaymentAuthorizationService {
  private readonly uow: AuthorizationUnitOfWork;
  private readonly now: () => Date;

  constructor(private readonly deps: PaymentAuthorizationServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
  }

  async authorize(token: string, pin: string): Promise<AuthorizeResult> {
    const session = await this.deps.sessions.resolveOpen(token);

    // Fail fast, before spending a PIN attempt, if the payment has already moved on.
    await this.assertCurrent(this.uow.read, session);

    const verification = await this.deps.pins.verify(session.userId, pin);
    if (verification.status !== "VERIFIED") {
      return this.reject(session, verification);
    }

    // Decide in one transaction: lock the intent so a concurrent edit either lands first (and this
    // is refused) or lands after (and its revocation sees this authorization). The session is
    // consumed in the same transaction by a conditional UPDATE, so a second browser using the same
    // link loses.
    const authorization = await this.uow.transaction(async (repositories) => {
      await repositories.intents.lockForUpdate(session.intentId);
      const context = await this.assertCurrent(repositories, session);
      const now = this.now();

      const consumed = await repositories.authorizationSessions.markAuthorized(session.id, now);
      if (!consumed) {
        throw new KaadaError(
          "AUTHORIZATION_SESSION_INVALID",
          "this authorization link is not valid",
        );
      }

      // Only one approval per intent is live: a new one replaces any earlier.
      await repositories.paymentAuthorizations.revokeActiveExcept(
        session.intentId,
        null,
        "REPLACED",
        now,
      );

      const { intent, route, quotes, wallet, recipientAddress } = context;
      const mode = intent.amount?.mode;
      if (!mode || (intent.type !== "SEND" && intent.type !== "CONVERT")) {
        throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this payment cannot be authorized");
      }
      const created = await repositories.paymentAuthorizations.create({
        id: createId(),
        userId: session.userId,
        walletId: wallet.id,
        intentId: intent.id,
        intentRevision: intent.revision,
        routeId: route.id,
        sessionId: session.id,
        operation: intent.type,
        chainId: wallet.chainId,
        recipient: {
          ...(intent.recipientId && { recipientId: intent.recipientId }),
          ...(recipientAddress && { address: recipientAddress }),
        },
        ...(intent.destinationCountry && { destinationCountry: intent.destinationCountry }),
        bounds: authorizationBounds(route, totalSlippageBps(quotes), mode),
        route: authorizedRoute(route, quotes),
        expiresAt: new Date(now.getTime() + this.deps.authorizationTtlMs),
      });
      await repositories.audit.append({
        id: createId(),
        userId: session.userId,
        type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorized,
        entityType: "payment_authorization",
        entityId: created.id,
        // Identifiers only: the bounds live in the authorization row, not in the audit trail.
        data: { intentId: intent.id, intentRevision: intent.revision, routeId: route.id },
      });
      return created;
    });
    return { status: "AUTHORIZED", authorization };
  }

  /** The user's current approval for an intent, if one is live and unexpired. */
  async activeFor(intentId: string): Promise<PaymentAuthorization | null> {
    const found = await this.uow.read.paymentAuthorizations.findActiveByIntent(intentId);
    return found && found.expiresAt.getTime() > this.now().getTime() ? found : null;
  }

  /** Marks approvals past their time EXPIRED (and audits nothing secret). Safe to call repeatedly. */
  async expireDue(): Promise<number> {
    const expired = await this.uow.read.paymentAuthorizations.expireDue(this.now());
    return expired.length;
  }

  /**
   * Re-reads the payment from storage and refuses unless it is exactly what the session was created
   * for: same intent at the same revision, still resolved, a still-VALID route for that revision, and
   * the user's own active wallet. A stale session is cancelled.
   */
  private async assertCurrent(
    repositories: AuthorizationRepositories,
    session: AuthorizationSession,
  ) {
    const stale = async (): Promise<never> => {
      await repositories.authorizationSessions.cancel(session.id, "STALE");
      throw new KaadaError(
        "AUTHORIZATION_SESSION_INVALID",
        "this payment changed and can no longer be authorized",
      );
    };
    const intent = await repositories.intents.findById(session.intentId);
    const route = await repositories.routes.findById(session.routeId);
    const wallet = await repositories.wallets.findById(session.walletId);
    if (
      !intent ||
      !route ||
      !wallet ||
      intent.userId !== session.userId ||
      wallet.userId !== session.userId ||
      intent.revision !== session.intentRevision ||
      intent.status !== "RESOLVED" ||
      route.intentId !== intent.id ||
      route.intentRevision !== session.intentRevision ||
      route.status !== "VALID" ||
      !isWalletActive(wallet) ||
      wallet.chainId !== CELO_CHAIN_ID
    ) {
      return stale();
    }
    const quotes: Quote[] = [];
    for (const step of route.steps) {
      if (!step.quoteId) continue;
      const quote = await repositories.quotes.findById(step.quoteId);
      if (quote) quotes.push(quote);
    }
    const recipient = intent.recipientId
      ? await repositories.recipients.findById(intent.recipientId)
      : null;
    const recipientAddress = recipient?.walletAddress?.toLowerCase();
    return {
      intent,
      route,
      quotes,
      wallet,
      ...(recipientAddress && /^0x[0-9a-f]{40}$/.test(recipientAddress) && { recipientAddress }),
    };
  }

  private async reject(
    session: AuthorizationSession,
    verification: Exclude<PinVerification, { status: "VERIFIED" }>,
  ): Promise<AuthorizeResult> {
    // The reason is a code; the PIN is not here to be logged.
    await this.uow.read.audit.append({
      id: createId(),
      userId: session.userId,
      type: AUTHORIZATION_AUDIT_EVENTS.paymentAuthorizationRejected,
      entityType: "authorization_session",
      entityId: session.id,
      data: { reason: verification.status },
    });
    switch (verification.status) {
      case "INVALID":
        return {
          status: "INVALID_PIN",
          attemptsRemaining: verification.attemptsRemaining,
          ...(verification.lockedUntil && { lockedUntil: verification.lockedUntil }),
        };
      case "LOCKED":
        return { status: "LOCKED", lockedUntil: verification.lockedUntil };
      case "NOT_SET":
        return { status: "PIN_NOT_SET" };
      case "RESET_REQUIRED":
        return { status: "PIN_RESET_REQUIRED" };
      case "INVALID_FORMAT":
        return { status: "INVALID_FORMAT" };
    }
  }
}
