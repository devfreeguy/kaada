import { createPublicClient, http, parseAbi } from "viem";
import type { Address } from "viem";
import { celo, celoSepolia } from "viem/chains";

import type { ChainReader } from "./balance-reader.js";

const erc20 = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

/** A read-only Celo reader over viem. Batches token reads through Multicall3 (deployed on Celo). */
export function createViemChainReader(
  options: { rpcUrl?: string; network?: "celo-mainnet" | "celo-sepolia" } = {},
): ChainReader {
  const chain = options.network === "celo-sepolia" ? celoSepolia : celo;
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });

  return {
    async getErc20Balances(owner, tokens) {
      const results = await client.multicall({
        allowFailure: false,
        contracts: tokens.map((token) => ({
          address: token as Address,
          abi: erc20,
          functionName: "balanceOf" as const,
          args: [owner as Address],
        })),
      });
      return [...results];
    },

    async getErc20Decimals(tokens) {
      const results = await client.multicall({
        allowFailure: false,
        contracts: tokens.map((token) => ({
          address: token as Address,
          abi: erc20,
          functionName: "decimals" as const,
        })),
      });
      return results.map((value) => (typeof value === "number" ? value : 0));
    },
  };
}
