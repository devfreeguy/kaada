import {
  KERNEL_MODE_BATCH,
  artifacts,
  buildRecoveryRoot,
  passkeyCredentialCommitment,
  recoveryBatchCallData,
  recoveryCommitmentHash,
  recoveryDeploymentSalt,
  recoveryDomain,
  recoveryInitiateMessage,
  recoveryInitiateTypes,
  recoveryInstallData,
  P256_HALF_N,
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
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseAbi,
  recoverTypedDataAddress,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import type { Abi, Address, Chain, Hex, PublicClient } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import { privateKeyToAccount } from "viem/accounts";

import { encodePasskeyAssertion } from "../execution/zerodev-kernel-adapter.js";

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
const EXECUTE_SELECTOR = toFunctionSelector("execute(bytes32,bytes)");
/** The recovery batch is validated by the recovery module, which ignores the UserOperation signature. */
const IGNORED_SIGNATURE: Hex = `0x${"11".repeat(64)}1b`;
const BIGINT_PREFIX = "bigint:";

const recoveryAbi = artifacts.KaadaRecoveryValidator.abi as unknown as Abi;
const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const entryPointAbi = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
]);
const validatorAbi = parseAbi([
  "function isInitialized(address account) view returns (bool)",
  "function validateUserOp((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp, bytes32 userOpHash) view returns (uint256)",
]);
const recoverySettersAbi = parseAbi([
  "function cancel()",
  "function setRecoveryKey(address newRecoveryKey)",
  "function setDelay(uint32 newDelay)",
]);

export interface ViemRecoveryChainOptions {
  chain: Chain;
  rpcUrl: string;
  bundlerUrl: string;
  /** The KaadaRecoveryValidator (or its test-only short-delay build on a testnet). */
  recoveryValidator: Address;
  deployments: ValidatorDeployments;
  /** An EOA that pays gas for clone deployment and `initiate` (anyone may submit them; it holds no authority). */
  relayerKey: Hex;
  /** Whether the P-256 precompile (RIP-7212) exists: the passkey assertion encoding depends on it. */
  p256Precompile: boolean;
  /**
   * Pays the account its UserOperation prefund when it has none (a recovery or a cancel must not be stopped by an empty
   * wallet). `maxTopUpWei` caps what one call may send. `none` makes a short account a deferral instead.
   */
  gasSponsor?: { mode: "none" } | { mode: "topup"; maxTopUpWei: bigint };
  gas?: { verification: bigint; call: bigint; preVerification: bigint };
}

const toJsonSafe = (value: unknown): unknown => {
  if (typeof value === "bigint") return `${BIGINT_PREFIX}${value.toString()}`;
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  }
  return value;
};
const fromJsonSafe = (value: unknown): unknown => {
  if (typeof value === "string" && value.startsWith(BIGINT_PREFIX)) {
    return BigInt(value.slice(BIGINT_PREFIX.length));
  }
  if (Array.isArray(value)) return value.map(fromJsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fromJsonSafe(v)]));
  }
  return value;
};

interface WireOperation {
  sender: Address;
  nonce: bigint;
  callData: Hex;
  callGasLimit: bigint;
  verificationGasLimit: bigint;
  preVerificationGas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  signature: Hex;
}

/**
 * The chain side of account recovery over viem, the Kernel v3.3 account, KaadaRecoveryValidator, the validator factories and
 * an ERC-4337 bundler. Writes are limited to: cloning a validator instance, `initiate`, and UserOperations of fixed shapes
 * (the exact recovery batch, or calls the ROOT signs). There is no method that sends arbitrary calldata.
 */
export class ViemRecoveryChain implements RecoveryChainPort {
  readonly chainId: number;
  readonly recoveryValidator: string;
  private readonly client: PublicClient;
  private readonly relayer;
  private readonly wallet;
  private readonly gas: { verification: bigint; call: bigint; preVerification: bigint };

