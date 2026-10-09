import { randomUUID } from "node:crypto";

import { CELO_CHAIN_ID, evmAddressCodec } from "@kaada/domain";

import type { PrismaClient } from "../generated/prisma/client.js";

export type CeloSeedClient = Pick<PrismaClient, "asset">;

/**
 * Celo assets whose exact metadata is VERIFIED. Nothing here is guessed.
 *
 * Provenance
 * - Textile's official address book for its live Celo deployment (chain 42220) lists cNGN, USDC,
 *   wARS, wBRL, IDRX and USDT with the addresses and decimals below.
 * - Every address and `decimals()` was also read on chain (eth_call to https://forno.celo.org,
 *   2026-10-09): cNGN 6, wARS 18 ("Peso Argentino"), wBRL 18 ("Real Brasileño"), IDRX 2, and
 *   USDT/USDC 6 (USDT is "Tether USD" with on-chain symbol "USD₮"; "USDT" is Kaada's canonical
 *   label). USDT is also in Celo's launch announcement and USDC in Circle's developer docs.
 *
 * `fiatCode` is explicit metadata saying which currency the token represents; settlement mapping reads
 * it and nothing infers a currency from a symbol.
 *
 * cNGN is exactly 0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f, the Textile token. The separate Mento
 * Nigerian Naira token (on-chain symbol NGNm, 0xE2702Bd97ee33c88c8f6f92DA3B733608aa76F71) is a
 * different asset and is deliberately NOT seeded.
 *
 * Still not seeded (not verified): wMXN, wCOP, wPEN, wCLP, USA₮.
 */
export const celoAssets = [
  {
    symbol: "USDT",
    name: "Tether USD",
    kind: "USD_STABLECOIN",
    fiatCode: "USD",
    contractAddress: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    decimals: 6,
  },
  {
    symbol: "USDC",
    name: "USDC",
    kind: "USD_STABLECOIN",
    fiatCode: "USD",
    contractAddress: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    decimals: 6,
  },
  {
    symbol: "cNGN",
    name: "cNGN",
    kind: "LOCAL_STABLECOIN",
    fiatCode: "NGN",
    countryCode: "NG",
    contractAddress: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    decimals: 6,
  },
  {
    symbol: "wARS",
    name: "Peso Argentino",
    kind: "LOCAL_STABLECOIN",
    fiatCode: "ARS",
    countryCode: "AR",
    contractAddress: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D",
    decimals: 18,
  },
  {
    symbol: "wBRL",
    name: "Real Brasileño",
    kind: "LOCAL_STABLECOIN",
    fiatCode: "BRL",
    countryCode: "BR",
    contractAddress: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0",
    decimals: 18,
  },
  {
    symbol: "IDRX",
    name: "IDRX",
    kind: "LOCAL_STABLECOIN",
    fiatCode: "IDR",
    countryCode: "ID",
    contractAddress: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22",
    decimals: 2,
  },
] as const satisfies readonly CeloAssetDefinition[];

export interface CeloAssetDefinition {
  symbol: string;
  name: string;
  kind: "USD_STABLECOIN" | "LOCAL_STABLECOIN";
  fiatCode: string;
  countryCode?: string;
  contractAddress: string;
  decimals: number;
}

/** Textile's Celo settlement contracts, documented here and not used for execution yet. */
export const textileCeloContracts = {
  limitOrderReactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3",
  feeController: "0x7b005466F905DD882A959888154587fA76cd3Ea7",
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  feeBps: 1,
} as const;

/**
 * Idempotent. Keyed by (chainId, lowercase contractAddress), so a second run changes nothing but
 * descriptive metadata. It never changes decimals (that would silently reinterpret stored amounts)
 * and never re-activates an asset an operator deactivated.
 */
export async function seedCeloAssets(
  db: CeloSeedClient,
  assets: readonly CeloAssetDefinition[] = celoAssets,
): Promise<void> {
  for (const asset of assets) {
    const contractAddress = evmAddressCodec.normalize(asset.contractAddress);
    const existing = await db.asset.findUnique({
      where: { chainId_contractAddress: { chainId: CELO_CHAIN_ID, contractAddress } },
    });
    if (existing) {
      if (existing.decimals !== asset.decimals) {
        throw new Error(`Refusing to change decimals of existing asset ${asset.symbol}`);
      }
      await db.asset.update({
        where: { id: existing.id },
        data: {
          name: asset.name,
          fiatCode: asset.fiatCode,
          countryCode: asset.countryCode ?? null,
        },
      });
    } else {
      await db.asset.create({
        data: {
          id: randomUUID(),
          symbol: asset.symbol,
          name: asset.name,
          kind: asset.kind,
          chainId: CELO_CHAIN_ID,
          contractAddress,
          decimals: asset.decimals,
          fiatCode: asset.fiatCode,
          ...(asset.countryCode && { countryCode: asset.countryCode }),
        },
      });
    }
  }
}
