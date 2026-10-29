/*
 * OPERATOR TOOL (not part of the application: nothing imports it). Sends ONE attribution-tagged transaction from the platform
 * wallet to ITSELF, value 0, through PlatformWallet.send. A DRY RUN unless --send is given.
 *
 *   tsx send-tagged-self.ts            dry run: prints the plan, sends nothing
 *   tsx send-tagged-self.ts --send     sends, waits for the receipt, checks the tag at the end of the input
 *
 * Settings (environment): PLATFORM_WALLET_ADDRESS (required, the public address the key must derive to),
 * PLATFORM_WALLET_KEY_FILE (default /run/secrets/platform-agent.key), CELO_RPC_URL (default: the public Forno endpoint).
 * The key is read only from that file, by PlatformWallet, and is never printed.
 *
 * Hard limits (src/platform/self-tag-limits.ts): the recipient is the wallet's own address, the value is 0, the worst-case gas
 * cost is under 0.02 CELO, and the balance must cover it. Anything else aborts before anything is signed.
 */
import { fileURLToPath } from "node:url";

import { createPublicClient, formatEther, http } from "viem";
import { celo } from "viem/chains";

import { PlatformWallet } from "./src/platform/platform-wallet.js";
import {
  assertSelfTagLimits,
  endsWithAttribution,
  planCostWei,
} from "./src/platform/self-tag-limits.js";

const args = process.argv.slice(2);
const send = args.includes("--send");
if (args.some((arg) => arg !== "--send")) {
  console.error(
    "usage: tsx send-tagged-self.ts [--send]   (no other argument: the recipient is always the wallet itself)",
  );
  process.exit(2);
}

try {
  const address = process.env["PLATFORM_WALLET_ADDRESS"];
  if (!address) throw new Error("PLATFORM_WALLET_ADDRESS is not set");
  const rpcUrl = process.env["CELO_RPC_URL"];
  const wallet = PlatformWallet.load({
    keyFile: process.env["PLATFORM_WALLET_KEY_FILE"] ?? "/run/secrets/platform-agent.key",
    expectedAddress: address,
    // The checkout (this file is at packages/blockchain/): the key file must not sit anywhere under it.
    repositoryRoot: fileURLToPath(new URL("../..", import.meta.url)),
    chain: celo,
    rpcUrl,
  });
  const client = createPublicClient({ chain: celo, transport: http(rpcUrl) });

  const request = { to: wallet.address, value: 0n };
  const prepared = wallet.prepare(request);
  const [gas, fees, balance] = await Promise.all([
    client.estimateGas({ account: wallet.address, ...prepared }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: wallet.address }),
  ]);
  const plan = {
    from: wallet.address,
    to: prepared.to,
    value: prepared.value,
    gas,
    maxFeePerGas: fees.maxFeePerGas,
    balance,
  };

  console.log(`mode:      ${send ? "SEND" : "dry run (nothing is sent)"}`);
  console.log(`from:      ${plan.from}`);
  console.log(`to:        ${plan.to}`);
  console.log(`value:     ${formatEther(plan.value)} CELO`);
  console.log(`gas:       ${gas}`);
  console.log(
    `cost:      at most ${formatEther(planCostWei(plan))} CELO (gas x maxFeePerGas ${fees.maxFeePerGas} wei)`,
  );
  console.log(`balance:   ${formatEther(balance)} CELO`);
  console.log(
    `calldata:  ${(prepared.data.length - 2) / 2} bytes, last 35 bytes (the whole attribution suffix): ${prepared.data.slice(-70)}`,
  );

  assertSelfTagLimits(plan);
  if (!send) {
    console.log("limits ok. Dry run: stopping. Pass --send to send this transaction.");
    process.exit(0);
  }

  const { txHash } = await wallet.send(request);
  console.log(`sent:      ${txHash}`);
  console.log(`celoscan:  https://celoscan.io/tx/${txHash}`);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  const tx = await client.getTransaction({ hash: txHash });
  console.log(
    `receipt:   ${receipt.status === "success" ? "success" : "REVERTED"} in block ${receipt.blockNumber}`,
  );
  console.log(`tag at the very end of the input: ${endsWithAttribution(tx.input) ? "yes" : "NO"}`);
} catch (error) {
  // Only the message: the wallet's errors name public addresses and paths, never the key.
  console.error(`aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
