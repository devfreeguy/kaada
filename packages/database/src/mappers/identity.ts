import type { Identity, NewIdentity, NewUser, Session, User } from "@kaada/domain";

import type {
  Identity as IdentityRow,
  Prisma,
  Session as SessionRow,
  User as UserRow,
} from "../generated/prisma/client.js";
import { jsonInput, maybe, readJsonObject } from "./support.js";

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    ...maybe("username", row.username),
    ...maybe("displayName", row.displayName),
    ...maybe("avatarUrl", row.avatarUrl),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function userCreateData(user: NewUser): Prisma.UserUncheckedCreateInput {
  return {
    id: user.id,
    username: user.username ?? null,
    displayName: user.displayName ?? null,
    avatarUrl: user.avatarUrl ?? null,
  };
}

export function toIdentity(row: IdentityRow): Identity {
  return {
    id: row.id,
    userId: row.userId,
    type: row.type,
    externalId: row.externalId,
    ...maybe("username", row.username),
    ...maybe("phone", row.phone),
    ...maybe("metadata", readJsonObject(row.metadata, "Identity.metadata")),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function identityCreateData(identity: NewIdentity): Prisma.IdentityUncheckedCreateInput {
  return {
    id: identity.id,
    userId: identity.userId,
    type: identity.type,
    externalId: identity.externalId,
    username: identity.username ?? null,
    phone: identity.phone ?? null,
    ...maybe("metadata", jsonInput(identity.metadata, "Identity.metadata")),
  };
}

export function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.userId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    ...maybe("revokedAt", row.revokedAt),
    createdAt: row.createdAt,
  };
}
