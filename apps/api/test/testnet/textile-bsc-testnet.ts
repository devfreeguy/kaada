/*
 * Textile TEST-environment validation on BNB Smart Chain testnet (chain 97). TESTNET ONLY.
 *
 *   node --import tsx test/testnet/textile-bsc-testnet.ts <scenario...>
 *   scenarios: preview | input | output | expired | insufficient | nomaker | crash | recover
 *
 * It drives the PRODUCTION Textile client and providers (TextileClient, TextileFirmQuoteProvider,
 * TextileOrderProvider) and the production approval inspector with a throwaway EOA that signs the approval and
 * swap itself. It is a provider-contract validation: it has nothing to do with Celo, Kernel or the database
 * orchestration (those are validated separately), and nothing here changes the application's configuration
 * (the app still refuses TEXTILE_ENV=test).
 *
 * The one-time claim token is never printed. It is AES-256-GCM encrypted (the production cipher) before it is
 * written to the persisted RFQ state, and decrypted only for the call that needs it.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { SecretValue } from "@kaada/domain";
import type { FirmQuoteRequest } from "@kaada/domain";
import { createPublicClient, createWalletClient, erc20Abi, http, maxUint256 } from "viem";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import { inspectApprovalTransaction } from "../../src/core/execution/approval-inspector.js";
import {
  TextileClient,
  TextileClientError,
  TextileFirmQuoteProvider,
  TextileOrderProvider,
  createFetchTransport,
} from "../../src/infrastructure/fx/textile/index.js";
import { AesGcmSecretCipher } from "../../src/infrastructure/security/aes-gcm-cipher.js";

try {
  process.loadEnvFile(new URL("../../../../.env", import.meta.url));
} catch {
  // rely on the real environment
}

const CHAIN = 97;
const RPC = "https://data-seed-prebsc-1-s1.binance.org:8545";
const CNGN = "0x8a078b182bA9649c03982c2a80CDcc81cdc99dA8" as const;
const USDT = "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd" as const;
const log = (...parts: unknown[]) => console.log(...parts);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const apiKey = process.env["TEXTILE_TEST_API_KEY"];
const apiUrl = process.env["TEXTILE_API_URL"];
const statePath = `${process.env["CLAUDE_JOB_DIR"] ?? ""}/tmp/textile-test-state.json`;
if (!apiKey?.startsWith("tx_test_") || !apiUrl)
  throw new Error("a tx_test_ key and TEXTILE_API_URL are required");
if (!existsSync(statePath)) throw new Error("state file missing");

interface PendingRfq {
  label: string;
  rfqId: string;
  mode: "EXACT_INPUT" | "EXACT_OUTPUT";
  requested: string;
  taker: string;
  sellAmount: string;
  takerPays: string;
  buyAmount: string;
  feeAmount: string;
  expiresAt: string;
  orderDeadline?: string;
  latestOrderDeadline?: string;
  /** The claim token, AES-GCM encrypted, bound to this rfq id. */
  claimCiphertext: string;
  swapTxHash?: string;
  balancesBefore: { cngn: string; usdt: string };
}
interface State {
  takerKey: Hex;
  takerKey2: Hex;
  cipherKey?: string;
  pending?: PendingRfq;
  settled: string[];
}
const loadState = (): State =>
  ({ settled: [], ...(JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>) }) as State;
const saveState = (state: State) =>
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });

const state = loadState();
state.cipherKey ??= randomBytes(32).toString("base64");
saveState(state);
const cipher = new AesGcmSecretCipher([{ version: 1, key: state.cipherKey }]);

const client = new TextileClient({
  transport: createFetchTransport({ baseUrl: apiUrl, apiKey }),
  timeoutMs: 8_000,
});
const firm = new TextileFirmQuoteProvider({ client, timeoutMs: 75_000 });
const orders = new TextileOrderProvider({ client });

const publicClient = createPublicClient({ chain: bscTestnet, transport: http(RPC) });
const taker = privateKeyToAccount(state.takerKey);
const wallet = createWalletClient({ account: taker, chain: bscTestnet, transport: http(RPC) });
const unfunded = privateKeyToAccount(state.takerKey2);

const balanceOf = (token: `0x${string}`, owner: `0x${string}`) =>
  publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
