// Off-chain half of the recovery protocol: the EIP-712 shape both signers sign, and the commitment, exactly
// as KaadaRecoveryValidator computes them. Clients (to sign) and the backend (to verify) share these.
import { encodeAbiParameters, keccak256 } from "viem";
import type { Address, Hex } from "viem";

/** The smallest recovery delay a wallet may configure (the contract enforces it). */
export const RECOVERY_MIN_DELAY_SECONDS = 24 * 60 * 60;
/** The default delay Kaada configures. */
export const RECOVERY_DEFAULT_DELAY_SECONDS = 72 * 60 * 60;

export const RECOVERY_TYPED_DATA_NAME = "KaadaRecovery";
export const RECOVERY_TYPED_DATA_VERSION = "1";

export const recoveryInitiateTypes = {
  Initiate: [
    { name: "account", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "rootId", type: "bytes21" },
    { name: "hook", type: "address" },
    { name: "validatorDataHash", type: "bytes32" },
    { name: "hookDataHash", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export function recoveryDomain(chainId: number, validator: Address) {
  return {
    name: RECOVERY_TYPED_DATA_NAME,
    version: RECOVERY_TYPED_DATA_VERSION,
    chainId,
    verifyingContract: validator,
  } as const;
}

/** The new root a recovery commits to: a validator-type id (0x01 || validator address) plus its install data. */
export interface RecoveryRoot {
  validator: Address;
  hook: Address;
  validatorData: Hex;
  hookData: Hex;
}

export const recoveryRootId = (validator: Address): Hex =>
  `0x01${validator.slice(2).toLowerCase()}`;

export function recoveryCommitment(root: RecoveryRoot) {
  return {
    rootId: recoveryRootId(root.validator),
    hook: root.hook,
    validatorDataHash: keccak256(root.validatorData),
    hookDataHash: keccak256(root.hookData),
  } as const;
}

export interface RecoveryInitiateMessage {
  account: Address;
  /** The validator's recoveryNonce(account) at signing time. */
  nonce: bigint;
  root: RecoveryRoot;
  /** Unix seconds after which the signatures are void. */
  deadline: bigint;
}

/** The typed-data message both the recovery key and the attestor sign. */
export function recoveryInitiateMessage(input: RecoveryInitiateMessage) {
  const c = recoveryCommitment(input.root);
  return {
    account: input.account,
    nonce: input.nonce,
    rootId: c.rootId,
    hook: c.hook,
    validatorDataHash: c.validatorDataHash,
    hookDataHash: c.hookDataHash,
    deadline: input.deadline,
  } as const;
}

/** abi.encode(address recoveryKey, uint32 delay): the validator's `onInstall` data. */
export function recoveryInstallData(recoveryKey: Address, delaySeconds: number): Hex {
  return encodeAbiParameters(
    [{ type: "address" }, { type: "uint32" }],
    [recoveryKey, delaySeconds],
  );
}
