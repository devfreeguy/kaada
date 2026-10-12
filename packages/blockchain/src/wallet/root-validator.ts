import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { PasskeyValidatorContractVersion, toPasskeyValidator } from "@zerodev/passkey-validator";
import { deviceKeyInstallData, deviceKeySignature } from "@kaada/contracts";
import { keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";

import type { DeviceKeyRoot, PasskeyRoot, RootCredential } from "@kaada/domain";

/*
 * Turns a root credential (public data) into the Kernel "sudo" validator plugin of its type. This is the ONLY place the
 * two root types differ for the Kernel SDK; everything above it sees a RootCredential.
 *
 *  - PASSKEY: the ZeroDev passkey validator (the stack's shared instance, or a clone when the root has a validatorAddress).
 *  - DEVICE_KEY: KaadaDeviceKeyValidator (always a clone). Its signature is `keyId || r || s` over the documented
 *    `KaadaDeviceKey/v1` payload; the SDK never signs: the signature is supplied from outside (the device).
 */

const ENTRY_POINT = getEntryPoint("0.7");

export interface SudoValidatorOptions {
  /** The stack's shared passkey validator on this chain (testnet fixtures only); default: the SDK's pinned one. */
  passkeyValidatorAddress?: Address;
  /** Whether RIP-7212 exists here: it decides how a passkey assertion and its stub are encoded. */
  p256Precompile?: boolean;
}

const word = (hex: string): bigint => BigInt(`0x${hex}`);

export function passkeyWebAuthnKey(root: PasskeyRoot) {
  return {
    pubX: word(root.publicKeyX),
    pubY: word(root.publicKeyY),
    authenticatorId: root.credentialId,
    // keccak256 of the credential id bytes, as the validator expects.
    authenticatorIdHash: keccak256(toHex(Buffer.from(root.credentialId, "base64url"))),
    rpID: root.rpId,
  };
}

/** A placeholder signature of the right SHAPE for gas estimation: the keyId is real, r and s are dummies (low-s). */
export function deviceKeyStubSignature(keyId: Hex): Hex {
  return deviceKeySignature(keyId, word("11".repeat(32)), word("22".repeat(32)));
}

/** The device-key sudo plugin. It cannot sign: the Kernel account is given the signature from outside. */
export function toDeviceKeyValidator(root: DeviceKeyRoot) {
  const validatorAddress = root.validatorAddress as Address;
  const keyId = root.keyId as Hex;
  // Deliberately NO signing members of any kind (message, typed data, transaction or operation): the Kernel account is given the
  // device's signature from outside, in the one file that sends operations. A missing member can only fail; it cannot sign.
  return {
    address: validatorAddress,
    type: "local" as const,
    source: "KaadaDeviceKeyValidator",
    supportedKernelVersions: KERNEL_V3_3,
    validatorType: "SECONDARY" as const,
    getIdentifier: () => validatorAddress,
    getEnableData: () =>
      Promise.resolve(
        deviceKeyInstallData({ x: word(root.publicKeyX), y: word(root.publicKeyY) }, keyId),
      ),
    getNonceKey: (_account?: Address, customNonceKey?: bigint) =>
      Promise.resolve(customNonceKey ?? 0n),
    getStubSignature: () => Promise.resolve(deviceKeyStubSignature(keyId)),
    isEnabled: () => Promise.resolve(false),
  };
}

/** The sudo validator plugin for any root. Reads nothing but the chain id; holds no secret. */
export async function toRootValidator(
  client: Parameters<typeof toPasskeyValidator>[0],
  root: RootCredential,
  options: SudoValidatorOptions = {},
): Promise<Record<string, unknown>> {
  if (root.type === "DEVICE_KEY") return toDeviceKeyValidator(root);
  const validatorAddress = (root.validatorAddress ?? options.passkeyValidatorAddress) as
    Address | undefined;
  return toPasskeyValidator(client, {
    webAuthnKey: passkeyWebAuthnKey(root),
    entryPoint: ENTRY_POINT,
    kernelVersion: KERNEL_V3_3,
    validatorContractVersion: PasskeyValidatorContractVersion.V0_0_3_PATCHED,
    ...(validatorAddress && { validatorAddress }),
  });
}