const balances = async (owner: `0x${string}` = taker.address) => ({
  cngn: await balanceOf(CNGN, owner),
  usdt: await balanceOf(USDT, owner),
});

function request(
  mode: "EXACT_INPUT" | "EXACT_OUTPUT",
  exactAmount: string,
  takerAddress: string,
): FirmQuoteRequest {
  return {
    chainId: CHAIN,
    sellAssetId: "cngn",
    buyAssetId: "usdt",
    sellToken: CNGN,
    buyToken: USDT,
    mode,
    exactAmount,
    taker: takerAddress,
  };
}

// ── preview ────────────────────────────────────────────────────────────────────────────────────
async function preview(): Promise<boolean> {
  log("\n=== PREVIEW (indicative; reserves nothing) ===");
  let ok = true;
  const cases: [string, Parameters<TextileClient["preview"]>[0]][] = [
    [
      "EXACT_INPUT  sell 100 cNGN -> USDT",
      {
        chainId: CHAIN,
        sellToken: CNGN,
        buyToken: USDT,
        exact: { mode: "EXACT_INPUT", sellAmount: "100000000" },
      },
    ],
    [
      "EXACT_OUTPUT buy 0.05 USDT <- cNGN",
      {
        chainId: CHAIN,
        sellToken: CNGN,
        buyToken: USDT,
        exact: { mode: "EXACT_OUTPUT", buyAmount: "50000000000000000" },
      },
    ],
    [
      "EXACT_INPUT  sell 0.05 USDT -> cNGN",
      {
        chainId: CHAIN,
        sellToken: USDT,
        buyToken: CNGN,
        exact: { mode: "EXACT_INPUT", sellAmount: "50000000000000000" },
      },
    ],
    [
      "EXACT_OUTPUT buy 100 cNGN <- USDT",
      {
        chainId: CHAIN,
        sellToken: USDT,
        buyToken: CNGN,
        exact: { mode: "EXACT_OUTPUT", buyAmount: "100000000" },
      },
    ],
  ];
  for (const [label, body] of cases) {
    const { data } = await client.preview(body);
    if (data.status !== "preview") {
      log(label, "->", data.status);
      ok = false;
      continue;
    }
    const exact =
      body.exact.mode === "EXACT_INPUT"
        ? data.sellAmount === body.exact.sellAmount
        : data.buyAmount === body.exact.buyAmount;
    log(
      label,
      "-> sell",
      data.sellAmount,
      "takerPays",
      data.takerPays,
      "buy",
      data.buyAmount,
      "fee",
      data.feeAmount,
      "| fixed side exact:",
      exact,
    );
    ok &&= exact;
  }
  return ok;
}

// ── a firm quote and its full settlement ──────────────────────────────────────────────────────
async function firmQuote(label: string, mode: "EXACT_INPUT" | "EXACT_OUTPUT", exactAmount: string) {
  const before = await balances();
  const result = await firm.requestFirm(request(mode, exactAmount, taker.address));
  if (result.status !== "QUOTED") {
    log(label, "firm request FAILED:", result.code, result.providerReason ?? "");
    return undefined;
  }
  const { quote, transactions, claimToken } = result;
  // The claim token is encrypted at once, bound to this rfq id, and only then is anything else done.
  const claimCiphertext = cipher.encrypt(
    claimToken.reveal(),
    `textile-claim:${quote.providerQuoteId}`,
  ).ciphertext;
  const pending: PendingRfq = {
    label,
    rfqId: quote.providerQuoteId,
    mode,
    requested: exactAmount,
    taker: taker.address,
    sellAmount: mode === "EXACT_INPUT" ? exactAmount : quote.input.amount,
    takerPays: quote.input.amount,
    buyAmount: quote.output.amount,
    feeAmount: quote.fee?.amount ?? "0",
    expiresAt: quote.expiresAt.toISOString(),
    ...(quote.orderDeadline && { orderDeadline: quote.orderDeadline.toISOString() }),
    ...(quote.latestOrderDeadline && {
      latestOrderDeadline: quote.latestOrderDeadline.toISOString(),
    }),
    claimCiphertext,
    balancesBefore: { cngn: before.cngn.toString(), usdt: before.usdt.toString() },
  };
  const s = loadState();
  s.pending = pending;
  saveState(s);
  log(
    label,
    "firm quote:",
    quote.providerQuoteId,
    "| takerPays",
    pending.takerPays,
    "| buy",
    pending.buyAmount,
    "| fee",
    pending.feeAmount,
  );
  log(
    "  expiresAt",
    pending.expiresAt,
    `(in ${Math.round((quote.expiresAt.getTime() - Date.now()) / 1000)}s)`,
    "| orderDeadline",
    pending.orderDeadline,
    "| latestOrderDeadline",
    pending.latestOrderDeadline,
  );
  log(
    "  reactor",
    quote.reactor,
    "| spender",
    quote.spender ?? "(same as reactor)",
    "| taker bound:",
    quote.taker === taker.address.toLowerCase(),
  );
  log(
    "  approval tx -> to",
    transactions.approval.to,
    "value",
    transactions.approval.value,
    "| swap tx -> to",
    transactions.swap.to,
    "value",
    transactions.swap.value,
    "selector",
    transactions.swap.data.slice(0, 10),
  );
  return { pending, quote, transactions };
}

