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
  RootCredential,
  RootCredentialData,
  UserOperationStatus,
  WalletCredentialKind,
} from "@kaada/domain";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { KernelVersionToAddressesMap } from "@zerodev/sdk/constants";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeFunctionData,
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
import type { KernelFactoryCallReader } from "../wallet/kernel-deriver.js";

const ENTRY_POINT: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
const EXECUTE_SELECTOR = toFunctionSelector("execute(bytes32,bytes)");
/** The recovery batch is validated by the recovery module, which ignores the UserOperation signature. */
const IGNORED_SIGNATURE: Hex = `0x${"11".repeat(64)}1b`;
/** Gas to open a Kernel account through its factory was measured at about 291k on Celo Sepolia; this adds margin. */
const OPEN_ACCOUNT_GAS_CEILING = 360_000n;
/** The most gas a sized arming has needed (441,673 for a passkey root on Celo Sepolia), rounded up: for the cost ceiling only. */
const ARMING_GAS_CEILING = 500_000n;
/**
 * The bundler publishes a fee FLOOR and refuses an operation below it. The fee is fixed inside the operation the person signs and the
 * floor can rise before it is sent, so every operation is priced this far above the floor.
 */
const FEE_MARGIN_PERCENT = 120n;
/** A sponsored operation's limits are the bundler's estimate plus this margin. */
const ESTIMATE_MARGIN_PERCENT = 125n;
const BIGINT_PREFIX = "bigint:";

