import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { KernelVersionToAddressesMap } from "@zerodev/sdk/constants";
import { encodeFunctionData, parseAbi, toFunctionSelector } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import type { RootCredential } from "@kaada/domain";

import { ViemRecoveryChain } from "./viem-chain.js";
import type { KernelFactoryCall } from "../wallet/kernel-deriver.js";

/*
 * openAccount sends one kind of transaction: `createAccount(data, salt)` to Kernel v3.3's own factory, for exactly the wallet asked
 * for. Every other shape is refused BEFORE anything is sent. A tiny JSON-RPC server answers "no code at the address" and records
 * every method called. (The accepted shape is proved with a real transaction by the Sepolia harness, test/testnet.)
 */

const wallet = "0x2222222222222222222222222222222222222222";
const versions = KernelVersionToAddressesMap["0.3.3"];
const kernelFactory = versions.factoryAddress;
const staker = versions.metaFactoryAddress as `0x${string}`;
const initialize = toFunctionSelector("initialize(bytes21,address,bytes,bytes,bytes[])");
const stakerAbi = parseAbi([
  "function deployWithFactory(address factory, bytes createData, bytes32 salt)",
]);
const root: RootCredential = {
  type: "DEVICE_KEY",
  keyId: `0x${"ab".repeat(32)}`,
  publicKeyX: "11".repeat(32),
  publicKeyY: "22".repeat(32),
  validatorAddress: "0x00000000000000000000000000000000000000d1",
  purpose: 0,
  deploymentSalt: `0x${"00".repeat(32)}`,
};
const salt: Hex = `0x${"00".repeat(32)}`;

/** What the ZeroDev SDK really hands over: the creation wrapped in the staker's deployWithFactory. */
const wrapped = (inner: `0x${string}`, createData: Hex): KernelFactoryCall => ({
  address: wallet,
  factory: staker,
  factoryData: encodeFunctionData({
    abi: stakerAbi,
    functionName: "deployWithFactory",
    args: [inner, createData, salt],
  }),
});

async function withChain(
  call: KernelFactoryCall | null,
  run: (chain: ViemRecoveryChain, methods: string[]) => Promise<void>,
) {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string };
      methods.push(message.method);
      const result = message.method === "eth_chainId" ? "0x" + celoSepolia.id.toString(16) : "0x";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  try {
    const chain = new ViemRecoveryChain({
      chain: celoSepolia,
      rpcUrl: url,
      bundlerUrl: url,
      recoveryValidator: "0x00000000000000000000000000000000000000aa",
      deployments: {
        passkey: { factory: kernelFactory, implementation: kernelFactory },
        device: { factory: kernelFactory, implementation: kernelFactory },
      },
      relayerKey: generatePrivateKey(),
      p256Precompile: true,
      ...(call && { accountFactoryCall: () => Promise.resolve(call) }),
    });
    await run(chain, methods);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const sent = (methods: string[]) =>
  methods.filter((m) => m.startsWith("eth_send") || m === "eth_estimateGas");
const genuine = `${initialize}00` as Hex;

async function refused(call: KernelFactoryCall | null, expected: RegExp) {
  await withChain(call, async (chain, methods) => {
    await assert.rejects(chain.openAccount({ account: wallet, root }), expected);
    assert.deepEqual(sent(methods), [], "nothing was sent");
  });
}

test("a service with no account factory call cannot open accounts", async () => {
  await refused(null, /cannot open accounts/);
});

test("a call to any contract but the staker or Kernel's own factory is refused before anything is sent", async () => {
  await refused(
    { ...wrapped(kernelFactory, genuine), factory: "0x00000000000000000000000000000000000000f9" },
    /not the wallet's account/,
  );
});

test("the staker pointed at any factory but Kernel v3.3's own is refused before anything is sent", async () => {
  await refused(
    wrapped("0x00000000000000000000000000000000000000f9", genuine),
    /not the wallet's account/,
  );
});

test("the staker asked to create from anything but the account's initialize call is refused before anything is sent", async () => {
  await refused(
    wrapped(kernelFactory, `${toFunctionSelector("transfer(address,uint256)")}00` as Hex),
    /not the wallet's account/,
  );
});

test("a call that would create some other account is refused before anything is sent", async () => {
  await refused(
    { ...wrapped(kernelFactory, genuine), address: "0x3333333333333333333333333333333333333333" },
    /not the wallet's account/,
  );
});

test("an unknown function on the staker is refused before anything is sent", async () => {
  await refused(
    { address: wallet, factory: staker, factoryData: `${toFunctionSelector("drain()")}` },
    /not the wallet's account/,
  );
});
