import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { createPublicClient, http } from "viem";
import type { Address, Hex } from "viem";
import { celo } from "viem/chains";
import type { Chain } from "viem";

import type { RootCredential } from "@kaada/domain";

import { toRootValidator } from "./root-validator.js";

import type { AccountAddressDeriver } from "./kernel-provisioning.js";

/** What it takes to create an account on chain: the factory to call and the call data. Public, deterministic, no key. */
export interface KernelFactoryCall {
  address: string;
  factory: Address;
  factoryData: Hex;
}

/** Reads the factory call that deploys the account of `root` (the same account the deriver gives the address of). */
export type KernelFactoryCallReader = (root: RootCredential) => Promise<KernelFactoryCall>;

/**
 * The only file that touches the wallet SDK for provisioning. It builds a Kernel v3.3 account whose
 * sudo (root) validator is the passkey validator, and reads the address the factory would deploy to.
 * Pinned versions: KERNEL_V3_3, EntryPoint 0.7, passkey validator 0.0.3 (patched), all deployed on Celo.
 * No private key is involved at any point: only the root's public coordinates (a passkey, or a P-256 device key).
 */
export function createKernelAddressDeriver(
  options: {
    rpcUrl?: string;
    /** Testnet fixtures only: the chain and the passkey validator deployed there. Default: Celo mainnet. */
    network?: { chain: Chain; passkeyValidatorAddress?: Address };
  } = {},
): AccountAddressDeriver {
  const chain = options.network?.chain ?? celo;
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");

  return {
    async deriveAddress(root: RootCredential): Promise<string> {
      const validator = await toRootValidator(client, root, {
        ...(options.network?.passkeyValidatorAddress && {
          passkeyValidatorAddress: options.network.passkeyValidatorAddress,
        }),
      });
      const account = await createKernelAccount(client, {
        plugins: { sudo: validator as never },
        entryPoint,
        kernelVersion: KERNEL_V3_3,
      });
      return account.address;
    },

    async isDeployed(address: string): Promise<boolean> {
      const code = await client.getCode({ address: address as Address });
      return code !== undefined && code !== "0x";
    },
  };
}

export function createKernelFactoryCallReader(
  options: {
    rpcUrl?: string;
    network?: { chain: Chain; passkeyValidatorAddress?: Address };
  } = {},
): KernelFactoryCallReader {
  const chain = options.network?.chain ?? celo;
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  return async (root) => {
    const validator = await toRootValidator(client, root, {
      ...(options.network?.passkeyValidatorAddress && {
        passkeyValidatorAddress: options.network.passkeyValidatorAddress,
      }),
    });
    const account = await createKernelAccount(client, {
      plugins: { sudo: validator as never },
      entryPoint,
      kernelVersion: KERNEL_V3_3,
    });
    const args = await account.getFactoryArgs();
    if (!args.factory || !args.factoryData) {
      throw new Error("the account has no factory call");
    }
    return { address: account.address, factory: args.factory, factoryData: args.factoryData };
  };
}
