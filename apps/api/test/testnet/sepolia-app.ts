/*
 * The REAL Kaada API, composed for Celo Sepolia. TESTNET ONLY.
 *
 *   KAADA_HARNESS_STATE=<state.json> node --import tsx test/testnet/sepolia-app.ts
 *
 * It boots the production AppModule (every controller, every service, the real database) and replaces ONLY the
 * pieces that are mainnet- or Textile-bound, with Sepolia/test-fixture equivalents behind the same Kaada ports:
 *   - the Kernel address deriver (Sepolia chain + the passkey-validator fixture deployed there),
 *   - the chain-read ports (balances, allowances, deployment: the production readers refuse any chain but Celo),
 *   - the Kernel/bundler adapter (the REAL adapter, pointed at Sepolia and the local Alto bundler),
 *   - the firm-quote provider and order provider (fakes: no Textile),
 *   - and the wiring of the preparation service, root-action service and runner over those.
 * The WebAuthn verification, setup/PIN/authorization services, root-action page API and runner are the production code.
 * The database keeps the LOGICAL chain id 42220; only the transport is Sepolia.
 */
import "reflect-metadata";

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env["KAADA_HARNESS_STATE"];
if (!statePath) throw new Error("KAADA_HARNESS_STATE is required");
const state = JSON.parse(readFileSync(statePath, "utf8")) as {
  validator: string;
  fixtures: { recipient: string };
  runner: { sell: string; buy: string; swap: string };
  http?: { executionKey?: string };
};
if (!state.http?.executionKey) {
  state.http = { ...state.http, executionKey: randomBytes(32).toString("base64") };
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}

// The environment this composition runs with (set BEFORE the application reads its configuration).
try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}
Object.assign(process.env, {
  NODE_ENV: "development",
  WALLET_PROVIDER: "kernel",
  PASSKEY_RP_ID: process.env["PASSKEY_RP_ID"] ?? "localhost",
  PASSKEY_ORIGIN: process.env["PASSKEY_ORIGIN"] ?? "http://localhost:3000",
  AGENT_INTERPRETER: "none",
  FX_PROVIDER: "none",
  EXECUTION_ENABLED: "false", // the execution pieces are provided below
  EXECUTION_SECRET_KEY: state.http.executionKey,
  LOG_LEVEL: "warn",
  // A person on a real browser needs longer than the 3-minute default to finish PIN + wallet setup.
  PAYMENT_AUTHORIZATION_TTL_SECONDS: "600",
  AUTHORIZATION_SESSION_TTL_SECONDS: "900",
});
delete process.env["TEXTILE_ENV"];

const SEPOLIA_RPC = "https://forno.celo-sepolia.celo-testnet.org";
const bundlerUrl = process.env["BUNDLER_URL_TESTNET"];
if (!bundlerUrl || !/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(bundlerUrl)) {
  throw new Error("BUNDLER_URL_TESTNET must point at the LOCAL Alto bundler");
}

const [
  { Test },
  { FastifyAdapter },
  { Logger },
  blockchain,
  database,
  domain,
  { AppModule },
  { configureApp },
  { APP_CONFIG },
  { DATABASE },
  walletTokens,
  authorizationTokens,
  executionTokens,
  { WalletService },
  { ExecutionPreparationService },
  { FirmQuoteService },
  { AccountReadinessService },
  { RootActionService },
  rootCredentials,
  rootAdapters,
  { ExecutionRunner },
  { ValidatedExecutionSigner },
  { AesGcmSecretCipher },
  { SimpleWebAuthnVerifier },
] = await Promise.all([
  import("@nestjs/testing"),
  import("@nestjs/platform-fastify"),
  import("nestjs-pino"),
  import("@kaada/blockchain"),
  import("@kaada/database"),
  import("@kaada/domain"),
  import("../../src/app.module.js"),
  import("../../src/app.setup.js"),
  import("../../src/config/config.module.js"),
  import("../../src/database/database.module.js"),
  import("../../src/wallet/wallet.tokens.js"),
  import("../../src/authorization/authorization.tokens.js"),
  import("../../src/execution/execution.tokens.js"),
  import("../../src/core/wallets/wallet-service.js"),
  import("../../src/core/execution/preparation-service.js"),
  import("../../src/core/execution/firm-quote-service.js"),
  import("../../src/core/execution/account-readiness.js"),
  import("../../src/core/execution/root-action-service.js"),
  import("../../src/core/roots/root-credentials.js"),
  import("../../src/core/roots/adapters.js"),
  import("../../src/core/execution/runner.js"),
  import("../../src/core/execution/validated-signer.js"),
  import("../../src/infrastructure/security/aes-gcm-cipher.js"),
  import("../../src/infrastructure/wallet/simplewebauthn-verifier.js"),
]);

