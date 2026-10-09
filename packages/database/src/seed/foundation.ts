import { randomUUID } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.js";

export type SeedClient = Pick<PrismaClient, "provider" | "asset">;

/**
 * Stable foundation records only: providers and fiat currencies. Verified Celo tokens are seeded by
 * celo-assets.ts and provider capabilities by capabilities.ts, each only once its facts are verified.
 */
export const providers = [
  { slug: "textile", name: "Textile", type: "FX" },
  { slug: "ripio", name: "Ripio", type: "RAMP" },
  { slug: "celo", name: "Celo", type: "RPC" },
] as const;

/** ISO 4217 fiat currencies for the corridors we expect to support. `decimals` is the minor unit. */
export const fiatAssets = [
  { fiatCode: "USD", name: "US Dollar", countryCode: "US", decimals: 2 },
  { fiatCode: "NGN", name: "Nigerian Naira", countryCode: "NG", decimals: 2 },
  { fiatCode: "ARS", name: "Argentine Peso", countryCode: "AR", decimals: 2 },
  { fiatCode: "BRL", name: "Brazilian Real", countryCode: "BR", decimals: 2 },
  { fiatCode: "IDR", name: "Indonesian Rupiah", countryCode: "ID", decimals: 2 },
] as const;

/** Idempotent: safe to run any number of times. Never changes an existing asset's decimals. */
export async function seedFoundation(db: SeedClient): Promise<void> {
  for (const { slug, name, type } of providers) {
    await db.provider.upsert({
      where: { slug },
      update: { name, type },
      create: { id: randomUUID(), slug, name, type },
    });
  }

  for (const { fiatCode, name, countryCode, decimals } of fiatAssets) {
    // The partial unique index on fiatCode is not visible to Prisma, so upsert is unavailable.
    const existing = await db.asset.findFirst({ where: { kind: "FIAT", fiatCode } });
    if (existing) {
      if (existing.decimals !== decimals) {
        // Changing decimals would silently reinterpret every stored amount.
        throw new Error(`Refusing to change decimals of existing asset ${fiatCode}`);
      }
      await db.asset.update({ where: { id: existing.id }, data: { name, countryCode } });
    } else {
      await db.asset.create({
        data: {
          id: randomUUID(),
          symbol: fiatCode,
          name,
          kind: "FIAT",
          fiatCode,
          countryCode,
          decimals,
        },
      });
    }
  }
}
