import { createPublicClient, http, parseAbi } from "viem";
import type { Address } from "viem";
import { celo } from "viem/chains";

import { CELO_CHAIN_ID, KaadaError } from "@kaada/domain";
import type { AllowanceReader } from "@kaada/domain";

const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/** READ-ONLY allowance lookups on Celo through viem. It has no write path of any kind. */
export function createViemAllowanceReader(options: { rpcUrl?: string } = {}): AllowanceReader {
  const client = createPublicClient({ chain: celo, transport: http(options.rpcUrl) });
  return {
    async readAllowance({ chainId, token, owner, spender }) {
      if (chainId !== CELO_CHAIN_ID) {
        throw new KaadaError("PAIR_NOT_SUPPORTED", "allowances are only read on Celo mainnet");
      }
      return client.readContract({
        address: token as Address,
        abi: erc20,
        functionName: "allowance",
        args: [owner as Address, spender as Address],
      });
    },
  };
}

/** READ-ONLY: whether contract code exists at an address (a deployed smart account). */
export function createViemDeploymentChecker(options: { rpcUrl?: string } = {}): {
  isDeployed(input: { chainId: number; address: string }): Promise<boolean>;
} {
  const client = createPublicClient({ chain: celo, transport: http(options.rpcUrl) });
  return {
    async isDeployed({ chainId, address }) {
      if (chainId !== CELO_CHAIN_ID) {
        throw new KaadaError("PAIR_NOT_SUPPORTED", "deployment is only read on Celo mainnet");
      }
      const code = await client.getCode({ address: address as Address });
      return code !== undefined && code !== "0x";
    },
  };
}
