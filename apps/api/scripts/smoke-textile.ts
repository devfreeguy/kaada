/*
 * Manual live check of the Textile adapter. NOT part of CI. QUOTE ONLY: it requests indicative RFQ
 * prices (POST /v2/rfq/preview) and nothing else. It never submits, cancels, executes or signs, has no
 * wallet, and persists nothing.
 *
 * The Textile environment is explicit; there is no default and no fallback between them:
 *   --env=test                  uses TEXTILE_TEST_API_KEY; only the sandbox chains 97 and 84532
 *                               (cNGN <-> USDT / cNGN <-> USDC). Textile has NO Celo testnet.
 *   --env=live --confirm-live   uses TEXTILE_LIVE_API_KEY; Celo mainnet (42220). The key is
 *                               production-scoped, so the extra flag is required. Reads the Celo
 *                               assets from DATABASE_URL (read only).
 *   --routing                   (live) also plans USDC -> USDT -> wBRL through RoutingService
 *                               without persisting it.
 *   --chain=97|84532            (test) run one sandbox corridor instead of both.
 *
 * Run: pnpm --filter @kaada/api smoke:textile -- --env=test
 *      pnpm --filter @kaada/api smoke:textile -- --env=live --confirm-live
 *
 * Secrets are never printed: only the environment name, the public key prefix (documented as safe to
 * log), amounts and Textile's request ids.
 */
import { ConfigError, loadTextileCredentials } from "@kaada/config";
import type { TextileCredentials } from "@kaada/config";
import { createDatabase, createRepositories } from "@kaada/database";
import {
  CELO_CHAIN_ID,
  createAssetRegistry,
  createFxProviderDirectory,
  createMoney,
  createProviderCapabilityRegistry,
  createRoutePlanner,
  createRoutingCandidateResolver,
  createSettlementAssetResolver,
  defaultCountryDirectory,
} from "@kaada/domain";
import type { Asset, AssetRegistry, FxQuote, QuoteRequest, RoutingRequest } from "@kaada/domain";

import { RoutingService, formatAmount } from "../src/core/routing/routing-service.js";
import {
  TextileClient,
  TextileClientError,
  TextileFxProvider,
  createFetchTransport,
} from "../src/infrastructure/fx/textile/index.js";
import {
  SANDBOX_CORRIDORS,
  assertChainForEnvironment,
} from "../src/infrastructure/fx/textile/sandbox.js";

try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  // No .env file; rely on the real environment.
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const has = (name: string) => args.includes(`--${name}`);

const environment = flag("env");
if (environment !== "test" && environment !== "live") {
  console.error(
    "Choose the Textile environment explicitly: --env=test or --env=live --confirm-live",
  );
  process.exit(1);
}
if (environment === "live" && !has("confirm-live")) {
  console.error(
    "The live key is production-scoped. Re-run with --confirm-live to request (quote-only) prices.",
  );
  process.exit(1);
}

let credentials: TextileCredentials;
try {
  credentials = loadTextileCredentials(environment);
} catch (error) {
  if (error instanceof ConfigError && error.message.endsWith("is not set")) {
    console.log("Textile credentials are not configured. Live smoke test skipped.");
    process.exit(2);
  }
  console.error(error instanceof ConfigError ? error.message : "invalid Textile configuration");
  process.exit(1);
}

const publicPrefix = credentials.apiKey.includes(".")
  ? credentials.apiKey.split(".")[0]
  : "(hidden)";
console.log(
  `environment=${environment} key=${publicPrefix} api=${credentials.apiUrl} timeoutMs=${credentials.timeoutMs}\n` +
    "QUOTE ONLY: indicative prices (POST /v2/rfq/preview). Nothing is submitted or executed.\n",
);

const client = new TextileClient({
  transport: createFetchTransport({ baseUrl: credentials.apiUrl, apiKey: credentials.apiKey }),
  timeoutMs: credentials.timeoutMs,
});

