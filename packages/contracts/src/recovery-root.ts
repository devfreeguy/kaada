// The new root a recovery commits to, and the exact batch that installs it. Shared by the client (which must be able to
// recompute what it signs), the backend (which builds and verifies it) and the chain adapter (which submits it).
import {
  bytesToHex,
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import type { Address, Hex } from "viem";

import { deviceKeyInstallData } from "./device-key.js";
import { PASSKEY_PURPOSE, passkeyInstallData, predictPasskeyInstance } from "./passkey-factory.js";
import type { PasskeyCredential, PasskeyPurpose } from "./passkey-factory.js";
import { recoveryCommitment } from "./recovery.js";
import type { RecoveryRoot } from "./recovery.js";

/** A new root credential, as public data (never a private key). */
export type NewRootCredential =
  | {
      kind: "PASSKEY";
      /** The WebAuthn credential id, base64url. */
      credentialId: string;
      /** P-256 public coordinates, 64 lower-case hex characters each (no 0x). */
      publicKeyX: string;
      publicKeyY: string;
    }
  | {
      kind: "DEVICE_KEY";
      /** The validator keyId (0x + 64 hex). */
      keyId: Hex;
      publicKeyX: string;
      publicKeyY: string;
    };

/** Where each validator kind is cloned from: the factory deployment and its implementation. */
export interface ValidatorDeployments {
  passkey: { factory: Address; implementation: Address };
  device: { factory: Address; implementation: Address };
}

/** base64url to bytes without Buffer, so the same code runs in a browser. */
export function base64urlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const hex256 = (value: string): bigint => BigInt(`0x${value}`);

/** The credential in the shape the factory and the validators use (x, y, id hash / keyId). */
export function toFactoryCredential(credential: NewRootCredential): PasskeyCredential {
  if (credential.kind === "PASSKEY") {
    return {
      x: hex256(credential.publicKeyX),
      y: hex256(credential.publicKeyY),
      // keccak256 of the credential id bytes, exactly as the passkey validator expects it.
      authenticatorIdHash: keccak256(bytesToHex(base64urlToBytes(credential.credentialId))),
    };
  }
  return {
    x: hex256(credential.publicKeyX),
    y: hex256(credential.publicKeyY),
    authenticatorIdHash: credential.keyId,
  };
}

/** The validator `onInstall` data for the credential (public: a key and an id). */
export function newRootInstallData(credential: NewRootCredential): Hex {
  const factoryCredential = toFactoryCredential(credential);
  return credential.kind === "PASSKEY"
    ? passkeyInstallData(factoryCredential)
    : deviceKeyInstallData(
        { x: factoryCredential.x, y: factoryCredential.y },
        factoryCredential.authenticatorIdHash,
      );
}

/** The per-attempt deployment salt: a fresh instance for every recovery attempt, never reused. */
export const recoveryDeploymentSalt = (attemptId: string): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }],
      ["kaada.recovery-attempt", attemptId],
    ),
  );

export interface BuiltRecoveryRoot {
  /** The fresh validator instance (CREATE2 address) the account will switch to. */
  instance: Address;
  root: RecoveryRoot;
  purpose: PasskeyPurpose;
  deploymentSalt: Hex;
}

/**
 * The exact root a recovery of `account` to `credential` commits to: the predicted clone as the validator, its install
 * data, no hook and no hook data. The factory address and implementation are part of the address, so the client can
 * recompute it from public configuration and refuse to sign anything else.
 */
export function buildRecoveryRoot(input: {
  deployments: ValidatorDeployments;
  account: Address;
  credential: NewRootCredential;
  deploymentSalt: Hex;
  purpose?: PasskeyPurpose;
}): BuiltRecoveryRoot {
  const purpose = input.purpose ?? PASSKEY_PURPOSE.RECOVERY;
  const target =
    input.credential.kind === "PASSKEY" ? input.deployments.passkey : input.deployments.device;
  const instance = predictPasskeyInstance(target.factory, target.implementation, {
    scope: input.account,
    purpose,
    credential: toFactoryCredential(input.credential),
    deploymentSalt: input.deploymentSalt,
  });
  return {
    instance,
    purpose,
    deploymentSalt: input.deploymentSalt,
    root: {
      validator: instance,
      hook: zeroAddress,
      validatorData: newRootInstallData(input.credential),
      hookData: "0x",
    },
  };
}