  constructor(private readonly options: ViemRecoveryChainOptions) {
    this.chainId = options.chain.id;
    this.recoveryValidator = options.recoveryValidator.toLowerCase();
    this.client = createPublicClient({
      chain: options.chain,
      transport: http(options.rpcUrl),
    });
    this.relayer = privateKeyToAccount(options.relayerKey);
    this.wallet = createWalletClient({
      account: this.relayer,
      chain: options.chain,
      transport: http(options.rpcUrl),
    });
    this.gas = options.gas ?? { verification: 700_000n, call: 600_000n, preVerification: 60_000n };
  }

  // ───────────────────────────────── reads ─────────────────────────────────

  async accountState(account: string): Promise<RecoveryAccountState> {
    const address = getAddress(account);
    const code = await this.client.getCode({ address });
    if (!code || code === "0x") return { deployed: false, rootValidator: null, currentNonce: 0 };
    const [root, nonce] = await Promise.all([
      this.client.readContract({
        address,
        abi: KernelV3_3AccountAbi,
        functionName: "rootValidator",
      }),
      this.client.readContract({
        address,
        abi: KernelV3_3AccountAbi,
        functionName: "currentNonce",
      }),
    ]);
    // A validator-type root is 0x01 || the validator address; anything else (a permission root) is not ours.
    const rootHex = root;
    return {
      deployed: true,
      rootValidator: rootHex.startsWith("0x01") ? `0x${rootHex.slice(4, 44)}`.toLowerCase() : null,
      currentNonce: Number(nonce),
    };
  }

  async validatorState(account: string): Promise<RecoveryValidatorState> {
    const address = getAddress(account);
    const read = <T>(functionName: string) =>
      this.client.readContract({
        address: this.options.recoveryValidator,
        abi: recoveryAbi,
        functionName,
        args: [address],
      }) as Promise<T>;
    const [config, pending, nonce] = await Promise.all([
      read<readonly [Address, number, boolean]>("configs"),
      read<readonly [Hex, number, boolean]>("pendings"),
      read<bigint>("recoveryNonce"),
    ]);
    return {
      initialized: config[2],
      ...(config[2] && { recoveryKey: config[0].toLowerCase(), delaySeconds: Number(config[1]) }),
      recoveryNonce: nonce.toString(),
      ...(pending[2] && { pending: { commitment: pending[0], executeAfter: Number(pending[1]) } }),
    };
  }

  async laneVoided(account: string, laneId: string): Promise<boolean> {
    const address = getAddress(account);
    const [config, current] = await Promise.all([
      this.client.readContract({
        address,
        abi: KernelV3_3AccountAbi,
        functionName: "validationConfig",
        args: [laneId as Hex],
      }),
      this.client.readContract({
        address,
        abi: KernelV3_3AccountAbi,
        functionName: "currentNonce",
      }),
    ]);
    const { nonce, hook } = config;
    // hook 0 means the validation id was never installed: it cannot be used at all.
    if (hook === zeroAddress) return true;
    const root = await this.client.readContract({
      address,
      abi: KernelV3_3AccountAbi,
      functionName: "rootValidator",
    });
    if (root.toLowerCase() === laneId.toLowerCase()) return false;
    return Number(nonce) < Number(current);
  }

  // ───────────────────────────────── roots ─────────────────────────────────

  proposeRoot(input: {
    account: string;
    credential: RootCredentialData;
    attemptId: string;
  }): ProposedRoot {
    const built = buildRecoveryRoot({
      deployments: this.options.deployments,
      account: getAddress(input.account),
      credential: input.credential as NewRootCredential,
      deploymentSalt: recoveryDeploymentSalt(input.attemptId),
    });
    return {
      kind: input.credential.kind,
      validator: built.instance.toLowerCase(),
      rootId: `0x01${built.instance.slice(2).toLowerCase()}`,
      validatorData: built.root.validatorData,
      validatorDataHash: keccak256(built.root.validatorData),
      hook: built.root.hook.toLowerCase(),
      hookData: built.root.hookData,
      hookDataHash: keccak256(built.root.hookData),
      commitmentHash: recoveryCommitmentHash(getAddress(input.account), built.root),
      deploymentSalt: built.deploymentSalt,
      purpose: built.purpose,
    };
  }

