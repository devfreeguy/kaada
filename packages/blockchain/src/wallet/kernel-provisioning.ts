import { CELO_CHAIN_ID, KaadaError, evmAddressCodec } from "@kaada/domain";
import type {
  DerivedAccount,
  RootCredential,
  WalletDeployment,
  WalletProvisioningAdapter,
} from "@kaada/domain";

import { KERNEL_PROVIDER } from "./kernel-policy.js";

/** Computes the counterfactual account address for a root credential. Deterministic, read-only. */
export interface AccountAddressDeriver {
  deriveAddress(root: RootCredential): Promise<string>;
  /** Whether contract code exists at the address on the chain. */
  isDeployed(address: string): Promise<boolean>;
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/;

/**
 * Provisions a Kernel v3.3 smart account whose ONLY root authority is the user's passkey. This stage
 * derives the stable counterfactual address; it deploys nothing, spends nothing and holds no secret:
 * the inputs are public coordinates and the output is an address.
 */
export class KernelProvisioningAdapter implements WalletProvisioningAdapter {
  readonly provider = KERNEL_PROVIDER;

  constructor(private readonly deriver: AccountAddressDeriver) {}

  async deriveAccount(input: { chainId: number; root: RootCredential }): Promise<DerivedAccount> {
    if (input.chainId !== CELO_CHAIN_ID) {
      throw new KaadaError(
        "WALLET_PROVISIONING_FAILED",
        "smart accounts are provisioned on Celo mainnet only",
      );
    }
    const { root } = input;
    if (
      !HEX_32_BYTES.test(root.publicKeyX) ||
      !HEX_32_BYTES.test(root.publicKeyY) ||
      root.credentialId.length === 0 ||
      root.rpId.length === 0
    ) {
      throw new KaadaError(
        "CREDENTIAL_REJECTED",
        "the root credential is not a valid P-256 passkey",
      );
    }

    const address = evmAddressCodec.normalize(await this.deriver.deriveAddress(root));
    // Never claim an undeployed account is deployed: ask the chain.
    const deployment: WalletDeployment = (await this.deriver.isDeployed(address))
      ? "DEPLOYED"
      : "COUNTERFACTUAL";
    return { address, provider: this.provider, deployment };
  }
}
