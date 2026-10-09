import type { ProviderRepository, RecipientRepository } from "@kaada/domain";

import type { Prisma } from "../generated/prisma/client.js";
import {
  recipientCreateData,
  toProvider,
  toProviderCapability,
  toRecipient,
} from "../mappers/index.js";
import type { Db } from "./db.js";

export function createRecipientRepository(db: Db): RecipientRepository {
  return {
    async findById(id) {
      const row = await db.recipient.findUnique({ where: { id } });
      return row ? toRecipient(row) : null;
    },

    async listSavedByOwner(ownerUserId) {
      const rows = await db.recipient.findMany({
        where: { ownerUserId, isSaved: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(toRecipient);
    },

    async create(recipient) {
      return toRecipient(await db.recipient.create({ data: recipientCreateData(recipient) }));
    },
  };
}

export function createProviderRepository(db: Db): ProviderRepository {
  return {
    async findBySlug(slug) {
      const row = await db.provider.findUnique({ where: { slug } });
      return row ? toProvider(row) : null;
    },

    async listActive() {
      const rows = await db.provider.findMany({
        where: { isActive: true },
        orderBy: { slug: "asc" },
      });
      return rows.map(toProvider);
    },

    async listCapabilities(query = {}) {
      const where: Prisma.ProviderCapabilityWhereInput = {
        isActive: true,
        provider: { isActive: true },
        ...(query.providerId !== undefined && { providerId: query.providerId }),
        ...(query.capability !== undefined && { capability: query.capability }),
        ...(query.inputAssetId !== undefined && { inputAssetId: query.inputAssetId }),
        ...(query.outputAssetId !== undefined && { outputAssetId: query.outputAssetId }),
        ...(query.countryCode !== undefined && { countryCode: query.countryCode }),
        ...(query.chainId !== undefined && { chainId: query.chainId }),
      };
      const rows = await db.providerCapability.findMany({ where, orderBy: { id: "asc" } });
      return rows.map(toProviderCapability);
    },
  };
}
