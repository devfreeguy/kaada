import type { JsonObject } from "../json.js";

export const IDENTITY_TYPES = ["TELEGRAM", "WHATSAPP", "PHONE", "EMAIL", "DISCORD", "X"] as const;
export type IdentityType = (typeof IDENTITY_TYPES)[number];

/**
 * A Kaada account. It is not a Telegram (or any channel) account: channels attach to it as
 * identities, and one user can have several identities, wallets and web sessions.
 */
export interface User {
  id: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  /**
   * Where the person mainly uses Kaada (ISO 3166 alpha-2; "ZZ" = chose "Other"), chosen by them, never inferred from a chat
   * account. Absent until they choose: nothing assumes a country for them.
   */
  homeCountry?: string;
  /** Their default currency (ISO 4217), from the home country. Absent for "Other" and until a country is chosen. */
  homeCurrency?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** An external account (Telegram, phone, email, ...) that belongs to one Kaada user. */
export interface Identity {
  id: string;
  userId: string;
  type: IdentityType;
  /** The channel's own stable id for the account, e.g. the Telegram user id. */
  externalId: string;
  username?: string;
  phone?: string;
  metadata?: JsonObject;
  createdAt: Date;
  updatedAt: Date;
}

/** A web session. Only a hash of the token exists; the plaintext token is never stored. */
export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}

export function isSessionActive(session: Session, now: Date): boolean {
  return session.revokedAt === undefined && session.expiresAt.getTime() > now.getTime();
}
