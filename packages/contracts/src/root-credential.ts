// The creation-time (PRIMARY) root of a wallet and the off-chain proof a root signer gives, shared by the client (which
// must be able to recompute what it signs), the backend (which derives and verifies) and the chain adapters.
import { concat, encodeAbiParameters, getAddress, keccak256, pad, stringToHex, toHex } from "viem";
import type { Address, Hex } from "viem";

import { PASSKEY_PURPOSE, ZERO_ADDRESS, predictPasskeyInstance } from "./passkey-factory.js";
import { newRootInstallData, toFactoryCredential } from "./recovery-root.js";
import type { NewRootCredential, ValidatorDeployments } from "./recovery-root.js";

/**
 * The deployment salt of a wallet's PRIMARY root instance: one per wallet owner, so the same public key enrolled for another
 * wallet gets another instance (an instance is never shared between wallets) and a retry of the same onboarding lands on
 * the same address.
 */
export const primaryRootDeploymentSalt = (walletOwnerId: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      ["kaada.primary-root", walletOwnerId],
    ),
  );

export interface BuiltPrimaryRoot {
  /** The validator instance (CREATE2 clone) that will be the account's root. */
  instance: Address;
  factory: Address;
  implementation: Address;
  purpose: typeof PASSKEY_PURPOSE.PRIMARY;
  deploymentSalt: Hex;
  /** The validator's `onInstall` data: public coordinates and the credential id hash or keyId. */
  validatorData: Hex;
}

/** The creation-time root for `credential`: a clone scoped to address(0) (the account does not exist yet). */
export function buildPrimaryRoot(input: {
  deployments: ValidatorDeployments;
  credential: NewRootCredential;
  deploymentSalt: Hex;
}): BuiltPrimaryRoot {
  const target =
    input.credential.kind === "PASSKEY" ? input.deployments.passkey : input.deployments.device;
  return {
    instance: predictPasskeyInstance(target.factory, target.implementation, {
      scope: ZERO_ADDRESS,
      purpose: PASSKEY_PURPOSE.PRIMARY,
      credential: toFactoryCredential(input.credential),
      deploymentSalt: input.deploymentSalt,
    }),
    factory: target.factory,
    implementation: target.implementation,
    purpose: PASSKEY_PURPOSE.PRIMARY,
    deploymentSalt: input.deploymentSalt,
    validatorData: newRootInstallData(input.credential),
  };
}

/** ASCII domain tag of an OFF-CHAIN proof by a device key. Different from the on-chain tag, so one can never pass for the other. */
export const DEVICE_PROOF_DOMAIN_TAG = "KaadaRootProof/v1";

/** Why a device key is signing off-chain. Part of the signed bytes. */
export const DEVICE_PROOF_PURPOSES = ["PIN_ENROLLMENT", "ROOT_ENROLLMENT"] as const;
export type DeviceProofPurpose = (typeof DEVICE_PROOF_PURPOSES)[number];

/**
 * The exact bytes a device key signs (ECDSA P-256 / SHA-256) to prove it holds the key for something that is NOT a
 * UserOperation, for example setting the PIN:
 *   "KaadaRootProof/v1" (17) || chainId (32) || validator (20) || account (20) || keyId (32) || purposeHash (32) || challenge (32)
 * The tag differs from `KaadaDeviceKey/v1`, so a proof can never be replayed as a UserOperation signature (and the other
 * way round), and `purposeHash` stops a proof for one purpose from being used for another.
 */
export function deviceProofPayload(input: {
  chainId: bigint | number;
  validator: Address;
  account: Address;
  keyId: Hex;
  purpose: DeviceProofPurpose;
  challenge: Hex;
}): Hex {
  return concat([
    stringToHex(DEVICE_PROOF_DOMAIN_TAG),
    pad(toHex(BigInt(input.chainId)), { size: 32 }),
    getAddress(input.validator),
    getAddress(input.account),
    pad(input.keyId, { size: 32 }),
    keccak256(stringToHex(`kaada.root-proof.${input.purpose}`)),
    pad(input.challenge, { size: 32 }),
  ]);
}