  async instanceStatus(input: { account: string; root: ProposedRoot }): Promise<InstanceStatus> {
    const instance = getAddress(input.root.validator);
    const code = await this.client.getCode({ address: instance });
    if (!code || code === "0x") return "NOT_DEPLOYED";
    const initialized = await this.client.readContract({
      address: instance,
      abi: validatorAbi,
      functionName: "isInitialized",
      args: [getAddress(input.account)],
    });
    return initialized ? "INITIALIZED_FOR_ACCOUNT" : "DEPLOYED_UNUSED";
  }

  async deployInstance(input: {
    account: string;
    root: ProposedRoot;
  }): Promise<{ created: boolean; txHash?: string }> {
    if ((await this.instanceStatus(input)) !== "NOT_DEPLOYED") return { created: false };
    const factory =
      input.root.kind === "PASSKEY"
        ? this.options.deployments.passkey.factory
        : this.options.deployments.device.factory;
    const hash = await this.wallet.writeContract({
      address: factory,
      abi: factoryAbi,
      functionName: "deploy",
      args: [
        getAddress(input.account),
        input.root.purpose,
        this.credentialCommitment(input.root),
        input.root.deploymentSalt,
      ],
      gas: 400_000n,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new KaadaError("RECOVERY_REJECTED", "the validator instance could not be deployed");
    // The deployment must land exactly where the commitment says.
    const code = await this.waitForCode(getAddress(input.root.validator));
    if (!code)
      throw new KaadaError(
        "RECOVERY_REJECTED",
        "the validator instance is not at the committed address",
      );
    return { created: true, txHash: hash };
  }

  /** The factory takes the credential commitment (a hash of the install data), not the data itself. */
  private credentialCommitment(root: ProposedRoot): Hex {
    const data = root.validatorData as Hex;
    return passkeyCredentialCommitment({
      x: BigInt(`0x${data.slice(2, 66)}`),
      y: BigInt(`0x${data.slice(66, 130)}`),
      authenticatorIdHash: `0x${data.slice(130, 194)}`,
    });
  }

  private async waitForCode(address: Address): Promise<boolean> {
    for (let i = 0; i < 30; i += 1) {
      const code = await this.client.getCode({ address });
      if (code && code !== "0x") return true;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return false;
  }

  // ──────────────────────────────── typed data ────────────────────────────────

  typedMessage(input: {
    account: string;
    root: ProposedRoot;
    nonce: string;
    deadline: string;
  }): RecoveryTypedMessage {
    const message = recoveryInitiateMessage({
      account: getAddress(input.account),
      nonce: BigInt(input.nonce),
      deadline: BigInt(input.deadline),
      root: {
        validator: getAddress(input.root.validator),
        hook: getAddress(input.root.hook),
        validatorData: input.root.validatorData as Hex,
        hookData: input.root.hookData as Hex,
      },
    });
    return {
      chainId: this.chainId,
      verifyingContract: this.recoveryValidator,
      account: message.account.toLowerCase(),
      nonce: message.nonce.toString(),
      rootId: message.rootId,
      hook: message.hook.toLowerCase(),
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
        verifyingContract: getAddress(message.verifyingContract),
      },
      types: {
        Initiate: recoveryInitiateTypes.Initiate.map((f) => ({ name: f.name, type: f.type })),
      },
      primaryType: "Initiate",
      message: {
        account: getAddress(message.account),
        nonce: message.nonce,
        rootId: message.rootId,
        hook: getAddress(message.hook),
        validatorDataHash: message.validatorDataHash,
        hookDataHash: message.hookDataHash,
        deadline: message.deadline,
      },
    };
  }

  async recoverInitiateSigner(
    message: RecoveryTypedMessage,
    signature: string,
  ): Promise<string | null> {
    try {
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return null;
      // Low-s only, exactly like the contract: a malleable twin is not a signature.
      if (BigInt(`0x${signature.slice(66, 130)}`) > SECP256K1_HALF_N) return null;
      const signer = await recoverTypedDataAddress({
        domain: recoveryDomain(message.chainId, getAddress(message.verifyingContract)),
        types: recoveryInitiateTypes,
        primaryType: "Initiate",
        message: {
          account: getAddress(message.account),
          nonce: BigInt(message.nonce),
          rootId: message.rootId as Hex,
          hook: getAddress(message.hook),
          validatorDataHash: message.validatorDataHash as Hex,
          hookDataHash: message.hookDataHash as Hex,
          deadline: BigInt(message.deadline),
        },
        signature: signature as Hex,
      });
      return signer.toLowerCase();
    } catch {
      return null;
    }
  }

  // ─────────────────────────────── root signatures ───────────────────────────────

  encodeRootSignature(input: { kind: WalletCredentialKind; material: unknown }): string {
    if (input.kind === "PASSKEY")
      return encodePasskeyAssertion(input.material, this.options.p256Precompile);
    const value =
      typeof input.material === "string"
        ? input.material
        : (input.material as { signature?: unknown } | null)?.signature;
    // keyId || r || s, exactly 96 bytes, low-s: anything else cannot validate, so it never goes further.
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{192}$/.test(value)) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the device signature is malformed");
    }
    if (BigInt(`0x${value.slice(2 + 128)}`) > P256_HALF_N) {
      throw new KaadaError("CREDENTIAL_REJECTED", "the device signature is not low-s");
    }
    return value.toLowerCase();
  }

