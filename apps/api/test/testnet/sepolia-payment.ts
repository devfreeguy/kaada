/*
 * Test-data helper for the Celo Sepolia browser validation. TESTNET ONLY.
 *
 *   node --import tsx test/testnet/sepolia-payment.ts <command> [userId]
 *   commands: assets | fund <userId> | payment <userId> | wallet <userId> | clean
 *
 * It creates only what the agent/channel would have created before the person reaches /authorize: the
 * test tokens' asset rows, a recipient, an intent, a priced route and an authorization SESSION. The link
 * itself is obtained from the running API's own development route over HTTP. Funding uses the throwaway
 * faucet-funded deployer. The PIN, passkey and every signature are the person's, in the browser.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import { CELO_CHAIN_ID, createAssetRegistry, createId, createMoney } from "@kaada/domain";
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { celoSepolia } from "viem/chains";

import { AuthorizationSessionService } from "../../src/core/authorization/session-service.js";
import { Argon2PinHasher } from "../../src/infrastructure/auth/argon2-pin-hasher.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}
const statePath = process.env["KAADA_HARNESS_STATE"] ?? "";
const databaseUrl = process.env["DATABASE_URL"] ?? "";
if (!statePath || !databaseUrl)
  throw new Error("KAADA_HARNESS_STATE and DATABASE_URL are required");
const API = (process.env["API_URL"] ?? "http://localhost:4000").replace(/\/$/, "");
const RPC = "https://forno.celo-sepolia.celo-testnet.org";

interface State {
  deployerKey: `0x${string}`;
  fixtures: { recipient: string };
  runner: { sell: string; buy: string; swap: string };
  http?: { assets?: { sell: string; buy: string }; executionKey?: string };
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const save = () => writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

const database = createDatabase({ url: databaseUrl, poolMax: 4, poolTimeoutMs: 30_000 });
const repositories = createRepositories(database);
const [command, userId] = process.argv.slice(2);

const mintAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

try {
  if (command === "assets") {
    state.http = { ...state.http };
    if (!state.http.assets) {
      const make = async (symbol: string, address: string, decimals: number) => {
        const id = createId();
        await database.client.asset.create({
          data: {
            id,
            symbol,
            name: `Kaada test ${symbol}`,
            kind: "USD_STABLECOIN",
            chainId: CELO_CHAIN_ID,
            contractAddress: address.toLowerCase(),
            decimals,
          },
        });
        return id;
      };
      state.http.assets = {
        sell: await make("tUSDTsep", state.runner.sell, 6),
        buy: await make("tBRLsep", state.runner.buy, 18),
      };
      save();
    }
    console.log("test assets:", JSON.stringify(state.http.assets));
  } else if (command === "wallet" && userId) {
    const wallet = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
    console.log(
      "wallet:",
      wallet?.address,
      "| status",
      wallet?.status,
      "| deployment",
      wallet?.deployment,
    );
  } else if (command === "fund" && userId) {
    const wallet = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
    if (!wallet?.address) throw new Error("the user has no wallet yet");
    const publicClient = createPublicClient({ chain: celoSepolia, transport: http(RPC) });
    const walletClient = createWalletClient({
      account: privateKeyToAccount(state.deployerKey),
      chain: celoSepolia,
      transport: http(RPC),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.sendTransaction({
        to: wallet.address as `0x${string}`,
        value: parseEther("0.5"),
      }),
    });
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.sendTransaction({
        to: state.runner.sell as `0x${string}`,
        data: encodeFunctionData({
          abi: mintAbi,
          functionName: "mint",
          args: [wallet.address as `0x${string}`, 1_000_000_000n],
        }),
        gas: 200_000n,
      }),
    });
    console.log("funded", wallet.address, "with 0.5 CELO and 1000 tUSDT (test token)");
  } else if (command === "payment" && userId) {
    const assets = state.http?.assets;
    if (!assets) throw new Error("run `assets` first");
    const wallet = await repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID);
    if (!wallet) throw new Error("the user has no wallet yet");
    const textile = await repositories.providers.findBySlug("textile");
    if (!textile) throw new Error("run `pnpm db:seed` first");
    const recipient = await repositories.recipients.create({
      id: createId(),
      ownerUserId: userId,
      type: "SAVED_BENEFICIARY",
      displayName: "Joao",
      isSaved: true,
      walletAddress: state.fixtures.recipient.toLowerCase(),
    });
    const conversation = await repositories.conversations.create({
      id: createId(),
      userId,
      channel: "TELEGRAM",
      status: "ACTIVE",
      externalConversationId: `sepolia-browser-${createId()}`,
    });
    const buyAmount = (100n * 10n ** 18n).toString();
    const intent = await repositories.intents.create({
      id: createId(),
      userId,
      conversationId: conversation.id,
      recipientId: recipient.id,
      type: "SEND",
      status: "RESOLVED",
      missingFields: [],
      revision: 1,
      sourceAssetId: assets.sell,
      destinationAssetId: assets.buy,
      amount: { money: createMoney(buyAmount, assets.buy), mode: "EXACT_OUTPUT" },
    });
    const quote = await repositories.quotes.create({
      id: createId(),
      intentId: intent.id,
      intentRevision: 1,
      providerId: textile.id,
      input: createMoney("20000000", assets.sell),
      output: createMoney(buyAmount, assets.buy),
      slippageBps: 5,
      rawProviderData: { adapter: "textile", indicative: true },
    });
    const routeId = createId();
    const route = await repositories.routes.createWithSteps({
      id: routeId,
      intentId: intent.id,
      intentRevision: 1,
      status: "VALID",
      input: createMoney("20000000", assets.sell),
      output: createMoney(buyAmount, assets.buy),
      steps: [
        {
          id: createId(),
          routeId,
          position: 0,
          type: "SWAP",
          input: createMoney("20000000", assets.sell),
          output: createMoney(buyAmount, assets.buy),
          providerId: textile.id,
          quoteId: quote.id,
        },
      ],
    });
    const uow = {
      read: repositories,
      transaction: <T>(work: (r: typeof repositories) => Promise<T>) =>
        withTransaction(database, work),
    };
    const pins = new TransactionPinService({ unitOfWork: uow, hasher: new Argon2PinHasher({}) });
    const sessions = new AuthorizationSessionService({
      unitOfWork: uow,
      assets: createAssetRegistry(repositories.assets),
      pins,
      origin: process.env["PASSKEY_ORIGIN"] ?? "http://localhost:3000",
      sessionTtlMs: 15 * 60_000,
    });
    const { sessionId } = await sessions.begin(repositories, {
      userId,
      walletId: wallet.id,
      intentId: intent.id,
      intentRevision: 1,
      routeId: route.id,
    });
    // The link comes from the RUNNING API's own development route, over HTTP.
    const response = await fetch(`${API}/api/v1/authorization/dev/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, userId }),
    });
    const body = (await response.json()) as { url?: string; expiresAt?: string };
    console.log(
      "authorize link (HTTP",
      response.status + "):",
      body.url,
      "| expires",
      body.expiresAt,
    );
  } else if (command === "clean") {
    const users = (
      await database.client.user.findMany({
        where: { displayName: "Dev user" },
        select: { id: true },
      })
    ).map((u) => u.id);
    const byUser = { userId: { in: users } };
    const intents = (
      await database.client.intent.findMany({ where: byUser, select: { id: true } })
    ).map((i) => i.id);
    const owned = { intentId: { in: intents } };
    await database.client.auditEvent.deleteMany({ where: byUser });
    await database.client.transaction.deleteMany({ where: { execution: byUser } });
    await database.client.rootActionSession.deleteMany({ where: byUser });
    await database.client.execution.deleteMany({ where: byUser });
    await database.client.firmQuoteAttempt.deleteMany({ where: byUser });
    await database.client.delegatedPermission.deleteMany({ where: byUser });
    await database.client.paymentAuthorization.deleteMany({ where: owned });
    await database.client.authorizationSession.deleteMany({ where: owned });
    await database.client.routeStep.deleteMany({ where: { route: owned } });
    await database.client.route.deleteMany({ where: owned });
    await database.client.quote.deleteMany({ where: owned });
    await database.client.intent.deleteMany({ where: byUser });
    await database.client.recipient.deleteMany({ where: { ownerUserId: { in: users } } });
    await database.client.conversation.deleteMany({ where: byUser });
    await database.client.transactionPinSecurity.deleteMany({ where: byUser });
    await database.client.passkeyCredential.deleteMany({ where: byUser });
    await database.client.passkeyChallenge.deleteMany({ where: byUser });
    await database.client.walletSetupSession.deleteMany({ where: byUser });
    await database.client.rootChange.deleteMany({ where: byUser });
    await database.client.walletCredential.deleteMany({ where: byUser });
    await database.client.wallet.deleteMany({ where: byUser });
    await database.client.user.deleteMany({ where: { id: { in: users } } });
    await database.client.executionSecret.deleteMany({
      where: {
        firmQuoteAttempts: { none: {} },
        purpose: { in: ["SESSION_KEY", "PERMISSION_APPROVAL", "TEXTILE_CLAIM_TOKEN"] },
      },
    });
    if (state.http?.assets) {
      await database.client.asset.deleteMany({
        where: { id: { in: [state.http.assets.sell, state.http.assets.buy] } },
      });
      delete state.http.assets;
      save();
    }
    console.log("cleaned", users.length, "dev user(s) and the test assets");
  } else {
    throw new Error("usage: assets | wallet <userId> | fund <userId> | payment <userId> | clean");
  }
} finally {
  await database.close();
}
