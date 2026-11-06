import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CELO_CHAIN_ID } from "@kaada/domain";
import type { FirmQuoteRequest } from "@kaada/domain";
import { encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import type { Hex } from "viem";

import {
  inspectApprovalTransaction,
  inspectSwapTransaction,
} from "../src/core/execution/approval-inspector.js";
import {
  VERIFIED_PROTOCOLS,
  checkSwapAgainst,
  readRouterCall,
} from "../src/infrastructure/fx/uniswap/calldata.js";
import type { SwapExpectation } from "../src/infrastructure/fx/uniswap/calldata.js";
import { UniswapClient } from "../src/infrastructure/fx/uniswap/client.js";
import {
  PERMIT2_ADDRESS,
  UniswapFirmQuoteProvider,
} from "../src/infrastructure/fx/uniswap/uniswap-firm-provider.js";
import type { UniswapTransport } from "../src/infrastructure/fx/uniswap/transport.js";

/*
 * Two kinds of fixture, kept apart on purpose:
 *
 *  - RECORDED: a real quote and swap response from the live Uniswap Trading API (cNGN -> wARS on Celo, 2026-11-06). It
 *    proves the decoder reads what Uniswap actually sends, not what this file thinks it sends.
 *  - BUILT: calldata assembled here with viem, so each test can change exactly one field. Every hostile case below was
 *    reproduced against the previous adapter, which accepted all of them as a valid firm quote.
 */

const CNGN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const WARS = "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d";
const USDT = "0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e";
/** Uniswap's Universal Router v2.1.2 on Celo, the one Kaada trusts (see TRUSTED_PERMIT2_SPENDERS). */
const ROUTER = "0xe2023f3fa515cf070e07fd9d51c1d236e07843f4";
const TAKER = "0xcfe279412b525a872ce32c5660141cde4cd0240f";
const ATTACKER = "0x000000000000000000000000000000000000dead";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const SELL_ASSET = "11111111-1111-4111-8111-111111111111";
const BUY_ASSET = "22222222-2222-4222-8222-222222222222";

const SPEND = 500_000_000n;
const OUTPUT = 602011849569562623975n;
/** What Uniswap puts in the calldata for 2.5% slippage on OUTPUT: observed to be 2 wei under plain arithmetic. */
const FLOOR = 586961553330323508476n;

const DEADLINE_SECONDS = 1_793_990_000;
const NOW = new Date((DEADLINE_SECONDS - 20 * 60) * 1000);

const EXECUTE = parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);

/** A V3 path: token, then repeated fee (3 bytes) and token. */
const v3Path = (tokens: string[]): Hex =>
  `0x${tokens.map((token, i) => token.slice(2) + (i < tokens.length - 1 ? "000064" : "")).join("")}`;

interface SwapFields {
  recipient?: string;
  amountIn?: bigint;
  amountOutMin?: bigint;
  payerIsUser?: boolean;
  tokens?: string[];
}
const v3Input = (o: SwapFields = {}): Hex =>
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "bytes" },
      { type: "bool" },
    ],
    [
      (o.recipient ?? TAKER) as Hex,
      o.amountIn ?? SPEND,
      o.amountOutMin ?? FLOOR,
      v3Path(o.tokens ?? [CNGN, USDT, WARS]),
      o.payerIsUser ?? true,
    ],
  );
const v2Input = (o: SwapFields = {}): Hex =>
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "address[]" },
      { type: "bool" },
    ],
    [
      (o.recipient ?? TAKER) as Hex,
      o.amountIn ?? SPEND,
      o.amountOutMin ?? FLOOR,
      (o.tokens ?? [CNGN, USDT, WARS]) as Hex[],
      o.payerIsUser ?? true,
    ],
  );

/** `execute(commands, inputs, deadline)`. `commands` are hex bytes ("00"), one input each. */
const routerCalldata = (
  commands: string[] = ["00"],
  inputs: Hex[] = [v3Input()],
  deadline: number = DEADLINE_SECONDS,
): Hex =>
  encodeFunctionData({
    abi: EXECUTE,
    functionName: "execute",
    args: [`0x${commands.join("")}`, inputs, BigInt(deadline)],
  });

