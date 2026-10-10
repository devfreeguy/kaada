import { AUTHORIZATION_AUDIT_EVENTS, KaadaError, createId, isSessionOpen } from "@kaada/domain";
import type { AssetRegistry, AuthorizationSession, Quote } from "@kaada/domain";

import type { AuthorizationSummary, MoneyView } from "../responses/agent-response.js";
import { OPAQUE_TOKEN_PATTERN, hashOpaqueToken, newOpaqueToken } from "./token.js";
import type { PinStatus } from "./pin-service.js";
import type { AuthorizationRepositories, AuthorizationUnitOfWork } from "./ports.js";
import { retireAuthorization } from "./retire.js";
import { buildPricedSummary } from "./summary.js";

export interface AuthorizationSessionServiceDeps {
  unitOfWork: AuthorizationUnitOfWork;
  assets: Pick<AssetRegistry, "getById">;
  pins: { status(userId: string): Promise<PinStatus> };
  /** The web origin that serves the authorization page; the link is `${origin}/authorize/${token}`. */
  origin: string;
  /** How long the person has to open the link and enter the PIN. */
  sessionTtlMs: number;
  now?: () => Date;
}

/** What the secure page shows. The ids of the user, wallet, intent and route stay on the server. */
export interface AuthorizationView {
  summary: AuthorizationSummary;
  fees: MoneyView[];
  expiresAt: Date;
  /** The price is an estimate; the final price is confirmed immediately before payment. */
  indicative: true;
  mock: boolean;
  pin: { isSet: boolean; resetRequired: boolean; lockedUntil?: Date };
}

/** The slice of repositories the agent hands over while it is storing a priced route. */
export type SessionRepositories = Pick<
  AuthorizationRepositories,
  "authorizationSessions" | "paymentAuthorizations" | "audit"
>;

/**
 * The UI interaction in which a person enters their PIN for ONE priced payment.
 *
 * Creation is idempotent per (user, intent revision, route) while a live session exists, so a
 * duplicate delivery never piles up sessions. A session is created WITHOUT a link: the bearer token
 * appears only when a channel asks for it at render time (`issueLink`), because the response that
 * announces a session is stored in the conversation history and must hold no secret.
 *
 * Also the single place where a changed payment retires what was built for the old one.
 */
export class AuthorizationSessionService {
  private readonly uow: AuthorizationUnitOfWork;
  private readonly now: () => Date;

  constructor(private readonly deps: AuthorizationSessionServiceDeps) {
    this.uow = deps.unitOfWork;
    this.now = deps.now ?? (() => new Date());
  }

  /** Called by routing, in its transaction, when a PAYMENT has a stored route. */
  async begin(
    repositories: SessionRepositories,
    input: {
      userId: string;
      walletId: string;
      intentId: string;
      intentRevision: number;
      routeId: string;
    },
  ): Promise<{ sessionId: string; expiresAt: Date }> {
    const now = this.now();
    const { session, created } = await repositories.authorizationSessions.createOrGetPending(
      { id: createId(), ...input, expiresAt: new Date(now.getTime() + this.deps.sessionTtlMs) },
      now,
    );
    if (created) {
      await repositories.audit.append({
        id: createId(),
        userId: input.userId,
        type: AUTHORIZATION_AUDIT_EVENTS.sessionCreated,
        entityType: "authorization_session",
        entityId: session.id,
      });
    }
    return { sessionId: session.id, expiresAt: session.expiresAt };
  }

  /**
   * A new route replaced the old one for the same revision: whatever was built on the old route (an
   * unused session, an approval) no longer matches what would be executed, so it is retired.
   */
  async routeReplaced(
    repositories: SessionRepositories,
    intentId: string,
    keep: { revision: number; routeId: string },
  ): Promise<void> {
    await retireAuthorization(repositories, intentId, keep, "ROUTE_REPLACED", this.now());
  }

  /**
   * Issues the secure link for a session. Called by the channel that is rendering the "Authorize
   * payment" button for `userId`; it must be that user's own session. Issuing again replaces the
   * earlier link, so only one link works at a time.
   */
  async issueLink(input: { sessionId: string; userId: string }): Promise<{
    url: string;
    token: string;
    expiresAt: Date;
  }> {
    const session = await this.uow.read.authorizationSessions.findById(input.sessionId);
    const now = this.now();
    if (!session || session.userId !== input.userId || !isSessionOpen(session, now)) {
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this authorization is not available");
    }
    const token = newOpaqueToken();
    const updated = await this.uow.read.authorizationSessions.issueToken({
      id: session.id,
      tokenHash: hashOpaqueToken(token),
      now,
    });
    if (!updated) {
      throw new KaadaError("AUTHORIZATION_SESSION_INVALID", "this authorization is not available");
    }
    return {
      url: `${this.deps.origin.replace(/\/$/, "")}/authorize/${token}`,
      token,
      expiresAt: updated.expiresAt,
    };
  }

  /**
   * The session a bearer token belongs to, if it is still PENDING and unexpired. Anything else (an
   * unknown or malformed token, an expired, used or cancelled session) is the same generic failure.
   * A PENDING session found past its time is marked EXPIRED (once, audited).
   */
  async resolveOpen(token: string): Promise<AuthorizationSession> {
    const invalid = () =>
      new KaadaError("AUTHORIZATION_SESSION_INVALID", "this authorization link is not valid");
    if (typeof token !== "string" || !OPAQUE_TOKEN_PATTERN.test(token)) throw invalid();
    const session = await this.uow.read.authorizationSessions.findByTokenHash(
      hashOpaqueToken(token),
    );
    if (!session) throw invalid();
    if (isSessionOpen(session, this.now())) return session;
    if (session.status === "PENDING") {
      const expired = await this.uow.read.authorizationSessions.markExpired(session.id);
      if (expired) {
        await this.uow.read.audit.append({
          id: createId(),
          userId: session.userId,
          type: AUTHORIZATION_AUDIT_EVENTS.sessionExpired,
          entityType: "authorization_session",
          entityId: session.id,
        });
      }
    }
    throw invalid();
  }

  /** What the secure page shows for a token. Read only; nothing is created or consumed. */
  async view(token: string): Promise<AuthorizationView> {
    const session = await this.resolveOpen(token);
    const invalid = () =>
      new KaadaError("AUTHORIZATION_SESSION_INVALID", "this payment can no longer be authorized");
    const read = this.uow.read;
    const intent = await read.intents.findById(session.intentId);
    const route = await read.routes.findById(session.routeId);
    if (
      !intent ||
      !route ||
      intent.revision !== session.intentRevision ||
      route.intentRevision !== session.intentRevision ||
      route.status !== "VALID" ||
      !intent.amount
    ) {
      throw invalid();
    }
    const quotes: Quote[] = [];
    for (const step of route.steps) {
      if (!step.quoteId) continue;
      const quote = await read.quotes.findById(step.quoteId);
      if (quote) quotes.push(quote);
    }
    const recipient = intent.recipientId
      ? await read.recipients.findById(intent.recipientId)
      : null;
    const priced = await buildPricedSummary({
      route,
      quotes,
      mode: intent.amount.mode,
      ...(recipient?.displayName && { recipient: recipient.displayName }),
      assets: this.deps.assets,
    });
    const pin = await this.deps.pins.status(session.userId);
    return {
      summary: priced.summary,
      fees: priced.fees,
      expiresAt: session.expiresAt,
      indicative: true,
      mock: priced.mock,
      pin: {
        isSet: pin.isSet,
        resetRequired: pin.resetRequired,
        ...(pin.lockedUntil && { lockedUntil: pin.lockedUntil }),
      },
    };
  }
}
