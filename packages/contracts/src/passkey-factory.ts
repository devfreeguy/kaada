// Off-chain half of KaadaPasskeyValidatorFactory: the exact derivation of a passkey validator instance address,
// shared by clients (to know the new root in advance) and the backend (to commit to it in a recovery).
import { encodeAbiParameters, getContractAddress, keccak256, pad, toHex } from "viem";
import type { Address, Hex } from "viem";

/** The role an instance plays; part of the salt, so one credential can intentionally get distinct instances. */
export const PASSKEY_PURPOSE = { PRIMARY: 0, RECOVERY: 1, BACKUP: 2, ROTATION: 3 } as const;
export type PasskeyPurpose = (typeof PASSKEY_PURPOSE)[keyof typeof PASSKEY_PURPOSE];

/** Bump (together with the contract constant) when the derivation or clone code changes. */
export const PASSKEY_FACTORY_VERSION = 1;
export const PASSKEY_SALT_DOMAIN = keccak256(toHex("kaada.passkey-validator-instance"));
export const PASSKEY_CREDENTIAL_DOMAIN = keccak256(toHex("kaada.passkey-credential"));

const installTypes = [
  {
    type: "tuple",
    components: [
      { name: "x", type: "uint256" },
      { name: "y", type: "uint256" },
    ],
  },
  { type: "bytes32" },
] as const;

export interface PasskeyCredential {
  /** P-256 public key coordinates. */
  x: bigint;
  y: bigint;
  /** keccak256 of the credential id bytes, as the validator expects. */
  authenticatorIdHash: Hex;
}

/** The passkey validator's `onInstall` data: abi.encode((x, y), authenticatorIdHash). 96 bytes. */
export function passkeyInstallData(credential: PasskeyCredential): Hex {
  return encodeAbiParameters(installTypes, [
    { x: credential.x, y: credential.y },
    credential.authenticatorIdHash,
  ]);
}

/** Commitment to a credential: keccak256(abi.encode(CREDENTIAL_DOMAIN, x, y, authenticatorIdHash)). */
export function passkeyCredentialCommitment(credential: PasskeyCredential): Hex {
  if (credential.x === 0n || credential.y === 0n) throw new Error("zero public key coordinate");
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }],
      [PASSKEY_CREDENTIAL_DOMAIN, credential.x, credential.y, credential.authenticatorIdHash],
    ),
  );
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export interface PasskeyInstanceInput {
  /**
   * The Kernel account the instance is for. address(0) is allowed ONLY for PRIMARY: the creation-time root, whose
   * account address cannot exist before the root validator it names (the address derives from it).
   */
  scope: Address;
  purpose: PasskeyPurpose;
  credential: PasskeyCredential;
  /** Extra caller-chosen salt: a fresh instance for the same credential and role. Default zero. */
  deploymentSalt?: Hex;
}

/** salt = keccak256(abi.encode(SALT_DOMAIN, FACTORY_VERSION, scope, purpose, credentialCommitment, deploymentSalt)). */
export function passkeyInstanceSalt(input: PasskeyInstanceInput): Hex {
  if (/^0x0{40}$/i.test(input.scope) && input.purpose !== PASSKEY_PURPOSE.PRIMARY)
    throw new Error("zero scope is only valid for the PRIMARY (creation-time) root");
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "uint16" },
        { type: "address" },
        { type: "uint8" },
        { type: "bytes32" },
        { type: "bytes32" },
      ],
      [
        PASSKEY_SALT_DOMAIN,
        PASSKEY_FACTORY_VERSION,
        input.scope,
        input.purpose,
        passkeyCredentialCommitment(input.credential),
        input.deploymentSalt ?? pad("0x", { size: 32 }),
      ],
    ),
  );
}

/** EIP-1167 minimal-proxy creation code for `implementation`. */
export const eip1167InitCode = (implementation: Address): Hex =>
  `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${implementation.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;

/** The address KaadaPasskeyValidatorFactory deploys this instance to (CREATE2). */
export function predictPasskeyInstance(
  factory: Address,
  implementation: Address,
  input: PasskeyInstanceInput,
): Address {
  return getContractAddress({
    opcode: "CREATE2",
    from: factory,
    salt: passkeyInstanceSalt(input),
    bytecode: eip1167InitCode(implementation),
  });
}
