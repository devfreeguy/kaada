import type { IdentityRepository, UserRepository } from "@kaada/domain";

import { identityCreateData, toIdentity, toUser, userCreateData } from "../mappers/index.js";
import { DataIntegrityError } from "../mappers/index.js";
import type { Db } from "./db.js";

export function createUserRepository(db: Db): UserRepository {
  return {
    async findById(id) {
      const row = await db.user.findUnique({ where: { id } });
      return row ? toUser(row) : null;
    },

    async findByUsername(username) {
      const row = await db.user.findUnique({ where: { username } });
      return row ? toUser(row) : null;
    },

    /**
     * One atomic write. A unique conflict on (type, externalId) or username rejects the whole call
     * with Prisma error P2002; callers racing on the same account should re-read the identity.
     */
    async createWithIdentity({ user, identity }) {
      if (identity.userId !== user.id) {
        throw new Error("identity.userId must equal user.id");
      }
      const { userId: _userId, ...identityData } = identityCreateData(identity);
      const row = await db.user.create({
        data: { ...userCreateData(user), identities: { create: identityData } },
        include: { identities: true },
      });
      const created = row.identities[0];
      if (!created) throw new DataIntegrityError("user was created without its identity");
      return { user: toUser(row), identity: toIdentity(created) };
    },
  };
}

export function createIdentityRepository(db: Db): IdentityRepository {
  return {
    async findByExternalId(type, externalId) {
      const row = await db.identity.findUnique({
        where: { type_externalId: { type, externalId } },
      });
      return row ? toIdentity(row) : null;
    },

    async listForUser(userId) {
      const rows = await db.identity.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
      return rows.map(toIdentity);
    },

    async add(identity) {
      return toIdentity(await db.identity.create({ data: identityCreateData(identity) }));
    },
  };
}