const failure = (error: unknown): string => {
  if (error instanceof TextileClientError) {
    const { meta } = error;
    return `${error.kind} http=${meta.httpStatus ?? "-"} code=${meta.providerCode ?? "-"} reason=${meta.reason ?? "-"} request=${meta.requestId ?? "-"} attempts=${meta.attempts}`;
  }
  if (error instanceof Error) {
    const details = (error as { details?: unknown }).details;
    return `${error.name}: ${error.message}${details ? ` ${JSON.stringify(details)}` : ""}`;
  }
  return "unknown error";
};

let problems = 0;

if (environment === "test") {
  const only = flag("chain");
  for (const corridor of SANDBOX_CORRIDORS) {
    if (only !== undefined && String(corridor.chainId) !== only) continue;
    assertChainForEnvironment("test", corridor.chainId);
    const { cngn, counter } = corridor.tokens;
    const atoms = (human: string, decimals: number) => {
      const [whole = "0", fraction = ""] = human.split(".");
      return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
    };
    const cases = [
      {
        label: `exact-input  ${cngn.symbol} -> ${counter.symbol}`,
        sell: cngn,
        buy: counter,
        exact: { mode: "EXACT_INPUT" as const, sellAmount: atoms("100", cngn.decimals) },
      },
      {
        label: `exact-output ${cngn.symbol} -> ${counter.symbol}`,
        sell: cngn,
        buy: counter,
        exact: { mode: "EXACT_OUTPUT" as const, buyAmount: atoms("0.05", counter.decimals) },
      },
      {
        label: `exact-input  ${counter.symbol} -> ${cngn.symbol}`,
        sell: counter,
        buy: cngn,
        exact: { mode: "EXACT_INPUT" as const, sellAmount: atoms("0.05", counter.decimals) },
      },
      {
        label: `exact-output ${counter.symbol} -> ${cngn.symbol}`,
        sell: counter,
        buy: cngn,
        exact: { mode: "EXACT_OUTPUT" as const, buyAmount: atoms("100", cngn.decimals) },
      },
    ];
    console.log(`== ${corridor.name} (chain ${corridor.chainId})`);
    for (const test of cases) {
      try {
        const started = Date.now();
        const { data, meta } = await client.preview({
          chainId: corridor.chainId,
          sellToken: test.sell.address,
          buyToken: test.buy.address,
          exact: test.exact,
        });
        if (data.status === "no_quote") {
          console.log(
            `${test.label}: no_quote reason=${data.reason ?? "-"} request=${meta.requestId ?? "-"}`,
          );
        } else {
          console.log(
            `${test.label}: sell=${formatAmount(data.sellAmount, test.sell.decimals)} ${test.sell.symbol} ` +
              `takerPays=${formatAmount(data.takerPays, test.sell.decimals)} fee=${formatAmount(data.feeAmount, test.sell.decimals)} ` +
              `buy=${formatAmount(data.buyAmount, test.buy.decimals)} ${test.buy.symbol} ` +
              `| raw sell=${data.sellAmount} buy=${data.buyAmount} fee=${data.feeAmount} takerPays=${data.takerPays} rateRay=${data.rateRay ?? "-"} ` +
              `| latency=${Date.now() - started}ms attempts=${meta.attempts} request=${meta.requestId ?? "-"}`,
          );
        }
      } catch (error) {
        problems += 1;
        console.log(`${test.label}: FAILED ${failure(error)}`);
      }
    }
    console.log("");
  }
  process.exit(problems === 0 ? 0 : 1);
}

