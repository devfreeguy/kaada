import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { KaadaError } from "@kaada/domain";
import { toFunctionSelector } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { ViemRecoveryChain } from "./viem-chain.js";

/*
 * How a wallet's gas is counted and how a sponsored operation is sized. A small JSON-RPC server plays the chain (balance, EntryPoint
 * deposit, fees) AND the bundler (estimates), and records every method, so a test can say "nothing was sent".
 */

const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
const account = "0x2222222222222222222222222222222222222222";
const GWEI = 10n ** 9n;
const CELO = 10n ** 18n;
const balanceOf = toFunctionSelector("balanceOf(address)");

interface World {
  native: bigint;
  deposit: bigint;
  estimate: Record<string, unknown> | { error: string } | "down";
  supported: string[];
  methods: string[];
  estimateRequests: Array<{ signature: string }>;
}

async function withChain(
  setup: Partial<World>,
  run: (chain: ViemRecoveryChain, world: World) => Promise<void>,
) {
  const world: World = {
    native: 0n,
    deposit: 0n,
    estimate: {
      callGasLimit: "0x30d40",
      verificationGasLimit: "0x186a0",
      preVerificationGas: "0xc350",
    },
    supported: [ENTRY_POINT],
    methods: [],
    estimateRequests: [],
    ...setup,
  };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const message = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
      world.methods.push(message.method);
      const reply = (result: unknown) =>
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      const fail = (text: string) =>
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: text },
          }),
        );
      response.setHeader("content-type", "application/json");
      switch (message.method) {
        case "eth_chainId":
          return reply(`0x${celoSepolia.id.toString(16)}`);
        case "eth_getBalance":
          return reply(`0x${world.native.toString(16)}`);
        case "eth_call": {
          const data = String((message.params?.[0] as { data?: string }).data);
          // balanceOf(account) is the deposit; anything else (getNonce) is zero.
          return reply(
            data.startsWith(balanceOf)
              ? `0x${world.deposit.toString(16).padStart(64, "0")}`
              : `0x${"0".repeat(64)}`,
          );
        }
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
        case "eth_gasPrice":
          return reply(`0x${(100n * GWEI).toString(16)}`);
        case "eth_supportedEntryPoints":
          return reply(world.supported);
        case "eth_estimateUserOperationGas": {
          world.estimateRequests.push(message.params?.[0] as { signature: string });
          if (world.estimate === "down") return response.destroy();
          if ("error" in world.estimate) return fail(String(world.estimate.error));
          return reply(world.estimate);
        }
        default:
          return fail(`unexpected ${message.method}`);
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
    await run(chain, world);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const calls = [{ to: "0x00000000000000000000000000000000000000f1", data: "0x" as const }];
const arm = (
  chain: ViemRecoveryChain,
  extra: {
    sponsorUpToWei?: string;
    sizeFromEstimate?: boolean;
    rootKind?: "PASSKEY" | "DEVICE_KEY";
  } = {},
) =>
  chain.prepareRootOperation({
    account,
    rootValidator: "0x00000000000000000000000000000000000000d1",
    rootKind: extra.rootKind ?? "DEVICE_KEY",
    calls,
    ...(extra.sponsorUpToWei && { sponsorUpToWei: extra.sponsorUpToWei }),
    ...(extra.sizeFromEstimate && { sizeFromEstimate: true }),
  });

const field = (operation: Record<string, unknown>, key: string): bigint =>
  BigInt(String(operation[key]).replace("bigint:", ""));
const sent = (methods: string[]) => methods.filter((m) => m.startsWith("eth_send"));
const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return "resolved";
  } catch (error) {
    return error instanceof KaadaError
      ? `${error.code}/${String((error.details as { reason?: string } | undefined)?.reason)}`
      : String(error);
  }
};

test("the EntryPoint deposit counts: a wallet with no native balance but a deposit that covers the prefund needs no top-up", async () => {
  await withChain({ native: 0n, deposit: 10n * CELO }, async (chain, world) => {
    const prepared = await arm(chain, { sponsorUpToWei: CELO.toString() });
    assert.equal(prepared.sponsoredWei, undefined);
    assert.deepEqual(sent(world.methods), [], "nothing was sent");
  });
});

