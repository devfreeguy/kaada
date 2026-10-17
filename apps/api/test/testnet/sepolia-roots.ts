/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- a testnet harness reading untyped JSON from its own API */
/*
 * THE ROOT-AGNOSTIC USER FLOW on Celo SEPOLIA through the REAL Kaada API and the local Alto bundler. TESTNET ONLY.
 *
 *   KAADA_HARNESS_STATE=<state.json> BUNDLER_URL_TESTNET=http://localhost:4337 \
 *     [SCENARIOS=A,B,C] node --import tsx test/testnet/sepolia-roots.ts
 *
 * It boots the production AppModule (every controller, service, repository, the real Postgres, the real Kernel/bundler adapter)
 * and replaces ONLY what is mainnet- or Textile-bound with Sepolia fixtures behind the same Kaada ports (chain reads, the
 * firm-quote and order providers: no Textile). Everything the person touches is plain HTTP, with software authenticators and
 * software P-256 device keys standing in for the person's devices.
 *
 *   A. PASSKEY root:    onboard -> 6-digit PIN -> payment 1 (root action: passkey) -> payment 2 (PIN only)
 *   B. DEVICE-KEY root: onboard -> 6-digit PIN -> payment 1 (root action: device key) -> payment 2 (PIN only)
 *   C. ROTATION:        passkey -> device key -> payment -> device key -> passkey -> payment; the address never changes
 *
 * The database keeps the LOGICAL chain id 42220; only the transport is Sepolia. No mainnet. No Textile.
 */
import "reflect-metadata";

import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Database } from "@kaada/database";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const statePath = process.env["KAADA_HARNESS_STATE"];
if (!statePath) throw new Error("KAADA_HARNESS_STATE is required");
interface State {
  deployerKey: `0x${string}`;
  validator: string;
  passkeyFactory: { address: string };
  deviceKey: { implementation: string; factory: string };
  recoveryProbe: { validator: string };
  fixtures: { recipient: string };
  runner: { sell: string; buy: string; swap: string };
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const workDir = dirname(statePath);
const SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org";
const CHAIN_ID = 11142220;
const RP_ID = "localhost";
const ORIGIN = "http://localhost:3000";
const bundlerUrl = process.env["BUNDLER_URL_TESTNET"];
if (!bundlerUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(bundlerUrl)) {
  throw new Error("BUNDLER_URL_TESTNET must point at the LOCAL Alto bundler");
}
const PIN = "735142";
const FUND_CELO = process.env["FUND_CELO"] ?? "0.25";
const want = new Set(
  (process.env["SCENARIOS"] ?? "A,B,C").split(",").map((s) => s.trim().toUpperCase()),
);

// ── keys and the outbox live next to the state file, outside the repository ──
const keyFile = (name: string, make: () => string) => {
  const path = `${workDir}/${name}`;
  if (!existsSync(path)) writeFileSync(path, make(), { mode: 0o600 });
  return path;
};
const { privateKeyToAccount } = await import("viem/accounts");
const relayerKeyFile = keyFile("recovery-relayer.key", () => state.deployerKey);
const outboxFile = `${workDir}/roots-outbox.jsonl`;
mkdirSync(workDir, { recursive: true });
writeFileSync(outboxFile, "", { mode: 0o600 });
const executionKey = randomBytes(32).toString("base64");

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}
Object.assign(process.env, {
  NODE_ENV: "development",
  WALLET_PROVIDER: "kernel",
  PASSKEY_RP_ID: RP_ID,
  PASSKEY_ORIGIN: ORIGIN,
  AGENT_INTERPRETER: "none",
  FX_PROVIDER: "none",
  EXECUTION_ENABLED: "false", // the execution pieces are provided below
  EXECUTION_SECRET_KEY: executionKey,
  LOG_LEVEL: "warn",
  PAYMENT_AUTHORIZATION_TTL_SECONDS: "600",
  DATABASE_TRANSACTION_TIMEOUT_MS: "60000",
  AUTHORIZATION_SESSION_TTL_SECONDS: "900",
  CELO_RPC_URL: SEPOLIA_RPC,
  BUNDLER_URL: bundlerUrl,
  DEVICE_KEY_ROOTS_ENABLED: "true",
  RECOVERY_ENABLED: "true", // the chain reads and the root-change service share the recovery chain adapter
  RECOVERY_CHAIN_ID: String(CHAIN_ID),
  RECOVERY_VALIDATOR_ADDRESS: state.recoveryProbe.validator,
  RECOVERY_PASSKEY_FACTORY_ADDRESS: state.passkeyFactory.address,
  RECOVERY_PASSKEY_IMPLEMENTATION_ADDRESS: state.validator,
  RECOVERY_DEVICE_FACTORY_ADDRESS: state.deviceKey.factory,
  RECOVERY_DEVICE_IMPLEMENTATION_ADDRESS: state.deviceKey.implementation,
  RECOVERY_RELAYER_KEY_FILE: relayerKeyFile,
  RECOVERY_TOTP_SECRET_KEY: randomBytes(32).toString("base64"),
  RECOVERY_CHALLENGE_SECRET: randomBytes(32).toString("base64"),
  RECOVERY_EMAIL_PROVIDER: "outbox",
  RECOVERY_EMAIL_OUTBOX_FILE: outboxFile,
  RECOVERY_DELAY_SECONDS: "25",
  RECOVERY_MIN_DELAY_SECONDS: "10",
  RECOVERY_SWEEP_INTERVAL_SECONDS: "0",
  RECOVERY_GAS_TOPUP_MAX_WEI: "300000000000000000",
});
delete process.env["TEXTILE_ENV"];

