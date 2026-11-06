import { createPublicClient, http, parseAbi } from "viem";
import type { Address } from "viem";
import { celo } from "viem/chains";

import { CELO_CHAIN_ID, KaadaError, PERMIT2 } from "@kaada/domain";
import type { AllowanceReader, Permit2AllowanceReader } from "@kaada/domain";

const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
]);

/**
 * Permit2's allowance getter.
 *
 * Argument order is (owner, token, spender), which is NOT the order its own `approve` takes — getting
 * that wrong reads a slot that is always zero and looks exactly like "no allowance". It returns three
 * values, of which Kaada reads the amount and the expiration.
 */
const permit2 = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
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

/**
 * READ-ONLY: the Permit2 allowance a wallet has granted a spender for one token.
 *
 * A separate reader from the ERC-20 one because it answers a different question with a different shape:
 * Permit2 returns an amount AND an expiration, and an expired allowance is no allowance at all however
 * large its amount. Kept read-only like its sibling: nothing here signs or sends.
 */
export function createViemPermit2AllowanceReader(
  options: { rpcUrl?: string } = {},
): Permit2AllowanceReader {
  const client = createPublicClient({ chain: celo, transport: http(options.rpcUrl) });
  return {
    async readPermit2Allowance({ chainId, owner, token, spender }) {
      if (chainId !== CELO_CHAIN_ID) {
        throw new KaadaError("PAIR_NOT_SUPPORTED", "allowances are only read on Celo mainnet");
      }
      const [amount, expiration] = await client.readContract({
        address: PERMIT2,
        abi: permit2,
        functionName: "allowance",
        args: [owner as Address, token as Address, spender as Address],
      });
      return { amount: BigInt(amount), expiration: BigInt(expiration) };
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