/** The honest calldata for the request below, with one field changed. */
const honest = (o: SwapFields = {}): Hex => routerCalldata(["00"], [v3Input(o)]);

const QUOTE = {
  requestId: "93b25181a349efb960f7a52421810777",
  routing: "CLASSIC",
  quote: {
    chainId: CELO_CHAIN_ID,
    swapper: TAKER,
    tradeType: "EXACT_INPUT",
    input: { amount: SPEND.toString(), token: CNGN, maximumAmount: SPEND.toString() },
    output: {
      amount: OUTPUT.toString(),
      token: WARS,
      recipient: TAKER,
      minimumAmount: FLOOR.toString(),
    },
    slippage: 2.5,
    quoteId: "01a1b0f3-e8e9-8000-a0ba-4abdf4990100",
    routeString: "[v3] 100.00% = [0.01%] 0x6519 -> [0.01%] 0x5D8e",
    blockNumber: "82064130",
  },
};

const swapResponse = (data: Hex, to: string = ROUTER, value = "0x00") => ({
  requestId: QUOTE.requestId,
  swap: { to, data, value, chainId: CELO_CHAIN_ID },
});

/** RECORDED from the live API: the swap for 100 cNGN -> wARS against the wallet 0x4347...e6c5. */
const RECORDED_WALLET = "0x4347d3c270d4654d13c0cee9865e80680ec3e6c5";
const RECORDED_DATA =
  "0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a0000000000000000000000000000000000000000000000000000000006aee17eb000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001600000000000000000000000004347d3c270d4654d13c0cee9865e80680ec3e6c50000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000064a5a3dd659f5e3eb00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001400000000000000000000000000000000000000000000000000000000000000042f6829d7393dae24509eb1e52ee8e572e2e271a4f00006448065fbbe25f71c9282ddf5e1cd6d6a887483d5e0000640dc4f92879b7670e5f4e4e6e3c801d229129d90d0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000756e6978000001a1b1f1f5158000ab4d4abdf4990100";

type Json = Record<string, unknown>;

/** Answers /quote and /swap from whatever each test supplies, and records what was sent. */
function providerWith(
  replies: { quote?: { status: number; body: unknown }; swap?: { status: number; body: unknown } },
  options: { now?: Date; minDeadlineMs?: number } = {},
) {
  const seen: { path: string; body: Json }[] = [];
  const transport: UniswapTransport = {
    post: (path, body) => {
      seen.push({ path, body: body as Json });
      const reply = path === "/quote" ? replies.quote : replies.swap;
      return Promise.resolve(reply ?? { status: 500, body: undefined });
    },
  };
  const provider = new UniswapFirmQuoteProvider({
    client: new UniswapClient({ transport, timeoutMs: 5_000 }),
    slippagePercent: 2.5,
    now: () => options.now ?? NOW,
    ...(options.minDeadlineMs !== undefined && { minDeadlineMs: options.minDeadlineMs }),
  });
  return { provider, seen };
}

const ok = (body: unknown) => ({ status: 200, body });
const happy = { quote: ok(QUOTE), swap: ok(swapResponse(honest())) };

const request = (overrides: Partial<FirmQuoteRequest> = {}): FirmQuoteRequest => ({
  chainId: CELO_CHAIN_ID,
  sellAssetId: SELL_ASSET,
  buyAssetId: BUY_ASSET,
  sellToken: CNGN,
  buyToken: WARS,
  mode: "EXACT_INPUT",
  exactAmount: SPEND.toString(),
  taker: TAKER,
  ...overrides,
});

const expectation = (overrides: Partial<SwapExpectation> = {}): SwapExpectation => ({
  taker: TAKER,
  sellToken: CNGN,
  buyToken: WARS,
  exactIn: SPEND,
  outputAmount: OUTPUT,
  slippageBps: 250,
  ...overrides,
});

const decoded = (data: string) => {
  const result = readRouterCall(data);
  // The message is built only on failure: a successful result holds bigints, which JSON.stringify cannot print.
  if (!result.ok)
    assert.fail(`expected the calldata to decode, got ${result.problem} ${result.detail ?? ""}`);
  return result.call;
};