const [
  { Test },
  { FastifyAdapter },
  blockchain,
  database,
  domain,
  { AppModule },
  { configureApp },
  { APP_CONFIG },
  { DATABASE },
  viem,
  { celoSepolia },
  { createSoftwareAuthenticator },
  walletTokens,
  authorizationTokens,
  executionTokens,
  rootsTokens,
  { WalletService },
  { ExecutionPreparationService },
  { FirmQuoteService },
  { AccountReadinessService },
  { RootActionService },
  { ExecutionRunner },
  { ValidatedExecutionSigner },
  { AesGcmSecretCipher },
  { SoftDeviceKey },
  { RunTracker },
] = await Promise.all([
  import("@nestjs/testing"),
  import("@nestjs/platform-fastify"),
  import("@kaada/blockchain"),
  import("@kaada/database"),
  import("@kaada/domain"),
  import("../../src/app.module.js"),
  import("../../src/app.setup.js"),
  import("../../src/config/config.module.js"),
  import("../../src/database/database.module.js"),
  import("viem"),
  import("viem/chains"),
  import("../support/software-authenticator.js"),
  import("../../src/wallet/wallet.tokens.js"),
  import("../../src/authorization/authorization.tokens.js"),
  import("../../src/execution/execution.tokens.js"),
  import("../../src/roots/roots.tokens.js"),
  import("../../src/core/wallets/wallet-service.js"),
  import("../../src/core/execution/preparation-service.js"),
  import("../../src/core/execution/firm-quote-service.js"),
  import("../../src/core/execution/account-readiness.js"),
  import("../../src/core/execution/root-action-service.js"),
  import("../../src/core/execution/runner.js"),
  import("../../src/core/execution/validated-signer.js"),
  import("../../src/infrastructure/security/aes-gcm-cipher.js"),
  import("../support/soft-device-key.js"),
  import("../../src/core/execution/run-tracker.js"),
]);
type Hex = `0x${string}`;
type Db = Database;

