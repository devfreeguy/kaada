/*
 * OPERATOR TOOL (not part of the application: nothing imports it). Registers the platform wallet as an ERC-8004 agent on Celo
 * mainnet: calls `register(agentURI)` on the Identity Registry through PlatformWallet.send (so the call carries the attribution tag).
 * A DRY RUN unless --send is given.
 *
 *   tsx register-agent-identity.ts                 dry run: checks everything, prints the plan, sends nothing
 *   tsx register-agent-identity.ts --send          registers, reads the agent ID from the Registered event, reads the URI back
 *   tsx register-agent-identity.ts --uri <https>   a different registration file URL (default: DEFAULT_AGENT_URI)
 *
 * Settings (environment): PLATFORM_WALLET_ADDRESS (required), PLATFORM_WALLET_KEY_FILE (default /run/secrets/platform-agent.key),
 * CELO_RPC_URL (default: the public Forno endpoint). The key is read only from that file, by PlatformWallet, and never printed.
 *
 * Before anything is signed it proves, on this run: the registry has code and is the Identity Registry; the URI returns Kaada's
 * registration file over HTTPS right now; the wallet owns no identity yet (it is never registered twice); `register` simulates
 * (both as plain calldata and as the TAGGED calldata that is actually sent); the worst-case gas cost is under 0.1 CELO and the
 * balance covers it (src/platform/agent-identity.ts).
 */
import { fileURLToPath } from "node:url";

import { createPublicClient, encodeFunctionData, formatEther, http, parseEventLogs } from "viem";
import { celo } from "viem/chains";

import {
  DEFAULT_AGENT_URI,
  IDENTITY_REGISTRY,
  REGISTRY_CHAIN_ID,
  assertRegistrationLimits,
  fetchRegistrationFile,
  identityRegistryAbi,
  readWithRetry,
  registrationCostWei,
} from "./src/platform/agent-identity.js";
import { PlatformWallet } from "./src/platform/platform-wallet.js";