  async checkSignature(input: {
    account: string;
    validator: string;
    kind: WalletCredentialKind;
    hash: string;
    signature: string;
  }): Promise<boolean> {
    try {
      const result = await this.client.readContract({
        address: getAddress(input.validator),
        abi: validatorAbi,
        functionName: "validateUserOp",
        args: [
          {
            sender: getAddress(input.account),
            nonce: 0n,
            initCode: "0x",
            callData: "0x",
            accountGasLimits: pad("0x", { size: 32 }),
            preVerificationGas: 0n,
            gasFees: pad("0x", { size: 32 }),
            paymasterAndData: "0x",
            signature: input.signature as Hex,
          },
          input.hash as Hex,
        ],
        // The validator reads its state for msg.sender: ask AS the account.
        account: getAddress(input.account),
      });
      return result === 0n;
    } catch {
      return false;
    }
  }

  permissionLaneId(providerPermissionId: string): string {
    return pad(concat(["0x02", providerPermissionId as Hex]), {
      size: 21,
      dir: "right",
    }).toLowerCase();
  }

  validatorLaneId(validator: string): string {
    return concat(["0x01", getAddress(validator)]).toLowerCase();
  }

  // ─────────────────────────────── root-signed calls ───────────────────────────────

  cancelCalls(): ChainCall[] {
    return [
      {
        to: this.recoveryValidator,
        data: encodeFunctionData({ abi: recoverySettersAbi, functionName: "cancel" }),
      },
    ];
  }