const results: { name: string; pass: boolean; detail: string }[] = [];
const record = (name: string, pass: boolean, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Sepolia reads behind the Kaada ports ────────────────────────────────────────────────────────
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
const tokenBalance = async (token: string, owner: string): Promise<bigint> => {
  const raw = await call(token, `0x70a08231${word(owner)}`);
  return raw && raw !== "0x" ? BigInt(raw) : 0n;
};
const nativeBalance = async (address: string): Promise<bigint> =>
  BigInt(await rpc<string>("eth_getBalance", [address, "latest"]));
const rootOf = async (account: string): Promise<string> => {
  const raw = (await pub.readContract({
    address: account as Hex,
    abi: viem.parseAbi(["function rootValidator() view returns (bytes21)"]),
    functionName: "rootValidator",
  })) as string;
  return raw.startsWith("0x01") ? `0x${raw.slice(4)}`.toLowerCase() : raw.toLowerCase();
};

const unitOfWork = (db: Db) => ({
  read: database.createRepositories(db),
  transaction: <T>(work: (r: ReturnType<typeof database.createRepositories>) => Promise<T>) =>
    database.withTransaction(db, work),
});

function chainPorts(db: Db) {
  return {
    allowances: {
      readAllowance: async ({
        token,
        owner,
        spender,
      }: {
        token: string;
        owner: string;
        spender: string;
      }) => BigInt(await call(token, `0xdd62ed3e${word(owner)}${word(spender)}`)),
    },
    balances: {
      balancesOf: async (address: string, ids: string[]) => {
        const out = new Map<string, bigint>();
        const repositories = database.createRepositories(db);
        for (const id of ids) {
          const asset = await repositories.assets.findById(id);
          if (asset?.contractAddress)
            out.set(id, await tokenBalance(asset.contractAddress, address));
        }
        return out;
      },
    },
    isDeployed: async ({ address }: { address: string }) =>
      ((await rpc<string>("eth_getCode", [address, "latest"])) ?? "0x") !== "0x",
  };
}

// ── fakes for the provider (no Textile) ─────────────────────────────────────────────────────────
const APPROVE = "0x095ea7b3";
const SWAP = "0x8a0ccd56"; // MockSwap.swap(address,uint256,address,uint256)
const TAKER_PAYS = 20_000_000n;
const BUY_AMOUNT = 100n * 10n ** 18n;

const network = blockchain.celoSepoliaKernelNetwork(state.validator as Hex);

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(walletTokens.WALLET_SERVICE)
  .useFactory({
    inject: [DATABASE],
    factory: (db: Db) =>
      new WalletService({
        unitOfWork: unitOfWork(db),
        provisioning: new blockchain.KernelProvisioningAdapter(
          blockchain.createKernelAddressDeriver({ rpcUrl: SEPOLIA_RPC, network }),
        ),
        policy: new blockchain.KernelPolicyAdapter(),
        rpId: RP_ID,
      }),
  })
  .overrideProvider(walletTokens.BALANCE_READER)
  .useFactory({
    inject: [DATABASE],
    factory: (db: Db) => ({
      async readBalances(input: { chainId: number; address: string; assetIds: string[] }) {
        const repositories = database.createRepositories(db);
        const tokens: ReturnType<typeof domain.createMoney>[] = [];
        for (const id of input.assetIds) {
          const asset = await repositories.assets.findById(id);
          tokens.push(
            domain.createMoney(
              asset?.contractAddress
                ? (await tokenBalance(asset.contractAddress, input.address)).toString()
                : "0",
              id,
            ),
          );
        }
        return { chainId: input.chainId, address: input.address, tokens };
      },
    }),
  })
  .overrideProvider(executionTokens.RUN_TRACKER)
  .useFactory({
    factory: () =>
      new RunTracker(Date.now, (error) =>
        console.log(
          "   [run ended unexpectedly]",
          String((error as Error)?.stack ?? error).slice(0, 700),
        ),
      ),
  })
  .overrideProvider(executionTokens.KERNEL_EXECUTION_PORT)
  .useFactory({
    factory: () =>
      blockchain.createZeroDevKernelAdapter({ bundlerUrl, rpcUrl: SEPOLIA_RPC, network }),
  })
  .overrideProvider(executionTokens.ROOT_ACTION_SERVICE)
  .useFactory({
    inject: [
      DATABASE,
      APP_CONFIG,
      walletTokens.WALLET_SERVICE,
      executionTokens.KERNEL_EXECUTION_PORT,
      rootsTokens.ROOT_CREDENTIAL_SERVICE,
      rootsTokens.ROOT_ADAPTERS,
      rootsTokens.ROOT_VALIDATOR_DEPLOYER,
    ],
    factory: (
      db: Db,
      config: any,
      wallets: any,
      kernel: any,
      roots: any,
      adapters: any,
      validators: any,
    ) =>
      new RootActionService({
        unitOfWork: unitOfWork(db),
        kernel,
        cipher: new AesGcmSecretCipher(config.execution.cipherKeys),
        wallets,
        roots,
        adapters,
        onChainId: CHAIN_ID,
        validators,
        origin: ORIGIN,
      }),
  })
  .overrideProvider(executionTokens.EXECUTION_PREPARATION_SERVICE)
  .useFactory({
    inject: [
      DATABASE,
      APP_CONFIG,
      walletTokens.WALLET_SERVICE,
      authorizationTokens.AUTHORIZATION_POLICY_SERVICE,
    ],
    factory: (db: Db, config: any, wallets: any, policy: any) => {
      const uow = unitOfWork(db) as never;
      const chain = chainPorts(db);
      const provider = {
        id: "textile",
        requestFirm(request: import("@kaada/domain").FirmQuoteRequest) {
          const sell = request.sellToken.toLowerCase();
          const buy = request.buyToken.toLowerCase();
          const swapData = `${SWAP}${word(sell)}${word(TAKER_PAYS.toString(16))}${word(buy)}${word(BigInt(request.exactAmount).toString(16))}`;
          return Promise.resolve({
            status: "QUOTED" as const,
            quote: {
              provider: "textile",
              providerQuoteId: `rfq_testnet_${randomBytes(6).toString("hex")}`,
              chainId: request.chainId,
              input: domain.createMoney(TAKER_PAYS.toString(), request.sellAssetId),
              output: domain.createMoney(request.exactAmount, request.buyAssetId),
              fee: domain.createMoney("1000", request.sellAssetId),
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
            claimToken: new domain.SecretValue(
              "rfqc_TESTNET_FIXTURE_TOKEN_not_a_real_provider_credential",
            ),
          });
        },
      };
      const cipher = new AesGcmSecretCipher(config.execution.cipherKeys);
      const infrastructure = { rpcConfigured: true, bundlerConfigured: true };
      return new ExecutionPreparationService({
        unitOfWork: uow,
        firmQuotes: new FirmQuoteService({
          unitOfWork: uow,
          provider,
          cipher,
          chain,
          maxOutstanding: 4,
          requestTimeoutMs: 75_000,
        }),
        policy,
        readiness: new AccountReadinessService({
          repositories: (uow as { read: never }).read,
          chain,
          infrastructure,
        }),
        chain,
        wallets,
        minWindowMs: config.execution.minFirmWindowMs,
      });
    },
  })
  .overrideProvider(executionTokens.EXECUTION_RUNNER)
  .useFactory({
    inject: [
      DATABASE,
      APP_CONFIG,
      walletTokens.WALLET_SERVICE,
      executionTokens.EXECUTION_PREPARATION_SERVICE,
      executionTokens.KERNEL_EXECUTION_PORT,
      executionTokens.ROOT_ACTION_SERVICE,
    ],
    factory: (
      db: Db,
      config: any,
      wallets: any,
      preparation: any,
      kernel: any,
      rootActions: any,
    ) => {
      const uow = unitOfWork(db) as never;
      const chain = chainPorts(db);
      const cipher = new AesGcmSecretCipher(config.execution.cipherKeys);
      const infrastructure = { rpcConfigured: true, bundlerConfigured: true };
      const orders = {
        id: "textile",
        submit: () => Promise.resolve({ state: "SUBMITTED" as const }),
        status: () => Promise.resolve({ state: "FILLED" as const }),
      };
      return new ExecutionRunner({
        unitOfWork: uow,
        preparation,
        wallets,
        kernel,
        orders,
        cipher,
        chain,
        signer: new ValidatedExecutionSigner({
          unitOfWork: uow,
          wallets,
          kernel,
          cipher,
          chain,
          minWindowMs: 5_000,
          infrastructure,
        }),
        rootActions,
        minWindowMs: 5_000,
        minNativeWei: config.execution.minNativeWei,
        infrastructure,
        poll: { intervalMs: 2_000, maxWaitMs: 90_000 },
      });
    },
  })
  .compile();

const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
configureApp(app, moduleRef.get(APP_CONFIG));
await app.init();
await app.listen(0, "127.0.0.1");
const baseUrl = (await app.getUrl()).replace("[::1]", "127.0.0.1");
const db = moduleRef.get<Db>(DATABASE);
const repos = database.createRepositories(db);
console.log("API listening at", baseUrl);

// ── HTTP as the person's browser would speak it ─────────────────────────────────────────────────
interface Reply {
  status: number;
  body: any;
}
async function api(
  method: "GET" | "POST",
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Reply> {
  const response = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, body };
}
const tokenOf = (url: string) => url.split("/").at(-1) ?? "";

// ── Sepolia plumbing ─────────────────────────────────────────────────────────────────────────────
const pub = viem.createPublicClient({ chain: celoSepolia, transport: viem.http(SEPOLIA_RPC) });
const deployer = privateKeyToAccount(state.deployerKey);
const funder = viem.createWalletClient({
  account: deployer,
  chain: celoSepolia,
  transport: viem.http(SEPOLIA_RPC),
});
const mintAbi = viem.parseAbi(["function mint(address to, uint256 amount)"]);

async function fund(address: string): Promise<void> {
  await pub.waitForTransactionReceipt({
    hash: await funder.sendTransaction({ to: address as Hex, value: viem.parseEther(FUND_CELO) }),
  });
  await pub.waitForTransactionReceipt({
    hash: await funder.sendTransaction({
      to: state.runner.sell as Hex,
      data: viem.encodeFunctionData({
        abi: mintAbi,
        functionName: "mint",
        args: [address as Hex, 200_000_000n],
      }),
      gas: 200_000n,
    }),
  });
  await sleep(2_000);
}

// ── test assets (the two fixture tokens) ─────────────────────────────────────────────────────────
const created = { users: [] as string[], assets: [] as string[] };
const run = randomUUID().slice(0, 8);
const mkAsset = async (symbol: string, address: string, decimals: number) => {
  // An earlier interrupted run may have left the fixture token's row behind: reuse it, and delete only what this run made.
  const existing = await db.client.asset.findFirst({
    where: { chainId: domain.CELO_CHAIN_ID, contractAddress: address.toLowerCase() },
  });
  if (existing) return existing.id;
  const id = domain.createId();
  await db.client.asset.create({
    data: {
      id,
      symbol: `${symbol}${run}`,
      name: `Kaada test ${symbol}`,
      kind: "USD_STABLECOIN",
      chainId: domain.CELO_CHAIN_ID,
      contractAddress: address.toLowerCase(),
      decimals,
    },
  });
  created.assets.push(id);
  return id;
};
const sellId = await mkAsset("tUSDT", state.runner.sell, 6);
const buyId = await mkAsset("tBRL", state.runner.buy, 18);
const sessions = moduleRef.get(authorizationTokens.AUTHORIZATION_SESSION_SERVICE);
const textile = await repos.providers.findBySlug("textile");
if (!textile) throw new Error("run `pnpm db:seed` first");
const textileId = textile.id;

/** The person asked for a payment and the agent priced it: what exists before the secure page. */
async function seedPayment(userId: string, walletId: string): Promise<string> {
  const recipient = await repos.recipients.create({
    id: domain.createId(),
    ownerUserId: userId,
    type: "SAVED_BENEFICIARY",
    displayName: "Joao",
    isSaved: true,
    walletAddress: state.fixtures.recipient.toLowerCase(),
  });
  const conversation = await repos.conversations.create({
    id: domain.createId(),
    userId,
    channel: "TELEGRAM",
    status: "ACTIVE",
    externalConversationId: `sepolia-roots-${domain.createId()}`,
  });
  const intent = await repos.intents.create({
    id: domain.createId(),
    userId,
    conversationId: conversation.id,
    recipientId: recipient.id,
    type: "SEND",
    status: "RESOLVED",
    missingFields: [],
    revision: 1,
    sourceAssetId: sellId,
    destinationAssetId: buyId,
    amount: { money: domain.createMoney(BUY_AMOUNT.toString(), buyId), mode: "EXACT_OUTPUT" },
  });
  const quote = await repos.quotes.create({
    id: domain.createId(),
    intentId: intent.id,
    intentRevision: 1,
    providerId: textileId,
    input: domain.createMoney(TAKER_PAYS.toString(), sellId),
    output: domain.createMoney(BUY_AMOUNT.toString(), buyId),
    slippageBps: 5,
    rawProviderData: { adapter: "textile", indicative: true },
  });
  const routeId = domain.createId();
  const route = await repos.routes.createWithSteps({
    id: routeId,
    intentId: intent.id,
    intentRevision: 1,
    status: "VALID",
    input: domain.createMoney(TAKER_PAYS.toString(), sellId),
    output: domain.createMoney(BUY_AMOUNT.toString(), buyId),
    steps: [
      {
        id: domain.createId(),
        routeId,
        position: 0,
        type: "SWAP",
        input: domain.createMoney(TAKER_PAYS.toString(), sellId),
        output: domain.createMoney(BUY_AMOUNT.toString(), buyId),
        providerId: textileId,
        quoteId: quote.id,
      },
    ],
  });
  const { sessionId } = await sessions.begin(repos, {
    userId,
    walletId,
    intentId: intent.id,
    intentRevision: 1,
    routeId: route.id,
  });
  const link = await api("POST", "/authorization/dev/links", { body: { sessionId, userId } });
  if (link.status !== 200) throw new Error(`no authorization link: ${link.status}`);
  return tokenOf(link.body.url);
}

// ── the person's devices ─────────────────────────────────────────────────────────────────────────
interface Device {
  type: "PASSKEY" | "DEVICE_KEY";
  /** What the person's root produces for a server challenge. */
  prove(challenge: any): any;
}
function passkeyDevice(authenticator = createSoftwareAuthenticator()) {
  let counter = 0;
  const device: Device & { authenticator: typeof authenticator } = {
    type: "PASSKEY",
    authenticator,
    prove(challenge) {
      counter += 1;
      return {
        type: "PASSKEY",
        assertion: authenticator.authenticate({
          challenge: challenge.options.challenge,
          origin: ORIGIN,
          rpId: RP_ID,
          counter,
        }),
      };
    },
  };
  return device;
}
function deviceKeyDevice(key = new SoftDeviceKey()) {
  const device: Device & { key: InstanceType<typeof SoftDeviceKey> } = {
    type: "DEVICE_KEY",
    key,
    prove: (challenge) =>
      key.proof(challenge.payload, challenge.challenge ? { challenge: challenge.challenge } : {}),
  };
  return device;
}

interface Person {
  userId: string;
  walletId: string;
  address: string;
  device: Device;
}

/** Onboarding through the real setup endpoints. */
async function onboard(kind: "PASSKEY" | "DEVICE_KEY"): Promise<Person> {
  const session = await api("POST", "/wallet/dev/setup-sessions", { body: {} });
  const userId = session.body.userId as string;
  created.users.push(userId);
  const token = tokenOf(session.body.url);
  let device: Device;
  let view: Reply;
  if (kind === "PASSKEY") {
    const passkey = passkeyDevice();
    device = passkey;
    const options = await api("POST", "/wallet/passkeys/registration/options", { token });
    const registration = passkey.authenticator.register({
      challenge: options.body.challenge,
      origin: ORIGIN,
      rpId: RP_ID,
    });
    view = await api("POST", "/wallet/passkeys/registration/verify", { token, body: registration });
  } else {
    const holder = deviceKeyDevice();
    device = holder;
    const options = await api("POST", "/wallet/device-keys/options", {
      token,
      body: { publicKeyX: holder.key.publicKeyX, publicKeyY: holder.key.publicKeyY },
    });
    const { r, s } = holder.key.sign(options.body.payload);
    view = await api("POST", "/wallet/device-keys/register", {
      token,
      body: {
        publicKeyX: holder.key.publicKeyX,
        publicKeyY: holder.key.publicKeyY,
        challenge: options.body.challenge,
        r,
        s,
      },
    });
  }
  const wallet = view.body.wallet;
  record(
    `${kind}: onboarded through the real setup endpoint; the wallet root is ${kind}`,
    view.status === 200 &&
      view.body.rootType === kind &&
      wallet?.status === "ACTIVE" &&
      !!wallet?.address,
    `${view.status} ${wallet?.address}`,
  );
  // The 6-digit PIN, vouched for by the wallet's ROOT (a passkey assertion or a device-key signature).
  const setupPin = async (pin: string) => {
    const challenge = (await api("POST", "/wallet/pin/options", { token })).body;
    return api("POST", "/wallet/pin", { token, body: { pin, proof: device.prove(challenge) } });
  };
  const challenge = (await api("POST", "/wallet/pin/options", { token })).body;
  record(
    `${kind}: the PIN challenge names the right signer`,
    challenge.action ===
      (kind === "PASSKEY" ? "ROOT_PASSKEY_REQUIRED" : "ROOT_DEVICE_KEY_REQUIRED"),
    String(challenge.action),
  );
  for (const bad of ["1234", "12345", "1234567", "12345a"]) {
    const refused = await api("POST", "/wallet/pin", {
      token,
      body: { pin: bad, proof: device.prove(challenge) },
    });
    record(
      `${kind}: a ${bad.length}-character PIN (${bad}) is refused`,
      refused.status === 400,
      String(refused.status),
    );
  }
  const saved = await setupPin(PIN);
  record(
    `${kind}: a 6-digit PIN is saved after the root's proof`,
    saved.status === 200,
    JSON.stringify(saved.body),
  );
  const row = await db.client.transactionPinSecurity.findUnique({ where: { userId } });
  record(
    `${kind}: only an Argon2id hash is stored, never the digits`,
    !!row && row.pinHash.startsWith("$argon2id$") && !row.pinHash.includes(PIN),
    "",
  );
  await fund(wallet.address);
  record(
    `${kind}: the wallet is funded (CELO for gas, test tUSDT)`,
    (await nativeBalance(wallet.address)) > 0n,
    wallet.address,
  );
  return { userId, walletId: wallet.id, address: wallet.address, device };
}

/** One payment through the real HTTP path. Returns what the person was asked for along the way. */
async function pay(
  person: Person,
  label: string,
): Promise<{ rootActions: string[]; sent: boolean }> {
  const recipientBefore = await tokenBalance(state.runner.buy, state.fixtures.recipient);
  const token = await seedPayment(person.userId, person.walletId);
  const view = await api("GET", "/authorization", { token });
  record(
    `${label}: the authorization page asks for the PIN`,
    view.status === 200 && view.body.action === "PIN_REQUIRED",
    String(view.body.action),
  );
  const authorized = await api("POST", "/authorization/authorize", { token, body: { pin: PIN } });
  record(
    `${label}: a 6-digit PIN creates the PaymentAuthorization (and nothing else)`,
    authorized.status === 200 &&
      authorized.body.status === "AUTHORIZED" &&
      authorized.body.action === "PAYMENT_READY",
    JSON.stringify(authorized.body),
  );
  await api("POST", "/execution/prepare", { token });
  for (let i = 0; i < 60; i += 1) {
    const outcome = await api("GET", "/execution/outcome", { token });
    if (outcome.body.state === "EXECUTION_READY") break;
    if (!["PREPARING", "NOT_STARTED"].includes(outcome.body.state))
      throw new Error(`prepare: ${JSON.stringify(outcome.body)}`);
    await sleep(1_000);
  }
  const asked: string[] = [];
  let sent = false;
  let signedRootAction = false;
  for (let i = 0; i < 120 && !sent; i += 1) {
    await api("POST", "/execution/run", { token });
    await sleep(2_000);
    const status = (await api("GET", "/execution/status", { token })).body;
    if (status.state === "PAYMENT_SENT") {
      sent = true;
    } else if (status.state === "ROOT_ACTION_REQUIRED" && signedRootAction) {
      // The root action was signed and sent: the runner is waiting for the chain to show it. Just keep running.
      continue;
    } else if (status.state === "ROOT_ACTION_REQUIRED") {
      asked.push(String(status.action));
      signedRootAction = true;
      const link = await api("POST", "/execution/root-action-link", { token });
      const page = tokenOf(link.body.url);
      const challenge = (await api("GET", "/root-action/options", { token: page })).body;
      const done = await api("POST", "/root-action/complete", {
        token: page,
        body: { proof: person.device.prove(challenge) },
      });
      if (done.status !== 202)
        throw new Error(`root action refused: ${done.status} ${JSON.stringify(done.body)}`);
      await sleep(3_000);
    } else if (
      ["PAYMENT_FAILED", "GAS_FUNDING_REQUIRED", "INSUFFICIENT_BALANCE"].includes(status.state)
    ) {
      throw new Error(`payment stopped: ${JSON.stringify(status)}`);
    }
  }
  await sleep(2_000);
  const recipientAfter = await tokenBalance(state.runner.buy, state.fixtures.recipient);
  record(
    `${label}: the payment completed on chain and the recipient received it`,
    sent && recipientAfter - recipientBefore === BUY_AMOUNT,
    `+${((recipientAfter - recipientBefore) / 10n ** 18n).toString()} tBRL`,
  );
  return { rootActions: asked, sent };
}

const onChainRoot = async (person: Person) => rootOf(person.address);
const dbRoot = async (person: Person) =>
  db.client.walletCredential.findFirst({
    where: { walletId: person.walletId, isRoot: true, status: "ACTIVE" },
  });
const securityToken = async (person: Person) => {
  const session = await api("POST", "/wallet/dev/setup-sessions", {
    body: { userId: person.userId, purpose: "SECURITY" },
  });
  return tokenOf(session.body.url);
};

try {
  // ── A / B: the same normal flow for each root type ──
  for (const [scenario, kind] of [
    ["A", "PASSKEY"],
    ["B", "DEVICE_KEY"],
  ] as const) {
    if (!want.has(scenario)) continue;
    console.log(`\n── ${scenario}. ${kind} ROOT: onboard, 6-digit PIN, payment, repeat payment ──`);
    const person = await onboard(kind);
    const first = await pay(person, `${scenario}: payment 1`);
    record(
      `${scenario}: the FIRST payment needed exactly one root action, of the wallet's own type`,
      first.rootActions.length === 1 &&
        first.rootActions[0] ===
          (kind === "PASSKEY" ? "ROOT_PASSKEY_REQUIRED" : "ROOT_DEVICE_KEY_REQUIRED"),
      first.rootActions.join(","),
    );
    const second = await pay(person, `${scenario}: payment 2`);
    record(
      `${scenario}: the REPEAT payment is PIN-only: no root prompt at all`,
      second.sent && second.rootActions.length === 0,
      `root actions asked: ${second.rootActions.length}`,
    );
    const actions = await db.client.rootActionSession.count({
      where: { walletId: person.walletId },
    });
    record(
      `${scenario}: exactly one root-action session exists for two payments`,
      actions === 1,
      String(actions),
    );
    record(
      `${scenario}: the account's root on chain is the recorded validator instance`,
      (await onChainRoot(person)) === (await dbRoot(person))?.validatorAddress ||
        (kind === "PASSKEY" && (await onChainRoot(person)) === state.validator.toLowerCase()),
      await onChainRoot(person),
    );
  }

  // ── C: voluntary rotation, both directions ──
  if (want.has("C")) {
    console.log("\n── C. ROTATION: passkey -> device key -> passkey, a payment after each ──");
    const person = await onboard("PASSKEY");
    const address = person.address;
    await pay(person, "C: payment before rotation");

    const rotate = async (
      to: "DEVICE_KEY" | "PASSKEY",
      from: Person["device"],
    ): Promise<Person["device"]> => {
      const token = await securityToken(person);
      let next: Person["device"];
      let credential: any;
      if (to === "DEVICE_KEY") {
        const holder = deviceKeyDevice();
        next = holder;
        const options = await api("POST", "/wallet/root/device-key/options", {
          token,
          body: { publicKeyX: holder.key.publicKeyX, publicKeyY: holder.key.publicKeyY },
        });
        const { r, s } = holder.key.sign(options.body.payload);
        credential = {
          type: "DEVICE_KEY",
          publicKeyX: holder.key.publicKeyX,
          publicKeyY: holder.key.publicKeyY,
          challenge: options.body.challenge,
          r,
          s,
        };
      } else {
        const passkey = passkeyDevice();
        next = passkey;
        const options = await api("POST", "/wallet/root/passkey/options", { token });
        credential = {
          type: "PASSKEY",
          response: passkey.authenticator.register({
            challenge: options.body.challenge,
            origin: ORIGIN,
            rpId: RP_ID,
          }),
        };
      }
      const prepared = await api("POST", "/wallet/root/changes", {
        token,
        body: { kind: "ROTATE_ROOT", credential },
      });
      record(
        `C: rotation to ${to} is prepared and the CURRENT root (${from.type}) is asked to sign`,
        prepared.status === 200 && prepared.body.challenge?.type === from.type,
        `${prepared.status} ${String(prepared.body.challenge?.action)}`,
      );
      const done = await api("POST", `/wallet/root/changes/${prepared.body.changeId}/complete`, {
        token,
        body: { proof: from.prove(prepared.body.challenge) },
      });
      record(
        `C: the rotation to ${to} is CONFIRMED by the chain`,
        done.status === 200 && done.body.status === "CONFIRMED",
        `${done.status} ${JSON.stringify(done.body)}`,
      );
      const row = await dbRoot(person);
      record(
        `C: the recorded root is now a ${to} on a FRESH clone, and it is the account's root on chain`,
        row?.kind === to && (await onChainRoot(person)) === row.validatorAddress,
        `${row?.validatorAddress}`,
      );
      record(
        `C: the wallet address did not change`,
        (
          await db.client.wallet.findUnique({ where: { id: person.walletId } })
        )?.address?.toLowerCase() === address.toLowerCase(),
        address,
      );
      return next;
    };

    const clones = new Set<string>();
    const toDevice = await rotate("DEVICE_KEY", person.device);
    clones.add((await dbRoot(person))?.validatorAddress ?? "");
    person.device = toDevice;
    const afterDevice = await pay(person, "C: payment after rotating to the device key");
    record(
      "C: the first payment under the new root asks the NEW root's signer (the old permission is void)",
      afterDevice.rootActions.length === 1 &&
        afterDevice.rootActions[0] === "ROOT_DEVICE_KEY_REQUIRED",
      afterDevice.rootActions.join(","),
    );
    const toPasskey = await rotate("PASSKEY", person.device);
    clones.add((await dbRoot(person))?.validatorAddress ?? "");
    person.device = toPasskey;
    const afterPasskey = await pay(person, "C: payment after rotating back to a passkey");
    record(
      "C: ...and after rotating back it asks the passkey again",
      afterPasskey.rootActions.length === 1 &&
        afterPasskey.rootActions[0] === "ROOT_PASSKEY_REQUIRED",
      afterPasskey.rootActions.join(","),
    );
    record(
      "C: no validator instance was ever reused",
      clones.size === 2 && !clones.has(""),
      [...clones].join(","),
    );
    record(
      "C: the address is the one the wallet was created with",
      (
        await db.client.wallet.findUnique({ where: { id: person.walletId } })
      )?.address?.toLowerCase() === address.toLowerCase(),
      address,
    );
  }
} catch (error) {
  record(
    "run completed without an unexpected error",
    false,
    String((error as Error).stack ?? error).slice(0, 900),
  );
} finally {
  const client = db.client;
  const where = { userId: { in: created.users } };
  try {
    const intents = (await client.intent.findMany({ where, select: { id: true } })).map(
      (i) => i.id,
    );
    const owned = { intentId: { in: intents } };
    const permissions = await client.delegatedPermission.findMany({
      where,
      select: { sessionKeySecretId: true, approvalSecretId: true },
    });
    await client.auditEvent.deleteMany({ where });
    await client.rootChange.deleteMany({ where });
    await client.transaction.deleteMany({ where: { execution: where } });
    await client.rootActionSession.deleteMany({ where });
    await client.execution.deleteMany({ where });
    await client.firmQuoteAttempt.deleteMany({ where });
    await client.delegatedPermission.deleteMany({ where });
    await client.paymentAuthorization.deleteMany({ where: owned });
    await client.authorizationSession.deleteMany({ where: owned });
    await client.routeStep.deleteMany({ where: { route: owned } });
    await client.route.deleteMany({ where: owned });
    await client.quote.deleteMany({ where: owned });
    await client.intent.deleteMany({ where });
    await client.recipient.deleteMany({ where: { ownerUserId: { in: created.users } } });
    await client.conversation.deleteMany({ where });
    await client.transactionPinSecurity.deleteMany({ where });
    await client.passkeyCredential.deleteMany({ where });
    await client.passkeyChallenge.deleteMany({ where });
    await client.walletSetupSession.deleteMany({ where });
    await client.walletCredential.deleteMany({ where });
    await client.wallet.deleteMany({ where });
    await client.executionSecret.deleteMany({
      where: {
        id: {
          in: permissions
            .flatMap((p) => [p.sessionKeySecretId, p.approvalSecretId])
            .filter((id): id is string => id !== null),
        },
      },
    });
    await client.user.deleteMany({ where: { id: { in: created.users } } });
    await client.asset.deleteMany({ where: { id: { in: created.assets } } });
  } catch (error) {
    console.log("cleanup warning:", (error as Error).message);
  }
  await app.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  for (const f of failed) console.log("FAILED:", f.name, f.detail);
  process.exitCode = 1;
}
