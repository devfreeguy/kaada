import { randomUUID } from "node:crypto";

import { CELO_CHAIN_ID, evmAddressCodec } from "@kaada/domain";

import type { PrismaClient } from "../generated/prisma/client.js";

export type CeloSeedClient = Pick<PrismaClient, "asset">;

/**
 * Celo assets whose exact metadata was VERIFIED. Nothing here is guessed: an asset appears only
 * when its address came from the issuer's own documentation or announcement AND was confirmed on
 * chain (chain id 42220, contract code present, `name()`, `symbol()` and `decimals()` read through
 * an eth_call against Celo's public RPC, https://forno.celo.org, on 2026-10-09).
 *
 * `fiatCode` is explicit metadata saying which currency the token represents. Settlement mapping
 * reads it; nothing infers a currency from a symbol.
 *
 * Provenance
 * - USDT  0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e: Celo's announcement "Tether Token (USDT) Is Now
 *   Available on Celo" (blog.celo.org). On chain: name "Tether USD", symbol "USD₮", decimals 6.
 *   Kaada's canonical label for it is "USDT" (what people and the language model say); the on-chain
 *   symbol is the Tether sign.
 * - USDC  0xcebA9300f2b948710d2653dD7B07f33A8B32118C: Circle developer documentation, "USDC contract
 *   addresses", Celo mainnet row (developers.circle.com/stablecoins/usdc-contract-addresses).
 *   On chain: name "USDC", symbol "USDC", decimals 6.
 *
 * NOT seeded because no authoritative address and decimals were found, and none may be guessed:
 * wBRL, wARS, wMXN, wCOP, wPEN, wCLP (Ripio wFIAT stack), cNGN, IDRX, and USA₮. The public pages that
 * announce them (Celo blog, Ripio) do not list contract addresses in what could be retrieved. Add
 * each one here, with its source, once its address is confirmed from the issuer and on chain.
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
] as const;

/**
 * Idempotent. Keyed by (chainId, lowercase contractAddress), so a second run changes nothing but
 * descriptive metadata. It never changes decimals (that would silently reinterpret stored amounts)
 * and never re-activates an asset an operator deactivated.
 */
export async function seedCeloAssets(
  db: CeloSeedClient,
  assets: readonly (typeof celoAssets)[number][] = celoAssets,
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
        data: { name: asset.name, fiatCode: asset.fiatCode },
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
        },
      });
    }
  }
}
