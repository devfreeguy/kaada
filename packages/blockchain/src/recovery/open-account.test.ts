import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { KernelVersionToAddressesMap } from "@zerodev/sdk/constants";
import { toFunctionSelector } from "viem";
import type { Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import type { RootCredential } from "@kaada/domain";

import { ViemRecoveryChain } from "./viem-chain.js";
import type { KernelFactoryCall } from "../wallet/kernel-deriver.js";

/*
 * openAccount sends one kind of transaction: the account factory's own creation call, for exactly the wallet asked for. Every other
 * shape is refused BEFORE anything is sent. A tiny JSON-RPC server answers "no code at the address" and records every method called.
 */

const wallet = "0x2222222222222222222222222222222222222222";
const pinned = KernelVersionToAddressesMap["0.3.3"].factoryAddress;
const creation = toFunctionSelector("createAccount(bytes,bytes32)");
const root: RootCredential = {
  type: "DEVICE_KEY",
  keyId: `0x${"ab".repeat(32)}`,
  publicKeyX: "11".repeat(32),
  publicKeyY: "22".repeat(32),
  validatorAddress: "0x00000000000000000000000000000000000000d1",
  purpose: 0,
  deploymentSalt: `0x${"00".repeat(32)}`,
};

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
        passkey: { factory: pinned, implementation: pinned },
        device: { factory: pinned, implementation: pinned },
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

const good = (over: Partial<KernelFactoryCall>): KernelFactoryCall => ({
  address: wallet,
  factory: pinned,
  factoryData: `${creation}00` as Hex,
  ...over,
});

test("a service with no account factory call cannot open accounts", async () => {
  await withChain(null, async (chain, methods) => {
    await assert.rejects(chain.openAccount({ account: wallet, root }), /cannot open accounts/);
    assert.deepEqual(sent(methods), []);
  });
});

test("a call to any contract but Kernel v3.3's own factory is refused before anything is sent", async () => {
  await withChain(
    good({ factory: "0x00000000000000000000000000000000000000f9" }),
    async (chain, methods) => {
      await assert.rejects(
        chain.openAccount({ account: wallet, root }),
        /not the wallet's account/,
      );
      assert.deepEqual(sent(methods), []);
    },
  );
});

test("a call that would create some other account is refused before anything is sent", async () => {
  await withChain(
    good({ address: "0x3333333333333333333333333333333333333333" }),
    async (chain, methods) => {
      await assert.rejects(
        chain.openAccount({ account: wallet, root }),
        /not the wallet's account/,
      );
      assert.deepEqual(sent(methods), []);
    },
  );
});

test("anything but the factory's creation function is refused before anything is sent", async () => {
  await withChain(
    good({ factoryData: `${toFunctionSelector("transfer(address,uint256)")}00` as Hex }),
    async (chain, methods) => {
      await assert.rejects(
        chain.openAccount({ account: wallet, root }),
        /not the wallet's account/,
      );
      assert.deepEqual(sent(methods), []);
    },
  );
});
