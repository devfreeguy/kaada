// A minimal in-process EVM for contract tests: deploy, call as any sender, control block time and chain id.
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createEVM } from "@ethereumjs/evm";
import type { EVM } from "@ethereumjs/evm";
import { SimpleStateManager } from "@ethereumjs/statemanager";
import { Account, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
import { p256 } from "@noble/curves/p256";
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeDeployData,
  encodeFunctionData,
} from "viem";
import type { Abi, Address, Hex } from "viem";

export interface LogEntry {
  address: Address;
  topics: Hex[];
  data: Hex;
}

export interface CallResult {
  ok: boolean;
  logs: LogEntry[];
  /** Raw return (or revert) data. */
  data: Hex;
  gasUsed: bigint;
}

/** RIP-7212 (Celo, 0x100): input hash|r|s|x|y (160 bytes); output uint256(1) when valid, empty otherwise. */
function p256Precompile(input: { data: Uint8Array; gasLimit: bigint }) {
  const gas = 3450n;
  if (input.gasLimit < gas) {
    return {
      executionGasUsed: input.gasLimit,
      returnValue: new Uint8Array(),
      exceptionError: undefined,
    };
  }
  const empty = { executionGasUsed: gas, returnValue: new Uint8Array() };
  if (input.data.length !== 160) return empty;
  const word = (i: number) => BigInt(bytesToHex(input.data.subarray(i * 32, i * 32 + 32)));
  try {
    const point = p256.ProjectivePoint.fromAffine({ x: word(3), y: word(4) });
    const sig = new p256.Signature(word(1), word(2));
    const valid = p256.verify(
      sig.toCompactRawBytes(),
      input.data.subarray(0, 32),
      point.toRawBytes(false),
      { lowS: false },
    );
    if (!valid) return empty;
    const out = new Uint8Array(32);
    out[31] = 1;
    return { executionGasUsed: gas, returnValue: out };
  } catch {
    return empty;
  }
}

export class TestChain {
  private constructor(
    private readonly evm: EVM,
    readonly chainId: bigint,
  ) {}
  /** Block timestamp used for every call; advance it with `warp`. */
  timestamp = 1_700_000_000n;
  private nonce = 0n;

  static async create(chainId = 1n): Promise<TestChain> {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    const evm = await createEVM({
      common,
      stateManager: new SimpleStateManager(),
      customPrecompiles: [
        {
          address: createAddressFromString("0x0000000000000000000000000000000000000100"),
          function: p256Precompile as never,
        },
      ],
    });
    return new TestChain(evm, chainId);
  }

  warp(seconds: number | bigint): void {
    this.timestamp += BigInt(seconds);
  }

  /** Tops the balance up to `wei`, keeping the account nonce (CREATE addresses depend on it). */
  async fund(address: Address, wei = 10n ** 20n): Promise<void> {
    const key = createAddressFromString(address);
    const existing = await this.evm.stateManager.getAccount(key);
    if (existing && existing.balance >= wei) return;
    await this.evm.stateManager.putAccount(key, new Account(existing?.nonce ?? 0n, wei));
  }

  /** Installs runtime code at an address (a verified third-party contract, without its constructor). */
  async setCode(address: Address, runtime: Hex): Promise<void> {
    const key = createAddressFromString(address);
    const existing = await this.evm.stateManager.getAccount(key);
    await this.evm.stateManager.putAccount(key, existing ?? new Account(0n, 0n));
    await this.evm.stateManager.putCode(key, hexToBytes(runtime));
  }

  async getCode(address: Address): Promise<Hex> {
    return bytesToHex(await this.evm.stateManager.getCode(createAddressFromString(address)));
  }

  private block() {
    return {
      header: {
        number: 1n,
        timestamp: this.timestamp,
        gasLimit: 30_000_000n,
        baseFeePerGas: 0n,
        coinbase: createAddressFromString("0x0000000000000000000000000000000000000000"),
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        getBlobGasPrice: () => 0n,
        cliqueSigner: () => createAddressFromString("0x0000000000000000000000000000000000000000"),
      },
    } as never;
  }

  async raw(input: {
    from: Address;
    to?: Address;
    data: Hex;
    value?: bigint;
  }): Promise<CallResult & { created?: Address }> {
    const result = await this.evm.runCall({
      caller: createAddressFromString(input.from),
      ...(input.to ? { to: createAddressFromString(input.to) } : {}),
      data: hexToBytes(input.data),
      value: input.value ?? 0n,
      gasLimit: 20_000_000n,
      block: this.block(),
    });
    const created = result.createdAddress?.toString();
    return {
      ok: result.execResult.exceptionError === undefined,
      data: bytesToHex(result.execResult.returnValue),
      gasUsed: result.execResult.executionGasUsed,
      logs: (result.execResult.logs ?? []).map(([address, topics, data]) => ({
        address: bytesToHex(address),
        topics: topics.map((t) => bytesToHex(t)),
        data: bytesToHex(data),
      })),
      ...(created ? { created } : {}),
    };
  }

  async deploy(from: Address, abi: Abi, bytecode: Hex, args: unknown[] = []): Promise<Address> {
    await this.fund(from);
    const data = encodeDeployData({ abi, bytecode, args });
    const result = await this.raw({ from, data });
    if (!result.ok || !result.created) throw new Error(`deployment failed: ${result.data}`);
    return result.created;
  }

  /** Calls a function; returns the decoded value, or the decoded custom error on revert. */
  async call(
    from: Address,
    to: Address,
    abi: Abi,
    functionName: string,
    args: unknown[] = [],
    value = 0n,
  ): Promise<
    | { ok: true; value: unknown; logs: LogEntry[]; gasUsed: bigint }
    | { ok: false; error: string; data: Hex }
  > {
    const data = encodeFunctionData({ abi, functionName, args });
    const result = await this.raw({ from, to, data, value });
    if (!result.ok)
      return { ok: false, error: describeRevert(abi, result.data), data: result.data };
    const decoded =
      result.data === "0x"
        ? undefined
        : decodeFunctionResult({ abi, functionName, data: result.data });
    return { ok: true, value: decoded, logs: result.logs, gasUsed: result.gasUsed };
  }
}

export function describeRevert(abi: Abi, data: Hex): string {
  if (data === "0x") return "revert(empty)";
  try {
    const decoded = decodeErrorResult({ abi, data });
    return decoded.errorName;
  } catch {
    return `revert(${data.slice(0, 10)})`;
  }
}
