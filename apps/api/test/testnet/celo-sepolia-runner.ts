/*
 * FULL ExecutionRunner validation on Celo Sepolia (chain 11142220) through a self-hosted Alto bundler.
 * TESTNET ONLY. Not part of `pnpm test` (it is not a *.test.ts file); run explicitly:
 *
 *   KAADA_HARNESS_STATE=<state.json> node --import tsx test/testnet/celo-sepolia-runner.ts [scenario...]
 *
 * What is REAL: the production ExecutionRunner, ValidatedExecutionSigner, RootActionService, preparation and
 * firm-quote services, the Neon database, the Kernel account on Sepolia, the passkey verification, the
 * permission install and read-back, the bounded approval, the swap + payout UserOperation, the Alto bundler.
 * What is SUBSTITUTED: the provider (no Textile: a fake firm quote and a fake order status), the two ERC-20s
 * and the swap contract (testnet fixtures), and the CHAIN-READ PORTS (the production readers refuse any chain
 * but Celo mainnet, so the runner is given Sepolia-backed readers behind the same Kaada ports). The database
 * keeps the LOGICAL chain id 42220 for the wallet and quote; only the transport is Sepolia.
 *
 * No direct handleOps. No mainnet. No Textile.
 */
import { createHash, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";

import { celoSepoliaKernelNetwork, createZeroDevKernelAdapter } from "@kaada/blockchain";
import { createDatabase, createRepositories, withTransaction } from "@kaada/database";
import type { Database, Repositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  KaadaError,
  SecretValue,
  createAssetRegistry,
  createId,
  createMoney,
} from "@kaada/domain";
import type {
  AccountCall,
  FirmQuoteProvider,
  FirmQuoteRequest,
  KernelExecutionPort,
  ProviderOrderPort,
  Wallet,
} from "@kaada/domain";

import { PaymentAuthorizationService } from "../../src/core/authorization/payment-authorization-service.js";
import { TransactionPinService } from "../../src/core/authorization/pin-service.js";
import { AuthorizationPolicyService } from "../../src/core/authorization/policy-service.js";
import { AuthorizationSessionService } from "../../src/core/authorization/session-service.js";
import { AccountReadinessService } from "../../src/core/execution/account-readiness.js";
import { FirmQuoteService } from "../../src/core/execution/firm-quote-service.js";
import { ExecutionPreparationService } from "../../src/core/execution/preparation-service.js";
import type { ChainState } from "../../src/core/execution/ports.js";
import type { ExecutionUnitOfWork } from "../../src/core/execution/ports.js";
import { RootActionService } from "../../src/core/execution/root-action-service.js";
import { DeviceKeyRootAdapter, PasskeyRootAdapter } from "../../src/core/roots/adapters.js";
import { RootAdapters, RootCredentialService } from "../../src/core/roots/root-credentials.js";
import { ExecutionRunner } from "../../src/core/execution/runner.js";
import { ValidatedExecutionSigner } from "../../src/core/execution/validated-signer.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";
import { SimpleWebAuthnVerifier } from "../../src/infrastructure/wallet/simplewebauthn-verifier.js";
import { TestPinHasher } from "../support/payment-world.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org";
const RP_ID = "harness.kaada.test";
const ORIGIN = "https://harness.kaada.test";
const PIN = "735142";
const KEY = randomBytes(32).toString("base64");
const BUY_AMOUNT = 100n * 10n ** 18n; // 100 tBRL, exact output
const TAKER_PAYS = 20_000_000n; // 20 tUSDT
const log = (...parts: unknown[]) => console.log(...parts);

const statePath = process.env["KAADA_HARNESS_STATE"];
const databaseUrl = process.env["DATABASE_URL"];
const bundlerUrl = process.env["BUNDLER_URL_TESTNET"];
if (!statePath || !databaseUrl || !bundlerUrl) {
  throw new Error("KAADA_HARNESS_STATE, DATABASE_URL and BUNDLER_URL_TESTNET are required");
}
if (!/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(bundlerUrl)) {
  throw new Error("this validation expects the LOCAL Alto bundler");
}

interface HarnessState {
  wallet: string;
  validator: string;
  passkey: { privateKeyPem: string; x: string; y: string; credentialId: string; counter: number };
  fixtures: { recipient: string };
  runner: { sell: string; buy: string; swap: string };
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as HarnessState;
let assertionCounter = state.passkey.counter + 100;

// ── Sepolia-backed chain reads behind the Kaada ports ───────────────────────────────────────────
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(SEPOLIA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await response.json()) as { result: T }).result;
}
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const call = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"]);
const balanceOf = async (token: string, owner: string): Promise<bigint> =>
  BigInt(await call(token, `0x70a08231${word(owner)}`));
