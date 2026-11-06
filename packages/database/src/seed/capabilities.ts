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
 * Textile's capabilities, VERIFIED against the provider. Each directed pair and each capability type is
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
export const textileCapabilities: readonly CapabilityDefinition[] = Object.values(
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

/**
 * Uniswap's Celo pairs, each one PROBED against the live Trading API in both amount modes before being listed here
 * (POST /v1/quote, 2026-11-06). The point of these rows is the pairs Textile has no corridor for at all; nothing is
 * listed against USDT, where Textile already serves every corridor and reserves its price.
 *
 * None of these is a single pool: the decoded route for cNGN -> wARS is cNGN/USDT then USDT/wARS, which is the dollar
 * pivot Kaada wants anyway, crossed inside one Universal Router transaction that either completes or reverts.
 *
 * WHY DIRECTION IS NOT ASSUMED, with the measured reason rather than the provider's message. `wBRL -> cNGN` answers
 * NoRouteFoundError, "No route with sufficient liquidity was found for this pair", at every size tried (6, 50, 500,
 * 5,000 wBRL), in both modes, under BEST_PRICE, and with each protocol version alone. That message is misleading: both
 * halves price on their own (`wBRL -> USDT` and `USDT -> cNGN` each return 200). Probing version by version shows why:
 *
 *   leg              v3   v4
 *   cNGN  <-> USDT   yes  no      cNGN has no v4 pool at all
 *   wARS  <-> USDT   yes  yes
 *   wBRL   -> USDT   NO   yes     the v3 USDT/wBRL pool holds wBRL and almost no USDT: one-sided
 *   USDT   -> wBRL   yes  yes
 *
 * So `wBRL -> cNGN` is the one path that must cross v4 then v3, and Uniswap's router does not chain versions. It is a
 * routing limit over a one-sided pool, not absent liquidity, and it is outside Kaada's control either way. The pair
 * still pays: the planner reaches it in two hops through USDT, where Textile holds both corridors.
 *
 * Everything that works does so because it stays on one version: cNGN <-> wARS is v3 throughout, wARS <-> wBRL is v4
 * throughout, and cNGN -> wBRL is v3 throughout.
 */
const UNISWAP_CELO = {
  cNGN: TEXTILE_CELO_COUNTERPARTS.cNGN,
  wARS: TEXTILE_CELO_COUNTERPARTS.wARS,
  wBRL: TEXTILE_CELO_COUNTERPARTS.wBRL,
  USDC: TEXTILE_CELO_COUNTERPARTS.USDC,
} as const;

/**
 * One directed pair. Listed one direction per entry and deliberately never mirrored: see the version table above for
 * what happens when a pair looks symmetric and is not.
 */
export type UniswapPair = readonly [keyof typeof UNISWAP_CELO, keyof typeof UNISWAP_CELO];

/** Every directed pair that answered in BOTH amount modes. Evidence, not a decision: see UNISWAP_ENABLED_PAIRS. */
export const UNISWAP_VERIFIED_PAIRS: readonly UniswapPair[] = [
  // Local to local: the corridors Textile cannot price at all.
  ["cNGN", "wARS"],
  ["wARS", "cNGN"],
  ["cNGN", "wBRL"],
  ["wARS", "wBRL"],
  ["wBRL", "wARS"],
  // Dollar to local and back. Textile serves these against USDT only, never against USDC.
  ["USDC", "cNGN"],
  ["cNGN", "USDC"],
  ["USDC", "wARS"],
  ["wARS", "USDC"],
  ["USDC", "wBRL"],
  ["wBRL", "USDC"],
];

/**
 * The pairs Kaada has DELIBERATELY turned on, which is what gets seeded.
 *
 * Verified and enabled are two different things. A pair earns a place above by answering the provider; it earns a place
 * here by having been settled end to end at least once. Until a Uniswap route has actually executed on chain, only the
 * corridor being proven is enabled, so a route that cannot yet be paid is never offered to anyone.
 *
 * To enable the rest, move entries down from UNISWAP_VERIFIED_PAIRS into this list. Nothing else changes.
 */
export const UNISWAP_ENABLED_PAIRS: readonly UniswapPair[] = [
  ["cNGN", "wARS"],
  ["wARS", "cNGN"],
];

/** Verified but not yet enabled. Exported so the difference stays visible and deliberate rather than looking lost. */
export const UNISWAP_PENDING_PAIRS: readonly UniswapPair[] = UNISWAP_VERIFIED_PAIRS.filter(
  ([from, to]) => !UNISWAP_ENABLED_PAIRS.some(([a, b]) => a === from && b === to),
);

/**
 * SWAP is included because the API returns executable Universal Router calldata for every enabled pair.
 *
 * EXACT_OUTPUT is deliberately NOT, even though the API will quote it. On an AMM the unfixed side moves, so an
 * exact-output trade has a maximum input rather than a known one, while Kaada's approval and its quoted input are a
 * single figure. The firm adapter therefore refuses it, and listing it here made the router choose Uniswap for "send
 * exactly 1,500 pesos" and fail only AFTER the person had entered their PIN. A capability row says what Kaada can
 * actually carry out, not what a provider can price.
 *
 * CONDITIONAL_EXECUTION is not included either: nothing probed establishes it.
 */
const UNISWAP_AMM_CAPABILITIES = ["QUOTE", "SWAP", "EXACT_INPUT"] as const;

const UNISWAP_SOURCE =
  "probed live against the Uniswap Trading API (POST /v1/quote, both modes) on Celo mainnet, 2026-11-06";

export const uniswapCapabilities: readonly CapabilityDefinition[] = UNISWAP_ENABLED_PAIRS.flatMap(
  ([from, to]) =>
    UNISWAP_AMM_CAPABILITIES.map((capability): CapabilityDefinition => ({
      provider: "uniswap",
      capability,
      chainId: CELO_CHAIN_ID,
      input: UNISWAP_CELO[from],
      output: UNISWAP_CELO[to],
      source: UNISWAP_SOURCE,
    })),
);

export const verifiedCapabilities: readonly CapabilityDefinition[] = [
  ...textileCapabilities,
  ...uniswapCapabilities,
];

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
