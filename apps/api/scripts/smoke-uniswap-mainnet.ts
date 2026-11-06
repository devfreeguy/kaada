/*
 * Live END-TO-END check of the Uniswap integration on CELO MAINNET, through Kaada's own code.
 *
 * NOT part of `pnpm test`. It can spend REAL money, so it must be asked for explicitly:
 *
 *   pnpm --filter @kaada/api smoke:uniswap -- --quote-only
 *   pnpm --filter @kaada/api smoke:uniswap -- --execute --confirm-mainnet
 *   pnpm --filter @kaada/api smoke:uniswap -- --execute --confirm-mainnet --reverse
 *
 * `--reverse` runs wARS -> cNGN instead. It is a SEPARATE check, not an inference from the forward
 * one: an AMM pair is directional, and assuming otherwise is how a one-way corridor gets advertised.
 *
 * WHAT IS REAL: the production RoutingService over the real capability rows in DATABASE_URL; the real
 * UniswapFirmQuoteProvider against the live Trading API; the real `buildExecutionPlan` over live chain
 * reads (ERC-20 allowance, Permit2 allowance, deployment); and the real `plannedSteps`, which turns a
 * plan into the exact calls the executor would send.
 *
 * WHAT IS SUBSTITUTED, and why. The Kernel smart account and its signer. A Kaada wallet is a smart
 * account whose root is either a passkey (a hardware prompt, impossible from a script) or a device key
 * (whose validator clone can only be deployed by the single relayer address the contracts were
 * deployed with). So the calls the plan produces are sent from a plain test EOA instead.
 *
 * That proves the CALLDATA and the money movement. It does NOT prove the UserOperation signing path,
 * which has its own unit tests and its own Celo Sepolia runner. This distinction is the whole point of
 * the script: it is honest about which link is covered here and which is not.
 *
 * Secrets: the test key is read from a file outside the repository and is never printed.
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env; rely on the real environment.
}

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SETTINGS } from "@kaada/config";
import { createDatabase, createRepositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  PERMIT2,
  createAssetRegistry,
  createId,
  createMoney,
  permit2AllowanceCovers,
} from "@kaada/domain";
import type {
  Asset,
  FirmExecutionCandidate,
  FirmQuote,
  PaymentAuthorization,
  RoutingRequest,
  Wallet,
} from "@kaada/domain";

import { buildExecutionPlan } from "../src/core/execution/plan-builder.js";
import { plannedSteps } from "../src/core/execution/steps.js";
import { defaultTokenPolicy } from "../src/core/execution/token-policy.js";
import { createRoutingService } from "../src/infrastructure/fx/pricing.js";
import {
  UniswapClient,
  UniswapFirmQuoteProvider,
  createUniswapFetchTransport,
  readRouterCall,
} from "../src/infrastructure/fx/uniswap/index.js";

const args = process.argv.slice(2).filter((a) => a !== "--");
const has = (name: string) => args.includes(`--${name}`);
const EXECUTE = has("execute");
if (!EXECUTE && !has("quote-only")) {
  console.error("Choose explicitly: --quote-only, or --execute --confirm-mainnet");
  process.exit(1);
}
if (EXECUTE && !has("confirm-mainnet")) {
  console.error("--execute spends real money on Celo mainnet. Re-run with --confirm-mainnet.");
  process.exit(1);
}

/*
 * Where the throwaway test keys live: OUTSIDE the repository, so they can never be committed. Override with
 * KAADA_TEST_WALLET_DIR; the default is a folder in your home directory. Nothing here is a Kaada user wallet.
 */
const DIR = process.env["KAADA_TEST_WALLET_DIR"] ?? join(homedir(), ".kaada-test-wallet");
const KEY_FILE = join(DIR, "celo-test-eoa.json");
const stored = JSON.parse(readFileSync(KEY_FILE, "utf8")) as {
  address: string;
  privateKey: string;
};
const WALLET_ADDRESS = stored.address.toLowerCase();
/** The payee: the same wallet, so no real funds are ever sent to an address this run did not fund. */
const RECIPIENT = WALLET_ADDRESS;

const databaseUrl = process.env["DATABASE_URL"];
const uniswapKey = process.env["UNISWAP_API_KEY"];
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!uniswapKey) throw new Error("UNISWAP_API_KEY is required");

const REVERSE = has("reverse");
/**
 * 100 cNGN forward, 100 wARS back. Both clear the $0.50 floor and are small enough to repeat on a
 * 1,500 naira balance.
 */
const SPEND = REVERSE ? "100000000000000000000" : "100000000";

const RPC = process.env["CELO_RPC_URL"] ?? "https://forno.celo.org";