describe("reading the Universal Router calldata", () => {
  it("decodes a REAL swap recorded from the live API, and it passes its own request", () => {
    const call = decoded(RECORDED_DATA);
    assert.deepEqual(call.commandNames, ["V3_SWAP_EXACT_IN"]);
    assert.equal(call.swaps.length, 1);
    const [swap] = call.swaps;
    assert.equal(swap?.recipient, RECORDED_WALLET, "the output goes to the wallet");
    assert.equal(swap?.amountIn, 100_000_000n);
    assert.equal(swap?.amountOutMin, 116038127139809518571n, "== the quote's own minimumAmount");
    assert.equal(swap?.payerIsUser, true);
    assert.deepEqual(swap?.tokens, [CNGN, USDT, WARS], "cNGN -> USDT -> wARS");

    assert.equal(
      checkSwapAgainst(call, {
        taker: RECORDED_WALLET,
        sellToken: CNGN,
        buyToken: WARS,
        exactIn: 100_000_000n,
        outputAmount: 119013463733137967766n,
        slippageBps: 250,
      }),
      undefined,
      "real Uniswap calldata satisfies the checks (including its 2-wei rounding on the floor)",
    );
  });

  it("decodes the on-chain deadline", () => {
    assert.equal(decoded(honest()).deadline.getTime(), DEADLINE_SECONDS * 1000);
  });

  it("decodes a V2 swap as well, which is the other command Kaada can verify", () => {
    const call = decoded(routerCalldata(["08"], [v2Input()]));
    assert.deepEqual(call.commandNames, ["V2_SWAP_EXACT_IN"]);
    assert.deepEqual(call.swaps[0]?.tokens, [CNGN, USDT, WARS]);
    assert.equal(checkSwapAgainst(call, expectation()), undefined);
  });

  it("refuses calldata that is not the router's execute", () => {
    const result = readRouterCall(`0x095ea7b3${"00".repeat(64)}`);
    assert.ok(!result.ok);
    assert.equal(result.problem, "NOT_ROUTER_EXECUTE");
  });

  /*
   * The high bit of a command byte means "a revert of this command does not revert the transaction". That is the one
   * outcome settlement must never see: the transaction would succeed with the swap undone.
   */
  it("refuses a command allowed to fail silently", () => {
    const result = readRouterCall(routerCalldata(["80"], ["0x"]));
    assert.ok(!result.ok);
    assert.equal(result.problem, "COMMAND_MAY_REVERT_SILENTLY");
  });

  it("refuses every command whose inputs Kaada cannot verify, naming the byte", () => {
    const refused: Record<string, string> = {
      "0a": "PERMIT2_PERMIT would carry a signature Kaada does not produce",
      "04": "SWEEP moves tokens to an address the provider picks",
      "05": "TRANSFER moves tokens to an address the provider picks",
      "06": "PAY_PORTION moves tokens to an address the provider picks",
      "0b": "WRAP_ETH involves native value",
      "0c": "UNWRAP_WETH involves native value",
      "10": "V4_SWAP: inputs not yet decoded, so recipient and amounts could not be checked",
      "01": "V3 exact-output: not offered, and its inputs are not decoded",
      "09": "V2 exact-output: not offered, and its inputs are not decoded",
    };
    for (const [command, why] of Object.entries(refused)) {
      const result = readRouterCall(routerCalldata([command], ["0x"]));
      assert.ok(!result.ok, why);
      assert.equal(result.problem, "COMMAND_NOT_ALLOWED", why);
      assert.equal(result.detail, command);
    }
  });

  it("refuses an empty command list, a zero deadline, and malformed or non-hex data", () => {
    const empty = readRouterCall(routerCalldata([], []));
    assert.ok(!empty.ok);
    assert.equal(empty.problem, "NO_COMMANDS");

    const noDeadline = readRouterCall(routerCalldata(["00"], [v3Input()], 0));
    assert.ok(!noDeadline.ok);
    assert.equal(noDeadline.problem, "NO_DEADLINE");

    const truncated = readRouterCall("0x3593564c0000");
    assert.ok(!truncated.ok);
    assert.equal(truncated.problem, "MALFORMED_CALLDATA");

    const notHex = readRouterCall("0xzzzz");
    assert.ok(!notHex.ok);
    assert.equal(notHex.problem, "MALFORMED_CALLDATA");
  });

  it("refuses a command list that does not line up with its inputs", () => {
    const result = readRouterCall(routerCalldata(["00", "00"], [v3Input()]));
    assert.ok(!result.ok);
    assert.equal(result.problem, "MALFORMED_CALLDATA");
  });

  it("refuses a swap input that cannot be decoded, rather than guessing", () => {
    const result = readRouterCall(routerCalldata(["00"], ["0xdeadbeef"]));
    assert.ok(!result.ok);
    assert.equal(result.problem, "SWAP_INPUT_MALFORMED");

    const badPath = readRouterCall(
      routerCalldata(
        ["00"],
        [
          encodeAbiParameters(
            [
              { type: "address" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "bytes" },
              { type: "bool" },
            ],
            [TAKER, SPEND, FLOOR, "0x1234", true],
          ),
        ],
      ),
    );
    assert.ok(!badPath.ok);
    assert.equal(badPath.problem, "SWAP_INPUT_MALFORMED");
  });
});

