/*
 * Live END-TO-END check of the Uniswap integration through a REAL Kernel smart account on CELO MAINNET.
 *
 * TEST ONLY. It lives in scripts/, never in src/, so it cannot ship with the app, and it changes no production
 * code and no security gate. It spends REAL money, so every step is explicit:
 *
 *   pnpm --filter @kaada/api smoke:kernel -- --setup                      create the test root + validator, print the address
 *   pnpm --filter @kaada/api smoke:kernel -- --fund --confirm-mainnet     top the Kernel account up from the test wallet
 *   pnpm --filter @kaada/api smoke:kernel -- --quote-only                 plan only, nothing sent
 *   pnpm --filter @kaada/api smoke:kernel -- --execute --confirm-mainnet  a real signed payment, cNGN -> wARS
 *   pnpm --filter @kaada/api smoke:kernel -- --execute --confirm-mainnet --reverse     wARS -> cNGN
 *
 * WHY NO PASSKEY. A Kaada wallet's root is a passkey (a hardware prompt) or a DEVICE KEY: a raw P-256 key. This
 * harness uses a device key held in software, in a file outside the repository. That is not a bypass of anything:
 * it is the second root type the production code already supports, driven through the production code paths.
 * The validator clone is deployed by the production ViemValidatorDeployer; the factory's `deploy` is permissionless
 * ("Anyone may deploy one and it holds no authority"), so the test wallet can pay for it. The relayer check in the
 * app's boot sequence is an application guard, not an on-chain rule, and this script never starts the app.
 *
 * WHAT IS REAL: the Kernel v3.3 account on mainnet; the production createZeroDevKernelAdapter; the live Pimlico
 * bundler; the account deployment and permission install in one root operation; the Permit2 grant signed by the ROOT;
 * the session key and the permission's on-chain call policies (policiesForScope); the real UniswapFirmQuoteProvider;
 * the real buildExecutionPlan and plannedSteps; and the live Uniswap Trading API.
 *
 * WHAT IS NOT: the database-backed runner, signer and authorization services, which have their own tests. Here the
 * plan's steps are sent straight through the adapter.
 *
 * Secrets: keys are read from files outside the repository and are never printed.
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env; rely on the real environment.
}

import { createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ViemValidatorDeployer,
  attributionSuffix,
  createKernelAddressDeriver,
  createZeroDevKernelAdapter,
} from "@kaada/blockchain";
import { RECOVERY_DEPLOYMENTS, SETTINGS } from "@kaada/config";
import {
  P256_N,
  buildPrimaryRoot,
  deviceKeyIdFromPoint,
  deviceKeyPayload,
  primaryRootDeploymentSalt,
} from "@kaada/contracts";
import { createDatabase, createRepositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createId,
  SecretValue,
  createMoney,
  permissionScopeKey,
  permit2AllowanceCovers,
} from "@kaada/domain";
import type {
  Asset,
  DelegatedPermission,
  DeviceKeyRoot,
  FirmExecutionCandidate,
  FirmQuote,
  PaymentAuthorization,
  Wallet,
} from "@kaada/domain";
import { celo } from "viem/chains";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  parseUnits,
} from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { buildExecutionPlan } from "../src/core/execution/plan-builder.js";
import { plannedSteps } from "../src/core/execution/steps.js";
import { defaultTokenPolicy } from "../src/core/execution/token-policy.js";
import {
  UniswapClient,
  UniswapFirmQuoteProvider,
  createUniswapFetchTransport,
} from "../src/infrastructure/fx/uniswap/index.js";

// ───────────────────────────── arguments and guards ─────────────────────────────
const args = process.argv.slice(2).filter((a) => a !== "--");
const has = (name: string) => args.includes(`--${name}`);
const SETUP = has("setup");
const FUND = has("fund");
const EXECUTE = has("execute");
const QUOTE_ONLY = has("quote-only");
const SIMULATE = has("simulate");
const REVERSE = has("reverse");
/**
 * A CONVERSION between the account's own currencies under the STANDING permission: installed once (one root operation),
 * then reused by every later run of the same pair with nothing signed by the root. `--amount N` sets the whole-token size,
 * so a second run with a different N proves the permission does not depend on the amount.
 */
const STANDING = has("standing");
const amountFlag = args.indexOf("--amount");
const AMOUNT = amountFlag >= 0 ? (args[amountFlag + 1] ?? "100") : "100";
if (!SETUP && !FUND && !EXECUTE && !QUOTE_ONLY && !SIMULATE) {
  console.error("Choose one: --setup, --fund, --quote-only, --simulate, or --execute");
  process.exit(1);
}
if ((FUND || EXECUTE) && !has("confirm-mainnet")) {
  console.error(
    "--fund and --execute spend real money on Celo mainnet. Re-run with --confirm-mainnet.",
  );
  process.exit(1);
}