type Db = InstanceType<typeof Object> & Parameters<typeof database.createRepositories>[0];
const network = blockchain.celoSepoliaKernelNetwork(state.validator as `0x${string}`);

// ── Sepolia reads behind the Kaada ports ───────────────────────────────────────────────────────
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
// A token that does not exist on Sepolia answers "0x": that is a zero balance, not an error.
const tokenBalance = async (token: string, owner: string) => {
  const raw = await call(token, `0x70a08231${word(owner)}`);
  return raw && raw !== "0x" ? BigInt(raw) : 0n;
};

const unitOfWork = (db: Db) => ({
  read: database.createRepositories(db),
  transaction: <T>(work: (r: ReturnType<typeof database.createRepositories>) => Promise<T>) =>
    database.withTransaction(db, work),
});

// ── fakes for the provider (no Textile) ────────────────────────────────────────────────────────
const APPROVE = "0x095ea7b3";
const SWAP = "0x8a0ccd56"; // MockSwap.swap(address,uint256,address,uint256)
const TAKER_PAYS = 20_000_000n;

const { PasskeyService } = await import("../../src/core/wallets/passkey-service.js");
const { coordinatesToCose } =
  await import("../../src/infrastructure/wallet/simplewebauthn-verifier.js");
const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");

/** The production verifier; on a refusal it re-runs the same call once to log the library's own reason. */
function diagnosticVerifier() {
  const real = new SimpleWebAuthnVerifier();
  type AuthInput = Parameters<typeof real.verifyAuthentication>[0];
  return {
    async verifyRegistration(input: Parameters<typeof real.verifyRegistration>[0]) {
      const result = await real.verifyRegistration(input);
      try {
        const attestation =
          (input.response as {
            response?: { attestationObject?: string };
            authenticatorAttachment?: string;
          }) ?? {};
        const helpers = await import("@simplewebauthn/server/helpers");
        const decoded = helpers.decodeAttestationObject(
          Buffer.from(attestation.response?.attestationObject ?? "", "base64url"),
        );
        const authData = helpers.parseAuthenticatorData(decoded.get("authData"));
        const f = authData.flags;
        const aaguid = authData.aaguid ? helpers.convertAAGUIDToString(authData.aaguid) : "?";
        console.log(
          "  [registration]",
          `UP=${f.up ? 1 : 0} UV=${f.uv ? 1 : 0} BE=${f.be ? 1 : 0} BS=${f.bs ? 1 : 0}`,
          "| aaguid",
          aaguid,
          "| fmt",
          decoded.get("fmt"),
          "| attachment",
          attestation.authenticatorAttachment,
          "| verified:",
          result !== null,
        );
      } catch (error) {
        console.log("  [registration] could not parse:", (error as Error).message);
      }
      return result;
    },
    async verifyAuthentication(input: AuthInput) {
      const result = await real.verifyAuthentication(input);
      if (result === null) {
        try {
          const r = input.response as {
            response?: { authenticatorData?: string; clientDataJSON?: string };
            authenticatorAttachment?: string;
          };
          const auth = Buffer.from(r.response?.authenticatorData ?? "", "base64url");
          const flags = auth[32] ?? 0;
          const client = JSON.parse(
            Buffer.from(r.response?.clientDataJSON ?? "", "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          console.log(
            "  [assertion] flags 0b" + flags.toString(2).padStart(8, "0"),
            `UP=${flags & 1 ? 1 : 0} UV=${flags & 4 ? 1 : 0} BE=${flags & 8 ? 1 : 0} BS=${flags & 16 ? 1 : 0}`,
            "| signCount",
            auth.length >= 37 ? auth.readUInt32BE(33) : "?",
            "| attachment",
            r.authenticatorAttachment,
            "| clientData type",
            client["type"],
            "origin",
            client["origin"],
            "crossOrigin",
            client["crossOrigin"],
          );
        } catch {
          console.log("  [assertion] could not be parsed");
        }
        try {
          await verifyAuthenticationResponse({
            response: input.response as never,
            expectedChallenge: input.expectedChallenge,
            expectedOrigin: input.expectedOrigin,
            expectedRPID: input.expectedRpId,
            requireUserVerification: true,
            credential: {
              id: input.credential.credentialId,
              publicKey: new Uint8Array(
                coordinatesToCose(input.credential.publicKeyX, input.credential.publicKeyY),
              ),
              counter: input.credential.signCount,
            },
          });
          console.log("  [verifier] second run did not fail (unexpected)");
        } catch (error) {
          console.log(
            "  [verifier] library reason:",
            (error as Error).name,
            "-",
            (error as Error).message.slice(0, 300),
          );
        }
      }
      return result;
    },
  };
}
const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  // Test visibility only: the PRODUCTION passkey service, with the internal reason of a refusal logged.
  .overrideProvider(walletTokens.PASSKEY_SERVICE)
  .useFactory({
    inject: [DATABASE, APP_CONFIG],
    factory: (db: Db, config: { wallet: { passkey?: { rpId: string; origin: string } } }) => {
      const service = new PasskeyService({
        unitOfWork: unitOfWork(db),
        verifier: diagnosticVerifier(),
        rpId: config.wallet.passkey?.rpId ?? "localhost",
        origin: config.wallet.passkey?.origin ?? "http://localhost:3000",
      });
      for (const method of ["completeAuthentication", "completeRegistration"] as const) {
        const original = (
          service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
        )[method];
        if (typeof original !== "function") continue;
        (service as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
          try {
            return await original.apply(service, args);
          } catch (error) {
            console.log("  [passkey service refused]", method, "->", (error as Error).message);
            throw error;
          }
        };
      }
      return service;
    },
  })
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
    ],
    factory: (
      db: Db,
      config: {
        wallet: { passkey?: { rpId: string; origin: string } };
        execution: { cipherKeys: { version: number; key: string }[] };
      },
      wallets: InstanceType<typeof WalletService>,
      kernel: never,
    ) => {
      const rpId = config.wallet.passkey?.rpId ?? "localhost";
      const origin = config.wallet.passkey?.origin ?? "http://localhost:3000";
      const work = unitOfWork(db);
      return new RootActionService({
        unitOfWork: work,
        kernel,
        cipher: new AesGcmSecretCipher(config.execution.cipherKeys),
        wallets,
        roots: new rootCredentials.RootCredentialService({ repositories: work.read, rpId }),
        adapters: new rootCredentials.RootAdapters(
          new rootAdapters.PasskeyRootAdapter({
            verifier: new SimpleWebAuthnVerifier(),
            passkeys: work.read.passkeys,
            rpId,
            origin,
          }),
          new rootAdapters.DeviceKeyRootAdapter(),
        ),
        onChainId: 11142220,
        origin,
      });
    },
  })
  .overrideProvider(executionTokens.EXECUTION_PREPARATION_SERVICE)
  .useFactory({
    inject: [
      DATABASE,
      APP_CONFIG,
      walletTokens.WALLET_SERVICE,
      authorizationTokens.AUTHORIZATION_POLICY_SERVICE,
    ],
    factory: (
      db: Db,
      config: {
        execution: { cipherKeys: { version: number; key: string }[]; minFirmWindowMs: number };
      },
      wallets: InstanceType<typeof WalletService>,
      policy: never,
    ) => {
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
      config: {
        execution: {
          cipherKeys: { version: number; key: string }[];
          minFirmWindowMs: number;
          minNativeWei: bigint;
        };
      },
      wallets: InstanceType<typeof WalletService>,
      preparation: never,
      kernel: never,
      rootActions: never,
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

const app = moduleRef.createNestApplication<
  import("@nestjs/platform-fastify").NestFastifyApplication
>(new FastifyAdapter());
const config = moduleRef.get<import("@kaada/config").AppConfig>(APP_CONFIG);
app.useLogger(moduleRef.get(Logger));
configureApp(app, config);
// Test visibility only: method, PATH (no query, no body, no headers) and status of every request.
app
  .getHttpAdapter()
  .getInstance()
  .addHook(
    "onResponse",
    (request: { method: string; url: string }, reply: { statusCode: number }, done: () => void) => {
      console.log(
        new Date().toISOString(),
        request.method,
        request.url.split("?")[0],
        reply.statusCode,
      );
      done();
    },
  );
await app.listen(config.port, config.apiHost);
console.log(
  `Kaada API (Celo Sepolia composition) on :${config.port} | RP ${config.wallet.passkey?.rpId} | origin ${config.wallet.passkey?.origin}`,
);
void existsSync;