const database = createDatabase({ url: databaseUrl, poolMax: 3, poolTimeoutMs: 20_000 });
let problems = 0;
const pass = (text: string) => console.log(`   PASS  ${text}`);
const fail = (text: string) => {
  problems += 1;
  console.log(`   FAIL  ${text}`);
};
const step = (text: string) => console.log(`\n── ${text}`);
/** The first line of an error: viem messages embed the whole request and run to pages. */
const firstLine = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const [first] = message.split(/\r?\n/);
  return (first ?? message).trim();
};

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

  console.log(`wallet    ${WALLET_ADDRESS}`);
  console.log(`spending  ${SPEND} ${sell.symbol} -> ${buy.symbol}`);
  console.log(`mode      ${EXECUTE ? "EXECUTE (real transactions)" : "quote only"}`);

  // ───────────────────────────── 1. routing ─────────────────────────────
  step("1. routing, over the real capability rows in the database");
  const routing = createRoutingService(
    {
      nodeEnv: "development",
      // The real settings, not hand-typed numbers: the figures the app would use are the figures tested.
      fx: {
        provider: "textile",
        textile: {
          env: "live" as const,
          apiKey: process.env["TEXTILE_LIVE_API_KEY"] ?? "",
          apiUrl: SETTINGS.textile.apiUrl,
          timeoutMs: SETTINGS.textile.timeoutMs,
        },
        uniswap: {
          apiKey: uniswapKey,
          apiUrl: SETTINGS.uniswap.apiUrl,
          timeoutMs: SETTINGS.uniswap.timeoutMs,
          slippagePercent: SETTINGS.uniswap.slippagePercent,
          quoteLifetimeMs: SETTINGS.uniswap.quoteLifetimeMs,
        },
      },
    },
    { assets: repositories.assets, providers: repositories.providers, read: repositories },
  );
  if (!routing) throw new Error("the routing service was not built");

  const routingRequest: RoutingRequest = {
    intentId: "00000000-0000-4000-8000-000000000000",
    intentRevision: 1,
    userId: "smoke",
    operation: "QUOTE",
    purpose: "QUOTE",
    amount: createMoney(SPEND, sell.id),
    amountMode: "EXACT_INPUT",
    sourceAssetId: sell.id,
    destinationAssetId: buy.id,
  };
  const outcome = await routing.plan(routingRequest);
  if (outcome.status !== "PLANNED") {
    fail(`not planned: ${JSON.stringify(outcome).slice(0, 240)}`);
  } else {
    const providers = outcome.route.hops.map((hop) => hop.providerId);
    console.log(`   ${outcome.route.hops.length} hop(s) via ${providers.join(" > ")}`);
    console.log(
      `   ${outcome.route.input.amount} ${sell.symbol} -> ${outcome.route.output.amount} ${buy.symbol}`,
    );
    if (providers.length === 1 && providers[0] === "uniswap") {
      pass("one atomic hop, chosen on Uniswap, from the seeded capability rows");
    } else {
      fail(`expected a single uniswap hop, got ${providers.join(">")}`);
    }
  }

  // ───────────────────────────── 2. firm quote ─────────────────────────────
  step("2. firm quote from the real UniswapFirmQuoteProvider");
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
    taker: WALLET_ADDRESS,
  });
  if (firm.status !== "QUOTED") {
    fail(`firm quote failed: ${firm.code} ${firm.providerReason ?? ""}`);
    throw new Error("cannot continue without a firm quote");
  }
  console.log(`   out ${firm.quote.output.amount} ${buy.symbol}`);
  console.log(`   expires ${firm.quote.expiresAt.toISOString()}  (the router's own deadline)`);
  if (firm.quote.spender === PERMIT2) pass("spender is Permit2");
  else fail(`spender is ${String(firm.quote.spender)}, expected Permit2`);
  if (firm.claimToken === undefined) pass("no claim token, which is correct for an AMM");
  else fail("a claim token was issued, which an AMM cannot honour");
  const decoded = readRouterCall(firm.transactions.swap.data);
  if (decoded.ok) pass(`router commands: ${decoded.call.commandNames.join(",")}`);
  else fail(`calldata refused: ${decoded.problem}`);

  // ───────────────────────────── 3. the plan ─────────────────────────────
  step("3. the real execution plan, over live chain reads");
  const {
    createViemAllowanceReader,
    createViemPermit2AllowanceReader,
    createViemDeploymentChecker,
  } = await import("@kaada/blockchain");
  const allowances = createViemAllowanceReader({ rpcUrl: RPC });
  const permit2Allowances = createViemPermit2AllowanceReader({ rpcUrl: RPC });
  const deployment = createViemDeploymentChecker({ rpcUrl: RPC });

  const spender = firm.quote.spender ?? firm.quote.reactor ?? "";
  const [currentAllowance, currentPermit2Allowance, deployed] = await Promise.all([
    allowances.readAllowance({
      chainId: CELO_CHAIN_ID,
      token: sell.contractAddress,
      owner: WALLET_ADDRESS,
      spender,
    }),
    permit2Allowances.readPermit2Allowance({
      chainId: CELO_CHAIN_ID,
      owner: WALLET_ADDRESS,
      token: sell.contractAddress,
      spender: firm.transactions.swap.to,
    }),
    deployment.isDeployed({ chainId: CELO_CHAIN_ID, address: WALLET_ADDRESS }),
  ]);
  console.log(`   ERC-20 -> Permit2        ${currentAllowance}`);
  console.log(
    `   Permit2 -> router        ${currentPermit2Allowance.amount} (expires ${currentPermit2Allowance.expiration})`,
  );

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
    operation: "SEND",
    recipient: { address: RECIPIENT },
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
    address: WALLET_ADDRESS,
    chainId: CELO_CHAIN_ID,
    status: "ACTIVE",
  } as unknown as Wallet & { address: string };

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
    deployed,
    // A plain EOA has no Kaada root credential; the signing path is out of scope here by design.
    rootAvailable: false,
    infrastructure: { rpcConfigured: true, bundlerConfigured: true },
    permissions: [],
    now,
  });

  console.log(`   status ${plan.status}  blockers [${plan.blockers.join(", ")}]`);
  const approval = plan.approvalRequirements[0];
  if (approval) {
    console.log(`   approval  spender=${approval.spender} amount=${approval.requiredAllowance}`);
    if (approval.requiredAllowance === SPEND) pass("the ERC-20 approval is bounded to this swap");
    else fail(`the approval is ${approval.requiredAllowance}, expected ${SPEND}`);
  }
  const grantCovered = permit2AllowanceCovers(currentPermit2Allowance, BigInt(SPEND), now);
  console.log(
    `   setup requirements: ${plan.setupRequirements.length} (Permit2 grant ${grantCovered ? "already covers this swap" : "needed"})`,
  );
  if (grantCovered === (plan.setupRequirements.length === 0)) {
    pass("the Permit2 grant is asked for exactly when it is missing");
  } else {
    fail("the setup requirement does not match the on-chain grant");
  }
  // NO_ROOT is expected and correct: an EOA has no Kaada root. Nothing else may be blocking.
  const unexpected = plan.blockers.filter((b) => b !== "NO_ROOT");
  if (unexpected.length === 0) pass("no blocker other than the expected NO_ROOT");
  else fail(`unexpected blockers: ${unexpected.join(", ")}`);

  // ───────────────────────────── 4. the exact calls ─────────────────────────────
  step("4. the exact calls the executor would send");
  const executionId = createId();
  const steps = plannedSteps(executionId, plan, firm.transactions.swap);
  for (const planned of steps) {
    console.log(
      `   ${planned.kind.padEnd(14)} ${planned.calls.length} call(s) -> ${planned.toAddress}`,
    );
    for (const call of planned.calls) {
      console.log(
        `      to=${call.to} value=${call.value} selector=${call.data.slice(0, 10)} bytes=${(call.data.length - 2) / 2}`,
      );
    }
  }
  const swapStep = steps.find((s) => s.kind === "SWAP");
  if (swapStep?.calls.length === 2) {
    pass("the swap and the payout are ONE step, so they succeed or revert together");
  } else {
    fail("the swap step is not the expected swap+payout pair");
  }

  // ───────────────────────────── 5. on chain ─────────────────────────────
  step(
    EXECUTE
      ? "5. executing those calls on Celo mainnet"
      : "5. simulating those calls (spends nothing)",
  );
  const { createPublicClient, createWalletClient, http, erc20Abi } = await import("viem");
  const { celo } = await import("viem/chains");
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(stored.privateKey as `0x${string}`);
  const pub = createPublicClient({ chain: celo, transport: http(RPC) });
  const signer = createWalletClient({ account, chain: celo, transport: http(RPC) });

  /** Balances pinned to a block, with a catch-up retry: a read at "latest" can hit a lagging node. */
  const balanceAt = async (token: string, blockNumber: bigint): Promise<bigint> => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        return await pub.readContract({
          address: token as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
          blockNumber,
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error("the node never caught up to that block");
  };

  /*
   * Each eth_call runs against CURRENT state, independently: a simulated approval does not persist, so
   * simulating a swap that depends on it would revert with TRANSFER_FROM_FAILED and say nothing useful.
   *
   * So only steps whose prerequisites are ALREADY satisfied on chain are simulated here. The rest are
   * reported as needing the earlier step to have really landed, which is what --execute does.
   */
  const needed = BigInt(SPEND);
  const approvalReady = currentAllowance >= needed;
  const grantReady = permit2AllowanceCovers(currentPermit2Allowance, needed, now);
  for (const planned of steps) {
    // Named individually, so the line says which prerequisite is missing rather than guessing.
    const missing =
      planned.kind === "SWAP"
        ? [
            ...(approvalReady ? [] : [`ERC-20 allowance ${currentAllowance} < ${needed}`]),
            ...(grantReady ? [] : ["the Permit2 grant is absent or expired"]),
          ]
        : [];
    if (missing.length > 0) {
      console.log(
        `   ${planned.kind.padEnd(14)} not simulated: ${missing.join("; ")} (--execute does it first)`,
      );
      continue;
    }
    try {
      for (const call of planned.calls) {
        await pub.call({
          account,
          to: call.to as `0x${string}`,
          data: call.data as `0x${string}`,
          value: BigInt(call.value),
        });
      }
      pass(`${planned.kind} simulates successfully against mainnet state`);
    } catch (error) {
      fail(`${planned.kind} would revert: ${firstLine(error).slice(0, 90)}`);
    }
  }

  if (!EXECUTE) {
    console.log("\n   (quote-only: nothing was sent)");
  } else {
    let lastBlock = 0n;
    /*
     * The plan's one-time SETUP calls, first.
     *
     * In the real system these are signed by the wallet's ROOT, in the same operation as the account
     * deployment and the permission install. Here the test EOA is its own root, so it signs them
     * itself. Skipping them is what made the first reverse run revert: the plan had correctly asked
     * for a Permit2 grant and the script had ploughed straight past it.
     */
    for (const requirement of plan.setupRequirements) {
      try {
        const hash = await signer.sendTransaction({
          to: requirement.to as `0x${string}`,
          data: requirement.data as `0x${string}`,
          value: BigInt(requirement.value),
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        lastBlock = receipt.blockNumber;
        console.log(
          `   SETUP ${requirement.purpose} ${receipt.status}  gas ${receipt.gasUsed}  ${hash}`,
        );
        if (receipt.status !== "success") fail(`setup ${requirement.purpose} reverted`);
      } catch (error) {
        const reason = firstLine(error);
        fail(`setup ${requirement.purpose} failed: ${String(reason).slice(0, 100)}`);
      }
    }
    for (const planned of steps) {
      // Each planned step is one UserOperation; sent here as one transaction per call, since an EOA
      // cannot batch. The SWAP step's two calls therefore lose atomicity in THIS script only.
      for (const call of planned.calls) {
        try {
          const hash = await signer.sendTransaction({
            to: call.to as `0x${string}`,
            data: call.data as `0x${string}`,
            value: BigInt(call.value),
          });
          const receipt = await pub.waitForTransactionReceipt({ hash });
          lastBlock = receipt.blockNumber;
          console.log(
            `   ${planned.kind.padEnd(14)} ${receipt.status}  gas ${receipt.gasUsed}  ${hash}`,
          );
          if (receipt.status !== "success") fail(`${planned.kind} reverted on chain`);
        } catch (error) {
          // A pre-flight revert: reported against the step that caused it, never as a crash.
          const reason = firstLine(error);
          fail(`${planned.kind} refused before sending: ${String(reason).slice(0, 110)}`);
        }
      }
    }
    const sent =
      steps.reduce((n, step) => n + step.calls.length, 0) + plan.setupRequirements.length;
    const before = lastBlock - BigInt(sent) - 1n;
    const [sellBefore, sellAfter, buyBefore, buyAfter] = await Promise.all([
      balanceAt(sell.contractAddress, before),
      balanceAt(sell.contractAddress, lastBlock),
      balanceAt(buy.contractAddress, before),
      balanceAt(buy.contractAddress, lastBlock),
    ]);
    console.log(`\n   ${sell.symbol}  ${sellBefore} -> ${sellAfter}  (${sellAfter - sellBefore})`);
    console.log(`   ${buy.symbol}  ${buyBefore} -> ${buyAfter}  (+${buyAfter - buyBefore})`);
    const delivered = buyAfter - buyBefore;
    const promised = BigInt(plan.payoutRequirement.amount);
    if (delivered >= promised) {
      pass(`delivered ${delivered} >= the ${promised} the plan promised`);
    } else {
      fail(`delivered ${delivered}, the plan promised ${promised}`);
    }
  }
} finally {
  await database.close();
}

console.log(`\n${problems === 0 ? "ALL CHECKS PASSED" : `${problems} CHECK(S) FAILED`}`);
process.exit(problems === 0 ? 0 : 1);
