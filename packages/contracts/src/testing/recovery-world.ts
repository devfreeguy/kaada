// Shared fixture for KaadaRecoveryValidator tests: a validator, a mock Kernel account, the keys,
// and builders for the exact recovery batch.
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  pad,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import type { Abi, Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { artifacts } from "../generated/artifacts.js";
import { TestChain, describeRevert } from "./evm.js";

export const validatorAbi = artifacts.KaadaRecoveryValidator.abi as unknown as Abi;
export const accountAbi = artifacts.MockAccount.abi as unknown as Abi;

export const DAY = 86_400;
export const MODE_BATCH: Hex = `0x01${"00".repeat(31)}`;
export const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
export const MODE_DELEGATE: Hex = `0xff${"00".repeat(31)}`;

export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
}

const executionsType = [
  { type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] },
] as const;
export const packExecutions = (calls: Call[]): Hex =>
  encodeAbiParameters(executionsType, [
    calls.map((c) => [c.to, c.value ?? 0n, c.data ?? "0x"] as const),
  ]);

const kernelAbi = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "execMode", type: "bytes32" },
      { name: "executionCalldata", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "changeRootValidator",
    inputs: [
      { name: "rootValidator", type: "bytes21" },
      { name: "hook", type: "address" },
      { name: "validatorData", type: "bytes" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "invalidateNonce",
    inputs: [{ name: "nonce", type: "uint32" }],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

export const executeData = (mode: Hex, execution: Hex): Hex =>
  encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [mode, execution] });
export const batch = (calls: Call[]): Hex => executeData(MODE_BATCH, packExecutions(calls));
export const rootCallData = (rootId: Hex, hook: Address, validatorData: Hex, hookData: Hex): Hex =>
  encodeFunctionData({
    abi: kernelAbi,
    functionName: "changeRootValidator",
    args: [rootId, hook, validatorData, hookData],
  });
export const invalidateData = (nonce: number): Hex =>
  encodeFunctionData({ abi: kernelAbi, functionName: "invalidateNonce", args: [nonce] });
export const selectors = {
  execute: toFunctionSelector("execute(bytes32,bytes)"),
  changeRoot: toFunctionSelector("changeRootValidator(bytes21,address,bytes,bytes)"),
};

export interface NewRoot {
  rootId: Hex;
  hook: Address;
  validatorData: Hex;
  hookData: Hex;
}

export interface Outcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

export class World {
  readonly deployer: Address = "0x1000000000000000000000000000000000000001";
  readonly stranger: Address = "0x1000000000000000000000000000000000000002";
  /** Kaada's recovery relayer: the only address the validator lets call `initiate`. */
  relayer: Address = "0x1000000000000000000000000000000000000003";
  readonly recoveryAddress: Address;

  private constructor(
    readonly recoveryKey: Hex,
    readonly chain: TestChain,
    readonly validator: Address,
    readonly account: Address,
    /** Any deployed contract: stands in for the new root validator instance. */
    readonly newValidator: Address,
  ) {
    this.recoveryAddress = privateKeyToAccount(recoveryKey).address;
  }

  static async create(
    options: {
      contract?: "KaadaRecoveryValidator" | "ShortDelayRecoveryValidator";
      relayer?: Address;
    } = {},
  ): Promise<World> {
    const chain = await TestChain.create();
    const deployer: Address = "0x1000000000000000000000000000000000000001";
    const recoveryKey = generatePrivateKey();
    const contract = options.contract ?? "KaadaRecoveryValidator";
    const validator = await chain.deploy(
      deployer,
      artifacts[contract].abi,
      artifacts[contract].bytecode,
      [options.relayer ?? "0x1000000000000000000000000000000000000003"],
    );
    const account = await chain.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    const newValidator = await chain.deploy(deployer, accountAbi, artifacts.MockAccount.bytecode);
    const world = new World(recoveryKey, chain, validator, account, newValidator);
    if (options.relayer) world.relayer = options.relayer;
    return world;
  }

  /** Calls the validator AS the account (msg.sender == account), like Kernel does. */
  async asAccount(data: Hex, account: Address = this.account): Promise<Outcome> {
    const forwarded = await this.chain.call(this.stranger, account, accountAbi, "forward", [
      this.validator,
      data,
    ]);
    if (!forwarded.ok) return { ok: false, error: forwarded.error };
    const [ok, ret] = forwarded.value as [boolean, Hex];
    if (ok) return { ok: true, value: ret };
    return { ok: false, error: describeRevert(validatorAbi, ret) };
  }

  fn(functionName: string, args: unknown[] = []): Hex {
    return encodeFunctionData({ abi: validatorAbi, functionName, args });
  }

  /** A call made by any address (not as the account). */
  async from(sender: Address, functionName: string, args: unknown[] = []): Promise<Outcome> {
    const result = await this.chain.call(sender, this.validator, validatorAbi, functionName, args);
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: result.error };
  }

  async read<T>(functionName: string, args: unknown[] = []): Promise<T> {
    const result = await this.from(this.stranger, functionName, args);
    if (!result.ok) throw new Error(`${functionName} reverted: ${result.error}`);
    return result.value as T;
  }

  async install(
    options: { recoveryKey?: Address; delay?: number; account?: Address } = {},
  ): Promise<Outcome> {
    const data = encodeAbiParameters(
      [{ type: "address" }, { type: "uint32" }],
      [options.recoveryKey ?? this.recoveryAddress, options.delay ?? 72 * 3600],
    );
    return this.asAccount(this.fn("onInstall", [data]), options.account);
  }

  root(options: Partial<NewRoot> = {}): NewRoot {
    return {
      rootId: options.rootId ?? concat(["0x01", this.newValidator]),
      hook: options.hook ?? zeroAddress,
      validatorData: options.validatorData ?? "0x1234",
      hookData: options.hookData ?? "0x",
    };
  }

  commitment(root: NewRoot) {
    return {
      rootId: root.rootId,
      hook: root.hook,
      validatorDataHash: keccak256(root.validatorData),
      hookDataHash: keccak256(root.hookData),
    };
  }

  domain() {
    return {
      name: "KaadaRecovery",
      version: "1",
      chainId: Number(this.chain.chainId),
      verifyingContract: this.validator,
    } as const;
  }

  async sign(
    key: Hex,
    root: NewRoot,
    options: {
      nonce?: bigint;
      deadline?: bigint;
      account?: Address;
      domain?: ReturnType<World["domain"]>;
    } = {},
  ): Promise<Hex> {
    const c = this.commitment(root);
    const account = options.account ?? this.account;
    return privateKeyToAccount(key).signTypedData({
      domain: options.domain ?? this.domain(),
      types: {
        Initiate: [
          { name: "account", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "rootId", type: "bytes21" },
          { name: "hook", type: "address" },
          { name: "validatorDataHash", type: "bytes32" },
          { name: "hookDataHash", type: "bytes32" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Initiate",
      message: {
        account,
        nonce: options.nonce ?? (await this.read<bigint>("recoveryNonce", [account])),
        rootId: c.rootId,
        hook: c.hook,
        validatorDataHash: c.validatorDataHash,
        hookDataHash: c.hookDataHash,
        deadline: options.deadline ?? this.chain.timestamp + 3600n,
      },
    });
  }

  /** The recovery key signs, then `initiate` (submitted by `sender`). */
  async initiate(
    root: NewRoot = this.root(),
    options: {
      sender?: Address;
      account?: Address;
      deadline?: bigint;
      sigRecovery?: Hex;
    } = {},
  ): Promise<Outcome> {
    const account = options.account ?? this.account;
    const deadline = options.deadline ?? this.chain.timestamp + 3600n;
    const sigRecovery =
      options.sigRecovery ?? (await this.sign(this.recoveryKey, root, { account, deadline }));
    return this.from(options.sender ?? this.relayer, "initiate", [
      account,
      this.commitment(root),
      deadline,
      sigRecovery,
    ]);
  }

  /** The exact recovery batch for `root`, as Kernel would receive it. */
  exactCalls(root: NewRoot, currentNonce: number, account: Address = this.account): Call[] {
    return [
      {
        to: account,
        data: rootCallData(root.rootId, root.hook, root.validatorData, root.hookData),
      },
      { to: account, data: invalidateData(currentNonce + 1) },
    ];
  }

  async currentNonce(account: Address = this.account): Promise<number> {
    const result = await this.chain.call(this.stranger, account, accountAbi, "currentNonce");
    if (!result.ok) throw new Error("currentNonce reverted");
    return Number(result.value);
  }

  userOp(
    callData: Hex,
    sender: Address = this.account,
    gas: {
      verificationGasLimit?: bigint;
      callGasLimit?: bigint;
      preVerificationGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      maxFeePerGas?: bigint;
    } = {},
  ) {
    const word = (high: bigint, low: bigint): Hex =>
      `0x${high.toString(16).padStart(32, "0")}${low.toString(16).padStart(32, "0")}`;
    return {
      sender,
      nonce: 0n,
      initCode: "0x" as Hex,
      callData,
      accountGasLimits: word(gas.verificationGasLimit ?? 0n, gas.callGasLimit ?? 0n),
      preVerificationGas: gas.preVerificationGas ?? 0n,
      gasFees: word(gas.maxPriorityFeePerGas ?? 0n, gas.maxFeePerGas ?? 0n),
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };
  }

  /** Kernel's call: validator.validateUserOp(userOp, hash) with msg.sender == account. */
  async validate(
    callData: Hex,
    options: {
      account?: Address;
      sender?: Address;
      gas?: Parameters<World["userOp"]>[2];
    } = {},
  ): Promise<Outcome> {
    const account = options.account ?? this.account;
    return this.asAccount(
      this.fn("validateUserOp", [
        this.userOp(callData, options.sender ?? account, options.gas),
        pad("0x01", { size: 32 }),
      ]),
      account,
    );
  }

  async pending(account: Address = this.account) {
    const [commitment, executeAfter, active] = await this.read<[Hex, number, boolean]>("pendings", [
      account,
    ]);
    return { commitment, executeAfter: BigInt(executeAfter), active };
  }
}