const recoveryAbi = artifacts.KaadaRecoveryValidator.abi as unknown as Abi;
const factoryAbi = artifacts.KaadaPasskeyValidatorFactory.abi as unknown as Abi;
const entryPointAbi = parseAbi([
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
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
  /**
   * Kaada's recovery relayer: the ONE address KaadaRecoveryValidator lets call `initiate` (it is the contract's immutable RELAYER),
   * and the EOA that pays gas for clone deployment. It is a submission gate, not an authority: it cannot produce the Recovery Code
   * signature `initiate` requires, holds no user wallet key, and cannot cancel or complete a recovery.
   */
  relayerKey: Hex;
  /** Whether the P-256 precompile (RIP-7212) exists: the passkey assertion encoding depends on it. */
  p256Precompile: boolean;
  /**
   * Pays the account its UserOperation prefund when it has none (a recovery or a cancel must not be stopped by an empty
   * wallet). `maxTopUpWei` caps what one call may send. `none` makes a short account a deferral instead.
   */
  gasSponsor?: { mode: "none" } | { mode: "topup"; maxTopUpWei: bigint };
  /**
   * How to read the factory call that opens a wallet's account (see `openAccount`). Absent: the relayer never opens accounts.
   * The call is only sent when it targets Kernel v3.3's own factory and creates exactly the account asked for.
   */
  accountFactoryCall?: KernelFactoryCallReader;
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
  /** The relayer's address (public). The key itself never leaves this class and is never logged. */
  readonly relayerAddress: string;
  private readonly client: PublicClient;
  private readonly relayer;
  private readonly wallet;
  private readonly gas: { verification: bigint; call: bigint; preVerification: bigint };

  /** Everything but the key: the key is used once, in the constructor, and is not kept on the object (so logging or serialising this class cannot leak it). */
  private readonly options: Omit<ViemRecoveryChainOptions, "relayerKey">;

  constructor(configured: ViemRecoveryChainOptions) {
    const { relayerKey, ...options } = configured;
    this.options = options;
    this.chainId = options.chain.id;
    this.recoveryValidator = options.recoveryValidator.toLowerCase();
    this.client = createPublicClient({
      chain: options.chain,
      transport: http(options.rpcUrl),
    });
    this.relayer = privateKeyToAccount(relayerKey);
    this.relayerAddress = this.relayer.address.toLowerCase();
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
    let status: InstanceStatus;
    try {
      status = await this.instanceStatus(input);
    } catch (error) {
      throw relayerUnavailable(error, "read");
    }
    if (status !== "NOT_DEPLOYED") return { created: false };
    await this.requireFundedRelayer();
    const factory =
      input.root.kind === "PASSKEY"
        ? this.options.deployments.passkey.factory
        : this.options.deployments.device.factory;
    let hash: Hex;
    try {
      hash = await this.wallet.writeContract({
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
    } catch (error) {
      if (isInsufficientFunds(error)) throw relayerUnavailable(error, "funds");
      throw error;
    }
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
    sponsorUpToWei?: string;
    sizeFromEstimate?: boolean;
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
      ...(input.sponsorUpToWei && { sponsorUpToWei: BigInt(input.sponsorUpToWei) }),
      ...(input.sizeFromEstimate && { sizeFromEstimate: true }),
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
    /** Overrides the configured top-up ceiling for this one operation (0 or absent: the configured one). */
    sponsorUpToWei?: bigint;
    /** Limits from a live estimate plus a margin (see estimateLimits) instead of the fixed ones. */
    sizeFromEstimate?: boolean;
  }): Promise<PreparedOperation> {
    const sender = getAddress(input.account);
    const [nonce, fees] = await Promise.all([
      this.client.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: "getNonce",
        args: [sender, input.nonceKey],
      }),
      this.operationFees(),
    ]);
    let operation: WireOperation = {
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
    if (input.sizeFromEstimate)
      operation = { ...operation, ...(await this.estimateLimits(operation)) };
    const sponsoredWei = await this.ensureGas(sender, operation, input.sponsorUpToWei);
    const userOpHash = getUserOperationHash({
      userOperation: { ...operation },
      entryPointAddress: ENTRY_POINT,
      entryPointVersion: "0.7",
      chainId: this.chainId,
    });
    return {
      userOpHash: userOpHash.toLowerCase(),
      operation: { ...(toJsonSafe({ ...operation, userOpHash }) as JsonObject) },
      ...(sponsoredWei > 0n && { sponsoredWei: sponsoredWei.toString() }),
    };
  }

  /**
   * What the account can pay a UserOperation's prefund with: its native balance plus its deposit held by the EntryPoint. The
   * EntryPoint takes the prefund from the deposit first and asks the account for only the missing part, and what an operation does not
   * use is credited back to the DEPOSIT, not to the balance. Counting only the balance would top the same wallet up again and again.
   */
  private async availableGas(account: Address): Promise<bigint> {
    const [native, deposit] = await Promise.all([
      this.client.getBalance({ address: account }),
      this.client.readContract({
        address: ENTRY_POINT,
        abi: entryPointAbi,
        functionName: "balanceOf",
        args: [account],
      }),
    ]);
    return native + deposit;
  }

  /** The account pays the prefund. A short account is topped up by the sponsor, or the step is deferred. */
  private async ensureGas(
    account: Address,
    operation: WireOperation,
    sponsorUpToWei?: bigint,
  ): Promise<bigint> {
    const required =
      (operation.callGasLimit + operation.verificationGasLimit + operation.preVerificationGas) *
      operation.maxFeePerGas;
    const available = await this.availableGas(account);
    if (available >= required) return 0n;
    const configured = this.options.gasSponsor ?? { mode: "none" };
    const sponsor =
      sponsorUpToWei !== undefined && sponsorUpToWei > 0n
        ? ({ mode: "topup", maxTopUpWei: sponsorUpToWei } as const)
        : configured;
    const shortfall = (required * 105n) / 100n - available;
    if (sponsor.mode === "none" || shortfall > sponsor.maxTopUpWei) {
      throw new KaadaError("RECOVERY_BLOCKED", "the wallet needs native gas for this operation", {
        details: { reason: "GAS_FUNDING_REQUIRED" },
      });
    }
    const hash = await this.wallet.sendTransaction({ to: account, value: shortfall });
    await this.client.waitForTransactionReceipt({ hash });
    for (let i = 0; i < 30; i += 1) {
      if ((await this.availableGas(account)) >= required) return shortfall;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new KaadaError("RECOVERY_BLOCKED", "the wallet top-up is not visible yet", {
      details: { reason: "GAS_FUNDING_REQUIRED" },
    });
  }

  /**
   * The operation's real gas needs, from the bundler's estimate (the operation carries a stub signature of the right shape for its
   * root type, so a passkey and a device key are each estimated on their own verification path), plus a 25% margin on each limit.
   * No estimate is a hard stop: the caller is NEVER given the fixed ceiling instead, because that would silently spend several times
   * what the operation needs.
   */
  private async estimateLimits(
    operation: WireOperation,
  ): Promise<Pick<WireOperation, "callGasLimit" | "verificationGasLimit" | "preVerificationGas">> {
    const unavailable = (why: string) =>
      new KaadaError("RECOVERY_BLOCKED", `the gas estimate is unavailable (${why})`, {
        details: { reason: "ESTIMATE_UNAVAILABLE" },
      });
    let response: { result?: unknown; error?: { message?: string } };
    try {
      response = await this.bundler("eth_estimateUserOperationGas", [
        toRpc(operation),
        ENTRY_POINT,
      ]);
    } catch {
      throw unavailable("bundler unreachable");
    }
    const found = response.result as Record<string, unknown> | null | undefined;
    if (response.error || !found) throw unavailable("bundler refused");
    const read = (key: string): bigint => {
      const value = found[key];
      if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value))
        throw unavailable(`no ${key}`);
      const parsed = BigInt(value);
      if (parsed <= 0n) throw unavailable(`zero ${key}`);
      return parsed;
    };
    const margin = (value: bigint) => (value * ESTIMATE_MARGIN_PERCENT + 99n) / 100n;
    return {
      callGasLimit: margin(read("callGasLimit")),
      verificationGasLimit: margin(read("verificationGasLimit")),
      preVerificationGas: margin(read("preVerificationGas")),
    };
  }

  /** Whether the bundler answers and serves this EntryPoint: checked before anything is spent on a wallet that would need an estimate. */
  async canEstimateGas(): Promise<boolean> {
    try {
      const response = await this.bundler("eth_supportedEntryPoints", []);
      return (
        Array.isArray(response.result) &&
        response.result.some((entry) => String(entry).toLowerCase() === ENTRY_POINT.toLowerCase())
      );
    } catch {
      return false;
    }
  }

  /**
   * The bundler's fee floor (its "standard" tier of `pimlico_getUserOperationGasPrice`, the same one the execution adapter reads).
   * Unlike the execution adapter, an unreadable floor is a hard stop here: pricing from the chain alone is what got an arming operation
   * refused ("maxFeePerGas must be at least ..."), so there is no fallback to the chain's price.
   */
  private async bundlerFeeFloor(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const unavailable = (why: string, refusal?: unknown) =>
      new KaadaError("RECOVERY_BLOCKED", `the bundler's fee floor is unavailable (${why})`, {
        details: {
          reason: "FEE_UNAVAILABLE",
          ...(refusal !== undefined && describeBundlerRefusal(refusal)),
        },
      });
    let response: { result?: unknown; error?: unknown };
    try {
      response = await this.bundler("pimlico_getUserOperationGasPrice", []);
    } catch {
      throw unavailable("bundler unreachable");
    }
    if (response.error !== undefined) throw unavailable("bundler refused", response.error);
    const standard = (response.result as { standard?: Record<string, unknown> } | null | undefined)
      ?.standard;
    const hex = /^0x[0-9a-fA-F]{1,32}$/;
    const maxFee = standard?.["maxFeePerGas"];
    const priority = standard?.["maxPriorityFeePerGas"];
    if (
      typeof maxFee !== "string" ||
      typeof priority !== "string" ||
      !hex.test(maxFee) ||
      !hex.test(priority) ||
      BigInt(maxFee) <= 0n
    ) {
      throw unavailable("no fee floor in the answer");
    }
    return { maxFeePerGas: BigInt(maxFee), maxPriorityFeePerGas: BigInt(priority) };
  }

  /**
   * The fee every operation is priced at: the higher of the chain's price and the bundler's floor, plus a 20% margin. This is the one
   * fee: the prefund check, the top-up and the cost ceiling all read it from the operation (or from here), never from the chain alone.
   */
  private async operationFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const [chain, floor] = await Promise.all([
      this.client.estimateFeesPerGas(),
      this.bundlerFeeFloor(),
    ]);
    const higher = (a: bigint, b: bigint) => (a > b ? a : b);
    const margin = (value: bigint) => (value * FEE_MARGIN_PERCENT + 99n) / 100n;
    const maxFeePerGas = margin(higher(chain.maxFeePerGas, floor.maxFeePerGas));
    const priority = margin(higher(chain.maxPriorityFeePerGas, floor.maxPriorityFeePerGas));
    return {
      maxFeePerGas,
      maxPriorityFeePerGas: priority > maxFeePerGas ? maxFeePerGas : priority,
    };
  }

  /**
   * A ceiling for what setting one wallet up can cost the sponsor now: opening its account (a direct transaction, at the chain's price)
   * plus the prefund of its arming operation (at the bundler's fee, with margin) plus the top-up's own fee. The fee floor is read
   * here, so a bundler that cannot price an operation is found BEFORE anything is spent on the wallet.
   */
  async estimateSetupCostWei(): Promise<string> {
    const [chain, operation] = await Promise.all([
      this.client.estimateFeesPerGas(),
      this.operationFees(),
    ]);
    const open = OPEN_ACCOUNT_GAS_CEILING * chain.maxFeePerGas;
    const topUp = (ARMING_GAS_CEILING * operation.maxFeePerGas * 105n) / 100n;
    const topUpFee = 30_000n * chain.maxFeePerGas;
    return (open + topUp + topUpFee).toString();
  }

  /** The relayer's native balance (wei): sponsoring stops while it is below its reserve. */
  async relayerBalanceWei(): Promise<string> {
    return (await this.client.getBalance({ address: this.relayer.address })).toString();
  }

  /**
   * Opens the wallet's account on chain when it does not exist yet, paid by the relayer. The only thing sent is the call Kernel v3.3's
   * own factory defines for this root, to that factory, and only if it creates exactly the account asked for: there is no way to make
   * this send anything else, and the relayer gains no authority over the account it opens.
   */
  async openAccount(input: {
    account: string;
    root: RootCredential;
  }): Promise<{ opened: boolean; costWei: string }> {
    const reader = this.options.accountFactoryCall;
    if (!reader) throw new KaadaError("RECOVERY_BLOCKED", "this service cannot open accounts");
    const account = getAddress(input.account);
    const existing = await this.client.getCode({ address: account });
    if (existing && existing !== "0x") return { opened: false, costWei: "0" };
    const call = await reader(input.root);
    const versions = KernelVersionToAddressesMap["0.3.3"];
    const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
    const initialize = toFunctionSelector("initialize(bytes21,address,bytes,bytes,bytes[])");
    const factoryAbi = parseAbi([
      "function createAccount(bytes data, bytes32 salt) payable returns (address)",
    ]);
    // The SDK wraps the creation in ZeroDev's staker: deployWithFactory(kernelFactory, initData, salt), where `initData` is the
    // account's own `initialize(...)` call. Whatever shape it hands over, the only transaction sent is
    // `createAccount(initData, salt)` to Kernel v3.3's own factory, for this wallet's account.
    let createData: Hex | undefined;
    if (
      same(call.factory, versions.metaFactoryAddress ?? zeroAddress) &&
      call.factoryData.startsWith(toFunctionSelector("deployWithFactory(address,bytes,bytes32)"))
    ) {
      const decoded = decodeFunctionData({
        abi: parseAbi([
          "function deployWithFactory(address factory, bytes createData, bytes32 salt)",
        ]),
        data: call.factoryData,
      });
      const [inner, initData, salt] = decoded.args;
      if (same(inner, versions.factoryAddress) && initData.startsWith(initialize)) {
        createData = encodeFunctionData({
          abi: factoryAbi,
          functionName: "createAccount",
          args: [initData, salt],
        });
      }
    } else if (
      same(call.factory, versions.factoryAddress) &&
      call.factoryData.startsWith(toFunctionSelector("createAccount(bytes,bytes32)"))
    ) {
      const [initData] = decodeFunctionData({ abi: factoryAbi, data: call.factoryData }).args;
      if (initData.startsWith(initialize)) createData = call.factoryData;
    }
    if (!createData || !same(call.address, account)) {
      throw new KaadaError("RECOVERY_BLOCKED", "the account to open is not the wallet's account");
    }
    const hash = await this.wallet.sendTransaction({
      to: getAddress(versions.factoryAddress),
      data: createData,
      gas: 600_000n,
    });
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new KaadaError("RECOVERY_BLOCKED", "opening the account failed on chain");
    }
    for (let i = 0; i < 30; i += 1) {
      const code = await this.client.getCode({ address: account });
      if (code && code !== "0x") {
        return { opened: true, costWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() };
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new KaadaError("RECOVERY_BLOCKED", "the opened account is not visible yet");
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
        details: describeBundlerRefusal(response.error),
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
    ];
    // Stage 1, nothing sent: the relayer must be reachable, funded, and be the validator's RELAYER. Any failure here means NOTHING
    // was broadcast, so it is reported as a retryable relayer outage. There is NO fallback to submitting from anywhere else.
    await this.requireFundedRelayer();
    let request: unknown;
    try {
      ({ request } = await this.client.simulateContract({
        account: this.relayer,
        address: this.options.recoveryValidator,
        abi: recoveryAbi,
        functionName: "initiate",
        args,
      } as never));
    } catch (error) {
      const reason = decodeRevert(error);
      // The validator names a different relayer than the key this service holds: a deployment mistake, not the person's fault.
      if (reason === "NotRelayer") throw relayerUnavailable(error, "relayer-mismatch");
      // Any other decoded contract error is a DEFINITE refusal of this recovery.
      if (reason)
        throw new KaadaError("RECOVERY_REJECTED", "initiate was refused", {
          details: { reason },
          cause: error,
        });
      throw relayerUnavailable(error, "simulate");
    }
    // Stage 2: broadcast. An unfunded relayer fails before anything leaves; any other failure here may have reached the network,
    // so it stays AMBIGUOUS and is settled by reading the chain.
    let hash: Hex;
    try {
      hash = await this.wallet.writeContract(request as never);
    } catch (error) {
      if (isInsufficientFunds(error)) throw relayerUnavailable(error, "funds");
      throw error;
    }
    const receipt = await this.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success")
      throw new KaadaError("RECOVERY_REJECTED", "initiate reverted");
    return { txHash: hash.toLowerCase() };
  }

  /** The relayer can pay for a transaction at all (a zero balance is the commonest outage). Reads only. */
  private async requireFundedRelayer(): Promise<void> {
    let balance: bigint;
    try {
      balance = await this.client.getBalance({ address: this.relayer.address });
    } catch (error) {
      throw relayerUnavailable(error, "read");
    }
    if (balance === 0n) throw relayerUnavailable(new Error("relayer has no gas"), "funds");
  }

  private async bundler(
    method: string,
    params: unknown[],
  ): Promise<{ result?: unknown; error?: { code?: number; message?: string } }> {
    const response = await fetch(this.options.bundlerUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(20_000),
    });
    return (await response.json()) as {
      result?: unknown;
      error?: { code?: number; message?: string };
    };
  }
}

