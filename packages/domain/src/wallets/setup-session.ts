/**
 * A short-lived, single-purpose grant that lets ONE person set up the wallet of ONE Kaada user in a
 * browser (WebAuthn needs a secure browser origin; Telegram and WhatsApp cannot do it themselves).
 * Any channel that has authenticated a user can create one and hand the link over.
 *
 * The browser holds an opaque random token and nothing else. Only a hash of that token is stored, so
 * a database leak cannot be turned into a working link, and the user the link belongs to is always
 * read from this record: a browser never names a user.
 *
 * Lifecycle: PENDING (may register a passkey) -> COMPLETED (registration finished; the token then
 * only allows read-only views until it expires) or REVOKED (a newer link replaced it). Time expiry is
 * derived from `expiresAt`, never stored.
 */
export const WALLET_SETUP_STATUSES = ["PENDING", "COMPLETED", "REVOKED"] as const;
export type WalletSetupStatus = (typeof WALLET_SETUP_STATUSES)[number];

export interface WalletSetupSession {
  id: string;
  userId: string;
  /** SHA-256 (hex) of the opaque token. The token itself is never stored. */
  tokenHash: string;
  status: WalletSetupStatus;
  expiresAt: Date;
  /** When registration finished and the session was consumed. */
  usedAt?: Date;
  createdAt: Date;
}

export type NewWalletSetupSession = Pick<
  WalletSetupSession,
  "id" | "userId" | "tokenHash" | "expiresAt"
>;

export interface WalletSetupSessionRepository {
  /** Stores a new PENDING session. */
  create(session: NewWalletSetupSession): Promise<WalletSetupSession>;
  /** The session for a token hash, in any state (the caller checks status and expiry). */
  findByTokenHash(tokenHash: string): Promise<WalletSetupSession | null>;
  /** Retires every PENDING session of the user, so only the newest link works. Returns how many. */
  revokePending(userId: string): Promise<number>;
  /**
   * PENDING -> COMPLETED, atomically, only if still PENDING and unexpired at `now`. Exactly one of
   * several concurrent callers gets the session back; the rest get null.
   */
  complete(id: string, now: Date): Promise<WalletSetupSession | null>;
}

/** True while a session may still be used for registration. */
export function isSetupSessionOpen(session: WalletSetupSession, now: Date): boolean {
  return session.status === "PENDING" && session.expiresAt.getTime() > now.getTime();
}

/** True while a session may still be used for read-only views (open, or completed and not expired). */
export function isSetupSessionViewable(session: WalletSetupSession, now: Date): boolean {
  return session.status !== "REVOKED" && session.expiresAt.getTime() > now.getTime();
}