const allowanceOf = async (token: string, owner: string, spender: string): Promise<bigint> =>
  BigInt(await call(token, `0xdd62ed3e${word(owner)}${word(spender)}`));
const nativeOf = async (address: string): Promise<bigint> =>
  BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));

// ── a software passkey assertion over the server's challenge ────────────────────────────────────
function assertionFor(challengeHex: string): unknown {
  assertionCounter += 1;
  const authData = Buffer.concat([
    createHash("sha256").update(RP_ID).digest(),
    Buffer.from([0x05]),
    Buffer.from([
      (assertionCounter >>> 24) & 255,
      (assertionCounter >>> 16) & 255,
      (assertionCounter >>> 8) & 255,
      assertionCounter & 255,
    ]),
  ]);
  const clientData = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: Buffer.from(challengeHex.slice(2), "hex").toString("base64url"),
      origin: ORIGIN,
      crossOrigin: false,
    }),
  );
  const signature = sign(
    "sha256",
    Buffer.concat([authData, createHash("sha256").update(clientData).digest()]),
    state.passkey.privateKeyPem,
  );
  return {
    id: state.passkey.credentialId,
    rawId: state.passkey.credentialId,
    type: "public-key",
    response: {
      authenticatorData: authData.toString("base64url"),
      clientDataJSON: clientData.toString("base64url"),
      signature: signature.toString("base64url"),
    },
    clientExtensionResults: {},
  };
}

// ── fixtures: the encoded calls the fake provider hands back ────────────────────────────────────
const APPROVE = "0x095ea7b3";
const SWAP = "0x8a0ccd56"; // swap(address,uint256,address,uint256) of the MockSwap fixture

