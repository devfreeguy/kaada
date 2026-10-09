import type { Identity, IdentityType, User } from "./identity.js";

export type NewUser = Omit<User, "createdAt" | "updatedAt">;
export type NewIdentity = Omit<Identity, "createdAt" | "updatedAt">;

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  create(user: NewUser): Promise<User>;
  /** Creates a user together with its first identity, atomically. */
  createWithIdentity(input: { user: NewUser; identity: NewIdentity }): Promise<{
    user: User;
    identity: Identity;
  }>;
}

export interface IdentityRepository {
  /** Looks up the owner of an external account, e.g. ("TELEGRAM", "123456"). */
  findByExternalId(type: IdentityType, externalId: string): Promise<Identity | null>;
  /** Identities of a type with this channel username (usernames are not guaranteed unique). */
  findByUsername(type: IdentityType, username: string): Promise<Identity[]>;
  listForUser(userId: string): Promise<Identity[]>;
  /** Attaches another identity to an existing user. */
  add(identity: NewIdentity): Promise<Identity>;
}