/**
 * What a bundler said when it refused an operation, reduced to what is useful and safe in a log: its JSON-RPC error code, the ERC-4337
 * "AA" code if the message carries one (AA21 prefund, AA24 signature, AA25 nonce, ...), and a short message with any long hex run
 * removed (a signature or calldata that a bundler echoes back must never reach a log). Never the operation itself.
 */
export function describeBundlerRefusal(error: unknown): {
  rpc: string;
  rpcCode?: number;
  aaCode?: string;
  rpcData?: string;
} {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  const text = (value: unknown): string =>
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? Object.values(value)
            .filter((v): v is string => typeof v === "string")
            .join(" ")
        : "";
  // An answer that is only a string (an HTTP-style refusal) is the message.
  const raw =
    typeof error === "string" ? error : typeof record.message === "string" ? record.message : "";
  const data = text(record.data);
  const aa = /\bAA\d{2}\b/.exec(`${raw} ${data}`)?.[0];
  const redact = (value: string) =>
    value
      .replace(/0x[0-9a-fA-F]{64,}/g, "0x[hex omitted]")
      .replace(/https?:\/\/\S+/g, "[url]")
      .slice(0, 200);
  return {
    rpc: redact(raw),
    ...(typeof record.code === "number" && { rpcCode: record.code }),
    ...(aa && { aaCode: aa }),
    ...(data && { rpcData: redact(data) }),
  };
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
/**
 * The relayer could not submit and NOTHING was broadcast: retryable, and the person must not be told to submit anything themselves.
 * Carries a stage code only; never an address, a key or the node's raw error text.
 */
function relayerUnavailable(cause: unknown, stage: string): KaadaError {
  return new KaadaError(
    "RECOVERY_RELAYER_UNAVAILABLE",
    "the recovery service cannot submit right now; nothing was sent, try again shortly",
    { details: { stage }, cause },
  );
}

function isInsufficientFunds(error: unknown): boolean {
  const walked = (error as { walk?: (fn: (e: unknown) => boolean) => unknown } | null)?.walk?.(
    (e) => (e as { name?: string } | null)?.name === "InsufficientFundsError",
  );
  return walked !== undefined && walked !== null;
}

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
