import { createHash } from "node:crypto";

import {
  buildRecoveryRoot,
  recoveryDeploymentSalt,
  recoveryCommitmentHash,
  recoveryDomain,
  recoveryInitiateMessage,
  recoveryInitiateTypes,
} from "@kaada/contracts";
import type { NewRootCredential, ValidatorDeployments } from "@kaada/contracts";
import { KaadaError } from "@kaada/domain";
import type {
  ChainCall,
  InstanceStatus,
  JsonObject,
  PreparedOperation,
  ProposedRoot,
  RecoveryAccountState,
  RecoveryChainPort,
  RecoveryTypedData,
  RecoveryTypedMessage,
  RecoveryValidatorState,
  RootCredentialData,
  UserOperationStatus,
  WalletCredentialKind,
} from "@kaada/domain";
import { keccak256, recoverTypedDataAddress } from "viem";
import type { Address, Hex } from "viem";

/*
 * A semantic stand-in for the chain, KaadaRecoveryValidator and Kernel, for offline service tests. It enforces the rules the
 * contracts enforce (both signatures over the exact typed message, the timelock, the exact committed batch, one-shot
 * consumption, a burnt Recovery Code key, nonce invalidation voiding old lanes) using the REAL shared helpers for the root,
 * the commitment hash and the EIP-712 message, so the formats are the production ones. Signature VERIFICATION of the root
 * (WebAuthn / P-256) is simulated: those are proved by the contract tests and on Celo Sepolia.
 */

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

interface FakeInstance {
  kind: WalletCredentialKind;
  credentialRef: string;
  deployed: boolean;
  initializedFor: Set<string>;
}

interface FakeAccount {
  deployed: boolean;
  root: string | null;
  currentNonce: number;
  /** validation lane id -> the nonce it was installed with. */
  lanes: Map<string, number>;
  config?: { recoveryKey: string; delay: number };
  recoveryNonce: bigint;
  pending?: { commitment: string; executeAfter: number };
  stale?: { commitment: string; executeAfter: number; reads: number };
  hiddenReads?: number;
  usedKeys: Set<string>;
  gasShort: boolean;
}

interface FakeOperation {
  state: "PENDING" | "INCLUDED";
  success: boolean;
  txHash: string;
  /** The state change, applied when the operation is included. */
  apply?: () => void;
}