describe("the calldata must do what the person was promised", () => {
  const verdict = (o: SwapFields, e: Partial<SwapExpectation> = {}) =>
    checkSwapAgainst(decoded(honest(o)), expectation(e));

  it("accepts the honest swap", () => {
    assert.equal(verdict({}), undefined);
  });

  it("accepts the router's own 'whoever called' sentinel as the recipient, because that is the wallet", () => {
    assert.equal(verdict({ recipient: MSG_SENDER }), undefined);
  });

  // Each of these was ACCEPTED by the previous adapter, which read only the command names and the deadline.
  it("refuses a swap whose output goes to someone else", () => {
    assert.equal(verdict({ recipient: ATTACKER }), "swap_recipient_differs");
    assert.equal(
      verdict({ recipient: "0x0000000000000000000000000000000000000002" }),
      "swap_recipient_differs",
      "the router's own address would need a sweep Kaada does not allow",
    );
  });

  it("refuses a swap with no real minimum output", () => {
    assert.equal(verdict({ amountOutMin: 1n }), "swap_min_output_too_low");
    assert.equal(verdict({ amountOutMin: 0n }), "swap_min_output_too_low");
  });

  it("accepts a minimum within one basis point of the agreed slippage, and no looser", () => {
    const exact = (OUTPUT * (10_000n - 250n)) / 10_000n;
    assert.equal(verdict({ amountOutMin: exact }), undefined);
    assert.equal(verdict({ amountOutMin: exact - 2n }), undefined, "Uniswap's own rounding");
    const oneBp = (OUTPUT * (10_000n - 251n)) / 10_000n;
    assert.equal(verdict({ amountOutMin: oneBp }), undefined);
    const fiveBp = (OUTPUT * (10_000n - 255n)) / 10_000n;
    assert.equal(verdict({ amountOutMin: fiveBp }), "swap_min_output_too_low");
  });

  it("refuses a swap that spends more or less than was authorised", () => {
    assert.equal(verdict({ amountIn: SPEND * 10n }), "swap_amount_in_differs");
    assert.equal(verdict({ amountIn: SPEND - 1n }), "swap_amount_in_differs");
  });

  it("refuses a swap the wallet does not pay for", () => {
    assert.equal(verdict({ payerIsUser: false }), "swap_payer_not_the_wallet");
  });

  it("refuses a route that does not start and end at the right tokens", () => {
    assert.equal(verdict({ tokens: [CNGN, USDT, CNGN] }), "swap_route_differs");
    assert.equal(verdict({ tokens: [USDT, WARS] }), "swap_route_differs");
    assert.equal(verdict({ tokens: [WARS, USDT, CNGN] }), "swap_route_differs");
  });

  it("sums a split route and holds the total to what was authorised", () => {
    const split = (a: bigint, b: bigint) =>
      decoded(
        routerCalldata(
          ["00", "00"],
          [
            v3Input({ amountIn: a, amountOutMin: FLOOR / 2n }),
            v3Input({ amountIn: b, amountOutMin: FLOOR / 2n + 1n }),
          ],
        ),
      );
    assert.equal(checkSwapAgainst(split(300_000_000n, 200_000_000n), expectation()), undefined);
    assert.equal(
      checkSwapAgainst(split(300_000_000n, 300_000_000n), expectation()),
      "swap_amount_in_differs",
      "the legs add up to more than was authorised",
    );
  });

  it("refuses when ANY leg of a split sends its output elsewhere", () => {
    const call = decoded(
      routerCalldata(
        ["00", "00"],
        [
          v3Input({ amountIn: 300_000_000n, amountOutMin: FLOOR / 2n }),
          v3Input({ amountIn: 200_000_000n, amountOutMin: FLOOR / 2n + 1n, recipient: ATTACKER }),
        ],
      ),
    );
    assert.equal(checkSwapAgainst(call, expectation()), "swap_recipient_differs");
  });
});

