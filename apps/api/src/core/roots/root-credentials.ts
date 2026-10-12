import { KaadaError } from "@kaada/domain";
import type {
  PasskeyRepository,
  RootChallenge,
  RootCredential,
  RootProof,
  Wallet,
  WalletCredential,
  WalletCredentialRepository,
} from "@kaada/domain";

import { DeviceKeyRootAdapter, PasskeyRootAdapter } from "./adapters.js";
import type { RootContext } from "./adapters.js";

export interface RootRepositories {
  walletCredentials: Pick<WalletCredentialRepository, "findRoot">;
  passkeys: Pick<PasskeyRepository, "listActiveForUser">;
}

/** A WalletCredential row as the root the Kernel adapter and the root adapters work with. */
export function toRootCredential(row: WalletCredential, fallbackRpId: string): RootCredential {
  if (row.kind === "DEVICE_KEY") {
    return {
      type: "DEVICE_KEY",
      keyId: row.credentialRef,
      publicKeyX: row.publicKeyX,
      publicKeyY: row.publicKeyY,
      validatorAddress: row.validatorAddress,
      purpose: row.validatorPurpose,
      deploymentSalt: row.deploymentSalt,
    };
  }
  return {
    type: "PASSKEY",
    credentialId: row.credentialRef,
    publicKeyX: row.publicKeyX,
    publicKeyY: row.publicKeyY,
    rpId: row.rpId ?? fallbackRpId,
    validatorAddress: row.validatorAddress,
  };
}

/**
 * Which root a wallet currently has. The recorded root credential is authoritative; a wallet created before credentials
 * were tracked has none, and its oldest active passkey (how those wallets were derived) is its root.
 */
export class RootCredentialService {
  constructor(private readonly deps: { repositories: RootRepositories; rpId: string }) {}

  async activeRoot(wallet: Wallet): Promise<RootCredential> {
    const row = await this.deps.repositories.walletCredentials.findRoot(wallet.id);
    if (row) return toRootCredential(row, this.deps.rpId);
    const [passkey] = await this.deps.repositories.passkeys.listActiveForUser(wallet.userId);
    if (!passkey) {
      throw new KaadaError(
        "ROOT_CREDENTIAL_REQUIRED",
        "no root credential is known for this wallet",
      );
    }
    return {
      type: "PASSKEY",
      credentialId: passkey.credentialId,
      publicKeyX: passkey.publicKeyX,
      publicKeyY: passkey.publicKeyY,
      rpId: passkey.rpId,
    };
  }
}

/** Whether the wallet has a root credential of either type (a recorded root, or a registered passkey). */
export async function hasRoot(
  repositories: RootRepositories,
  wallet: Pick<Wallet, "id" | "userId">,
): Promise<boolean> {
  if (await repositories.walletCredentials.findRoot(wallet.id)) return true;
  return (await repositories.passkeys.listActiveForUser(wallet.userId)).length > 0;
}

/**
 * The only place that chooses an adapter by root type. Callers hold a RootCredential and never branch on it themselves.
 */
export class RootAdapters {
  constructor(
    readonly passkey: PasskeyRootAdapter,
    readonly device: DeviceKeyRootAdapter,
  ) {}

  prepareOperationChallenge(
    root: RootCredential,
    context: RootContext,
    userOpHash: string,
  ): RootChallenge {
    return root.type === "PASSKEY"
      ? this.passkey.prepareOperationChallenge(root, context, userOpHash)
      : this.device.prepareOperationChallenge(root, context, userOpHash);
  }

  verifyOperationProof(
    root: RootCredential,
    context: RootContext,
    userOpHash: string,
    proof: RootProof,
  ): Promise<void> {
    return root.type === "PASSKEY"
      ? this.passkey.verifyOperationProof(root, context, userOpHash, proof)
      : this.device.verifyOperationProof(root, context, userOpHash, proof);
  }
}
