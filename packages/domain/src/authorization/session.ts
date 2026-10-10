/**
 * The short-lived UI interaction in which a person enters their PIN for ONE priced payment.
 *
 * It is NOT the approval (that is PaymentAuthorization) and its token is never an authorization id.
 * The row is created without a token when a payment becomes ready; whoever renders the secure link
 * (a channel, later) asks for a token, and only its SHA-256 is stored. The browser holds nothing but
 * that token: the user, wallet, intent and route all come from this row.
 *
 * PENDING -> AUTHORIZED (PIN verified, approval recorded) | EXPIRED (time ran out) | CANCELLED
 * (the payment changed). A PIN lock is not a session state: it belongs to the user, so a fresh
 * session can never be used to dodge it.
 */
export const AUTHORIZATION_SESSION_STATUSES = [
  "PENDING",
  "AUTHORIZED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type AuthorizationSessionStatus = (typeof AUTHORIZATION_SESSION_STATUSES)[number];

export interface AuthorizationSession {
  id: string;
  userId: string;
  walletId: string;
  intentId: string;
  intentRevision: number;
  routeId: string;
  /** SHA-256 hex of the opaque token, once a link has been issued. */
  tokenHash?: string;
  tokenIssuedAt?: Date;
  status: AuthorizationSessionStatus;
  expiresAt: Date;
  /** When the session was authorized. */
  usedAt?: Date;
  cancelReason?: string;
  createdAt: Date;
}

export type NewAuthorizationSession = Pick<
  AuthorizationSession,
  "id" | "userId" | "walletId" | "intentId" | "intentRevision" | "routeId" | "expiresAt"
>;

export interface AuthorizationSessionRepository {
  /**
   * The live PENDING session for (user, intent revision, route), or a new one. Idempotent: duplicate
   * deliveries get the same session. An expired PENDING one is marked EXPIRED first.
   */
  createOrGetPending(
    session: NewAuthorizationSession,
    now: Date,
  ): Promise<{ session: AuthorizationSession; created: boolean }>;
  findById(id: string): Promise<AuthorizationSession | null>;
  findByTokenHash(tokenHash: string): Promise<AuthorizationSession | null>;
  /** Sets (replacing any earlier) the token hash of a PENDING, unexpired session. Null otherwise. */
  issueToken(input: {
    id: string;
    tokenHash: string;
    now: Date;
  }): Promise<AuthorizationSession | null>;
  /** PENDING -> AUTHORIZED atomically, only if unexpired. Exactly one concurrent caller wins. */
  markAuthorized(id: string, now: Date): Promise<AuthorizationSession | null>;
  /** PENDING -> EXPIRED (idempotent). Null if it was not PENDING. */
  markExpired(id: string): Promise<AuthorizationSession | null>;
  /** PENDING -> CANCELLED. Null if it was not PENDING. */
  cancel(id: string, reason: string): Promise<AuthorizationSession | null>;
  /**
   * Cancels the intent's PENDING sessions that do not match `keep` (all of them when `keep` is
   * null). Returns the cancelled sessions.
   */
  cancelPendingExcept(
    intentId: string,
    keep: { revision: number; routeId: string } | null,
    reason: string,
  ): Promise<AuthorizationSession[]>;
}

export function isSessionOpen(session: AuthorizationSession, now: Date): boolean {
  return session.status === "PENDING" && session.expiresAt.getTime() > now.getTime();
}
