import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.js";

export type DevelopmentSeedClient = Pick<PrismaClient, "provider">;

/** The slug the development-only mock FX adapter is stored under. */
export const MOCK_FX_PROVIDER_SLUG = "mock-textile";

/**
 * Development-only records. The mock FX provider needs a Provider row so the quotes and routes it
 * prices can be persisted against a real foreign key. The row is INACTIVE on purpose: it never shows
 * up in capability lookups or active-provider listings, and it is never seeded in production
 * (the seed script skips this when NODE_ENV=production). Idempotent; never changes isActive.
 */
export async function seedDevelopmentProviders(db: DevelopmentSeedClient): Promise<void> {
  await db.provider.upsert({
    where: { slug: MOCK_FX_PROVIDER_SLUG },
    update: { name: "Mock Textile (development only)", type: "FX" },
    create: {
      id: randomUUID(),
      slug: MOCK_FX_PROVIDER_SLUG,
      name: "Mock Textile (development only)",
      type: "FX",
      isActive: false,
      metadata: { mock: true },
    },
  });
}
