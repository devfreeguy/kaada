/*
 * Shared helpers for the Celo SEPOLIA Kernel probes (kernel-recovery-probe.ts, recovery-atomic-probe.ts).
 * TESTNET ONLY: real EntryPoint userOps handed straight to handleOps by the throwaway deployer.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  toFunctionSelector,
  zeroAddress,
} from "viem";
import type {
  Account as ViemAccount,
  Address,
  Chain,
  Hex,
  HttpTransport,
  PublicClient,
  WalletClient,
} from "viem";
import {
  entryPoint07Abi,
  getUserOperationHash,
  toPackedUserOperation,
} from "viem/account-abstraction";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

export const RPC = "https://forno.celo-sepolia.celo-testnet.org";
export const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;
export const FACTORY = "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9" as const;
export const ECDSA_X = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57" as const;

export const statePath = process.env["KAADA_HARNESS_STATE"];
if (!statePath) throw new Error("set KAADA_HARNESS_STATE");
export interface State {
  deployerKey: Hex;
  recoveryProbe?: { copies: Address[] };
}
export const state = JSON.parse(readFileSync(statePath, "utf8")) as State;

export const pub = createPublicClient({
  chain: celoSepolia,
  transport: http(RPC),
}) as unknown as PublicClient;
export const deployer = privateKeyToAccount(state.deployerKey);
export const wallet = createWalletClient({
  account: deployer,
  chain: celoSepolia,
  transport: http(RPC),
}) as unknown as WalletClient<HttpTransport, Chain, ViemAccount>;

export const factoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);

export const sel = {
  changeRoot: toFunctionSelector("changeRootValidator(bytes21,address,bytes,bytes)"),
  invalidate: toFunctionSelector("invalidateNonce(uint32)"),
  execute: toFunctionSelector("execute(bytes32,bytes)"),
};
export const MODE_SINGLE: Hex = `0x${"00".repeat(32)}`;
export const MODE_BATCH: Hex = `0x01${"00".repeat(31)}`;

export const vid = (address: Address): Hex => concat(["0x01", address]);
export const ownerData = (key: Hex): Hex => privateKeyToAccount(key).address;

export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
}
export const encodeExecute = (calls: Call[]): Hex =>
  calls.length === 1
    ? encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "execute",
        args: [
          MODE_SINGLE,
          concat([
            calls[0]!.to,
            pad(`0x${(calls[0]!.value ?? 0n).toString(16)}`, { size: 32 }),
            calls[0]!.data ?? "0x",
          ]),
        ],
      })
    : encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "execute",
        args: [
          MODE_BATCH,
          encodeAbiParameters(
            [
              {
                type: "tuple[]",
                components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
              },
            ],
            [calls.map((c) => [c.to, c.value ?? 0n, c.data ?? "0x"] as const)],
          ),
        ],
      });

export const results: { name: string; pass: boolean; detail: string }[] = [];
export function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

export function describeError(error: unknown): string {
  const walked = (error as { walk?: (fn: (e: unknown) => boolean) => unknown })?.walk?.(
    (e) =>
      typeof (e as { data?: unknown })?.data === "object" &&
      (e as { data?: unknown }).data !== null,
  ) as { data?: { errorName?: string; args?: unknown[] } } | undefined;
  if (walked?.data?.errorName) {
    return `${walked.data.errorName}(${(walked.data.args ?? []).map(String).join(",")})`;
  }
  const text = String((error as { message?: string })?.message ?? error);
  const data = /0x[0-9a-fA-F]{8,}/.exec(text)?.[0];
  if (data && data.length > 42) {
    try {
      const decoded = decodeErrorResult({
        abi: [...KernelV3_3AccountAbi, ...entryPoint07Abi],
        data: data as Hex,
      });
      return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(",")})`;
    } catch {
      return `revert ${data.slice(0, 74)}`;
    }
  }
  return text.split("\n")[0]!.slice(0, 160);
}

// ── validator copies ───────────────────────────────────────────────────────────────────────────

export async function ensureCopies(count: number): Promise<Address[]> {
  state.recoveryProbe ??= { copies: [] };
  const copies = state.recoveryProbe.copies;
  const runtime = (await pub.getCode({ address: ECDSA_X }))!;
  const body = runtime.slice(2);
  const length = body.length / 2;
  const initcode = `0x61${length.toString(16).padStart(4, "0")}80600a3d393df3${body}` as Hex;
  while (copies.length < count) {
    const hash = await wallet.sendTransaction({ data: initcode, gas: 3_000_000n });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error("copy was not deployed");
    copies.push(receipt.contractAddress);
    writeFileSync(statePath!, JSON.stringify(state), { mode: 0o600 });
  }
  return copies;
}

// ── userOps through handleOps ──────────────────────────────────────────────────────────────────

export interface Account {
  address: Address;
  deployed: boolean;
  initData: Hex;
  salt: Hex;
}

export async function newAccount(owner: Hex, salt: Hex): Promise<Account> {
  const initData = encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "initialize",
    args: [vid(ECDSA_X), zeroAddress, ownerData(owner), "0x", []],
  });
  const address = await pub.readContract({
    address: FACTORY,
    abi: factoryAbi,
    functionName: "getAddress",
    args: [initData, salt],
  });
  return { address, deployed: false, initData, salt };
}

export interface Outcome {
  accepted: boolean; // survived validation
  executed: boolean; // inner call succeeded
  detail: string;
}

/** One userOp: signed by `signerKey` through `validator` (`null` = the root validator). */
export async function submit(
  account: Account,
  validator: Address | null,
  signerKey: Hex,
  callData: Hex,
  gas: { verification?: bigint; call?: bigint } = {},
): Promise<Outcome> {
  const key = BigInt(
    concat(["0x00", validator ? "0x01" : "0x00", validator ?? zeroAddress, "0x0000"]),
  );
  const nonce = await pub.readContract({
    address: EP,
    abi: entryPoint07Abi,
    functionName: "getNonce",
    args: [account.address, key],
  });
  const fees = await pub.estimateFeesPerGas();
  // The EntryPoint holds the worst-case prefund; keep the account topped up to it (testnet CELO only).
  const verificationLimit = gas.verification ?? (account.deployed ? 200_000n : 500_000n);
  const callLimit = gas.call ?? 300_000n;
  const required = (verificationLimit + callLimit + 40_000n) * fees.maxFeePerGas;
  const have = await pub.getBalance({ address: account.address });
  if (have < required) {
    const hash = await wallet.sendTransaction({
      to: account.address,
      value: (required * 105n) / 100n - have,
    });
    await pub.waitForTransactionReceipt({ hash });
    for (
      let i = 0;
      i < 30 && (await pub.getBalance({ address: account.address })) < required;
      i++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const createData = encodeFunctionData({
    abi: factoryAbi,
    functionName: "createAccount",
    args: [account.initData, account.salt],
  });
  const operation = {
    sender: account.address,
    nonce,
    ...(account.deployed
      ? {}
      : {
          factory: FACTORY,
          factoryData: createData,
        }),
    callData,
    callGasLimit: callLimit,
    verificationGasLimit: verificationLimit,
    preVerificationGas: 40_000n,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    signature: "0x" as Hex,
  };
  const hash = getUserOperationHash({
    userOperation: operation,
    entryPointAddress: EP,
    entryPointVersion: "0.7",
    chainId: celoSepolia.id,
  });
  operation.signature = await privateKeyToAccount(signerKey).sign({ hash });
  const packed = toPackedUserOperation(operation);
  try {
    const { request } = await pub.simulateContract({
      account: deployer,
      address: EP,
      abi: entryPoint07Abi,
      functionName: "handleOps",
      args: [[packed], deployer.address],
      gas: 1_300_000n + (verificationLimit - 200_000n) + (callLimit - 300_000n),
    });
    const txHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
    let executed = false;
    let detail = "";
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== EP.toLowerCase()) continue;
      try {
        const event = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
        if (event.eventName === "UserOperationEvent") executed = event.args.success;
        if (event.eventName === "UserOperationRevertReason")
          detail = describeError({ message: event.args.revertReason });
      } catch {
        // not an EntryPoint event we know
      }
    }
    if (!account.deployed) account.deployed = true;
    // Let the RPC node catch up before anything reads state or builds the next nonce.
    await new Promise((resolve) => setTimeout(resolve, 4000));
    return { accepted: true, executed, detail };
  } catch (error) {
    return { accepted: false, executed: false, detail: describeError(error) };
  }
}

