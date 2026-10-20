import type { JsonObject } from "../json.js";
import type { IdentityType } from "../identity/index.js";
import type { WalletCredentialKind } from "./credential.js";
import type { RootCredential } from "../wallets/root.js";

/*
 * Kaada-owned recovery contracts. The chain stack (viem, Kernel, the validators, the bundler) lives behind
 * RecoveryChainPort in @kaada/blockchain. Domain and application code never import it.
 */

// ─────────────────────────────── the new root ───────────────────────────────

/** A new root credential, as PUBLIC data. Never a private key. */
export type RootCredentialData =
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
      keyId: string;
      publicKeyX: string;
      publicKeyY: string;
    };

/**
 * The exact new root a recovery commits to. `validator` is a fresh clone (never used before), the data is its install
 * data, and the hook and hook data are empty. The commitment hash is what the recovery validator stores.
 */
export interface ProposedRoot {
  kind: WalletCredentialKind;
  /** The fresh validator instance (lower-case address). */
  validator: string;
  /** 0x01 || validator: the Kernel validation id. */
  rootId: string;
  validatorData: string;
  validatorDataHash: string;
  hook: string;
  hookData: string;
  hookDataHash: string;
  /** keccak256(abi.encode(account, rootId, hook, validatorDataHash, hookDataHash)). */
  commitmentHash: string;
  /** The factory deployment salt (0x + 64 hex) and purpose the instance was derived with. */
  deploymentSalt: string;
  purpose: number;
}

/** A complete EIP-712 signing request: what the Recovery Code key signs. */
export interface RecoveryTypedData {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, { name: string; type: string }[]>;
  primaryType: "Initiate";
  message: Record<string, string>;
}

/** The typed message the Recovery Code key signs (EIP-712 `Initiate`). Decimal strings, no floats. */
export interface RecoveryTypedMessage {
  chainId: number;
  /** The recovery validator contract: the EIP-712 verifying contract. */
  verifyingContract: string;
  account: string;
  nonce: string;
  rootId: string;
  hook: string;
  validatorDataHash: string;
  hookDataHash: string;
  /** Unix seconds after which the signature is void. */
  deadline: string;
}

// ───────────────────────────────── the chain ─────────────────────────────────

export interface ChainCall {
  to: string;
  data: string;
  value?: string;
}

export interface RecoveryAccountState {
  deployed: boolean;
  /** The validator address when the account root is a validator-type root; null otherwise (or undeployed). */
  rootValidator: string | null;
  /** Kernel `currentNonce()` (the nonce below which non-root validators are void). */
  currentNonce: number;
}

export interface RecoveryValidatorState {
  initialized: boolean;
  recoveryKey?: string;
  delaySeconds?: number;
  /** The validator monotonic recovery nonce for the account (decimal string). */
  recoveryNonce: string;
  pending?: { commitment: string; executeAfter: number };
}

export type InstanceStatus = "NOT_DEPLOYED" | "DEPLOYED_UNUSED" | "INITIALIZED_FOR_ACCOUNT";

export interface PreparedOperation {
  /** The ERC-4337 userOpHash the signer must sign over (the challenge). */
  userOpHash: string;
  /** The unsigned operation, JSON-safe, with no secret in it. */
  operation: JsonObject;
  /** Native CELO (wei, decimal string) the sponsor sent to the account to pay for this operation; absent when nothing was sent. */
  sponsoredWei?: string;
}

export interface UserOperationStatus {
  state: "UNKNOWN" | "PENDING" | "INCLUDED";
  success?: boolean;
  txHash?: string;
}

/**
 * Everything the recovery orchestration needs from the chain. Writes are limited to: deploying a validator clone,
 * `initiate` on the recovery validator, and UserOperations built from a fixed set of shapes (the exact recovery batch, or
 * calls the ROOT signs: cancel, arm). There is no method that takes arbitrary calldata from a caller.
 */
export interface RecoveryChainPort {
  readonly chainId: number;
  /** The KaadaRecoveryValidator (lower-case address). */
  readonly recoveryValidator: string;

  accountState(account: string): Promise<RecoveryAccountState>;
  validatorState(account: string): Promise<RecoveryValidatorState>;
  /** Whether a validation lane (0x01||validator or 0x02||permissionId) is void: installed with a nonce below currentNonce. */
  laneVoided(account: string, laneId: string): Promise<boolean>;

  /** PURE: the exact root a recovery of `account` to `credential` commits to, for this attempt. */
  proposeRoot(input: {
    account: string;
    credential: RootCredentialData;
    attemptId: string;
  }): ProposedRoot;
  instanceStatus(input: { account: string; root: ProposedRoot }): Promise<InstanceStatus>;
  /** Deploys the fresh clone if absent (anyone may; it is blank). Idempotent. */
  deployInstance(input: {
    account: string;
    root: ProposedRoot;
  }): Promise<{ created: boolean; txHash?: string }>;

