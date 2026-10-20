import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { KaadaError } from "@kaada/domain";
import { generatePrivateKey } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { ViemRecoveryChain, describeBundlerRefusal } from "./viem-chain.js";

/*
 * When a bundler refuses an operation, the adapter keeps its JSON-RPC code, its AA code and a short message for the log, and nothing
 * that could be a signature or calldata. A small JSON-RPC server plays the chain and a bundler that refuses.
 */

const account = "0x2222222222222222222222222222222222222222";
const GWEI = 10n ** 9n;
const SIGNATURE = `0x${"ab".repeat(65)}`;

async function refusedWith(refusal: { code?: unknown; message: string }) {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string };
      response.setHeader("content-type", "application/json");
      const reply = (result: unknown) =>
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      switch (message.method) {
        case "eth_chainId":
          return reply(`0x${celoSepolia.id.toString(16)}`);
        case "eth_getBalance":
          return reply(`0x${(10n ** 20n).toString(16)}`);
        case "eth_call":
          return reply(`0x${"0".repeat(64)}`);
        case "eth_getBlockByNumber":
          return reply({
            number: "0x10",
            hash: `0x${"11".repeat(32)}`,
            parentHash: `0x${"22".repeat(32)}`,
            timestamp: "0x1",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            baseFeePerGas: `0x${(100n * GWEI).toString(16)}`,
            transactions: [],
          });
        case "eth_maxPriorityFeePerGas":
          return reply(`0x${(2n * GWEI).toString(16)}`);
        case "eth_sendUserOperation":
          return response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: refusal }));
        default:
          return response.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "no" },
            }),
          );
      }
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
        passkey: { factory: account, implementation: account },
        device: { factory: account, implementation: account },
      },
      relayerKey: generatePrivateKey(),
      p256Precompile: true,
    });
    const prepared = await chain.prepareRootOperation({
      account,
      rootValidator: "0x00000000000000000000000000000000000000d1",
      rootKind: "DEVICE_KEY",
      calls: [{ to: "0x00000000000000000000000000000000000000f1", data: "0x" }],
    });
    return await chain
      .submitOperation({ operation: prepared.operation, signature: SIGNATURE })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a refusal keeps the bundler's JSON-RPC code, its AA code and its message, and the answer is still BUNDLER_REJECTED", async () => {
  const error = await refusedWith({ code: -32500, message: "AA24 signature error" });
  assert.ok(error instanceof KaadaError);
  assert.equal(error.code, "BUNDLER_REJECTED");
  assert.equal(
    error.message,
    "the bundler refused the operation",
    "what the caller sees is unchanged",
  );
  assert.deepEqual(error.details, { rpc: "AA24 signature error", rpcCode: -32500, aaCode: "AA24" });
});

test("a refusal without an AA code or a numeric code still says what it can", async () => {
  const error = await refusedWith({ code: "weird", message: "rate limited" });
  assert.ok(error instanceof KaadaError);
  assert.deepEqual(error.details, { rpc: "rate limited" });
});

test("a signature or calldata the bundler echoes back never reaches the details", async () => {
  const echoed = `AA21 didn't pay prefund; userOp signature ${SIGNATURE} callData 0x${"cd".repeat(200)}`;
  const error = await refusedWith({ code: -32500, message: echoed });
  assert.ok(error instanceof KaadaError);
  const text = JSON.stringify(error.details);
  assert.equal(text.includes("abab"), false, text);
  assert.equal(text.includes("cdcd"), false, text);
  assert.match(text, /AA21/);
  assert.match(text, /hex omitted/);
});

test("describeBundlerRefusal caps the message and ignores non-text input", () => {
  assert.equal(describeBundlerRefusal({ message: "x".repeat(500) }).rpc.length, 200);
  assert.deepEqual(describeBundlerRefusal({ code: 1, message: 42 }), { rpc: "", rpcCode: 1 });
  assert.equal(describeBundlerRefusal({ message: "no AAA24 here, but AA25 nonce" }).aaCode, "AA25");
});
