import { randomUUID } from "node:crypto";

import { evmAddressCodec } from "@kaada/domain";
import type { CapabilityType } from "@kaada/domain";

import type { PrismaClient } from "../generated/prisma/client.js";

export type CapabilitySeedClient = Pick<PrismaClient, "provider" | "asset" | "providerCapability">;

/** How a capability names an asset: a token by chain and address, or a fiat currency by ISO code. */
export type AssetRef = { chainId: number; contractAddress: string } | { fiatCode: string };

export interface CapabilityDefinition {
  /** Provider slug, e.g. "textile". */
  provider: string;
  capability: CapabilityType;
  chainId?: number;
  input?: AssetRef;
  output?: AssetRef;
  countryCode?: string;
  /** Where this was verified. Comment-level provenance; it is not stored. */
  source: string;
}

/**
 * Provider capabilities that have been VERIFIED against the provider itself. Each directed pair and
 * each capability type is its own entry; nothing implies another (QUOTE is not SWAP, one direction
 * is not the reverse, SWAP is not EXACT_OUTPUT).
 *
 * Empty on purpose. The Textile corridors under discussion (USDC/USDT, cNGN, wARS, wBRL, IDRX) were
 * reported as working, but neither their token addresses nor the supported directions and exact
 * modes could be confirmed from Textile's documentation or API in this build, and the wFIAT/cNGN/IDRX
 * assets themselves are not seeded (see celo-assets.ts). A capability whose assets are missing is
 * skipped, never invented. Ripio's ON_RAMP / OFF_RAMP / BANK_PAYOUT likewise wait for verification of
 * the country and asset coverage of each mode.
 */
export const verifiedCapabilities: readonly CapabilityDefinition[] = [];

export interface CapabilitySeedReport {
  created: number;
  existing: number;
  skipped: { definition: CapabilityDefinition; reason: string }[];
}

async function resolveAsset(db: CapabilitySeedClient, ref: AssetRef): Promise<string | undefined> {
  if ("fiatCode" in ref) {
    const row = await db.asset.findFirst({ where: { kind: "FIAT", fiatCode: ref.fiatCode } });
    return row?.id;
  }
  const contractAddress = evmAddressCodec.normalize(ref.contractAddress);
  const row = await db.asset.findUnique({
    where: { chainId_contractAddress: { chainId: ref.chainId, contractAddress } },
  });
  return row?.id;
}

/**
 * Find-or-create, never duplicating: an existing row (active or not) is left exactly as it is, so an
 * operator who disabled a capability is not overridden by a re-seed. The NULL-safe unique index from
 * migration 20261011000000 backs this up against concurrent runs.
 */
export async function seedProviderCapabilities(
  db: CapabilitySeedClient,
  definitions: readonly CapabilityDefinition[] = verifiedCapabilities,
): Promise<CapabilitySeedReport> {
  const report: CapabilitySeedReport = { created: 0, existing: 0, skipped: [] };

  for (const definition of definitions) {
    const provider = await db.provider.findUnique({ where: { slug: definition.provider } });
    if (!provider) {
      report.skipped.push({ definition, reason: `provider ${definition.provider} is not seeded` });
      continue;
    }
    const inputAssetId = definition.input ? await resolveAsset(db, definition.input) : undefined;
    const outputAssetId = definition.output ? await resolveAsset(db, definition.output) : undefined;
    if (definition.input && !inputAssetId) {
      report.skipped.push({ definition, reason: "input asset is not seeded" });
      continue;
    }
    if (definition.output && !outputAssetId) {
      report.skipped.push({ definition, reason: "output asset is not seeded" });
      continue;
    }

    const identity = {
      providerId: provider.id,
      capability: definition.capability,
      chainId: definition.chainId ?? null,
      inputAssetId: inputAssetId ?? null,
      outputAssetId: outputAssetId ?? null,
      countryCode: definition.countryCode ?? null,
    };
    if (await db.providerCapability.findFirst({ where: identity })) {
      report.existing += 1;
      continue;
    }
    try {
      await db.providerCapability.create({ data: { id: randomUUID(), ...identity } });
      report.created += 1;
    } catch (error) {
      // A concurrent seed won the race and the unique index rejected this insert.
      if (await db.providerCapability.findFirst({ where: identity })) report.existing += 1;
      else throw error;
    }
  }
  return report;
}
