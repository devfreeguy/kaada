import {
  AUTHORIZATION_AUDIT_EVENTS,
  CELO_CHAIN_ID,
  KaadaError,
  createId,
  isWalletActive,
} from "@kaada/domain";
import type { AuthorizationSession, PaymentAuthorization, Quote } from "@kaada/domain";

import type { AgentLog } from "../agent/ports.js";

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
  /** Says WHY a link was cancelled: a payment that goes stale before the person can confirm it must never be a mystery. */
  log?: AgentLog;
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

/** Why a PIN was not accepted. */
export type PinRejection = Exclude<AuthorizeResult, { status: "AUTHORIZED" }>;

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
    const { session } = await this.inspect(token);
    const rejected = await this.verifyPin(session, pin);
    if (rejected) return rejected;
    return { status: "AUTHORIZED", authorization: await this.authorizeVerified(session) };
  }

  /**
   * The open session behind a link and the payment it is for, re-read just now. Fails fast, before any proof is spent, if the
   * payment has already moved on (changed, cancelled, or already being carried out).
   */
  async inspect(token: string) {
    const session = await this.deps.sessions.resolveOpen(token);
    const context = await this.assertCurrent(this.uow.read, session);
    await this.assertNotAlreadyPaid(this.uow.read, session);
    return { session, ...context };
  }

  /** Checks the PIN for a session. Undefined when it is right; otherwise the reason it was not accepted (audited, never the PIN). */
  async verifyPin(session: AuthorizationSession, pin: string): Promise<PinRejection | undefined> {
    const verification = await this.deps.pins.verify(session.userId, pin);
    return verification.status === "VERIFIED" ? undefined : this.reject(session, verification);
  }

  /**
   * Records the approval once the person has PROVED it, by the PIN (above) or by their wallet's own passkey or device key over the
   * exact operation (see RootPaymentService). The proof is the caller's to check first: nothing here does.
   */
  async authorizeVerified(session: AuthorizationSession): Promise<PaymentAuthorization> {
    // Decide in one transaction: lock the intent so a concurrent edit either lands first (and this
    // is refused) or lands after (and its revocation sees this authorization). The session is
    // consumed in the same transaction by a conditional UPDATE, so a second browser using the same
    // link loses.
    return this.uow.transaction(async (repositories) => {
      await repositories.intents.lockForUpdate(session.intentId);
      const context = await this.assertCurrent(repositories, session);
      // Under the intent lock: a payment that is moving or already sent can never be authorized a second time.
      await this.assertNotAlreadyPaid(repositories, session);
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
  /**
   * Double-spend guard. An execution's idempotency key is per authorization, so a SECOND authorization of the same payment
   * would start a second payment. Once money for this payment has moved or may be moving, the link is dead: the session is
   * cancelled and the person is told this payment is not available to authorize again.
   */
  private async assertNotAlreadyPaid(
    repositories: AuthorizationRepositories,
    session: AuthorizationSession,
  ): Promise<void> {
    if (!(await repositories.paymentAuthorizations.hasSpendingExecution(session.intentId))) return;
    this.deps.log?.("warn", "authorization.session_cancelled", {
      sessionId: session.id,
      intentId: session.intentId,
      reason: "ALREADY_PAID",
    });
    await repositories.authorizationSessions.cancel(session.id, "STALE");
    throw new KaadaError(
      "AUTHORIZATION_SESSION_INVALID",
      "this payment was already authorized and is being carried out, so it cannot be authorized again",
    );
  }

  private async assertCurrent(
    repositories: AuthorizationRepositories,
    session: AuthorizationSession,
  ) {
    const intent = await repositories.intents.findById(session.intentId);
    const route = await repositories.routes.findById(session.routeId);
    const wallet = await repositories.wallets.findById(session.walletId);
    // Every check that failed, by name, so the log says exactly why the payment can no longer be authorized.
    const failed: string[] = [];
    if (!intent) failed.push("INTENT_MISSING");
    if (!route) failed.push("ROUTE_MISSING");
    if (!wallet) failed.push("WALLET_MISSING");
    if (intent) {
      if (intent.userId !== session.userId) failed.push("INTENT_OTHER_USER");
      if (intent.revision !== session.intentRevision) {
        failed.push(
          `INTENT_REVISED(${String(intent.revision)}!=${String(session.intentRevision)})`,
        );
      }
      if (intent.status !== "RESOLVED") failed.push(`INTENT_${intent.status}`);
    }
    if (route) {
      if (intent && route.intentId !== intent.id) failed.push("ROUTE_OTHER_INTENT");
      if (route.intentRevision !== session.intentRevision) failed.push("ROUTE_OLD_REVISION");
      if (route.status !== "VALID") failed.push(`ROUTE_${route.status}`);
    }
    if (wallet) {
      if (wallet.userId !== session.userId) failed.push("WALLET_OTHER_USER");
      if (!isWalletActive(wallet)) failed.push("WALLET_NOT_ACTIVE");
      if (wallet.chainId !== CELO_CHAIN_ID) failed.push("WALLET_WRONG_CHAIN");
    }
    if (!intent || !route || !wallet || failed.length > 0) {
      this.deps.log?.("warn", "authorization.session_cancelled", {
        sessionId: session.id,
        intentId: session.intentId,
        reason: "STALE",
        failed: failed.join(","),
      });
      await repositories.authorizationSessions.cancel(session.id, "STALE");
      throw new KaadaError(
        "AUTHORIZATION_SESSION_INVALID",
        "this payment changed and can no longer be authorized",
      );
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
  ): Promise<PinRejection> {
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
