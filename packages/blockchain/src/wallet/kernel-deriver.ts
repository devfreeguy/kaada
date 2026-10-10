import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { PasskeyValidatorContractVersion, toPasskeyValidator } from "@zerodev/passkey-validator";
import { createPublicClient, http, keccak256, toHex } from "viem";
import type { Address } from "viem";
import { celo } from "viem/chains";

import type { RootCredential } from "@kaada/domain";

import type { AccountAddressDeriver } from "./kernel-provisioning.js";

/**
 * The only file that touches the wallet SDK for provisioning. It builds a Kernel v3.3 account whose
 * sudo (root) validator is the passkey validator, and reads the address the factory would deploy to.
 * Pinned versions: KERNEL_V3_3, EntryPoint 0.7, passkey validator 0.0.3 (patched), all deployed on Celo.
 * No private key is involved at any point: only the passkey's public coordinates.
 */
export function createKernelAddressDeriver(
  options: { rpcUrl?: string } = {},
): AccountAddressDeriver {
  const client = createPublicClient({ chain: celo, transport: http(options.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");

  return {
    async deriveAddress(root: RootCredential): Promise<string> {
      const webAuthnKey = {
        pubX: BigInt(`0x${root.publicKeyX}`),
        pubY: BigInt(`0x${root.publicKeyY}`),
        authenticatorId: root.credentialId,
        // keccak256 of the credential id bytes, as the validator expects.
        authenticatorIdHash: keccak256(toHex(Buffer.from(root.credentialId, "base64url"))),
        rpID: root.rpId,
      };
      const validator = await toPasskeyValidator(client, {
        webAuthnKey,
        entryPoint,
        kernelVersion: KERNEL_V3_3,
        validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
      });
      const account = await createKernelAccount(client, {
        plugins: { sudo: validator },
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
