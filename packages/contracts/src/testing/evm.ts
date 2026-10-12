// A minimal in-process EVM for contract tests: deploy, call as any sender, control block time and chain id.
import { Common, Hardfork, Mainnet } from "@ethereumjs/common";
import { createEVM } from "@ethereumjs/evm";
import type { EVM } from "@ethereumjs/evm";
import { SimpleStateManager } from "@ethereumjs/statemanager";
import { Account, bytesToHex, createAddressFromString, hexToBytes } from "@ethereumjs/util";
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
    const evm = await createEVM({ common, stateManager: new SimpleStateManager() });
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
