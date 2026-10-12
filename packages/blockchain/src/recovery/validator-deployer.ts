import { artifacts, passkeyCredentialCommitment, toFactoryCredential } from "@kaada/contracts";
import type { NewRootCredential, ValidatorDeployments } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import type { RootValidatorDeployer, RootValidatorInstance } from "@kaada/domain";
import { createPublicClient, createWalletClient, getAddress, http } from "viem";
import type { Abi, Address, Chain, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export interface ViemValidatorDeployerOptions {
  chain: Chain;
  rpcUrl: string;
  deployments: ValidatorDeployments;
  /** An EOA that pays gas for clone deployment. It holds no authority over any wallet. */
  relayerKey: Hex;
}

/**
 * Deploys the validator clone a root names, through the validator factory, paid by the relayer. The factory fixes the
 * clone's address from the credential and salt, so this can only ever create exactly the instance the wallet is already
 * committed to; it has no method that sends anything else.
 */
export class ViemValidatorDeployer implements RootValidatorDeployer {
  private readonly client;
  private readonly wallet;

  constructor(private readonly options: ViemValidatorDeployerOptions) {
    this.client = createPublicClient({ chain: options.chain, transport: http(options.rpcUrl) });
    this.wallet = createWalletClient({
      account: privateKeyToAccount(options.relayerKey),
      chain: options.chain,
      transport: http(options.rpcUrl),
    });
  }

  async ensureDeployed(
    instance: RootValidatorInstance,
  ): Promise<{ created: boolean; txHash?: string }> {
    const address = getAddress(instance.validatorAddress);
    if (await this.hasCode(address)) return { created: false };
    const target =
      instance.type === "PASSKEY"
        ? this.options.deployments.passkey
        : this.options.deployments.device;
    const credential: NewRootCredential =
      instance.type === "PASSKEY"
        ? {
            kind: "PASSKEY",
            credentialId: instance.credentialRef,
            publicKeyX: instance.publicKeyX,
            publicKeyY: instance.publicKeyY,
          }
        : {
            kind: "DEVICE_KEY",
            keyId: instance.credentialRef as Hex,
            publicKeyX: instance.publicKeyX,
            publicKeyY: instance.publicKeyY,
          };
    const hash = await this.wallet.writeContract({
      address: target.factory,
      abi: factoryAbi,
      functionName: "deploy",
      args: [
        instance.account === null ? ZERO : getAddress(instance.account),
        instance.purpose,
        passkeyCredentialCommitment(toFactoryCredential(credential)),
        instance.deploymentSalt as Hex,
      ],
      gas: 400_000n,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new KaadaError(
        "WALLET_PROVISIONING_FAILED",
        "the validator instance could not be deployed",
      );
    }
    // The deployment must land exactly where the wallet expects it (the node may lag a moment behind the receipt).
    for (let i = 0; i < 30; i += 1) {
      if (await this.hasCode(address)) return { created: true, txHash: hash };
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new KaadaError(
      "WALLET_PROVISIONING_FAILED",
      "the validator instance is not at the expected address",
    );
  }

  private async hasCode(address: Address): Promise<boolean> {
    const code = await this.client.getCode({ address });
    return code !== undefined && code !== "0x";
  }
}