describe("Uniswap as a firm-quote provider", () => {
  it("declares that it issues no claim token, and issues none", async () => {
    const { provider } = providerWith(happy);
    assert.equal(provider.issuesClaimToken, false);
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.equal(result.claimToken, undefined, "there is no reservation to claim");
  });

  it("honours a quote for 3 minutes, far inside the router's own deadline", async () => {
    const { provider } = providerWith(happy);
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.equal(result.quote.expiresAt.getTime(), NOW.getTime() + 180_000);
    assert.ok(result.quote.expiresAt.getTime() < DEADLINE_SECONDS * 1000);
    assert.equal(result.quote.orderDeadline?.getTime(), result.quote.expiresAt.getTime());
    assert.equal(result.quote.latestOrderDeadline, undefined, "no slot is held to release");
  });

  it("never outlives the router deadline, even when that is closer than 3 minutes", async () => {
    const { provider } = providerWith(happy, { now: new Date((DEADLINE_SECONDS - 90) * 1000) });
    const result = await provider.requestFirm(request());
    // 90s left is over the 60s minimum, so it is quoted, but only until the router deadline.
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.equal(result.quote.expiresAt.getTime(), DEADLINE_SECONDS * 1000);
  });

  it("names Permit2 as the spender, and approves exactly this swap's input", async () => {
    const { provider } = providerWith(happy);
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;

    assert.equal(result.quote.spender, PERMIT2_ADDRESS);
    const { approval } = result.transactions;
    assert.equal(approval.to, CNGN, "the allowance is on the token being sold");
    assert.equal(approval.data.slice(0, 10), "0x095ea7b3", "a plain ERC-20 approve");
    assert.equal(`0x${approval.data.slice(34, 74)}`, PERMIT2_ADDRESS);
    // Uniswap's own /check_approval answers MAX_UINT256, which Kaada refuses; this figure comes from the quote.
    assert.equal(BigInt(`0x${approval.data.slice(74, 138)}`), SPEND);
    assert.equal(approval.value, "0");
  });

  it("hands back the provider's swap calldata untouched, with the value in Kaada's own form", async () => {
    const { provider, seen } = providerWith(happy);
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.equal(result.transactions.swap.to, ROUTER);
    assert.equal(result.transactions.swap.data, honest(), "the calldata is untouched");
    /*
     * DECIMAL "0", not Uniswap's hex "0x00". Kaada's UnsignedTransaction.value is a decimal wei string, and both
     * `inspectSwapTransaction` and the validated signer compare it against "0": the hex form blocked every Uniswap
     * payment with SWAP_CARRIES_UNEXPECTED_VALUE for a swap that carries nothing.
     */
    assert.equal(result.transactions.swap.value, "0");
    assert.equal(result.transactions.approval.value, "0");
    assert.equal(result.quote.fee, undefined, "an AMM charges no provider fee");
    assert.deepEqual(
      seen.map((s) => s.path),
      ["/quote", "/swap"],
    );
    assert.equal(seen[0]?.body["swapper"], TAKER, "priced against the wallet that will sign");
  });

  it("asks only for the pool versions whose calldata it can verify", async () => {
    const { provider, seen } = providerWith(happy);
    await provider.requestFirm(request());
    assert.deepEqual(seen[0]?.body["protocols"], [...VERIFIED_PROTOCOLS]);
    assert.deepEqual([...VERIFIED_PROTOCOLS], ["V2", "V3"], "no V4 until its inputs are decoded");
  });

  it("refuses EXACT_OUTPUT rather than approximating it, and calls nobody", async () => {
    const { provider, seen } = providerWith(happy);
    const result = await provider.requestFirm(request({ mode: "EXACT_OUTPUT" }));
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.code, "NO_QUOTE");
    assert.equal(result.providerReason, "exact_output_not_supported");
    assert.deepEqual(seen, [], "refused locally, before any request left the process");
  });

  it("never reports a held slot, because an AMM holds none", async () => {
    for (const replies of [
      { quote: { status: 404, body: { errorCode: "NoRouteFoundError" } } },
      { quote: { status: 500, body: {} } },
      { quote: { status: 429, body: {} } },
    ]) {
      const { provider } = providerWith(replies);
      const result = await provider.requestFirm(request());
      assert.equal(result.status, "FAILED");
      if (result.status !== "FAILED") continue;
      assert.equal(result.mayHoldSlot, false);
    }
  });

  it("maps a missing route to NO_QUOTE, not to an outage", async () => {
    const { provider } = providerWith({ quote: { status: 404, body: { errorCode: "NoRoute" } } });
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.code, "NO_QUOTE");
  });
});