/** keccak256(abi.encode(account, rootId, hook, validatorDataHash, hookDataHash)): exactly what the contract stores. */
export function recoveryCommitmentHash(account: Address, root: RecoveryRoot): Hex {
  const c = recoveryCommitment(root);
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "bytes21" },
        { type: "address" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [account, c.rootId, c.hook, c.validatorDataHash, c.hookDataHash],
    ),
  );
}

const kernelAbi = parseAbi([
  "function execute(bytes32 execMode, bytes executionCalldata) payable",
  "function changeRootValidator(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData) payable",
  "function invalidateNonce(uint32 nonce) payable",
]);

/** ERC-7579 batch mode, no exec type or selector. */
export const KERNEL_MODE_BATCH: Hex = `0x01${"00".repeat(31)}`;

/**
 * The two calls that change an account's root, in order: switch the root validator to the new instance, then invalidate every
 * validator installed before (so no old lane, permission or session key survives the change). The recovery batch and a root's
 * own voluntary rotation are exactly these two calls.
 */
export function rootChangeCalls(input: {
  account: Address;
  root: RecoveryRoot;
  currentNonce: number;
}): { target: Address; value: bigint; callData: Hex }[] {
  const c = recoveryCommitment(input.root);
  return [
    {
      target: input.account,
      value: 0n,
      callData: encodeFunctionData({
        abi: kernelAbi,
        functionName: "changeRootValidator",
        args: [c.rootId, input.root.hook, input.root.validatorData, input.root.hookData],
      }),
    },
    {
      target: input.account,
      value: 0n,
      callData: encodeFunctionData({
        abi: kernelAbi,
        functionName: "invalidateNonce",
        args: [input.currentNonce + 1],
      }),
    },
  ];
}

/**
 * The ONE call data the recovery validator accepts, and nothing else:
 *   execute(MODE_BATCH, abi.encode([
 *     (account, 0, changeRootValidator(rootId, hook, validatorData, hookData)),
 *     (account, 0, invalidateNonce(currentNonce + 1)),
 *   ]))
 */
export function recoveryBatchCallData(input: {
  account: Address;
  root: RecoveryRoot;
  currentNonce: number;
}): Hex {
  const calls = rootChangeCalls(input);
  return encodeFunctionData({
    abi: kernelAbi,
    functionName: "execute",
    args: [
      KERNEL_MODE_BATCH,
      encodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [
              { name: "target", type: "address" },
              { name: "value", type: "uint256" },
              { name: "callData", type: "bytes" },
            ],
          },
        ],
        [calls],
      ),
    ],
  });
}

const laneAbi = parseAbi([
  "function installValidations(bytes21[] vIds, (uint32 nonce, address hook)[] configs, bytes[] validationData, bytes[] hookData) payable",
  "function grantAccess(bytes21 vId, bytes4 selector, bool allow) payable",
]);
const EXECUTE_SELECTOR = toFunctionSelector("execute(bytes32,bytes)");

/**
 * The two calls the account's root signs to install a validator instance as an ADDITIONAL validator lane (a backup
 * credential): install it under the account's current nonce, then allow it to use `execute`. `currentNonce` must equal the
 * account's current validator nonce. Anything installed is voided by the next `invalidateNonce`.
 */
export function validatorLaneInstallCalls(input: {
  account: Address;
  validator: Address;
  validatorData: Hex;
  currentNonce: number;
}): { to: Address; value: bigint; data: Hex }[] {
  const laneId = concat(["0x01", input.validator]);
  return [
    {
      to: input.account,
      value: 0n,
      data: encodeFunctionData({
        abi: laneAbi,
        functionName: "installValidations",
        args: [
          [laneId],
          [{ nonce: input.currentNonce, hook: zeroAddress }],
          [input.validatorData],
          ["0x"],
        ],
      }),
    },
    {
      to: input.account,
      value: 0n,
      data: encodeFunctionData({
        abi: laneAbi,
        functionName: "grantAccess",
        args: [laneId, EXECUTE_SELECTOR, true],
      }),
    },
  ];
}