export async function read<T>(
  account: Account,
  functionName: string,
  args: unknown[] = [],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const value = await (pub.readContract as (request: object) => Promise<unknown>)({
        address: account.address,
        abi: KernelV3_3AccountAbi,
        functionName,
        args,
      });
      return value as T;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export const nonceNow = async (a: Account): Promise<number> =>
  Number(await read<number>(a, "currentNonce"));

/** The calls that make `validator` a secondary validator owned by `owner`, granted `selectors`. */
export function installCalls(
  account: Account,
  validator: Address,
  owner: Hex,
  nonce: number,
  selectors: Hex[],
): Call[] {
  return [
    {
      to: account.address,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "installValidations",
        args: [[vid(validator)], [{ nonce, hook: zeroAddress }], [ownerData(owner)], ["0x"]],
      }),
    },
    ...selectors.map((selector) => ({
      to: account.address,
      data: encodeFunctionData({
        abi: KernelV3_3AccountAbi,
        functionName: "grantAccess",
        args: [vid(validator), selector, true],
      }),
    })),
  ];
}

export const changeRootData = (validator: Address, owner: Hex): Hex =>
  encodeFunctionData({
    abi: KernelV3_3AccountAbi,
    functionName: "changeRootValidator",
    args: [vid(validator), zeroAddress, ownerData(owner), "0x"],
  });
export const invalidateData = (nonce: number): Hex =>
  encodeFunctionData({ abi: KernelV3_3AccountAbi, functionName: "invalidateNonce", args: [nonce] });
export const salt = (): Hex =>
  pad(`0x${Buffer.from(generatePrivateKey().slice(2, 18), "hex").toString("hex")}`, { size: 32 });
export const rootOf = async (a: Account): Promise<string> =>
  String(await read<Hex>(a, "rootValidator")).toLowerCase();