  armCalls(input: {
    account: string;
    recoveryAddress: string;
    delaySeconds: number;
    currentNonce: number;
    alreadyConfigured: boolean;
  }): ChainCall[] {
    const account = getAddress(input.account);
    if (input.alreadyConfigured) {
      return [
        {
          to: this.recoveryValidator,
          data: encodeFunctionData({
            abi: recoverySettersAbi,
            functionName: "setRecoveryKey",
            args: [getAddress(input.recoveryAddress)],
          }),
        },
        {
          to: this.recoveryValidator,
          data: encodeFunctionData({
            abi: recoverySettersAbi,
            functionName: "setDelay",
            args: [input.delaySeconds],
          }),
        },
      ];
    }
    const validationId = concat(["0x01", getAddress(this.recoveryValidator)]);
    return [
      {
        to: account,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "installValidations",
          args: [
            [validationId],
            [{ nonce: input.currentNonce, hook: zeroAddress }],
            [recoveryInstallData(getAddress(input.recoveryAddress), input.delaySeconds)],
            ["0x"],
          ],
        }),
      },
      {
        to: account,
        data: encodeFunctionData({
          abi: KernelV3_3AccountAbi,
          functionName: "grantAccess",
          args: [validationId, EXECUTE_SELECTOR, true],
        }),
      },
    ];
  }

  // ──────────────────────────────── operations ────────────────────────────────

  async prepareRootOperation(input: {
    account: string;
    rootValidator: string;
    rootKind: WalletCredentialKind;
    calls: ChainCall[];
  }): Promise<PreparedOperation> {
    // The ROOT lane: mode 0x00, type 0x00 (root), no validator address, nonce key 0.
    const key = BigInt(concat(["0x00", "0x00", zeroAddress, "0x0000"]));
    const stub =
      input.rootKind === "PASSKEY"
        ? encodePasskeyStub(this.options.p256Precompile)
        : `0x${"11".repeat(96)}`;
    return this.prepare({
      account: input.account,
      nonceKey: key,
      callData: encodeExecute(input.calls),
      signature: stub as Hex,
    });
  }

  async prepareRecoveryBatch(input: {
    account: string;
    root: ProposedRoot;
    nonceBefore: number;
  }): Promise<PreparedOperation> {
    // The recovery validator lane: mode 0x00, type 0x01 (validator), the recovery validator address, nonce key 0.
    const key = BigInt(concat(["0x00", "0x01", getAddress(this.recoveryValidator), "0x0000"]));
    const callData = recoveryBatchCallData({
      account: getAddress(input.account),
      root: {
        validator: getAddress(input.root.validator),
        hook: getAddress(input.root.hook),
        validatorData: input.root.validatorData as Hex,
        hookData: input.root.hookData as Hex,
      },
      currentNonce: input.nonceBefore,
    });
    const prepared = await this.prepare({
      account: input.account,
      nonceKey: key,
      callData,
      signature: IGNORED_SIGNATURE,
    });
    await this.preflight(prepared.operation);
    return prepared;
  }

  private async prepare(input: {
    account: string;
    nonceKey: bigint;
    callData: Hex;
    signature: Hex;
  }): Promise<PreparedOperation> {
    const sender = getAddress(input.account);
    const [nonce, fees] = await Promise.all([
      this.client.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: "getNonce",
        args: [sender, input.nonceKey],
      }),
      this.client.estimateFeesPerGas(),
    ]);
    const operation: WireOperation = {
      sender,
      nonce,
      callData: input.callData,
      callGasLimit: this.gas.call,
      verificationGasLimit: this.gas.verification,
      preVerificationGas: this.gas.preVerification,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signature: input.signature,
    };
    await this.ensureGas(sender, operation);
    const userOpHash = getUserOperationHash({
      userOperation: { ...operation },
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.7",
      chainId: this.chainId,
    });
    return {
      userOpHash: userOpHash.toLowerCase(),
      operation: { ...(toJsonSafe({ ...operation, userOpHash }) as JsonObject) },
    };
  }

  /** The account pays the prefund. A short account is topped up by the sponsor, or the step is deferred. */
  private async ensureGas(account: Address, operation: WireOperation): Promise<void> {
    const required =
      (operation.callGasLimit + operation.verificationGasLimit + operation.preVerificationGas) *
      operation.maxFeePerGas;
    const balance = await this.client.getBalance({ address: account });
    if (balance >= required) return;
    const sponsor = this.options.gasSponsor ?? { mode: "none" };
    const shortfall = (required * 105n) / 100n - balance;
    if (sponsor.mode === "none" || shortfall > sponsor.maxTopUpWei) {
      throw new KaadaError("RECOVERY_BLOCKED", "the wallet needs native gas for this operation", {
        details: { reason: "GAS_FUNDING_REQUIRED" },
      });
    }
    const hash = await this.wallet.sendTransaction({ to: account, value: shortfall });
    await this.client.waitForTransactionReceipt({ hash });
    for (let i = 0; i < 30; i += 1) {
      if ((await this.client.getBalance({ address: account })) >= required) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new KaadaError("RECOVERY_BLOCKED", "the wallet top-up is not visible yet", {
      details: { reason: "GAS_FUNDING_REQUIRED" },
    });
  }

  /**
   * The recovery is consumed during VALIDATION, so a batch that validates but then reverts would burn the Recovery Code. The
   * bundler simulates the whole operation (execution included) before anything is sent; a failure defers instead.
   */
  private async preflight(operation: JsonObject): Promise<void> {
    const wire = fromJsonSafe(operation) as WireOperation;
    const response = await this.bundler("eth_estimateUserOperationGas", [toRpc(wire), ENTRY_POINT]);
    if (response.error) {
      const message = String(response.error.message ?? "");
      const reason = /AA22|not due/.test(message) ? "NOT_MATURE" : "SIMULATION_FAILED";
      throw new KaadaError("RECOVERY_BLOCKED", "the recovery batch did not simulate", {
        details: { reason },
      });
    }
  }

  async submitOperation(input: {
    operation: JsonObject;
    signature?: string;
  }): Promise<{ userOpHash: string }> {
    const wire = fromJsonSafe(input.operation) as WireOperation & { userOpHash?: Hex };
    const signed: WireOperation = {
      ...wire,
      ...(input.signature && { signature: input.signature as Hex }),
    };
    const expected = getUserOperationHash({
      userOperation: { ...signed },
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.7",
      chainId: this.chainId,
    });
    if (wire.userOpHash && wire.userOpHash.toLowerCase() !== expected.toLowerCase()) {
      throw new KaadaError("EXECUTION_FAILED", "the prepared operation was altered");
    }
    // A thrown error here (a network failure) is ambiguous: the request may or may not have arrived.
    const response = await this.bundler("eth_sendUserOperation", [toRpc(signed), ENTRY_POINT]);
    if (response.error) {
      throw new KaadaError("BUNDLER_REJECTED", "the bundler refused the operation", {
        details: { rpc: String(response.error.message ?? "").slice(0, 200) },
      });
    }
    return {
      userOpHash: (typeof response.result === "string" ? response.result : expected).toLowerCase(),
    };
  }

  async operationStatus(userOpHash: string): Promise<UserOperationStatus> {
    const receipt = await this.bundler("eth_getUserOperationReceipt", [userOpHash]);
    const found = receipt.result as
      { success?: boolean; receipt?: { transactionHash?: string } } | null | undefined;
    if (found) {
      return {
        state: "INCLUDED",
        success: found.success === true,
        ...(found.receipt?.transactionHash && {
          txHash: found.receipt.transactionHash.toLowerCase(),
        }),
      };
    }
    const known = await this.bundler("eth_getUserOperationByHash", [userOpHash]);
    return { state: known.result ? "PENDING" : "UNKNOWN" };
  }

  // ───────────────────────────── initiate ─────────────────────────────

  async initiate(input: {
    account: string;
    root: ProposedRoot;
    deadline: string;
    recoverySignature: string;
    attestorSignature: string;
  }): Promise<{ txHash: string }> {
    const args = [
      getAddress(input.account),
      {
        rootId: input.root.rootId,
        hook: getAddress(input.root.hook),
        validatorDataHash: input.root.validatorDataHash,
        hookDataHash: input.root.hookDataHash,
      },
      BigInt(input.deadline),
      input.recoverySignature,
      input.attestorSignature,
    ];
    try {
      const { request } = await this.client.simulateContract({
        account: this.relayer,
        address: this.options.recoveryValidator,
        abi: recoveryAbi,
        functionName: "initiate",
        args,
      } as never);
      const hash = await this.wallet.writeContract(request as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success")
        throw new KaadaError("RECOVERY_REJECTED", "initiate reverted");
      return { txHash: hash.toLowerCase() };
    } catch (error) {
      if (error instanceof KaadaError) throw error;
      const reason = decodeRevert(error);
      // A decoded contract error is a DEFINITE refusal; anything else (a network failure) is ambiguous.
      if (reason)
        throw new KaadaError("RECOVERY_REJECTED", "initiate was refused", {
          details: { reason },
          cause: error,
        });
      throw error;
    }
  }

  private async bundler(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { message?: string } }> {
    const response = await fetch(this.options.bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as { result?: unknown; error?: { message?: string } };
  }
}

function toRpc(operation: WireOperation) {
  const hex = (value: bigint) => `0x${value.toString(16)}`;
  return {
    sender: operation.sender,
    nonce: hex(operation.nonce),
    callData: operation.callData,
    callGasLimit: hex(operation.callGasLimit),
    verificationGasLimit: hex(operation.verificationGasLimit),
    preVerificationGas: hex(operation.preVerificationGas),
    maxFeePerGas: hex(operation.maxFeePerGas),
    maxPriorityFeePerGas: hex(operation.maxPriorityFeePerGas),
    signature: operation.signature,
  };
}

function encodeExecute(calls: ChainCall[]): Hex {
  if (calls.length === 1) {
    const call = calls[0]!;
    return encodeFunctionData({
      abi: KernelV3_3AccountAbi,
      functionName: "execute",
      args: [
        MODE_SINGLE,
        concat([
          getAddress(call.to),
          pad(`0x${BigInt(call.value ?? "0").toString(16)}`, { size: 32 }),
          call.data as Hex,
        ]),
      ],
    });
  }
  return encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "execute",
    args: [
      KERNEL_MODE_BATCH,
      encodeAbiParameters(
        [
          {
            type: "tuple[]",
            components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
          },
        ],
        [
          calls.map(
            (call) => [getAddress(call.to), BigInt(call.value ?? "0"), call.data as Hex] as const,
          ),
        ],
      ),
    ],
  });
}

/** A syntactically valid passkey assertion, only for gas estimation and the preparation of an unsigned operation. */
function encodePasskeyStub(usePrecompiled: boolean): Hex {
  return encodeAbiParameters(
    [
      { type: "bytes" },
      { type: "string" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bool" },
    ],
    [
      "0x49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97631d00000000",
      '{"type":"webauthn.get","challenge":"tbxXNFS9X_4Byr1cMwqKrIGB-_30a0QhZ6y7ucM0BOE","origin":"http://localhost:3000","crossOrigin":false}',
      1n,
      44941127272049826721201904734628716258498742255959991581049806490182030242267n,
      9910254599581058084911561569808925251374718953855182016200087235935345969636n,
      usePrecompiled,
    ],
  );
}

/** The contract error name behind a viem failure, if it is one of the recovery validator's own errors. */
function decodeRevert(error: unknown): string | null {
  const text = JSON.stringify(
    (error as { cause?: unknown } | null)?.cause ?? {},
    (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
  );
  const data = /0x[0-9a-fA-F]{8,}/.exec(text)?.[0];
  if (!data) return null;
  try {
    return decodeErrorResult({ abi: recoveryAbi, data: data as Hex }).errorName;
  } catch {
    return null;
  }
}
