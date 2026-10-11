import { celoSepolia } from "viem/chains";
import type { Address } from "viem";

import type { KernelNetwork } from "./zerodev-kernel-adapter.js";

/**
 * Celo Sepolia (chain 11142220) as a TEST FIXTURE network for the Kernel adapter. The SDK's pinned
 * passkey validator exists on mainnet only, so the testnet takes the address of a copy deployed there, and
 * the RIP-7212 P-256 precompile was verified on this chain. Never used by the application's configuration.
 */
export function celoSepoliaKernelNetwork(passkeyValidatorAddress: Address): KernelNetwork {
  return { chain: celoSepolia, passkeyValidatorAddress, p256Precompile: true };
}