test("native balance and deposit add up: neither alone covers the prefund, together they do", async () => {
  await withChain({ native: 10n * CELO }, async (chain, world) => {
    const probe = await arm(chain);
    const op = probe.operation;
    const required =
      (field(op, "callGasLimit") +
        field(op, "verificationGasLimit") +
        field(op, "preVerificationGas")) *
      field(op, "maxFeePerGas");
    world.native = required / 2n;
    world.deposit = required - world.native;
    assert.equal((await arm(chain)).sponsoredWei, undefined, "exactly enough between the two");
    world.deposit -= 1n;
    assert.equal(await code(arm(chain)), "RECOVERY_BLOCKED/GAS_FUNDING_REQUIRED", "one wei short");
    assert.deepEqual(sent(world.methods), []);
  });
});

test("a wallet with nothing is refused without a sponsor, and when the top-up it needs is above what may be sent", async () => {
  await withChain({}, async (chain, world) => {
    assert.equal(await code(arm(chain)), "RECOVERY_BLOCKED/GAS_FUNDING_REQUIRED");
    assert.equal(
      await code(arm(chain, { sponsorUpToWei: "1" })),
      "RECOVERY_BLOCKED/GAS_FUNDING_REQUIRED",
    );
    assert.deepEqual(sent(world.methods), [], "neither attempt sent anything");
  });
});

test("a sized operation's limits are the estimate plus 25%, and what it needs is judged on THOSE limits", async () => {
  await withChain({ native: 10n * CELO }, async (chain, world) => {
    const prepared = await arm(chain, { sizeFromEstimate: true });
    const op = prepared.operation;
    assert.equal(field(op, "callGasLimit"), 250_000n, "200,000 + 25%");
    assert.equal(field(op, "verificationGasLimit"), 125_000n, "100,000 + 25%");
    assert.equal(field(op, "preVerificationGas"), 62_500n, "50,000 + 25%");
    // The prefund is the SIZED limits times the fee ceiling: exactly that is enough, a wei less is not.
    const required = (250_000n + 125_000n + 62_500n) * field(op, "maxFeePerGas");
    world.native = required;
    assert.equal((await arm(chain, { sizeFromEstimate: true })).sponsoredWei, undefined);
    world.native = required - 1n;
    assert.equal(
      await code(arm(chain, { sizeFromEstimate: true })),
      "RECOVERY_BLOCKED/GAS_FUNDING_REQUIRED",
    );
    // The fixed limits would have needed several times as much.
    const fixed = await (async () => {
      world.native = 10n * CELO;
      const f = await arm(chain);
      return (
        (field(f.operation, "callGasLimit") +
          field(f.operation, "verificationGasLimit") +
          field(f.operation, "preVerificationGas")) *
        field(f.operation, "maxFeePerGas")
      );
    })();
    assert.ok(fixed > required * 3n, `fixed ${fixed} vs sized ${required}`);
  });
});

test("an estimate that is down, refused or empty is a hard stop: never a silent fall back to the fixed limits", async () => {
  for (const estimate of [
    "down",
    { error: "AA21 didn't pay prefund" },
    {},
    { callGasLimit: "0x0", verificationGasLimit: "0x1", preVerificationGas: "0x1" },
  ] as const) {
    await withChain({ native: 10n * CELO, estimate }, async (chain, world) => {
      assert.equal(
        await code(arm(chain, { sizeFromEstimate: true })),
        "RECOVERY_BLOCKED/ESTIMATE_UNAVAILABLE",
        JSON.stringify(estimate),
      );
      assert.deepEqual(sent(world.methods), []);
    });
  }
});

test("each root type is estimated with a stub signature of its own shape", async () => {
  await withChain({ native: 10n * CELO }, async (chain, world) => {
    await arm(chain, { sizeFromEstimate: true, rootKind: "DEVICE_KEY" });
    await arm(chain, { sizeFromEstimate: true, rootKind: "PASSKEY" });
    const [device, passkey] = world.estimateRequests.map((r) => r.signature);
    assert.equal(
      device?.length,
      2 + 96 * 2,
      "a device key's signature is keyId || r || s: 96 bytes",
    );
    assert.ok(
      (passkey?.length ?? 0) > (device?.length ?? 0) * 2,
      "a WebAuthn assertion is far larger",
    );
    assert.notEqual(device, passkey);
  });
});

test("whether estimates can be had is asked of the bundler", async () => {
  await withChain({}, async (chain) => assert.equal(await chain.canEstimateGas(), true));
  await withChain({ supported: ["0x0000000000000000000000000000000000000001"] }, async (chain) =>
    assert.equal(await chain.canEstimateGas(), false),
  );
});