describe("a firm quote is refused when the provider's answer does not match the request", () => {
  const cases: { label: string; replies: Parameters<typeof providerWith>[0]; reason: string }[] = [
    {
      label: "a non-CLASSIC route",
      replies: {
        quote: ok({ ...QUOTE, routing: "DUTCH_LIMIT" }),
        swap: ok(swapResponse(honest())),
      },
      reason: "routing_DUTCH_LIMIT",
    },
    {
      label: "a different taker",
      replies: {
        quote: ok({ ...QUOTE, quote: { ...QUOTE.quote, swapper: `0x${"9".repeat(40)}` } }),
        swap: ok(swapResponse(honest())),
      },
      reason: "taker_differs",
    },
    {
      label: "the fixed side moved",
      replies: {
        quote: ok({
          ...QUOTE,
          quote: { ...QUOTE.quote, input: { ...QUOTE.quote.input, amount: "499999999" } },
        }),
        swap: ok(swapResponse(honest())),
      },
      reason: "sell_amount_differs",
    },
    {
      label: "the wrong buy token",
      replies: {
        quote: ok({
          ...QUOTE,
          quote: { ...QUOTE.quote, output: { ...QUOTE.quote.output, token: CNGN } },
        }),
        swap: ok(swapResponse(honest())),
      },
      reason: "buy_token_differs",
    },
    {
      label: "the output paid to someone else (in the quote)",
      replies: {
        quote: ok({
          ...QUOTE,
          quote: { ...QUOTE.quote, output: { ...QUOTE.quote.output, recipient: ATTACKER } },
        }),
        swap: ok(swapResponse(honest())),
      },
      reason: "output_recipient_differs",
    },
    {
      label: "a swap carrying native value",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest(), ROUTER, "0x01")) },
      reason: "swap_carries_value",
    },
    {
      label: "calldata for a command Kaada will not run",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(routerCalldata(["0a"], ["0x"]))) },
      reason: "calldata_command_not_allowed",
    },
    {
      label: "calldata that is not the router's execute",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(`0x095ea7b3${"00".repeat(64)}`)) },
      reason: "calldata_not_router_execute",
    },
    // The next six were reproduced as ACCEPTED against the previous adapter.
    {
      label: "a swap target that is not the trusted router",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest(), ATTACKER)) },
      reason: "swap_target_not_trusted",
    },
    {
      label: "calldata sending the swap output to an attacker",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest({ recipient: ATTACKER }))) },
      reason: "calldata_swap_recipient_differs",
    },
    {
      label: "calldata with no real minimum output",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest({ amountOutMin: 1n }))) },
      reason: "calldata_swap_min_output_too_low",
    },
    {
      label: "calldata spending ten times the authorised amount",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest({ amountIn: SPEND * 10n }))) },
      reason: "calldata_swap_amount_in_differs",
    },
    {
      label: "calldata the wallet does not pay for",
      replies: { quote: ok(QUOTE), swap: ok(swapResponse(honest({ payerIsUser: false }))) },
      reason: "calldata_swap_payer_not_the_wallet",
    },
    {
      label: "calldata routed to the wrong end token",
      replies: {
        quote: ok(QUOTE),
        swap: ok(swapResponse(honest({ tokens: [CNGN, USDT, CNGN] }))),
      },
      reason: "calldata_swap_route_differs",
    },
  ];

  for (const { label, replies, reason } of cases) {
    it(`refuses ${label}`, async () => {
      const { provider } = providerWith(replies);
      const result = await provider.requestFirm(request());
      assert.equal(result.status, "FAILED", label);
      if (result.status !== "FAILED") return;
      assert.equal(result.providerReason, reason, label);
      assert.equal(result.mayHoldSlot, false);
    });
  }

  it("refuses a chain it does not serve, without calling anyone", async () => {
    const { provider, seen } = providerWith(happy);
    const result = await provider.requestFirm(request({ chainId: 1 }));
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.providerReason, "chain_not_supported");
    assert.deepEqual(seen, []);
  });

  it("refuses a quote with almost none of the router deadline left", async () => {
    const { provider } = providerWith(happy, {
      now: new Date((DEADLINE_SECONDS - 30) * 1000),
      minDeadlineMs: 60_000,
    });
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.providerReason, "deadline_too_close");
  });

  it("never carries the API key or an amount out of the provider's prose", async () => {
    const { provider } = providerWith({
      quote: {
        status: 401,
        body: { errorCode: "Unauthorized", detail: "key abc123 for 500000000" },
      },
    });
    const result = await provider.requestFirm(request());
    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes("abc123"), false, "no key material");
    assert.equal(serialised.includes("500000000"), false, "no amounts from provider prose");
  });
});