const fakeHash = (value: unknown): string =>
  `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export class FakeRecoveryChain implements RecoveryChainPort {
  readonly chainId = 11142220;
  readonly recoveryValidator = "0x00000000000000000000000000000000000000c1";
  readonly deployments: ValidatorDeployments = {
    passkey: {
      factory: "0x00000000000000000000000000000000000000f1",
      implementation: "0x00000000000000000000000000000000000000a1",
    },
    device: {
      factory: "0x00000000000000000000000000000000000000f2",
      implementation: "0x00000000000000000000000000000000000000a2",
    },
  };

  readonly accounts = new Map<string, FakeAccount>();
  readonly instances = new Map<string, FakeInstance>();
  readonly operations = new Map<string, FakeOperation>();
  readonly log: string[] = [];
  /** The validator's immutable RELAYER: the only address whose `initiate` it accepts. */
  readonly relayerAddress = "0x00000000000000000000000000000000000fee01";
  /** Failure injection for the next call of each kind. */
  inject: {
    /** The relayer cannot submit (out of gas, node down): nothing is sent, and it stays that way until cleared. */
    relayerDown?: boolean;
    initiate?: Error;
    submit?: Error;
    deploy?: Error;
    /** Leave submitted operations PENDING until `includePending()`. */
    holdInclusion?: boolean;
    /** The batch passes validation (and consumes the recovery) but its execution reverts. */
    revertExecution?: boolean;
    /** After a cancel, the next N reads still show the recovery (a node answering from an older block). */
    staleReads?: number;
    /** After `initiate`, the next N reads do not show the new recovery yet (a node behind by a block). */
    hiddenReads?: number;
  } = {};
  submittedBatches = 0;
  private counter = 0;

  constructor(private readonly clock: () => Date) {}

  // ───────────────────────────────── test setup ─────────────────────────────────

  seedAccount(input: {
    address: string;
    root: { validator: string; kind: WalletCredentialKind; credentialRef: string };
    currentNonce?: number;
    recovery?: { recoveryKey: string; delay: number };
  }): FakeAccount {
    const address = input.address.toLowerCase();
    const account: FakeAccount = {
      deployed: true,
      root: input.root.validator.toLowerCase(),
      currentNonce: input.currentNonce ?? 1,
      lanes: new Map(),
      recoveryNonce: 0n,
      usedKeys: new Set(),
      gasShort: false,
      ...(input.recovery && {
        config: {
          recoveryKey: input.recovery.recoveryKey.toLowerCase(),
          delay: input.recovery.delay,
        },
      }),
    };
    account.lanes.set(this.validatorLaneId(input.root.validator), account.currentNonce);
    this.accounts.set(address, account);
    this.instances.set(input.root.validator.toLowerCase(), {
      kind: input.root.kind,
      credentialRef: input.root.credentialRef,
      deployed: true,
      initializedFor: new Set([address]),
    });
    return account;
  }

  /** Installs a delegated permission lane (a session key's validator) with the account's current nonce. */
  installPermissionLane(account: string, providerPermissionId: string): string {
    const lane = this.permissionLaneId(providerPermissionId);
    const acct = this.mustAccount(account);
    acct.lanes.set(lane, acct.currentNonce);
    return lane;
  }

  includePending(): void {
    for (const operation of this.operations.values()) {
      if (operation.state !== "PENDING") continue;
      operation.state = "INCLUDED";
      operation.apply?.();
      delete operation.apply;
    }
  }

  /** Signs as the Recovery Code key would (tests only). */
  async signAs(privateKey: Hex, message: RecoveryTypedMessage): Promise<Hex> {
    const { privateKeyToAccount } = await import("viem/accounts");
    return privateKeyToAccount(privateKey).signTypedData(this.viemTyped(message));
  }

  // ───────────────────────────────── reads ─────────────────────────────────

  accountState(account: string): Promise<RecoveryAccountState> {
    const acct = this.accounts.get(account.toLowerCase());
    if (!acct) return Promise.resolve({ deployed: false, rootValidator: null, currentNonce: 0 });
    return Promise.resolve({
      deployed: acct.deployed,
      rootValidator: acct.root,
      currentNonce: acct.currentNonce,
    });
  }

  validatorState(account: string): Promise<RecoveryValidatorState> {
    const acct = this.accounts.get(account.toLowerCase());
    if (!acct) return Promise.resolve({ initialized: false, recoveryNonce: "0" });
    if (acct.stale && !acct.pending) acct.stale.reads -= 1;
    const hidden = (acct.hiddenReads ?? 0) > 0 && acct.pending !== undefined;
    if (hidden) acct.hiddenReads = (acct.hiddenReads ?? 0) - 1;
    return Promise.resolve({
      initialized: acct.config !== undefined,
      ...(acct.config && { recoveryKey: acct.config.recoveryKey, delaySeconds: acct.config.delay }),
      recoveryNonce: acct.recoveryNonce.toString(),
      ...(acct.pending && !hidden && { pending: { ...acct.pending } }),
      ...(!acct.pending &&
        acct.stale &&
        acct.stale.reads > 0 && {
          pending: { commitment: acct.stale.commitment, executeAfter: acct.stale.executeAfter },
        }),
    });
  }

  laneVoided(account: string, laneId: string): Promise<boolean> {
    const acct = this.mustAccount(account);
    const installed = acct.lanes.get(laneId);
    if (installed === undefined) return Promise.resolve(true);
    if (acct.root && laneId === this.validatorLaneId(acct.root)) return Promise.resolve(false);
    return Promise.resolve(installed < acct.currentNonce);
  }

  // ───────────────────────────────── roots ─────────────────────────────────

  proposeRoot(input: {
    account: string;
    credential: RootCredentialData;
    attemptId: string;
  }): ProposedRoot {
    const built = buildRecoveryRoot({
      deployments: this.deployments,
      account: input.account as Address,
      credential: input.credential as NewRootCredential,
      deploymentSalt: this.saltFor(input.attemptId),
    });
    const validator = built.instance.toLowerCase();
    if (!this.instances.has(validator)) {
      this.instances.set(validator, {
        kind: input.credential.kind,
        credentialRef:
          input.credential.kind === "PASSKEY"
            ? input.credential.credentialId
            : input.credential.keyId,
        deployed: false,
        initializedFor: new Set(),
      });
    }
    return {
      kind: input.credential.kind,
      validator,
      rootId: `0x01${validator.slice(2)}`,
      validatorData: built.root.validatorData,
      validatorDataHash: keccak256(built.root.validatorData),
      hook: built.root.hook.toLowerCase(),
      hookData: built.root.hookData,
      hookDataHash: keccak256(built.root.hookData),
      commitmentHash: recoveryCommitmentHash(input.account as Address, built.root),
      deploymentSalt: built.deploymentSalt,
      purpose: built.purpose,
    };
  }

  private saltFor(attemptId: string): Hex {
    return recoveryDeploymentSalt(attemptId);
  }

  instanceStatus(input: { account: string; root: ProposedRoot }): Promise<InstanceStatus> {
    const instance = this.instances.get(input.root.validator);
    if (!instance?.deployed) return Promise.resolve("NOT_DEPLOYED");
    return Promise.resolve(
      instance.initializedFor.has(input.account.toLowerCase())
        ? "INITIALIZED_FOR_ACCOUNT"
        : "DEPLOYED_UNUSED",
    );
  }

  private requireRelayerUp(): void {
    if (this.inject.relayerDown) {
      throw new KaadaError(
        "RECOVERY_RELAYER_UNAVAILABLE",
        "the recovery service cannot submit right now; nothing was sent, try again shortly",
      );
    }
  }

  deployInstance(input: {
    account: string;
    root: ProposedRoot;
  }): Promise<{ created: boolean; txHash?: string }> {
    this.requireRelayerUp();
    if (this.inject.deploy) {
      const error = this.inject.deploy;
      delete this.inject.deploy;
      return Promise.reject(error);
    }
    const instance = this.instances.get(input.root.validator);
    if (!instance) return Promise.reject(new Error("unknown instance (proposeRoot first)"));
    const created = !instance.deployed;
    instance.deployed = true;
    return Promise.resolve({
      created,
      ...(created && { txHash: fakeHash(["deploy", input.root.validator]) }),
    });
  }

  // ──────────────────────────────── typed data ────────────────────────────────

  typedMessage(input: {
    account: string;
    root: ProposedRoot;
    nonce: string;
    deadline: string;
  }): RecoveryTypedMessage {
    const message = recoveryInitiateMessage({
      account: input.account as Address,
      nonce: BigInt(input.nonce),
      deadline: BigInt(input.deadline),
      root: {
        validator: input.root.validator as Address,
        hook: input.root.hook as Address,
        validatorData: input.root.validatorData as Hex,
        hookData: input.root.hookData as Hex,
      },
    });
    return {
      chainId: this.chainId,
      verifyingContract: this.recoveryValidator,
      account: message.account,
      nonce: message.nonce.toString(),
      rootId: message.rootId,
      hook: message.hook,
      validatorDataHash: message.validatorDataHash,
      hookDataHash: message.hookDataHash,
      deadline: message.deadline.toString(),
    };
  }

  typedData(message: RecoveryTypedMessage): RecoveryTypedData {
    return {
      domain: {
        name: "KaadaRecovery",
        version: "1",
        chainId: message.chainId,
        verifyingContract: message.verifyingContract,
      },
      types: {
        Initiate: recoveryInitiateTypes.Initiate.map((field) => ({
          name: field.name,
          type: field.type,
        })),
      },
      primaryType: "Initiate",
      message: {
        account: message.account,
        nonce: message.nonce,
        rootId: message.rootId,
        hook: message.hook,
        validatorDataHash: message.validatorDataHash,
        hookDataHash: message.hookDataHash,
        deadline: message.deadline,
      },
    };
  }

  private viemTyped(message: RecoveryTypedMessage) {
    return {
      domain: recoveryDomain(message.chainId, message.verifyingContract as Address),
      types: recoveryInitiateTypes,
      primaryType: "Initiate" as const,
      message: {
        account: message.account as Address,
        nonce: BigInt(message.nonce),
        rootId: message.rootId as Hex,
        hook: message.hook as Address,
        validatorDataHash: message.validatorDataHash as Hex,
        hookDataHash: message.hookDataHash as Hex,
        deadline: BigInt(message.deadline),
      },
    };
  }

  async recoverInitiateSigner(
    message: RecoveryTypedMessage,
    signature: string,
  ): Promise<string | null> {
    try {
      // Low-s only, like the contract: a malleable twin is refused.
      const s = BigInt(`0x${signature.slice(66, 130)}`);
      if (s > SECP256K1_HALF_N) return null;
      const signer = await recoverTypedDataAddress({
        ...this.viemTyped(message),
        signature: signature as Hex,
      });
      return signer.toLowerCase();
    } catch {
      return null;
    }
  }

  // ─────────────────────────────── root signatures ───────────────────────────────

  encodeRootSignature(input: { kind: WalletCredentialKind; material: unknown }): string {
    const material = input.material as { credentialRef?: unknown; signs?: unknown } | null;
    if (typeof material?.credentialRef !== "string" || typeof material.signs !== "string") {
      throw new KaadaError("CREDENTIAL_REJECTED", "the signature material is malformed");
    }
    return `sig:${input.kind}:${material.credentialRef}:${material.signs.toLowerCase()}`;
  }

  checkSignature(input: {
    account: string;
    validator: string;
    kind: WalletCredentialKind;
    hash: string;
    signature: string;
  }): Promise<boolean> {
    const [tag, kind, credentialRef, hash] = input.signature.split(":");
    const instance = this.instances.get(input.validator.toLowerCase());
    return Promise.resolve(
      tag === "sig" &&
        kind === input.kind &&
        instance !== undefined &&
        instance.kind === input.kind &&
        instance.credentialRef === credentialRef &&
        instance.initializedFor.has(input.account.toLowerCase()) &&
        hash === input.hash.toLowerCase(),
    );
  }

  permissionLaneId(providerPermissionId: string): string {
    return `0x02${providerPermissionId.replace(/^0x/, "").toLowerCase().padEnd(40, "0")}`;
  }

  validatorLaneId(validator: string): string {
    return `0x01${validator.replace(/^0x/, "").toLowerCase()}`;
  }

  // ─────────────────────────────── root-signed calls ───────────────────────────────

  cancelCalls(): ChainCall[] {
    return [{ to: this.recoveryValidator, data: "cancel()" }];
  }

  armCalls(input: {
    account: string;
    recoveryAddress: string;
    delaySeconds: number;
    currentNonce: number;
    alreadyConfigured: boolean;
  }): ChainCall[] {
    return [
      {
        to: this.recoveryValidator,
        data: `arm:${input.recoveryAddress.toLowerCase()}:${input.delaySeconds}:${input.alreadyConfigured}`,
      },
    ];
  }

  prepareRootOperation(input: {
    account: string;
    rootValidator: string;
    rootKind: WalletCredentialKind;
    calls: ChainCall[];
  }): Promise<PreparedOperation> {
    this.counter += 1;
    const userOpHash = fakeHash(["root", input, this.counter]);
    return Promise.resolve({
      userOpHash,
      operation: {
        kind: "ROOT",
        account: input.account.toLowerCase(),
        rootValidator: input.rootValidator.toLowerCase(),
        calls: input.calls.map((call) => ({ to: call.to, data: call.data })),
        hash: userOpHash,
      },
    });
  }

  prepareRecoveryBatch(input: {
    account: string;
    root: ProposedRoot;
    nonceBefore: number;
  }): Promise<PreparedOperation> {
    const acct = this.mustAccount(input.account);
    if (acct.gasShort) {
      return Promise.reject(
        new KaadaError("RECOVERY_BLOCKED", "the wallet needs gas", {
          details: { reason: "GAS_FUNDING_REQUIRED" },
        }),
      );
    }
    const userOpHash = fakeHash([
      "batch",
      input.account,
      input.root.commitmentHash,
      input.nonceBefore,
      ++this.counter,
    ]);
    return Promise.resolve({
      userOpHash,
      operation: {
        kind: "RECOVERY_BATCH",
        account: input.account.toLowerCase(),
        rootId: input.root.rootId,
        hook: input.root.hook,
        validatorData: input.root.validatorData,
        hookData: input.root.hookData,
        nonceBefore: input.nonceBefore,
        hash: userOpHash,
      },
    });
  }

  submitOperation(input: {
    operation: JsonObject;
    signature?: string;
  }): Promise<{ userOpHash: string }> {
    if (this.inject.submit) {
      const error = this.inject.submit;
      delete this.inject.submit;
      return Promise.reject(error);
    }
    const operation = input.operation as Record<string, unknown>;
    const hash = String(operation["hash"]);
    const acct = this.mustAccount(String(operation["account"]));
    const reject = (reason: string) =>
      new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
        details: { rpc: reason },
      });
    const now = Math.floor(this.clock().getTime() / 1000);
    let success = true;
    let apply: () => void = () => undefined;

    if (operation["kind"] === "RECOVERY_BATCH") {
      if (!acct.pending) return Promise.reject(reject("NoPendingRecovery"));
      const expected = recoveryCommitmentHash(String(operation["account"]) as Address, {
        validator: `0x${String(operation["rootId"]).slice(4)}`,
        hook: String(operation["hook"]) as Address,
        validatorData: String(operation["validatorData"]) as Hex,
        hookData: String(operation["hookData"]) as Hex,
      });
      if (expected.toLowerCase() !== acct.pending.commitment.toLowerCase())
        return Promise.reject(reject("NotTheCommittedBatch"));
      if (operation["nonceBefore"] !== acct.currentNonce)
        return Promise.reject(reject("NotTheCommittedBatch"));
      if (now < acct.pending.executeAfter) return Promise.reject(reject("AA22 expired or not due"));
      this.submittedBatches += 1;
      const reverts = this.inject.revertExecution === true;
      success = !reverts;
      apply = () => {
        // Validation consumes the recovery whatever happens next: one shot, and the Recovery Code key is burnt.
        if (acct.config) acct.usedKeys.add(acct.config.recoveryKey);
        delete acct.config;
        acct.recoveryNonce += 1n;
        delete acct.pending;
        if (!reverts) {
          const validator = `0x${String(operation["rootId"]).slice(4)}`;
          acct.root = validator;
          acct.currentNonce = Number(operation["nonceBefore"]) + 1;
          const instance = this.instances.get(validator);
          if (instance) instance.initializedFor.add(String(operation["account"]));
          acct.lanes.set(this.validatorLaneId(validator), acct.currentNonce);
        }
      };
    } else {
      // A root operation: the validator must accept the signature over this operation's hash.
      const signature = input.signature ?? "";
      const [, kind, credentialRef, signedHash] = signature.split(":");
      const instance = acct.root ? this.instances.get(acct.root) : undefined;
      if (
        !instance ||
        instance.kind !== kind ||
        instance.credentialRef !== credentialRef ||
        signedHash !== hash
      ) {
        return Promise.reject(reject("AA24 signature error"));
      }
      apply = () => {
        for (const call of operation["calls"] as { data: string }[]) {
          if (call.data === "cancel()") {
            delete acct.pending;
            acct.recoveryNonce += 1n;
          } else if (call.data.startsWith("arm:")) {
            const [, key, delay] = call.data.split(":");
            acct.config = { recoveryKey: key ?? "", delay: Number(delay) };
          }
        }
      };
    }
    const held = this.inject.holdInclusion === true;
    this.operations.set(hash, {
      state: held ? "PENDING" : "INCLUDED",
      success,
      txHash: fakeHash(["tx", hash]),
      ...(held && { apply }),
    });
    if (!held) apply();
    return Promise.resolve({ userOpHash: hash });
  }

  operationStatus(userOpHash: string): Promise<UserOperationStatus> {
    const found = this.operations.get(userOpHash.toLowerCase()) ?? this.operations.get(userOpHash);
    if (!found) return Promise.resolve({ state: "UNKNOWN" });
    return Promise.resolve({
      state: found.state,
      ...(found.state === "INCLUDED" && { success: found.success, txHash: found.txHash }),
    });
  }

  // ───────────────────────────── initiate ─────────────────────────────

  async initiate(input: {
    account: string;
    root: ProposedRoot;
    deadline: string;
    recoverySignature: string;
    /** Who calls the validator. The adapter always sends from the relayer; tests pass another address to prove the gate. */
    sender?: string;
  }): Promise<{ txHash: string }> {
    this.requireRelayerUp();
    if (this.inject.initiate) {
      const error = this.inject.initiate;
      delete this.inject.initiate;
      throw error;
    }
    const acct = this.mustAccount(input.account);
    const revert = (reason: string) =>
      new KaadaError("RECOVERY_REJECTED", "initiate reverted", { details: { reason } });
    if ((input.sender ?? this.relayerAddress).toLowerCase() !== this.relayerAddress) throw revert("NotRelayer");
    if (!acct.config) throw revert("NotInitialized");
    if (acct.pending) throw revert("RecoveryActive");
    if (Number(input.deadline) < Math.floor(this.clock().getTime() / 1000)) throw revert("Expired");
    const instance = this.instances.get(input.root.validator);
    if (!instance?.deployed) throw revert("InvalidRoot");
    const message = this.typedMessage({
      account: input.account,
      root: input.root,
      nonce: acct.recoveryNonce.toString(),
      deadline: input.deadline,
    });
    const recovery = await this.recoverInitiateSigner(message, input.recoverySignature);
    if (recovery !== acct.config.recoveryKey || acct.usedKeys.has(acct.config.recoveryKey))
      throw revert("BadSignature");
    acct.pending = {
      commitment: input.root.commitmentHash,
      executeAfter: Math.floor(this.clock().getTime() / 1000) + acct.config.delay,
    };
    if (this.inject.hiddenReads) acct.hiddenReads = this.inject.hiddenReads;
    return { txHash: fakeHash(["initiate", input.account, input.root.commitmentHash]) };
  }

  private mustAccount(address: string): FakeAccount {
    const acct = this.accounts.get(address.toLowerCase());
    if (!acct) throw new Error(`unknown account ${address}`);
    return acct;
  }
}