async function main(): Promise<void> {
  const database: Database = createDatabase({
    url: databaseUrl ?? "",
    poolMax: 8,
    poolTimeoutMs: 30_000,
  });
  const repositories: Repositories = createRepositories(database);
  const created = { users: [] as string[], assets: [] as string[] };
  const cipher = new AesGcmSecretCipher([{ version: 1, key: KEY }]);
  const run = createId().slice(0, 8);

  // ── spy on state transitions (the sequence the runner really takes) ───────────────────────────
  const transitions: string[] = [];
  const spy = (r: Repositories): Repositories => ({
    ...r,
    executionPlans: {
      ...r.executionPlans,
      transition: async (id, from, to, fields) => {
        const moved = await r.executionPlans.transition(id, from, to, fields);
        if (moved && transitions[transitions.length - 1] !== to) transitions.push(to);
        return moved;
      },
      acquire: async (id, now) => {
        const result = await r.executionPlans.acquire(id, now);
        transitions.push(`acquire:${result.status}`);
        return result;
      },
    },
  });
  const uow: ExecutionUnitOfWork = {
    read: spy(repositories),
    transaction: (work) =>
      withTransaction(database, (tx) => work(spy(tx)), { timeoutMs: 60_000, maxWaitMs: 30_000 }),
  };

  // ── the account's user, wallet, passkey, PIN, assets, recipient, conversation ─────────────────
  const user = await repositories.users.create({ id: createId(), username: `sepolia-${run}` });
  created.users.push(user.id);
  const mkAsset = async (symbol: string, address: string, decimals: number) => {
    const id = createId();
    await database.client.asset.create({
      data: {
        id,
        symbol: `${symbol}${run}`,
        name: `Kaada test ${symbol}`,
        kind: "USD_STABLECOIN",
        chainId: CELO_CHAIN_ID,
        contractAddress: address.toLowerCase(),
        decimals,
      },
    });
    created.assets.push(id);
    return id;
  };
  const sellId = await mkAsset("tUSDT", state.runner.sell, 6);
  const buyId = await mkAsset("tBRL", state.runner.buy, 18);
  const wallet: Wallet = await repositories.wallets.create({
    id: createId(),
    userId: user.id,
    chainId: CELO_CHAIN_ID, // LOGICAL chain id; the transport below is Sepolia
    isPrimary: true,
    type: "EMBEDDED",
    status: "ACTIVE",
    deployment: "DEPLOYED",
    address: state.wallet.toLowerCase(),
  });
  await repositories.passkeys.create({
    id: createId(),
    userId: user.id,
    credentialId: state.passkey.credentialId,
    publicKeyX: state.passkey.x,
    publicKeyY: state.passkey.y,
    rpId: RP_ID,
  });
  const recipient = await repositories.recipients.create({
    id: createId(),
    ownerUserId: user.id,
    type: "SAVED_BENEFICIARY",
    displayName: "Joao",
    isSaved: true,
    walletAddress: state.fixtures.recipient.toLowerCase(),
  });
  const conversation = await repositories.conversations.create({
    id: createId(),
    userId: user.id,
    channel: "TELEGRAM",
    status: "ACTIVE",
    externalConversationId: `sepolia-${run}`,
  });
  const textile = await repositories.providers.findBySlug("textile");
  if (!textile) throw new Error("run `pnpm db:seed` first");
  const providerId = textile.id;

  const authUow = {
    read: repositories,
    transaction: <T>(work: (r: Repositories) => Promise<T>) =>
      withTransaction(database, work, { timeoutMs: 60_000, maxWaitMs: 30_000 }),
  };
  const pins = new TransactionPinService({ unitOfWork: authUow, hasher: new TestPinHasher() });
  await pins.setPin(user.id, PIN);
  const sessions = new AuthorizationSessionService({
    unitOfWork: authUow,
    assets: createAssetRegistry(repositories.assets),
    pins,
    origin: "https://app.kaada.test",
    sessionTtlMs: 10 * 60_000,
  });
  const payments = new PaymentAuthorizationService({
    unitOfWork: authUow,
    sessions,
    pins,
    authorizationTtlMs: 15 * 60_000,
  });

  /** A new intent + route + PIN-authorized payment for the same user and wallet. */
  async function authorize() {
    const intent = await repositories.intents.create({
      id: createId(),
      userId: user.id,
      conversationId: conversation.id,
      recipientId: recipient.id,
      type: "SEND",
      status: "RESOLVED",
      missingFields: [],
      revision: 1,
      sourceAssetId: sellId,
      destinationAssetId: buyId,
      amount: { money: createMoney(BUY_AMOUNT.toString(), buyId), mode: "EXACT_OUTPUT" },
    });
    const routeId = createId();
    const quote = await repositories.quotes.create({
      id: createId(),
      intentId: intent.id,
      intentRevision: 1,
      providerId,
      input: createMoney(TAKER_PAYS.toString(), sellId),
      output: createMoney(BUY_AMOUNT.toString(), buyId),
      slippageBps: 5,
      rawProviderData: { adapter: "textile", indicative: true },
    });
    const route = await repositories.routes.createWithSteps({
      id: routeId,
      intentId: intent.id,
      intentRevision: 1,
      status: "VALID",
      input: createMoney(TAKER_PAYS.toString(), sellId),
      output: createMoney(BUY_AMOUNT.toString(), buyId),
      steps: [
        {
          id: createId(),
          routeId,
          position: 0,
          type: "SWAP",
          input: createMoney(TAKER_PAYS.toString(), sellId),
          output: createMoney(BUY_AMOUNT.toString(), buyId),
          providerId,
          quoteId: quote.id,
        },
      ],
    });
    const { sessionId } = await sessions.begin(repositories, {
      userId: user.id,
      walletId: wallet.id,
      intentId: intent.id,
      intentRevision: 1,
      routeId: route.id,
    });
    const { token } = await sessions.issueLink({ sessionId, userId: user.id });
    const result = await payments.authorize(token, PIN);
    if (result.status !== "AUTHORIZED") throw new Error(`PIN not accepted: ${result.status}`);
    return result.authorization;
  }

  // ── chain ports (Sepolia) and the substituted providers ───────────────────────────────────────
  const chain: ChainState = {
    allowances: {
      readAllowance: ({ token, owner, spender }) => allowanceOf(token, owner, spender),
    },
    balances: {
      balancesOf: async (address, ids) => {
        const out = new Map<string, bigint>();
        for (const id of ids) {
          const asset = await repositories.assets.findById(id);
          if (asset?.contractAddress) out.set(id, await balanceOf(asset.contractAddress, address));
        }
        return out;
      },
    },
    isDeployed: async ({ address }) =>
      ((await rpc<string>("eth_getCode", [address, "latest"])) ?? "0x") !== "0x",
  };

  class FakeFirmProvider implements FirmQuoteProvider {
    readonly id = "textile";
    calls = 0;
    requestFirm(request: FirmQuoteRequest) {
      this.calls += 1;
      const sell = request.sellToken.toLowerCase();
      const buy = request.buyToken.toLowerCase();
      const swapData = `${SWAP}${word(sell)}${word(TAKER_PAYS.toString(16))}${word(buy)}${word(BUY_AMOUNT.toString(16))}`;
      return Promise.resolve({
        status: "QUOTED" as const,
        quote: {
          provider: "textile",
          providerQuoteId: `rfq_testnet_${randomBytes(6).toString("hex")}`,
          chainId: request.chainId,
          input: createMoney(TAKER_PAYS.toString(), request.sellAssetId),
          output: createMoney(request.exactAmount, request.buyAssetId),
          fee: createMoney("1000", request.sellAssetId),
          expiresAt: new Date(Date.now() + 4 * 60_000),
          orderDeadline: new Date(Date.now() + 4.5 * 60_000),
          latestOrderDeadline: new Date(Date.now() + 6 * 60_000),
          reactor: state.runner.swap,
          taker: request.taker.toLowerCase(),
          executionReference: "rfq",
          indicative: false as const,
        },
        transactions: {
          approval: {
            to: sell,
            data: `${APPROVE}${word(state.runner.swap)}${word(TAKER_PAYS.toString(16))}`,
            value: "0",
            chainId: request.chainId,
          },
          swap: {
            to: state.runner.swap.toLowerCase(),
            data: swapData,
            value: "0",
            chainId: request.chainId,
          },
        },
        claimToken: new SecretValue("rfqc_TESTNET_FIXTURE_TOKEN_not_a_real_provider_credential"),
      });
    }
  }

  class FakeOrders implements ProviderOrderPort {
    readonly id = "textile";
    submits = 0;
    submit() {
      this.submits += 1;
      return Promise.resolve({ state: "SUBMITTED" as const });
    }
    status() {
      return Promise.resolve({ state: "FILLED" as const });
    }
  }

  const wallets = {
    getWallet: (userId: string): Promise<Wallet | null> =>
      repositories.wallets.findEmbedded(userId, CELO_CHAIN_ID),
  };
  const realKernel = createZeroDevKernelAdapter({
    bundlerUrl: bundlerUrl ?? "",
    rpcUrl: SEPOLIA_RPC,
    network: celoSepoliaKernelNetwork(state.validator as `0x${string}`),
  });
  const infrastructure = { rpcConfigured: true, bundlerConfigured: true };

  // The real adapter, with the bundler's one-line reason printed when it refuses (the production signer
  // deliberately records only the code).
  const kernelBase: KernelExecutionPort = {
    isDeployed: (address) => realKernel.isDeployed(address),
    nativeBalance: (address) => realKernel.nativeBalance(address),
    prepareRootOperation: (input) => realKernel.prepareRootOperation(input),
    sendRootOperation: (input) => realKernel.sendRootOperation(input),
    isPermissionInstalled: (input) => realKernel.isPermissionInstalled(input),
    getUserOperationReceipt: (hash) => realKernel.getUserOperationReceipt(hash),
    getTransactionReceipt: (hash) => realKernel.getTransactionReceipt(hash),
    sendDelegatedCalls: async (input) => {
      try {
        return await realKernel.sendDelegatedCalls(input);
      } catch (error) {
        const details = error instanceof KaadaError ? JSON.stringify(error.details) : String(error);
        log("   [bundler refused/failed a delegated send]", details);
        throw error;
      }
    },
  };

  /** One full set of production services over a kernel port (a "process"). */
  function buildProcess(kernel: KernelExecutionPort) {
    const provider = new FakeFirmProvider();
    const firmQuotes = new FirmQuoteService({
      unitOfWork: uow,
      provider,
      cipher,
      chain,
      maxOutstanding: 4,
      requestTimeoutMs: 75_000,
    });
    const preparation = new ExecutionPreparationService({
      unitOfWork: uow,
      firmQuotes,
      policy: new AuthorizationPolicyService({ unitOfWork: authUow }),
      readiness: new AccountReadinessService({ repositories: uow.read, chain, infrastructure }),
      chain,
      wallets,
      minWindowMs: 12_000,
    });
    const orders = new FakeOrders();
    const signer = new ValidatedExecutionSigner({
      unitOfWork: uow,
      wallets,
      kernel,
      cipher,
      chain,
      minWindowMs: 5_000,
      infrastructure,
    });
    const rootActions = new RootActionService({
      unitOfWork: uow,
      kernel,
      cipher,
      wallets: {
        getWallet: wallets.getWallet,
        createDelegatedPermission: (request) =>
          uow.read.delegatedPermissions.create({
            id: createId(),
            userId: request.userId,
            walletId: request.walletId,
            provider: "zerodev-kernel-v3.3",
            chainId: request.chainId,
            status: "PENDING",
            allowedOperations: request.allowedOperations,
            allowedContracts: request.allowedContracts,
            allowedAssetIds: request.allowedAssetIds,
            perTransactionLimit: request.perTransactionLimit,
            enforcement: {
              contracts: "ONCHAIN",
              operations: "ONCHAIN",
              assets: "ONCHAIN",
              perTransactionLimit: "ONCHAIN",
              cumulativeLimit: "KAADA_POLICY",
              validity: "ONCHAIN",
            },
            validFrom: request.validFrom,
            expiresAt: request.expiresAt,
          }),
      },
      roots: new RootCredentialService({ repositories: uow.read, rpId: RP_ID }),
      adapters: new RootAdapters(
        new PasskeyRootAdapter({
          verifier: new SimpleWebAuthnVerifier(),
          passkeys: uow.read.passkeys,
          rpId: RP_ID,
          origin: ORIGIN,
        }),
        new DeviceKeyRootAdapter(),
      ),
      onChainId: 11142220,
      origin: ORIGIN,
    });
    const runner = new ExecutionRunner({
      unitOfWork: uow,
      preparation,
      wallets,
      kernel,
      orders,
      cipher,
      chain,
      signer,
      rootActions,
      minWindowMs: 5_000,
      minNativeWei: 10n ** 15n,
      infrastructure,
      poll: { intervalMs: 2_000, maxWaitMs: 90_000 },
    });
    return { preparation, runner, rootActions, orders, provider };
  }

  const snapshot = async () => ({
    recipientBuy: await balanceOf(state.runner.buy, state.fixtures.recipient),
    walletSell: await balanceOf(state.runner.sell, state.wallet),
    walletBuy: await balanceOf(state.runner.buy, state.wallet),
    allowance: await allowanceOf(state.runner.sell, state.wallet, state.runner.swap),
    native: await nativeOf(state.wallet),
  });
  const rows = async (executionId: string) =>
    (
      await database.client.transaction.findMany({
        where: { executionId },
        orderBy: { createdAt: "asc" },
      })
    ).map((t) => ({
      step: (t.idempotencyKey ?? "").split(":").pop(),
      type: t.type,
      status: t.status,
      userOpHash: t.userOpHash ? `${t.userOpHash.slice(0, 10)}…` : null,
      txHash: t.hash ? `${t.hash.slice(0, 10)}…` : null,
      failure: t.failureCode,
    }));
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const settle = () => wait(10_000); // public RPC nodes lag a block

  try {
    // ── scenarios ─────────────────────────────────────────────────────────────────────────────────
    const wanted = process.argv.slice(2);
    const want = (name: string) => wanted.length === 0 || wanted.includes(name);
    const results: Record<string, string> = {};

    async function prepare(p: ReturnType<typeof buildProcess>) {
      const authorization = await authorize();
      const prepared = await p.preparation.prepare(authorization.id);
      if (prepared.status !== "EXECUTION_READY") {
        log("authorized route:", JSON.stringify(authorization.route));
        throw new Error(`not ready: ${JSON.stringify(prepared)}`);
      }
      return { authorization, executionId: prepared.executionId };
    }
    /** If the payment needs wallet setup, performs the root action (the passkey step) first. */
    async function runWithRoot(p: ReturnType<typeof buildProcess>, executionId: string) {
      const first = await p.runner.run(executionId);
      if (first.status !== "ROOT_ACTION_REQUIRED") return first; // this run already executed the payment
      const pending = await repositories.rootActions.findPendingByExecution(executionId);
      if (!pending) throw new Error("no pending root action");
      const link = await p.rootActions.issueLink({ sessionId: pending.id, userId: user.id });
      await p.rootActions.complete(link.url.split("/").at(-1) ?? "", {
        type: "PASSKEY",
        assertion: assertionFor(pending.challenge),
      });
      // The run that EXECUTES the payment is the next one; its outcome is what the caller observes.
      return p.runner.run(executionId);
    }
    const authStatus = async (id: string) =>
      (await repositories.paymentAuthorizations.findById(id))?.status;

    // S1 ── normal successful run, through a root action
    if (want("normal")) {
      log("\n=== S1: normal run (root action, approval, swap + payout, settlement) ===");
      const p = buildProcess(kernelBase);
      const { authorization, executionId } = await prepare(p);
      transitions.length = 0;
      const before = await snapshot();
      const first = await p.runner.run(executionId);
      log(
        "run #1 ->",
        first.status,
        "| execution:",
        (await repositories.executionPlans.findById(executionId))?.status,
        "| authorization:",
        await authStatus(authorization.id),
      );
      if (first.status === "ROOT_ACTION_REQUIRED") {
        const pending = await repositories.rootActions.findPendingByExecution(executionId);
        if (!pending) throw new Error("no pending root action");
        const link = await p.rootActions.issueLink({ sessionId: pending.id, userId: user.id });
        const token = link.url.split("/").at(-1) ?? "";
        const options = await p.rootActions.options(token);
        log(
          "root-action page options: challenge is the UserOperation hash:",
          options.type === "PASSKEY" && options.options.challenge.length > 0,
        );
        const accepted = await p.rootActions.complete(token, {
          type: "PASSKEY",
          assertion: assertionFor(pending.challenge),
        });
        log(
          "root action sent through Alto; userOpHash == signed challenge:",
          accepted.userOpHash.toLowerCase() === pending.challenge.toLowerCase(),
        );
      }
      const startedAt = Date.now();
      const second = await p.runner.run(executionId);
      log("run #2 ->", second.status, `(${Math.round((Date.now() - startedAt) / 1000)}s)`);
      await settle();
      const after = await snapshot();
      const record = await repositories.executionPlans.findById(executionId);
      const authAfter = await repositories.paymentAuthorizations.findById(authorization.id);
      const txs = await database.client.transaction.findMany({
        where: { executionId },
        orderBy: { createdAt: "asc" },
      });
      log("transitions:", transitions.join(" -> "));
      log("transactions:", JSON.stringify(await rows(executionId)));
      log(
        "recipient tBRL delta:",
        (after.recipientBuy - before.recipientBuy).toString(),
        "(expected",
        BUY_AMOUNT.toString() + ")",
      );
      log(
        "wallet tUSDT delta:",
        (after.walletSell - before.walletSell).toString(),
        "(expected -" + TAKER_PAYS.toString() + ")",
      );
      log(
        "allowance after:",
        after.allowance.toString(),
        "(the swap consumed the bounded approval)",
      );
      const consumed = authAfter?.consumedAt?.getTime() ?? 0;
      const rootTx = txs.find((t) => t.type === "PERMISSION_INSTALL");
      const firstPayment = txs.find((t) => t.type === "APPROVAL" || t.type === "SWAP");
      log(
        "authorization status:",
        authAfter?.status,
        "| consumed AFTER the root action:",
        rootTx ? consumed >= rootTx.createdAt.getTime() : "n/a",
        "| consumed BEFORE the first payment tx row:",
        firstPayment ? consumed <= firstPayment.createdAt.getTime() : "n/a",
      );
      log(
        "record:",
        record?.status,
        "| failure:",
        record?.failureCode,
        "| settled amounts:",
        record?.settledInputAmount,
        record?.settledOutputAmount,
        "| claim tombstoned:",
        Boolean(record?.claimTombstonedAt),
        "| provider submits:",
        p.orders.submits,
      );
      results["normal"] =
        second.status === "PAYMENT_SENT" && after.recipientBuy - before.recipientBuy === BUY_AMOUNT
          ? "PASS"
          : "FAIL";
    }

    // S2 ── racing runners on a fresh payment (permission reused: no root action)
    if (want("race")) {
      log("\n=== S2: racing runners (3 concurrent calls on 2 separate 'processes') ===");
      const a = buildProcess(kernelBase);
      const b = buildProcess(kernelBase);
      const { authorization, executionId } = await prepare(a);
      transitions.length = 0;
      const before = await snapshot();
      const outcomes = await Promise.all([
        a.runner.run(executionId),
        b.runner.run(executionId),
        a.runner.run(executionId),
      ]);
      log("outcomes:", outcomes.map((o) => o.status).join(", "));
      // Whatever the losers reported, the winner's work finishes; a final call reads the persisted state.
      const final = await a.runner.run(executionId);
      await settle();
      const after = await snapshot();
      const swaps = (await rows(executionId)).filter((r) => r.type === "SWAP");
      log(
        "final run ->",
        final.status,
        "| acquire results:",
        transitions.filter((t) => t.startsWith("acquire")).join(", "),
      );
      log(
        "SWAP rows:",
        swaps.length,
        "| recipient tBRL delta:",
        (after.recipientBuy - before.recipientBuy).toString(),
        "| authorization:",
        await authStatus(authorization.id),
      );
      log("transactions:", JSON.stringify(await rows(executionId)));
      results["race"] =
        swaps.length === 1 &&
        after.recipientBuy - before.recipientBuy === BUY_AMOUNT &&
        final.status === "PAYMENT_SENT"
          ? "PASS"
          : "FAIL";
    }

    // S3 ── a crash after the bundler accepted the swap, before the local record of it
    if (want("restart")) {
      log("\n=== S3: process dies right after the bundler accepts the swap UserOperation ===");
      let crashed = false;
      const crashing: KernelExecutionPort = {
        isDeployed: (a) => realKernel.isDeployed(a),
        nativeBalance: (a) => realKernel.nativeBalance(a),
        prepareRootOperation: (i) => realKernel.prepareRootOperation(i),
        sendRootOperation: (i) => realKernel.sendRootOperation(i),
        isPermissionInstalled: (i) => realKernel.isPermissionInstalled(i),
        getUserOperationReceipt: (h) => realKernel.getUserOperationReceipt(h),
        getTransactionReceipt: (h) => realKernel.getTransactionReceipt(h),
        sendDelegatedCalls: async (input) => {
          const sent = await realKernel.sendDelegatedCalls(input);
          const isSwap = input.calls.length === 2;
          if (isSwap && !crashed) {
            crashed = true;
            // The bundler HAS the operation; the process dies before it can record the hash.
            throw new Error("simulated crash after the bundler accepted the operation");
          }
          return sent;
        },
      };
      const first = buildProcess(crashing);
      const { authorization, executionId } = await prepare(first);
      transitions.length = 0;
      const before = await snapshot();
      const run1 = await runWithRoot(first, executionId);
      log(
        "run (process #1) ->",
        run1.status,
        "| execution:",
        (await repositories.executionPlans.findById(executionId))?.status,
      );
      log("transactions after the crash:", JSON.stringify(await rows(executionId)));
      await settle();
      // "Restart": brand-new services over the same database, nothing in memory.
      const second = buildProcess(kernelBase);
      const reconciled = await second.runner.reconcile();
      log("reconcile (process #2) ->", JSON.stringify(reconciled));
      const final = await second.runner.run(executionId);
      await settle();
      const after = await snapshot();
      const swaps = (await rows(executionId)).filter((r) => r.type === "SWAP");
      log(
        "final run ->",
        final.status,
        "| execution:",
        (await repositories.executionPlans.findById(executionId))?.status,
        "| authorization:",
        await authStatus(authorization.id),
      );
      log("transactions:", JSON.stringify(await rows(executionId)));
      log(
        "SWAP rows:",
        swaps.length,
        "| recipient tBRL delta:",
        (after.recipientBuy - before.recipientBuy).toString(),
        "(the payment DID execute on chain:",
        after.recipientBuy - before.recipientBuy === BUY_AMOUNT,
        ")",
      );
      results["restart"] =
        final.status === "PAYMENT_SENT" && swaps.length === 1 ? "PASS" : `CHECK (${final.status})`;
    }

    // S4 ── the bundler refuses an operation (a call outside the permission), safely
    if (want("reject")) {
      log("\n=== S4: a known bundler rejection (a tampered spender; nothing can move) ===");
      const tampering: KernelExecutionPort = {
        isDeployed: (a) => realKernel.isDeployed(a),
        nativeBalance: (a) => realKernel.nativeBalance(a),
        prepareRootOperation: (i) => realKernel.prepareRootOperation(i),
        sendRootOperation: (i) => realKernel.sendRootOperation(i),
        isPermissionInstalled: (i) => realKernel.isPermissionInstalled(i),
        getUserOperationReceipt: (h) => realKernel.getUserOperationReceipt(h),
        getTransactionReceipt: (h) => realKernel.getTransactionReceipt(h),
        sendDelegatedCalls: (input) => {
          const calls: AccountCall[] = input.calls.map((c) =>
            c.data.startsWith(APPROVE)
              ? {
                  ...c,
                  data: `${APPROVE}${word("0x000000000000000000000000000000000000dEaD")}${c.data.slice(10 + 64)}`,
                }
              : c,
          );
          return realKernel.sendDelegatedCalls({ ...input, calls });
        },
      };
      const p = buildProcess(tampering);
      const { authorization, executionId } = await prepare(p);
      const before = await snapshot();
      const outcome = await runWithRoot(p, executionId);
      log(
        "run ->",
        outcome.status,
        JSON.stringify(outcome),
        "| authorization:",
        await authStatus(authorization.id),
      );
      const again = await p.runner.run(executionId);
      await settle();
      const after = await snapshot();
      log("run again ->", again.status, "| transactions:", JSON.stringify(await rows(executionId)));
      log(
        "funds moved:",
        after.recipientBuy !== before.recipientBuy || after.walletSell !== before.walletSell,
      );
      results["reject"] =
        outcome.status === "PAYMENT_FAILED" && after.recipientBuy === before.recipientBuy
          ? "PASS"
          : "FAIL";
    }

    log("\nRESULTS", JSON.stringify(results));
  } finally {
    // ── cleanup of everything this run created (assets last: they are referenced) ─────────────────
    const userIds = { in: created.users };
    const intents = (
      await database.client.intent.findMany({ where: { userId: userIds }, select: { id: true } })
    ).map((r) => r.id);
    const owned = { intentId: { in: intents } };
    await database.client.transaction.deleteMany({ where: { execution: { userId: userIds } } });
    await database.client.rootActionSession.deleteMany({ where: { userId: userIds } });
    await database.client.auditEvent.deleteMany({ where: { userId: userIds } });
    await database.client.execution.deleteMany({ where: { userId: userIds } });
    await database.client.firmQuoteAttempt.deleteMany({ where: { userId: userIds } });
    await database.client.delegatedPermission.deleteMany({ where: { userId: userIds } });
    await database.client.paymentAuthorization.deleteMany({ where: owned });
    await database.client.authorizationSession.deleteMany({ where: owned });
    await database.client.routeStep.deleteMany({ where: { route: owned } });
    await database.client.route.deleteMany({ where: owned });
    await database.client.quote.deleteMany({ where: owned });
    await database.client.intent.deleteMany({ where: { userId: userIds } });
    await database.client.recipient.deleteMany({ where: { ownerUserId: userIds } });
    await database.client.conversation.deleteMany({ where: { userId: userIds } });
    await database.client.transactionPinSecurity.deleteMany({ where: { userId: userIds } });
    await database.client.passkeyCredential.deleteMany({ where: { userId: userIds } });
    await database.client.auditEvent.deleteMany({ where: { userId: userIds } });
    await database.client.wallet.deleteMany({ where: { userId: userIds } });
    await database.client.user.deleteMany({ where: { id: userIds } });
    await database.client.executionSecret.deleteMany({
      where: {
        firmQuoteAttempts: { none: {} },
        purpose: { in: ["SESSION_KEY", "PERMISSION_APPROVAL", "TEXTILE_CLAIM_TOKEN"] },
      },
    });
    await database.client.asset.deleteMany({ where: { id: { in: created.assets } } });
  }
  await database.close();
}

await main().catch((error: unknown) => {
  console.error(error instanceof KaadaError ? `${error.code}: ${error.message}` : error);
  process.exitCode = 1;
});