/*
 * Where the throwaway test keys live: OUTSIDE the repository, so they can never be committed. Override with
 * KAADA_TEST_WALLET_DIR; the default is a folder in your home directory. Nothing here is a Kaada user wallet.
 */
const DIR = process.env["KAADA_TEST_WALLET_DIR"] ?? join(homedir(), ".kaada-test-wallet");
const FUNDER_FILE = join(DIR, "celo-test-eoa.json");
const ROOT_FILE = join(DIR, "kernel-root.json");
const STANDING_FILE = join(DIR, "standing-permission.json");
const RPC = process.env["CELO_RPC_URL"] ?? "https://forno.celo.org";
const bundlerUrl = process.env["BUNDLER_URL"];
const uniswapKey = process.env["UNISWAP_API_KEY"];
const databaseUrl = process.env["DATABASE_URL"];
if (!bundlerUrl) throw new Error("BUNDLER_URL is required");
if (!uniswapKey) throw new Error("UNISWAP_API_KEY is required");
if (!databaseUrl) throw new Error("DATABASE_URL is required");

/** What a --standing run keeps so a LATER run can reuse the permission, as the app keeps it in its database and secret store. */
interface StandingFile {
  scopeKey: string;
  scope: {
    allowedOperations: string[];
    allowedContracts: string[];
    allowedAssetIds: string[];
    perTransactionLimit: { amount: string; assetId: string };
  };
  validFrom: string;
  expiresAt: string;
  sessionKeyAddress: string;
  sessionKeyPrivateKey: string;
  approval: string;
}

// ───────────────────────────── the test-only software device key ─────────────────────────────
interface RootFile {
  note: string;
  userId: string;
  privateKeyPem: string;
  publicKeyX: string;
  publicKeyY: string;
}

function loadOrCreateRoot(): RootFile {
  if (existsSync(ROOT_FILE)) return JSON.parse(readFileSync(ROOT_FILE, "utf8")) as RootFile;
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const created: RootFile = {
    note: "TEST-ONLY software device key for a Kaada Kernel test account on Celo mainnet. Holds test amounts only.",
    userId: randomUUID(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyX: Buffer.from(jwk.x ?? "", "base64url").toString("hex"),
    publicKeyY: Buffer.from(jwk.y ?? "", "base64url").toString("hex"),
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(ROOT_FILE, `${JSON.stringify(created, null, 2)}\n`, { mode: 0o600 });
  return created;
}

const rootFile = loadOrCreateRoot();
const keyId = deviceKeyIdFromPoint({
  x: BigInt(`0x${rootFile.publicKeyX}`),
  y: BigInt(`0x${rootFile.publicKeyY}`),
});

/** ECDSA P-256 over SHA-256, low-s only: the validator refuses a high-s signature. */
function signPayload(payload: Hex): { r: string; s: string } {
  const raw = sign("sha256", Buffer.from(payload.slice(2), "hex"), {
    key: createPrivateKey(rootFile.privateKeyPem),
    dsaEncoding: "ieee-p1363",
  });
  let s = BigInt(`0x${raw.subarray(32).toString("hex")}`);
  if (s > P256_N / 2n) s = P256_N - s;
  return { r: raw.subarray(0, 32).toString("hex"), s: s.toString(16).padStart(64, "0") };
}

// ───────────────────────────── the validator clone and the account ─────────────────────────────
const mainnet = RECOVERY_DEPLOYMENTS["celo-mainnet"];
if (!mainnet) throw new Error("no celo-mainnet deployments recorded");
const deployments = {
  passkey: {
    factory: mainnet.passkeyFactory as Address,
    implementation: mainnet.passkeyImplementation as Address,
  },
  device: {
    factory: mainnet.deviceFactory as Address,
    implementation: mainnet.deviceImplementation as Address,
  },
};
const primary = buildPrimaryRoot({
  deployments,
  credential: {
    kind: "DEVICE_KEY",
    keyId,
    publicKeyX: rootFile.publicKeyX,
    publicKeyY: rootFile.publicKeyY,
  },
  deploymentSalt: primaryRootDeploymentSalt(rootFile.userId),
});
const root: DeviceKeyRoot = {
  type: "DEVICE_KEY",
  keyId,
  publicKeyX: rootFile.publicKeyX,
  publicKeyY: rootFile.publicKeyY,
  validatorAddress: primary.instance,
  purpose: primary.purpose,
  deploymentSalt: primary.deploymentSalt,
};

const funder = JSON.parse(readFileSync(FUNDER_FILE, "utf8")) as {
  address: string;
  privateKey: Hex;
};
const funderAccount = privateKeyToAccount(funder.privateKey);
const pub = createPublicClient({ chain: celo, transport: http(RPC) });
const funderWallet = createWalletClient({
  account: funderAccount,
  chain: celo,
  transport: http(RPC),
});

const deriver = createKernelAddressDeriver({ rpcUrl: RPC });
const KERNEL = (await deriver.deriveAddress(root)).toLowerCase() as Address;
/*
 * The derived address is only meaningful once the validator clone exists on chain: the account's address is a
 * function of the validator's installed state. Derived any earlier, it comes back as the zero address, and funding
 * the zero address is an unrecoverable loss. So nothing that moves money may run against it, and --setup (which is
 * what creates the clone) is the one mode allowed to see it.
 */
const ZERO = "0x0000000000000000000000000000000000000000";
if (KERNEL === ZERO && !SETUP) {
  console.error(
    "The Kernel address derived to the zero address. Run --setup first so the validator clone exists.",
  );
  process.exit(1);
}

const firstLine = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const [first] = message.split(/\r?\n/);
  return (first ?? message).trim();
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let problems = 0;
const pass = (text: string) => console.log(`   PASS  ${text}`);
const fail = (text: string) => {
  problems += 1;
  console.log(`   FAIL  ${text}`);
};
const step = (text: string) => console.log(`\n── ${text}`);

const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address;
const WARS = "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D" as Address;

/** A read pinned to a block, with a catch-up retry: a read at "latest" can hit a lagging node. */
async function tokenBalance(token: Address, owner: Address, blockNumber?: bigint): Promise<bigint> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await pub.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [owner],
        ...(blockNumber !== undefined && { blockNumber }),
      });
    } catch {
      await sleep(1_000);
    }
  }
  throw new Error("the node never caught up");
}