async function approveIfNeeded(
  quote: { reactor?: string; spender?: string; input: { amount: string } },
  approval: { to: string; data: string; value: string; chainId: number },
): Promise<void> {
  const spender = (quote.spender ?? quote.reactor ?? "") as `0x${string}`;
  const required = BigInt(quote.input.amount);
  const inspection = inspectApprovalTransaction(approval, {
    chainId: CHAIN,
    token: CNGN,
    spender,
    requiredAmount: required,
  });
  log("  approval inspection blockers:", JSON.stringify(inspection.blockers), "(none expected)");
  if (inspection.blockers.length > 0)
    throw new Error("the provider's approval transaction is not acceptable");
  const allowance = await publicClient.readContract({
    address: CNGN,
    abi: erc20Abi,
    functionName: "allowance",
    args: [taker.address, spender],
  });
  if (allowance >= required) {
    log("  allowance already covers it:", allowance.toString(), "- no approval sent");
    return;
  }
  const hash = await wallet.sendTransaction({
    to: approval.to as `0x${string}`,
    data: approval.data as Hex,
    value: 0n,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.readContract({
    address: CNGN,
    abi: erc20Abi,
    functionName: "allowance",
    args: [taker.address, spender],
  });
  log(
    "  approval",
    hash,
    "-> allowance",
    after.toString(),
    "| bounded (not unlimited):",
    after < maxUint256 / 2n,
    "| >= takerPays:",
    after >= required,
  );
}

async function broadcastSwap(
  pending: PendingRfq,
  swap: { to: string; data: string; value: string },
): Promise<string> {
  if (Date.now() >= Date.parse(pending.expiresAt))
    throw new Error("the quote has expired; request a new one");
  const hash = await wallet.sendTransaction({
    to: swap.to as `0x${string}`,
    data: swap.data as Hex,
    value: 0n,
  });
  const s = loadState();
  if (s.pending) s.pending.swapTxHash = hash; // persisted BEFORE waiting for anything
  saveState(s);
  return hash;
}

function claimFor(pending: PendingRfq): SecretValue {
  return new SecretValue(cipher.decrypt(pending.claimCiphertext, `textile-claim:${pending.rfqId}`));
}

/** Submit the hash, poll the order to a terminal state, and compare the balances with the quote. */
async function settle(pending: PendingRfq, txHash: string, tag: string): Promise<boolean> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex });
  log("  swap tx", txHash, "->", receipt.status, "block", receipt.blockNumber.toString());
  const submitted = await orders.submit({
    providerQuoteId: pending.rfqId,
    claimToken: claimFor(pending),
    txHash,
  });
  log("  submit ->", submitted.state);
  let final = submitted;
  for (let i = 0; i < 60; i += 1) {
    final = await orders.status({ providerQuoteId: pending.rfqId, claimToken: claimFor(pending) });
    if (final.state === "FILLED" || final.state === "FAILED" || final.state === "EXPIRED") break;
    await wait(3_000);
  }
  log(
    "  order status ->",
    final.state,
    `sell ${final.sellAmount ?? "?"} buy ${final.buyAmount ?? "?"} fee ${final.feeAmount ?? "?"}`,
  );
  await wait(4_000);
  const after = await balances();
  const dCngn = after.cngn - BigInt(pending.balancesBefore.cngn);
  const dUsdt = after.usdt - BigInt(pending.balancesBefore.usdt);
  log(
    `  [${tag}] balances: cNGN ${dCngn} (takerPays ${pending.takerPays}) | USDT ${dUsdt} (quoted buy ${pending.buyAmount})`,
  );
  const exactSide =
    pending.mode === "EXACT_INPUT"
      ? -dCngn === BigInt(pending.requested)
      : dUsdt === BigInt(pending.requested);
  const matchesQuote = -dCngn === BigInt(pending.takerPays) && dUsdt === BigInt(pending.buyAmount);
  log(
    `  [${tag}] ${pending.mode}: fixed side exact on chain = ${exactSide} | both sides equal the firm quote = ${matchesQuote}`,
  );
  return receipt.status === "success" && final.state === "FILLED" && exactSide && matchesQuote;
}