// ── live: Celo mainnet through the real adapter ──────────────────────────────────────────────────
assertChainForEnvironment("live", CELO_CHAIN_ID);
const url = process.env["DATABASE_URL"];
if (!url) {
  console.error("DATABASE_URL is required to read the Celo assets (read only).");
  process.exit(1);
}
const database = createDatabase({ url, poolMax: 2, poolTimeoutMs: 20_000 });
try {
  const repositories = createRepositories(database);
  const registry: AssetRegistry = createAssetRegistry(repositories.assets);
  const bySymbol = async (symbol: string): Promise<Asset> => {
    const [asset] = await registry.findBySymbol(symbol, { chainId: CELO_CHAIN_ID });
    if (!asset) throw new Error(`${symbol} is not seeded on Celo (run pnpm db:seed)`);
    return asset;
  };
  const [usdt, usdc, wbrl] = await Promise.all([
    bySymbol("USDT"),
    bySymbol("USDC"),
    bySymbol("wBRL"),
  ]);
  const provider = new TextileFxProvider({ assets: registry, client, now: () => new Date() });
  const human = (value: string, asset: Asset) => {
    const [whole = "0", fraction = ""] = value.split(".");
    return createMoney(BigInt(whole + fraction.padEnd(asset.decimals, "0")).toString(), asset.id);
  };
  const show = (quote: FxQuote, from: Asset, to: Asset) => {
    const view = (m: { amount: string; assetId: string }, a: Asset) =>
      `${formatAmount(m.amount, a.decimals)} ${a.symbol}`;
    const expires = quote.expiresAt
      ? `${Math.max(0, quote.expiresAt.getTime() - Date.now())} ms`
      : "none";
    console.log(
      `   input=${view(quote.input, from)} output=${view(quote.output, to)} fee=${quote.fee ? view(quote.fee, from) : "-"} ` +
        `slippageBps=${quote.slippageBps ?? "(none given)"} providerQuoteId=${quote.providerQuoteId ?? "(none on a preview)"} ` +
        `expiresIn=${expires} indicative=${quote.metadata?.["indicative"] === true ? "yes" : "no"}`,
    );
  };

  const cases: { label: string; request: QuoteRequest; from: Asset; to: Asset }[] = [
    {
      label: "exact-input  2 USDT -> wBRL",
      from: usdt,
      to: wbrl,
      request: {
        userId: "smoke",
        inputAssetId: usdt.id,
        outputAssetId: wbrl.id,
        amount: human("2", usdt),
        mode: "EXACT_INPUT",
      },
    },
    {
      label: "exact-output 10 wBRL from USDT",
      from: usdt,
      to: wbrl,
      request: {
        userId: "smoke",
        inputAssetId: usdt.id,
        outputAssetId: wbrl.id,
        amount: human("10", wbrl),
        mode: "EXACT_OUTPUT",
      },
    },
    {
      label: "exact-input  2 USDT -> USDC",
      from: usdt,
      to: usdc,
      request: {
        userId: "smoke",
        inputAssetId: usdt.id,
        outputAssetId: usdc.id,
        amount: human("2", usdt),
        mode: "EXACT_INPUT",
      },
    },
    {
      label: "exact-input  2 USDC -> USDT",
      from: usdc,
      to: usdt,
      request: {
        userId: "smoke",
        inputAssetId: usdc.id,
        outputAssetId: usdt.id,
        amount: human("2", usdc),
        mode: "EXACT_INPUT",
      },
    },
    {
      label: "exact-input  10 wBRL -> USDT",
      from: wbrl,
      to: usdt,
      request: {
        userId: "smoke",
        inputAssetId: wbrl.id,
        outputAssetId: usdt.id,
        amount: human("10", wbrl),
        mode: "EXACT_INPUT",
      },
    },
    {
      label: "direct USDC -> wBRL (NOT a verified corridor; Textile's own answer)",
      from: usdc,
      to: wbrl,
      request: {
        userId: "smoke",
        inputAssetId: usdc.id,
        outputAssetId: wbrl.id,
        amount: human("2", usdc),
        mode: "EXACT_INPUT",
      },
    },
  ];
  for (const test of cases) {
    console.log(test.label);
    try {
      show(await provider.quote(test.request), test.from, test.to);
    } catch (error) {
      if (!test.label.startsWith("direct")) problems += 1;
      console.log(
        `   ${test.label.startsWith("direct") ? "answered" : "FAILED"}: ${failure(error)}`,
      );
    }
  }

  if (has("routing")) {
    const capabilities = createProviderCapabilityRegistry(repositories.providers);
    console.log(
      `
capability registry: USDC->wBRL direct supported = ${String(await capabilities.supportsPair({ chainId: CELO_CHAIN_ID, inputAssetId: usdc.id, outputAssetId: wbrl.id, capability: "QUOTE" }))}`,
    );
    const routing = new RoutingService({
      candidates: createRoutingCandidateResolver({
        assets: registry,
        settlement: createSettlementAssetResolver(registry),
        capabilities,
        countries: defaultCountryDirectory,
        maxHops: 2,
      }),
      planner: createRoutePlanner({
        assets: registry,
        capabilities,
        fx: createFxProviderDirectory([{ capabilityProvider: "textile", provider }]),
        now: () => new Date(),
      }),
      assets: registry,
      read: repositories,
    });
    // Plan only: nothing is persisted. The second scenario exists because a leg can have no live
    // makers at a given moment (seen: USDC -> USDT), which says nothing about the code.
    const scenarios: { label: string; from: Asset; to: Asset; amount: string }[] = [
      { label: "USDC -> USDT -> wBRL", from: usdc, to: wbrl, amount: "2" },
      { label: "wBRL -> USDT -> USDC", from: wbrl, to: usdc, amount: "10" },
    ];
    for (const scenario of scenarios) {
      console.log(`routing ${scenario.label} (plan only, nothing persisted)`);
      const request: RoutingRequest = {
        intentId: "00000000-0000-4000-8000-000000000000",
        intentRevision: 1,
        userId: "smoke",
        operation: "QUOTE",
        purpose: "QUOTE",
        amount: human(scenario.amount, scenario.from),
        amountMode: "EXACT_INPUT",
        sourceAssetId: scenario.from.id,
        destinationAssetId: scenario.to.id,
      };
      try {
        const outcome = await routing.plan(request);
        if (outcome.status === "PLANNED") {
          const { route } = outcome;
          const symbol = (id: string) => [usdt, usdc, wbrl].find((a) => a.id === id);
          console.log(
            `   ${route.hops.length} hop(s) via ${route.hops.map((h) => h.providerId).join(" > ")}; ` +
              `${route.hops.map((h) => `${symbol(h.input.assetId)?.symbol}>${symbol(h.output.assetId)?.symbol}`).join(", ")}`,
          );
          route.hops.forEach((h, i) =>
            console.log(
              `   hop ${i + 1}: in ${formatAmount(h.input.amount, symbol(h.input.assetId)?.decimals ?? 0)} out ${formatAmount(h.output.amount, symbol(h.output.assetId)?.decimals ?? 0)} fee ${h.quote.fee ? formatAmount(h.quote.fee.amount, symbol(h.quote.fee.assetId)?.decimals ?? 0) : "-"}`,
            ),
          );
          console.log(
            `   route: in ${formatAmount(route.input.amount, scenario.from.decimals)} ${scenario.from.symbol} -> out ${formatAmount(route.output.amount, scenario.to.decimals)} ${scenario.to.symbol}; expires in ${route.expiresAt ? Math.max(0, route.expiresAt.getTime() - Date.now()) : 0} ms; indicative`,
          );
        } else {
          console.log(
            `   not planned: ${outcome.status === "FAILED" ? JSON.stringify(outcome.response) : outcome.status}`,
          );
        }
      } catch (error) {
        problems += 1;
        console.log(`   FAILED: ${failure(error)}`);
      }
    }
  }
} finally {
  await database.close();
}
process.exit(problems === 0 ? 0 : 1);