console.log(`test root keyId  ${keyId}`);
console.log(`validator clone  ${primary.instance}`);
console.log(`KERNEL ACCOUNT   ${KERNEL}`);

try {
  // ───────────────────────────── setup ─────────────────────────────
  if (SETUP) {
    step("setup: deploy the validator clone with the production deployer");
    const deployer = new ViemValidatorDeployer({
      chain: celo,
      rpcUrl: RPC,
      deployments,
      relayerKey: funder.privateKey,
    });
    const result = await deployer.ensureDeployed({
      type: "DEVICE_KEY",
      account: null,
      purpose: primary.purpose,
      deploymentSalt: primary.deploymentSalt,
      validatorAddress: primary.instance,
      publicKeyX: rootFile.publicKeyX,
      publicKeyY: rootFile.publicKeyY,
      credentialRef: keyId,
    });
    console.log(
      `   ${result.created ? `deployed in ${result.txHash ?? "?"}` : "already deployed"}`,
    );
    for (let i = 0; i < 20; i += 1) {
      const code = await pub.getCode({ address: primary.instance });
      if (code && code !== "0x") break;
      await sleep(1_500);
    }
    const code = await pub.getCode({ address: primary.instance });
    if (code && code !== "0x") pass("the validator clone has code on mainnet");
    else fail("the validator clone has no code");
    console.log(`\n   Kernel account address: ${KERNEL}`);
    console.log("   (counterfactual until its first root operation deploys it)");
  }

  // ───────────────────────────── fund ─────────────────────────────
  if (FUND) {
    step("fund: top the Kernel account up from the test wallet");
    const targets: { label: string; token: Address | null; want: bigint; decimals: number }[] = [
      { label: "CELO", token: null, want: parseUnits("0.42", 18), decimals: 18 },
      { label: "cNGN", token: CNGN, want: parseUnits("300", 6), decimals: 6 },
      { label: "wARS", token: WARS, want: parseUnits("150", 18), decimals: 18 },
    ];
    for (const target of targets) {
      const have = target.token
        ? await tokenBalance(target.token, KERNEL)
        : await pub.getBalance({ address: KERNEL });
      const missing = target.want - have;
      if (missing <= 0n) {
        console.log(`   ${target.label}: already holds ${formatUnits(have, target.decimals)}`);
        continue;
      }
      const hash = target.token
        ? await funderWallet.writeContract({
            address: target.token,
            abi: erc20Abi,
            functionName: "transfer",
            args: [KERNEL, missing],
          })
        : await funderWallet.sendTransaction({ to: KERNEL, value: missing });
      const receipt = await pub.waitForTransactionReceipt({ hash });
      console.log(
        `   ${target.label}: sent ${formatUnits(missing, target.decimals)}  ${receipt.status}  ${hash}`,
      );
      if (receipt.status !== "success") fail(`funding ${target.label} reverted`);
    }
  }

  // ───────────────────────────── the payment ─────────────────────────────
  if (QUOTE_ONLY || EXECUTE || SIMULATE) {
    const database = createDatabase({ url: databaseUrl, poolMax: 3, poolTimeoutMs: 20_000 });
    try {
      const repositories = createRepositories(database);
      const registry = createAssetRegistry(repositories.assets);
      const bySymbol = async (symbol: string): Promise<Asset & { contractAddress: string }> => {
        const [asset] = await registry.findBySymbol(symbol, { chainId: CELO_CHAIN_ID });
        if (!asset?.contractAddress) throw new Error(`${symbol} is not seeded on Celo mainnet`);
        return asset as Asset & { contractAddress: string };
      };
      const [sell, buy] = REVERSE
        ? await Promise.all([bySymbol("wARS"), bySymbol("cNGN")])
        : await Promise.all([bySymbol("cNGN"), bySymbol("wARS")]);
      /** 100 of the sell token: above the $0.50 floor and repeatable on the funded balance. */
      const SPEND = REVERSE ? parseUnits(AMOUNT, 18).toString() : parseUnits(AMOUNT, 6).toString();
      /* The payee is the funding wallet: a DIFFERENT address from the Kernel account, so the payout leg
       * is a real transfer to someone else and not a transfer to itself. */
      // A conversion pays back to the account itself, so its "recipient" balance is the account's own.
      const RECIPIENT = (STANDING ? KERNEL : funderAccount.address).toLowerCase() as Address;

      step(`payment: ${SPEND} ${sell.symbol} -> ${buy.symbol}, paid out to a second address`);
      console.log(
        `   mode ${EXECUTE ? "EXECUTE (real, signed, through the bundler)" : "quote only"}`,
      );

      const kernelCode = await pub.getCode({ address: KERNEL });
      const deployed = kernelCode !== undefined && kernelCode !== "0x";
      console.log(`   account deployed: ${deployed}`);

      // 1. firm quote, taker = the Kernel account
      const firmProvider = new UniswapFirmQuoteProvider({
        client: new UniswapClient({
          transport: createUniswapFetchTransport({
            baseUrl: SETTINGS.uniswap.apiUrl,
            apiKey: uniswapKey,
          }),
          timeoutMs: SETTINGS.uniswap.timeoutMs,
        }),
        slippagePercent: SETTINGS.uniswap.slippagePercent,
      });
      const firm = await firmProvider.requestFirm({
        chainId: CELO_CHAIN_ID,
        sellAssetId: sell.id,
        buyAssetId: buy.id,
        sellToken: sell.contractAddress,
        buyToken: buy.contractAddress,
        mode: "EXACT_INPUT",
        exactAmount: SPEND,
        taker: KERNEL,
      });
      if (firm.status !== "QUOTED") {
        fail(`firm quote failed: ${firm.code} ${firm.providerReason ?? ""}`);
        throw new Error("no firm quote");
      }
      console.log(
        `   quoted output ${firm.quote.output.amount} ${buy.symbol}, expires ${firm.quote.expiresAt.toISOString()}`,
      );

      // 2. the real plan over live chain reads
      const { createViemAllowanceReader, createViemPermit2AllowanceReader } =
        await import("@kaada/blockchain");
      const allowances = createViemAllowanceReader({ rpcUrl: RPC });
      const permit2Allowances = createViemPermit2AllowanceReader({ rpcUrl: RPC });
      const spender = firm.quote.spender ?? "";
      const [currentAllowance, currentPermit2Allowance] = await Promise.all([
        allowances.readAllowance({
          chainId: CELO_CHAIN_ID,
          token: sell.contractAddress,
          owner: KERNEL,
          spender,
        }),
        permit2Allowances.readPermit2Allowance({
          chainId: CELO_CHAIN_ID,
          owner: KERNEL,
          token: sell.contractAddress,
          spender: firm.transactions.swap.to,
        }),
      ]);

      const now = new Date();
      const quote: FirmQuote = { ...firm.quote, id: createId() };
      const authorization = {
        id: createId(),
        userId: "smoke",
        walletId: "smoke-wallet",
        intentRevision: 1,
        routeId: "smoke-route",
        bounds: {
          mode: "EXACT_INPUT",
          authorizedInput: createMoney(SPEND, sell.id),
          minimumOutput: quote.output,
        },
      } as unknown as PaymentAuthorization;
      const candidate = {
        userId: "smoke",
        walletId: "smoke-wallet",
        chainId: CELO_CHAIN_ID,
        intentRevision: 1,
        operation: STANDING ? "CONVERT" : "SEND",
        recipient: STANDING ? {} : { address: RECIPIENT },
        input: quote.input,
        output: quote.output,
        route: { assetPath: [sell.id, buy.id], providers: ["uniswap"] },
        intentId: "smoke-intent",
        authorizationId: authorization.id,
        provider: "uniswap",
        providerQuoteId: quote.providerQuoteId,
        executionReference: quote.executionReference,
        expiresAt: quote.expiresAt,
        routeSteps: [
          { type: "SWAP" as const, provider: "uniswap", input: quote.input, output: quote.output },
        ],
      } as unknown as FirmExecutionCandidate;
      const wallet = {
        id: "smoke-wallet",
        userId: "smoke",
        address: KERNEL,
        chainId: CELO_CHAIN_ID,
        status: "ACTIVE",
      } as unknown as Wallet & { address: string };

      /*
       * The permission a previous --standing run installed, if any, exactly as the app would hold it in its database: the
       * scope key it was installed with, its window, and the session key. A later run reuses it only if its own plan's scope
       * has the identical key, which is what the app does.
       */
      const saved =
        STANDING && existsSync(STANDING_FILE)
          ? (JSON.parse(readFileSync(STANDING_FILE, "utf8")) as StandingFile)
          : undefined;
      const storedPermissions: DelegatedPermission[] = saved
        ? [
            {
              id: "standing-1",
              userId: "smoke",
              walletId: "smoke-wallet",
              provider: "zerodev-kernel-v3.3",
              providerPermissionId: "standing-1",
              chainId: CELO_CHAIN_ID,
              status: "ACTIVE" as const,
              allowedOperations: saved.scope
                .allowedOperations as DelegatedPermission["allowedOperations"],
              allowedContracts: saved.scope.allowedContracts,
              allowedAssetIds: saved.scope.allowedAssetIds,
              perTransactionLimit: saved.scope.perTransactionLimit,
              enforcement: {} as DelegatedPermission["enforcement"],
              scopeKey: saved.scopeKey,
              validFrom: new Date(saved.validFrom),
              expiresAt: new Date(saved.expiresAt),
              sessionKeyAddress: saved.sessionKeyAddress,
              installedAt: new Date(saved.validFrom),
              createdAt: new Date(saved.validFrom),
            },
          ]
        : [];

      const plan = buildExecutionPlan({
        candidate,
        quote,
        transactions: firm.transactions,
        claimTokenStored: false,
        authorization,
        wallet,
        sellAsset: sell,
        buyAsset: buy,
        tokenPolicy: defaultTokenPolicy,
        currentAllowance,
        currentPermit2Allowance,
        permit2Grant: SETTINGS.execution.permit2Grant,
        ...(STANDING && { standingConversion: SETTINGS.execution.standingConversion }),
        deployed,
        // A real root exists now: the software device key.
        rootAvailable: true,
        infrastructure: { rpcConfigured: true, bundlerConfigured: true },
        permissions: storedPermissions,
        now,
      });
      console.log(`   plan status ${plan.status}  blockers [${plan.blockers.join(", ")}]`);
      console.log(
        `   deployment ${plan.accountRequirements.deploymentRequired ? "required" : "not needed"}, ` +
          `permission ${plan.permissionRequirement.state}, setup calls ${plan.setupRequirements.length}`,
      );
      if (plan.status === "READY") pass("the plan is READY with a real root (no NO_ROOT blocker)");
      else fail(`the plan is ${plan.status}: ${plan.blockers.join(", ")}`);
      if (
        permit2AllowanceCovers(currentPermit2Allowance, BigInt(SPEND), now) ===
        (plan.setupRequirements.length === 0)
      ) {
        pass("the Permit2 grant is asked for exactly when it is missing");
      } else {
        fail("the setup requirement does not match the on-chain grant");
      }

      const steps = plannedSteps(createId(), plan, firm.transactions.swap);
      for (const planned of steps) {
        console.log(
          `   step ${planned.kind.padEnd(8)} ${planned.calls.length} call(s) -> ${planned.toAddress}`,
        );
      }

      if (SIMULATE) {
        /*
         * FREE pre-flight of the SWAP step, run AS THE ACCOUNT. Kernel's `execute(mode, calldata)` only accepts the
         * EntryPoint (or the account itself), and an eth_call may name any `from`, so impersonating the EntryPoint
         * runs exactly the inner batch a UserOperation would run, with the account as msg.sender. It costs nothing,
         * shows the true revert reason where a bundler says only "refused", and needs the on-chain prerequisites
         * (the ERC-20 allowance and the Permit2 grant) to already be in place.
         */
        step(
          "simulate: the SWAP step as the account (eth_call from the EntryPoint, costs nothing)",
        );
        const swapStep = steps.find((planned) => planned.kind === "SWAP");
        if (!swapStep) throw new Error("the plan has no SWAP step");
        /* The swap pulls through BOTH allowances. A missing one is a missing prerequisite, not a defect in the swap. */
        const needsApproval = steps.some((planned) => planned.kind === "APPROVAL");
        if (needsApproval || plan.setupRequirements.length > 0) {
          console.log(
            `   not simulated: the account still needs ${needsApproval ? "the ERC-20 approval" : ""}` +
              `${needsApproval && plan.setupRequirements.length > 0 ? " and " : ""}` +
              `${plan.setupRequirements.length > 0 ? "the Permit2 grant" : ""} on chain first`,
          );
          throw new Error("prerequisites are not in place");
        }
        const ENTRY_POINT = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as Address;
        const { encodeFunctionData, encodeAbiParameters, parseAbi } = await import("viem");
        const executeAbi = parseAbi([
          "function execute(bytes32 execMode, bytes executionCalldata)",
        ]);
        /* ERC-7579 mode: call type 0x01 (batch), exec type 0x00 (revert on failure), the rest zero. */
        const BATCH_MODE = `0x01${"00".repeat(31)}` as Hex;
        type PlannedCall = { to: string; data: string; value: string };
        const batch = (calls: PlannedCall[]): Hex =>
          encodeFunctionData({
            abi: executeAbi,
            functionName: "execute",
            args: [
              BATCH_MODE,
              encodeAbiParameters(
                [
                  {
                    type: "tuple[]",
                    components: [
                      { name: "target", type: "address" },
                      { name: "value", type: "uint256" },
                      { name: "callData", type: "bytes" },
                    ],
                  },
                ],
                [
                  calls.map((c) => ({
                    target: c.to as Address,
                    value: BigInt(c.value),
                    callData: c.data as Hex,
                  })),
                ],
              ),
            ],
          });
        const attempt = async (calls: PlannedCall[]) => {
          try {
            await pub.call({ account: ENTRY_POINT, to: KERNEL, data: batch(calls) });
            return { ok: true as const };
          } catch (error) {
            return { ok: false as const, reason: firstLine(error).slice(0, 160) };
          }
        };

        const planned = await attempt(swapStep.calls);
        if (planned.ok) pass("the planned swap + payout batch succeeds as the account");
        else fail(`the planned swap + payout batch REVERTS as the account: ${planned.reason}`);

        /*
         * What does the swap really deliver? The payout is a transfer of the QUOTED output, so it reverts whenever the
         * swap delivers even one unit less. Bisect the transfer amount: the largest amount that still succeeds IS the
         * swap's actual output right now, to compare with the quote's promise.
         */
        const swapCall = swapStep.calls[0];
        const payoutCall = swapStep.calls[1];
        if (swapCall && payoutCall) {
          const quoted = BigInt(plan.payoutRequirement.amount);
          const withAmount = (amount: bigint): PlannedCall => ({
            ...payoutCall,
            data: `${payoutCall.data.slice(0, 10 + 64)}${amount.toString(16).padStart(64, "0")}`,
          });
          /*
           * The transfer draws on the account's WHOLE balance of the buy token, not only on what the swap just delivered,
           * so the largest amount that succeeds is (balance already held + swap output). Subtract what is already held, or
           * the search measures the wallet instead of the swap. This is also a real property of the payout leg, reported below.
           */
          const heldBefore = await tokenBalance(buy.contractAddress as Address, KERNEL);
          let lo = 0n;
          let hi = heldBefore + quoted + quoted / 50n; // 2% above the quote, on top of what is already held
          if ((await attempt([swapCall, withAmount(lo)])).ok) {
            while (hi - lo > 1n) {
              const mid = (lo + hi) / 2n;
              if ((await attempt([swapCall, withAmount(mid)])).ok) lo = mid;
              else hi = mid;
            }
            lo -= heldBefore;
            const drift = lo - quoted;
            console.log(
              `   account already holds ${heldBefore} of ${buy.symbol} (the payout can draw on it)`,
            );
            console.log(`   quoted output      ${quoted}`);
            console.log(`   actual deliverable ${lo}`);
            console.log(
              `   difference         ${drift}  (${drift >= 0n ? "the swap delivers at least the quote" : "the swap delivers LESS than the quote"})`,
            );
            if (lo >= quoted) pass("the swap delivers at least what the quote promised");
            else
              fail(
                `the swap delivers ${quoted - lo} less than quoted, so the exact-amount payout would revert`,
              );
          } else {
            fail(
              "the swap alone reverts as the account, so the delivered amount cannot be measured",
            );
          }
        }
      } else if (!EXECUTE) {
        console.log("\n   (quote-only: nothing was sent)");
      } else if (plan.status !== "READY") {
        fail("not executing a plan that is not READY");
      } else {
        const adapter = createZeroDevKernelAdapter({
          bundlerUrl,
          rpcUrl: RPC,
          attributionSuffix: attributionSuffix(),
        });
        const waitFor = async (label: string, userOpHash: string) => {
          const started = Date.now();
          let transientErrors = 0;
          for (let i = 0; i < 90; i += 1) {
            /*
             * A receipt poll that throws is an outage, not a verdict: the operation was already accepted, so it is
             * retried and never resent. This is what the production runner does (it marks the transaction unknown
             * and the reconciler polls again). Counted, so the report can say how often the RPC misbehaved.
             */
            const receipt = await adapter
              .getUserOperationReceipt(userOpHash)
              .catch((error: unknown) => {
                transientErrors += 1;
                if (transientErrors === 1)
                  console.log(
                    `   (receipt poll error, retrying: ${firstLine(error).slice(0, 80)})`,
                  );
                return null;
              });
            if (receipt === null) {
              await sleep(2_000);
              continue;
            }
            if (receipt.status === "INCLUDED") {
              const seconds = Math.round((Date.now() - started) / 1000);
              console.log(
                `   ${label}: included after ${seconds}s  success=${receipt.success}  tx ${receipt.txHash}`,
              );
              if (receipt.success) pass(`${label} succeeded on chain`);
              else fail(`${label} was included but REVERTED`);
              return receipt;
            }
            await sleep(2_000);
          }
          fail(`${label} was not included within 3 minutes`);
          return null;
        };

        const before = {
          sell: await tokenBalance(sell.contractAddress as Address, KERNEL),
          recipientBuy: await tokenBalance(buy.contractAddress as Address, RECIPIENT),
        };

        // A previous --standing run left a permission whose scope is identical: nothing needs the root at all.
        const reuse =
          STANDING &&
          saved !== undefined &&
          plan.permissionRequirement.state === "SATISFIED" &&
          !plan.accountRequirements.rootSignatureRequired;
        let sessionKeySecret: SecretValue | undefined;
        let approvalSecret: SecretValue | undefined;
        if (reuse && saved) {
          step(
            "NO root operation: the standing permission from an earlier run covers this conversion",
          );
          const stillInstalled = await adapter.isPermissionInstalled({
            walletAddress: KERNEL,
            sessionKeyAddress: saved.sessionKeyAddress,
            scope: {
              ...plan.permissionRequirement.scope,
              validFrom: new Date(saved.validFrom),
              expiresAt: new Date(saved.expiresAt),
            },
          });
          if (stillInstalled)
            pass("the standing permission reads back as installed on chain, no signature needed");
          else {
            fail("the standing permission is NOT installed on chain");
            throw new Error("standing permission missing");
          }
          sessionKeySecret = new SecretValue(saved.sessionKeyPrivateKey);
          approvalSecret = new SecretValue(saved.approval);
        } else {
          // 3. the ROOT operation: deploy the account, install the permission, grant Permit2. One passkey-equivalent signature.
          step(
            "root operation: deploy + permission + Permit2 grant, signed by the device-key root",
          );
          const prepared = await adapter.prepareRootOperation({
            walletAddress: KERNEL,
            credential: root,
            calls: plan.setupRequirements.map((r) => ({ to: r.to, data: r.data, value: r.value })),
            permission: { scope: plan.permissionRequirement.scope },
          });
          /*
           * The deposit the EntryPoint takes up front, against what the account holds. With no paymaster the account
           * itself pays, and AA21 "didn't pay prefund" means exactly that this figure exceeds the balance. Printing both
           * makes the cause visible instead of leaving it to be guessed from a one-line bundler error.
           */
          const op = prepared.prepared["userOperation"] as Record<string, unknown>;
          // The adapter's JSON-safe form writes a bigint as "bigint:<decimal>"; a plain hex string is also accepted.
          const hexToBig = (value: unknown): bigint => {
            if (typeof value !== "string") return 0n;
            if (/^bigint:\d+$/.test(value)) return BigInt(value.slice("bigint:".length));
            if (/^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
            return 0n;
          };
          const gas =
            hexToBig(op["callGasLimit"]) +
            hexToBig(op["verificationGasLimit"]) +
            hexToBig(op["preVerificationGas"]);
          const maxFee = hexToBig(op["maxFeePerGas"]);
          const balanceNow = await pub.getBalance({ address: KERNEL });
          console.log(
            `   gas limits ${gas} x maxFeePerGas ${maxFee} wei = prefund ${formatUnits(gas * maxFee, 18)} CELO` +
              `  |  account holds ${formatUnits(balanceNow, 18)} CELO`,
          );
          const payload = deviceKeyPayload({
            chainId: CELO_CHAIN_ID,
            validator: root.validatorAddress as Address,
            account: KERNEL,
            keyId,
            userOpHash: prepared.challenge as Hex,
          });
          const { r, s } = signPayload(payload);
          const sent = await adapter.sendRootOperation({
            prepared: prepared.prepared,
            proof: { type: "DEVICE_KEY", keyId, r, s },
          });
          console.log(`   accepted by the bundler: ${sent.userOpHash}`);
          const rootReceipt = await waitFor("root operation", sent.userOpHash);
          if (!rootReceipt || !prepared.sessionKey || !sent.approval)
            throw new Error("root operation did not complete");
          await sleep(6_000);

          const installed = await adapter.isPermissionInstalled({
            walletAddress: KERNEL,
            sessionKeyAddress: prepared.sessionKey.address,
            scope: plan.permissionRequirement.scope,
          });
          if (installed) pass("the permission reads back as installed on chain");
          else fail("the permission is NOT installed on chain");

          sessionKeySecret = prepared.sessionKey.privateKey;
          approvalSecret = sent.approval;
          if (STANDING && installed) {
            const scope = plan.permissionRequirement.scope;
            const file: StandingFile = {
              scopeKey: permissionScopeKey(scope),
              scope: {
                allowedOperations: scope.allowedOperations,
                allowedContracts: scope.allowedContracts,
                allowedAssetIds: scope.allowedAssetIds,
                perTransactionLimit: scope.perTransactionLimit,
              },
              validFrom: scope.validFrom.toISOString(),
              expiresAt: scope.expiresAt.toISOString(),
              sessionKeyAddress: prepared.sessionKey.address,
              sessionKeyPrivateKey: prepared.sessionKey.privateKey.reveal(),
              approval: sent.approval.reveal(),
            };
            writeFileSync(
              STANDING_FILE,
              `${JSON.stringify(file, null, 2)}
`,
              { mode: 0o600 },
            );
            console.log(
              "   (kept the standing permission for the next run, outside the repository)",
            );
          }
        }
        if (!sessionKeySecret || !approvalSecret) throw new Error("no session key to sign with");
        // 4. each planned step as a DELEGATED operation, signed by the restricted session key under the call policies.
        step("delegated operations: signed by the session key, under the on-chain call policies");
        for (const planned of steps) {
          try {
            const op = await adapter.sendDelegatedCalls({
              walletAddress: KERNEL,
              sessionKey: sessionKeySecret,
              approval: approvalSecret,
              calls: planned.calls,
            });
            console.log(`   ${planned.kind}: accepted by the bundler: ${op.userOpHash}`);
            const done = await waitFor(
              `${planned.kind} (${planned.calls.length} call(s) in one UserOperation)`,
              op.userOpHash,
            );
            if (!done?.success) break;
          } catch (error) {
            fail(`${planned.kind} was refused: ${firstLine(error).slice(0, 140)}`);
            // The bundler's own one-line reason; the adapter strips calldata and keys before it reaches `details`.
            const details = (error as { details?: unknown } | null)?.details;
            if (details !== undefined)
              console.log(`   reason: ${JSON.stringify(details).slice(0, 500)}`);
            break;
          }
        }

        // 5. what actually happened to the money
        await sleep(6_000);
        const after = {
          sell: await tokenBalance(sell.contractAddress as Address, KERNEL),
          recipientBuy: await tokenBalance(buy.contractAddress as Address, RECIPIENT),
        };
        const spent = before.sell - after.sell;
        const delivered = after.recipientBuy - before.recipientBuy;
        console.log(
          `\n   Kernel ${sell.symbol}:   ${before.sell} -> ${after.sell}   (spent ${spent})`,
        );
        console.log(
          `   recipient ${buy.symbol}: ${before.recipientBuy} -> ${after.recipientBuy}   (+${delivered})`,
        );
        if (spent === BigInt(SPEND)) pass(`spent exactly the authorised ${SPEND}`);
        else fail(`spent ${spent}, authorised ${SPEND}`);
        if (STANDING) {
          // A conversion pays back to the account itself, so what it gained is what the swap delivered.
          const floor =
            (BigInt(plan.payoutRequirement.amount) *
              BigInt(10_000 - Math.round(SETTINGS.uniswap.slippagePercent * 100) - 1)) /
            10_000n;
          if (delivered >= floor)
            pass(
              `the conversion delivered ${delivered} ${buy.symbol} to the account (at least ${floor})`,
            );
          else fail(`the conversion delivered ${delivered}, below the floor ${floor}`);
        } else if (delivered === BigInt(plan.payoutRequirement.amount)) {
          pass(`the recipient received exactly the promised ${delivered}`);
        } else {
          fail(
            `the recipient received ${delivered}, the plan promised ${plan.payoutRequirement.amount}`,
          );
        }
      }
    } finally {
      await database.close();
    }
  }
} catch (error) {
  fail(`stopped: ${firstLine(error).slice(0, 160)}`);
  // The adapter keeps the bundler's own one-line reason (for example "AA23 reverted") in `details`. It carries no
  // calldata and no keys by construction, so it is safe to print, and it is the only way to tell WHY it refused.
  const details = (error as { details?: unknown } | null)?.details;
  if (details !== undefined) console.log(`   reason: ${JSON.stringify(details).slice(0, 400)}`);
}

console.log(`\n${problems === 0 ? "ALL CHECKS PASSED" : `${problems} CHECK(S) FAILED`}`);
process.exit(problems === 0 ? 0 : 1);