async function settlement(
  label: string,
  mode: "EXACT_INPUT" | "EXACT_OUTPUT",
  exactAmount: string,
): Promise<boolean> {
  log(`\n=== ${label} ===`);
  const made = await firmQuote(label, mode, exactAmount);
  if (!made) return false;
  await approveIfNeeded(made.quote, made.transactions.approval);
  const hash = await broadcastSwap(made.pending, made.transactions.swap);
  const ok = await settle(made.pending, hash, label);
  const s = loadState();
  if (ok) s.settled.push(made.pending.rfqId);
  delete s.pending;
  saveState(s);
  return ok;
}

// ── failures ───────────────────────────────────────────────────────────────────────────────────
async function expired(): Promise<boolean> {
  log("\n=== EXPIRED QUOTE ===");
  const made = await firmQuote("expired", "EXACT_INPUT", "10000000");
  if (!made) return false;
  const waitMs = Date.parse(made.pending.expiresAt) - Date.now() + 3_000;
  log(`  waiting ${Math.round(waitMs / 1000)}s past expiresAt (the swap is NOT broadcast) ...`);
  await wait(Math.max(waitMs, 0));
  // Kaada's own guard: nothing is broadcast once the accept cutoff has passed.
  let guarded = false;
  try {
    await broadcastSwap(made.pending, made.transactions.swap);
  } catch {
    guarded = true;
  }
  log("  broadcast refused locally after expiry:", guarded);
  const status = await orders.status({
    providerQuoteId: made.pending.rfqId,
    claimToken: claimFor(made.pending),
  });
  log("  provider status after expiry ->", status.state);
  // A submit for an expired quote is rejected by the provider (documented): classify the failure.
  let kind = "ACCEPTED?";
  try {
    await orders.submit({
      providerQuoteId: made.pending.rfqId,
      claimToken: claimFor(made.pending),
      txHash: `0x${"11".repeat(32)}`,
    });
  } catch (error) {
    kind =
      error instanceof Error ? `${error.name}:${(error as { code?: string }).code ?? ""}` : "error";
  }
  log("  submit after expiry ->", kind);
  const s = loadState();
  delete s.pending;
  saveState(s);
  return guarded;
}

async function insufficient(): Promise<boolean> {
  log("\n=== INSUFFICIENT BALANCE (the unfunded taker) ===");
  const result = await firm.requestFirm(request("EXACT_INPUT", "100000000", unfunded.address));
  log(
    "  result:",
    result.status === "FAILED"
      ? `${result.code} (mayHoldSlot=${result.mayHoldSlot}) ${result.providerReason ?? ""}`
      : result.status,
  );
  return result.status === "FAILED" && result.code === "INSUFFICIENT_FUNDS_AT_PROVIDER";
}

async function nomaker(): Promise<boolean> {
  log("\n=== NO-MAKER / UNAVAILABLE (best effort) ===");
  // Far beyond published depth for the sell token the taker actually holds.
  const result = await firm.requestFirm(
    request("EXACT_OUTPUT", (50n * 10n ** 18n).toString(), taker.address),
  );
  log(
    "  buy 50 USDT (depth is a few USDT) ->",
    result.status === "FAILED" ? `${result.code} ${result.providerReason ?? ""}` : result.status,
  );
  if (result.status === "QUOTED")
    log("  (a quote was returned; it holds a slot until its deadline and will be left to lapse)");
  return true;
}