const args = process.argv.slice(2);
const send = args.includes("--send");
const uriAt = args.indexOf("--uri");
const uri = uriAt === -1 ? DEFAULT_AGENT_URI : (args[uriAt + 1] ?? "");
const known = new Set(["--send", "--uri", ...(uriAt === -1 ? [] : [uri])]);
if (args.some((arg) => !known.has(arg)) || (uriAt !== -1 && uri === "")) {
  console.error("usage: tsx register-agent-identity.ts [--send] [--uri <https url>]");
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

  const chainId = await client.getChainId();
  if (chainId !== REGISTRY_CHAIN_ID)
    throw new Error(`refusing: the RPC is chain ${chainId}, not Celo mainnet ${REGISTRY_CHAIN_ID}`);
  const [code, registryName] = await Promise.all([
    client.getCode({ address: IDENTITY_REGISTRY }),
    client
      .readContract({ address: IDENTITY_REGISTRY, abi: identityRegistryAbi, functionName: "name" })
      .catch(() => undefined),
  ]);
  if (!code || code === "0x")
    throw new Error(`refusing: ${IDENTITY_REGISTRY} has no code on Celo mainnet`);
  if (registryName !== "AgentIdentity")
    throw new Error(
      `refusing: ${IDENTITY_REGISTRY} answers name() with ${String(registryName)}, not AgentIdentity`,
    );

  const file = await fetchRegistrationFile(uri, wallet.address);

  const owned = await client.readContract({
    address: IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: "balanceOf",
    args: [wallet.address],
  });

  // The calldata that is really sent: `register(uri)` with the attribution tag after it. Simulate both forms.
  const data = encodeFunctionData({
    abi: identityRegistryAbi,
    functionName: "register",
    args: [uri],
  });
  const prepared = wallet.prepare({ to: IDENTITY_REGISTRY, data });
  const simulated = await client.simulateContract({
    account: wallet.address,
    address: IDENTITY_REGISTRY,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [uri],
  });
  const taggedCall = await client.call({
    account: wallet.address,
    to: prepared.to,
    data: prepared.data,
  });
  if (taggedCall.data === undefined) throw new Error("refusing: the tagged call returned nothing");
  const [gas, fees, balance] = await Promise.all([
    client.estimateGas({ account: wallet.address, ...prepared }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: wallet.address }),
  ]);
  const plan = { wallet: wallet.address, owned, gas, maxFeePerGas: fees.maxFeePerGas, balance };

  console.log(`mode:        ${send ? "SEND" : "dry run (nothing is sent)"}`);
  console.log(
    `registry:    ${IDENTITY_REGISTRY} (code ${(code.length - 2) / 2} bytes, name() = ${registryName})`,
  );
  console.log(`wallet:      ${wallet.address}`);
  console.log(`uri:         ${uri}`);
  console.log(
    `file:        ok: "${file.name}", ${file.services.length} services, ${file.registrations.length} registrations`,
  );
  console.log(`identities already owned by the wallet: ${owned}`);
  console.log(
    `simulate:    register(uri) would return agentId ${simulated.result} (plain and tagged calldata both succeed)`,
  );
  console.log(`gas:         ${gas}`);
  console.log(
    `cost:        at most ${formatEther(registrationCostWei(plan))} CELO (gas x maxFeePerGas ${fees.maxFeePerGas} wei)`,
  );
  console.log(`balance:     ${formatEther(balance)} CELO`);

  assertRegistrationLimits(plan);
  if (!send) {
    console.log("limits ok. Dry run: stopping. Pass --send to register.");
    process.exit(0);
  }

  const { txHash } = await wallet.send({ to: IDENTITY_REGISTRY, data });
  console.log(`sent:        ${txHash}`);
  console.log(`celoscan:    https://celoscan.io/tx/${txHash}`);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success")
    throw new Error(`the registration REVERTED in block ${receipt.blockNumber}`);

  const [registered] = parseEventLogs({
    abi: identityRegistryAbi,
    eventName: "Registered",
    logs: receipt.logs.filter(
      (log) => log.address.toLowerCase() === IDENTITY_REGISTRY.toLowerCase(),
    ),
  }).filter((log) => log.args.owner.toLowerCase() === wallet.address.toLowerCase());
  if (!registered) throw new Error("the receipt has no Registered event for this wallet");
  const agentId = registered.args.agentId;
  console.log(`agent ID:    ${agentId}`);
  console.log(`identity:    https://celoscan.io/nft/${IDENTITY_REGISTRY}/${agentId}`);

  // The transaction has succeeded: a read that the node cannot answer yet is reported, never an abort.
  const [stored, owner] = await Promise.all([
    readWithRetry(() =>
      client.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: "tokenURI",
        args: [agentId],
      }),
    ),
    readWithRetry(() =>
      client.readContract({
        address: IDENTITY_REGISTRY,
        abi: identityRegistryAbi,
        functionName: "ownerOf",
        args: [agentId],
      }),
    ),
  ]);
  if (stored === undefined || owner === undefined) {
    console.log(
      `read back:   read-back not available yet (the registration itself succeeded: see the Celoscan links above). Read tokenURI(${agentId}) and ownerOf(${agentId}) on the registry again in a minute.`,
    );
  } else {
    console.log(`read back:   tokenURI = ${stored}`);
    console.log(
      `uri matches: ${stored === uri ? "yes" : "NO"}   owner is the wallet: ${owner.toLowerCase() === wallet.address.toLowerCase() ? "yes" : "NO"}`,
    );
  }
  console.log(
    `next: add {"agentId": ${agentId}, "agentRegistry": "eip155:${REGISTRY_CHAIN_ID}:${IDENTITY_REGISTRY}"} to "registrations" in the registration file and deploy the website (the URI itself does not change).`,
  );
} catch (error) {
  // Only the message: the wallet's errors name public addresses and paths, never the key.
  console.error(`aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