  /** `initiate` on the recovery validator with the Recovery Code signature. Resolves once included and successful. */
  initiate(input: {
    account: string;
    root: ProposedRoot;
    deadline: string;
    recoverySignature: string;
  }): Promise<{ txHash: string }>;

  /** The typed `Initiate` message for a root, for the validator at `recoveryValidator`. */
  typedMessage(input: {
    account: string;
    root: ProposedRoot;
    nonce: string;
    deadline: string;
  }): RecoveryTypedMessage;
  /** The complete EIP-712 request a client signs (domain, types, primary type, message). */
  typedData(message: RecoveryTypedMessage): RecoveryTypedData;
  /** The address that signed `message` (EIP-712) with `signature`, or null if the signature is malformed or high-s. */
  recoverInitiateSigner(message: RecoveryTypedMessage, signature: string): Promise<string | null>;
  /**
   * Turns what a root signer produced into the validator signature: a WebAuthn assertion (PASSKEY) or the 96-byte device
   * signature (DEVICE_KEY). Throws CREDENTIAL_REJECTED on a malformed one.
   */
  encodeRootSignature(input: { kind: WalletCredentialKind; material: unknown }): string;
  /** The Kernel validation id (0x02 || permission id, right-padded to 21 bytes) of an installed permission. */
  permissionLaneId(providerPermissionId: string): string;
  /** The Kernel validation id of a validator-type lane: 0x01 || address. */
  validatorLaneId(validator: string): string;

  /** Calls for the CURRENT ROOT to sign: the account cancels its own pending recovery. */
  cancelCalls(): ChainCall[];
  /** Calls for the CURRENT ROOT to sign: (re)arm recovery with a new Recovery Code verifier. */
  armCalls(input: {
    account: string;
    recoveryAddress: string;
    delaySeconds: number;
    currentNonce: number;
    /** The validator already holds a configuration for this account: update it instead of installing. */
    alreadyConfigured: boolean;
  }): ChainCall[];

  /** Builds an unsigned UserOperation of `calls`, to be signed by the account root validator. */
  prepareRootOperation(input: {
    account: string;
    rootValidator: string;
    rootKind: WalletCredentialKind;
    calls: ChainCall[];
    /** The most native CELO (wei, decimal string) the sponsor may send to the account to pay for it. Absent or "0": none. */
    sponsorUpToWei?: string;
  }): Promise<PreparedOperation>;
  /** The relayer's native balance (wei, decimal string). Absent: not readable here. */
  relayerBalanceWei?(): Promise<string>;
  /**
   * Opens (deploys) the account of `root` on chain, paid by the sponsor, when it does not exist yet. Anyone could do this: it creates
   * exactly the account the root already commits to and gives the sponsor no authority over it. Idempotent.
   */
  openAccount?(input: {
    account: string;
    root: RootCredential;
  }): Promise<{ opened: boolean; costWei: string }>;
  /** Builds the unsigned UserOperation of the EXACT recovery batch for the recovery validator lane. */
  prepareRecoveryBatch(input: {
    account: string;
    root: ProposedRoot;
    nonceBefore: number;
  }): Promise<PreparedOperation>;
  /** Submits a prepared operation. For a root operation `signature` is the root signature; the recovery batch needs none. */
  submitOperation(input: {
    operation: JsonObject;
    signature?: string;
  }): Promise<{ userOpHash: string }>;
  operationStatus(userOpHash: string): Promise<UserOperationStatus>;

  /** Asks the validator, through an eth_call as the account, whether `signature` is valid over `hash`. */
  checkSignature(input: {
    account: string;
    validator: string;
    kind: WalletCredentialKind;
    hash: string;
    signature: string;
  }): Promise<boolean>;
}

// ──────────────────────────────── communication ───────────────────────────────

export interface RecoveryEmailSender {
  /** Delivers one email. The implementation must never log the body (it may carry a one-time code). */
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export interface ChannelMessage {
  /** A short subject (used by email). */
  subject: string;
  text: string;
}

/** Delivers one message to one linked channel identity (email, Telegram, WhatsApp ...). */
export interface ChannelMessenger {
  supports(type: IdentityType): boolean;
  send(
    identity: { type: IdentityType; externalId: string },
    message: ChannelMessage,
  ): Promise<void>;
}

/** What the platform gates a recovery on, kept out of the service so it can be tuned and tested alone. */
export interface RecoveryRiskInput {
  userId: string;
  walletId: string;
  now: Date;
  attemptsInLast24h: number;
  lastCompletedAt: Date | null;
}
export type RecoveryRiskDecision = { allow: true } | { allow: false; reason: string };
export interface RecoveryRiskPolicy {
  evaluate(input: RecoveryRiskInput): RecoveryRiskDecision;
}