async function slots(): Promise<boolean> {
  log("\n=== PROVIDER SLOT CAP (4 outstanding quotes per key; nothing is broadcast) ===");
  const outcomes: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const result = await firm.requestFirm(request("EXACT_INPUT", "2000000", taker.address));
    outcomes.push(
      result.status === "QUOTED"
        ? "QUOTED"
        : `${result.code}${result.mayHoldSlot ? "(holds slot?)" : ""}`,
    );
  }
  log("  six firm requests ->", outcomes.join(", "));
  log("  (the quotes lapse by themselves after 60 s; nothing was approved or sent)");
  return (
    outcomes.filter((o) => o === "QUOTED").length <= 4 &&
    outcomes.includes("PROVIDER_CAPACITY_REACHED")
  );
}

// ── crash / recover ────────────────────────────────────────────────────────────────────────────
async function crash(): Promise<boolean> {
  log("\n=== CRASH: broadcast, then the process dies before submit ===");
  const made = await firmQuote("crash", "EXACT_INPUT", "50000000");
  if (!made) return false;
  await approveIfNeeded(made.quote, made.transactions.approval);
  const hash = await broadcastSwap(made.pending, made.transactions.swap);
  log("  swap broadcast", hash, "- the process now 'dies' (nothing submitted, nothing polled)");
  return true;
}

async function recover(): Promise<boolean> {
  log("\n=== RECOVER: a fresh process, persisted state only ===");
  const pending = loadState().pending;
  if (!pending?.swapTxHash) {
    log("  nothing pending");
    return false;
  }
  log(
    "  persisted:",
    pending.rfqId,
    "| swap tx",
    pending.swapTxHash,
    "| claim token stored encrypted:",
    pending.claimCiphertext.startsWith("v1."),
  );
  const ok = await settle(pending, pending.swapTxHash, "recovered");
  // No duplicate settlement: the same hash again is idempotent; a different hash is refused (409).
  const again = await orders.submit({
    providerQuoteId: pending.rfqId,
    claimToken: claimFor(pending),
    txHash: pending.swapTxHash,
  });
  log("  submit AGAIN (same hash) ->", again.state, "(idempotent)");
  let different = "ACCEPTED?!";
  try {
    await orders.submit({
      providerQuoteId: pending.rfqId,
      claimToken: claimFor(pending),
      txHash: `0x${"22".repeat(32)}`,
    });
  } catch (error) {
    different =
      error instanceof Error
        ? `${error.name}:${(error as { code?: string }).code ?? ""}`
        : "refused";
  }
  log("  submit with a DIFFERENT hash ->", different);
  const final = await balances();
  log(
    "  cNGN/USDT moved exactly once:",
    `${final.cngn - BigInt(pending.balancesBefore.cngn)} / ${final.usdt - BigInt(pending.balancesBefore.usdt)}`,
  );
  const s = loadState();
  if (ok) s.settled.push(pending.rfqId);
  delete s.pending;
  saveState(s);
  return ok && /Error|refused/.test(different);
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────
const wanted = process.argv.slice(2);
const results: Record<string, string> = {};
const runs: Record<string, () => Promise<boolean>> = {
  preview,
  input: () => settlement("EXACT_INPUT settlement (sell 100 cNGN)", "EXACT_INPUT", "100000000"),
  output: () =>
    settlement("EXACT_OUTPUT settlement (buy 0.05 USDT)", "EXACT_OUTPUT", "50000000000000000"),
  expired,
  insufficient,
  nomaker,
  slots,
  crash,
  recover,
};
log(
  "taker",
  taker.address,
  "| balances before:",
  JSON.stringify(
    Object.fromEntries(Object.entries(await balances()).map(([k, v]) => [k, v.toString()])),
  ),
);
for (const name of wanted) {
  const run = runs[name];
  if (!run) throw new Error(`unknown scenario ${name}`);
  try {
    results[name] = (await run()) ? "PASS" : "FAIL";
  } catch (error) {
    results[name] = "ERROR";
    log(
      name,
      "error:",
      error instanceof TextileClientError
        ? `${error.kind} ${error.message}`
        : error instanceof Error
          ? error.message
          : error,
    );
  }
}
log("\nRESULTS", JSON.stringify(results));