/*
 * Kaada's conventions at the provider boundary. A provider's own encodings stop here; anything that leaks past becomes
 * a blocker or a refusal somewhere far away from the adapter that caused it.
 */
describe("the adapter speaks Kaada's conventions, not Uniswap's", () => {
  it("converts the hex value quantity to the decimal string the domain documents", async () => {
    for (const raw of ["0x00", "0x0"]) {
      const { provider } = providerWith({
        quote: ok(QUOTE),
        swap: ok(swapResponse(honest(), ROUTER, raw)),
      });
      const result = await provider.requestFirm(request());
      assert.equal(result.status, "QUOTED", raw);
      if (result.status !== "QUOTED") continue;
      assert.equal(result.transactions.swap.value, "0", `value from ${raw}`);
    }
  });

  it("rejects a value that is not a hex quantity, instead of guessing at it", async () => {
    const { provider } = providerWith({
      quote: ok(QUOTE),
      swap: ok(swapResponse(honest(), ROUTER, "0")),
    });
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "FAILED");
    if (result.status !== "FAILED") return;
    assert.equal(result.code, "MALFORMED_RESPONSE");
  });

  it("produces transactions that pass Kaada's own swap inspection", async () => {
    const { provider } = providerWith(happy);
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.deepEqual(
      inspectSwapTransaction(result.transactions.swap, { chainId: CELO_CHAIN_ID }),
      [],
    );
    assert.deepEqual(
      inspectApprovalTransaction(result.transactions.approval, {
        chainId: CELO_CHAIN_ID,
        token: CNGN,
        spender: PERMIT2_ADDRESS,
        requiredAmount: SPEND,
      }).blockers,
      [],
    );
  });

  it("lowercases the addresses it reports, so comparisons never fail on case", async () => {
    const checksummed = "0xe2023F3FA515cF070e07fD9d51c1d236e07843f4";
    const { provider } = providerWith({
      quote: ok(QUOTE),
      swap: ok(swapResponse(honest(), checksummed)),
    });
    const result = await provider.requestFirm(request());
    assert.equal(result.status, "QUOTED");
    if (result.status !== "QUOTED") return;
    assert.equal(result.transactions.swap.to, ROUTER);
    assert.equal(result.transactions.approval.to, CNGN);
  });
});
