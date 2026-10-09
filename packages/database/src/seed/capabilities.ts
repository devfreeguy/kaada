import { randomUUID } from "node:crypto";

import { CELO_CHAIN_ID, evmAddressCodec } from "@kaada/domain";
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

const celoToken = (contractAddress: string): AssetRef => ({
  chainId: CELO_CHAIN_ID,
  contractAddress,
});

const USDT = celoToken("0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e");

/** Textile's live Celo corridors, each against USDT (official Textile address book). */
const TEXTILE_CELO_COUNTERPARTS = {
  cNGN: celoToken("0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f"),
  USDC: celoToken("0xcebA9300f2b948710d2653dD7B07f33A8B32118C"),
  wARS: celoToken("0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D"),
  wBRL: celoToken("0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0"),
  IDRX: celoToken("0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22"),
} as const;

/** What Textile v2 RFQ supports: firm quote, swap, exact input (sellAmount), exact output (buyAmount). */
const TEXTILE_RFQ_CAPABILITIES = ["QUOTE", "SWAP", "EXACT_INPUT", "EXACT_OUTPUT"] as const;

const TEXTILE_SOURCE =
  "Textile official address book (live Celo corridors) and Textile v2 RFQ documentation";

/**
 * Provider capabilities VERIFIED against the provider. Each directed pair and each capability type is
 * its own row; nothing implies another (one direction is not the reverse, QUOTE is not SWAP).
 *
 * Textile, Celo: cNGN, USDC, wARS, wBRL and IDRX each trade against USDT, listed in BOTH directions
 * explicitly (5 corridors x 2 directions x 4 capabilities = 40 rows). CONDITIONAL_EXECUTION is not
 * seeded: the RFQ capabilities above do not establish it. Textile ON_RAMP / OFF_RAMP / BANK_PAYOUT
 * belong to the separate Ramp API and are not seeded here. Nothing is seeded for wMXN, wCOP, wPEN,
 * wCLP or USA₮.
 *
 * Documented only (settlement contracts, fee 1 bps): see `textileCeloContracts` in celo-assets.ts.
 */
export const verifiedCapabilities: readonly CapabilityDefinition[] = Object.values(
  TEXTILE_CELO_COUNTERPARTS,
).flatMap((counterpart) =>
  [
    { input: USDT, output: counterpart },
    { input: counterpart, output: USDT },
  ].flatMap((direction) =>
    TEXTILE_RFQ_CAPABILITIES.map((capability): CapabilityDefinition => ({
      provider: "textile",
      capability,
      chainId: CELO_CHAIN_ID,
      input: direction.input,
      output: direction.output,
      source: TEXTILE_SOURCE,
    })),
  ),
);

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

  // Providers and assets repeat across definitions; look each up once per run.
  const providerMemo = new Map<string, Promise<{ id: string } | null>>();
  const assetMemo = new Map<string, Promise<string | undefined>>();
  const providerFor = (slug: string) => {
    if (!providerMemo.has(slug))
      providerMemo.set(slug, db.provider.findUnique({ where: { slug } }));
    return providerMemo.get(slug) as Promise<{ id: string } | null>;
  };
  const assetFor = (ref: AssetRef) => {
    const key = JSON.stringify(ref);
    if (!assetMemo.has(key)) assetMemo.set(key, resolveAsset(db, ref));
    return assetMemo.get(key) as Promise<string | undefined>;
  };

  for (const definition of definitions) {
    const provider = await providerFor(definition.provider);
    if (!provider) {
      report.skipped.push({ definition, reason: `provider ${definition.provider} is not seeded` });
      continue;
    }
    const inputAssetId = definition.input ? await assetFor(definition.input) : undefined;
    const outputAssetId = definition.output ? await assetFor(definition.output) : undefined;
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
