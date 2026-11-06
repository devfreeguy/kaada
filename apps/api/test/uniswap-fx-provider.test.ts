import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createId, createMoney } from "@kaada/domain";
import type { AmountMode, Asset, AssetRegistry, QuoteRequest } from "@kaada/domain";

import { UniswapClient } from "../src/infrastructure/fx/uniswap/client.js";
import { UniswapFxProvider } from "../src/infrastructure/fx/uniswap/uniswap-fx-provider.js";
import type { UniswapTransport } from "../src/infrastructure/fx/uniswap/transport.js";

/*
 * The fixtures below are RECORDED from live calls to the Uniswap Trading API for cNGN -> wARS on Celo, trimmed to the
 * fields the adapter reads. They are not invented: the published reference redirects to a 404 and llms-full.txt has no
 * field-level schema, so the adapter was built against what the API actually answers.
 */

const CELO = 42220;
const CNGN = "0xf6829d7393dae24509eb1e52ee8e572e2e271a4f";
const WARS = "0x0dc4f92879b7670e5f4e4e6e3c801d229129d90d";

const token = (symbol: string, decimals: number, address: string, fiatCode: string): Asset => ({
  id: createId(),
  symbol,
  name: symbol,
  kind: "LOCAL_STABLECOIN",
  decimals,
  chainId: CELO,
  contractAddress: address,
  fiatCode,
  isActive: true,
});

const cNGN = token("cNGN", 6, CNGN, "NGN");
const wARS = token("wARS", 18, WARS, "ARS");
/** The same currency on another chain: structurally unsupported here, whatever Uniswap would say. */
const offChain: Asset = { ...token("wARS", 18, WARS, "ARS"), chainId: 1 };

function registry(assets: Asset[]): AssetRegistry {
  const unsupported = () => Promise.reject(new Error("not used by these tests"));
  return {
    getById: (id: string) => Promise.resolve(assets.find((asset) => asset.id === id) ?? null),
    findBySymbol: unsupported,
    findByFiatCode: unsupported,
    findByDenomination: unsupported,
    listActive: () => Promise.resolve(assets),
    requireActive: unsupported,
    decimalsOf: unsupported,
  };
}

/** The recorded CLASSIC quote: 1,400 cNGN in, 1,685.88 wARS out, 2.5% slippage. */
const RECORDED = {
  requestId: "93b25181a349efb960f7a52421810777",
  routing: "CLASSIC",
  isTokenApprovalApplicable: true,
  quote: {
    chainId: CELO,
    swapper: "0x0000000000000000000000000000000000000001",
    tradeType: "EXACT_INPUT",
    input: { amount: "1400000000", token: CNGN, maximumAmount: "1400000000" },
    output: {
      amount: "1685883838512875350502",
      token: WARS,
      recipient: "0x0000000000000000000000000000000000000001",
      minimumAmount: "1643736742550053466739",
    },
    slippage: 2.5,
    priceImpact: 0.02,
    gasFee: "63600211997880000",
    quoteId: "01a1ae2f-9bcd-8000-bdb5-4abdf4990100",
    routeString: "[v3] 100.00% = [0.01%] 0x6519 -> [0.01%] 0x5D8e",
    blockNumber: "12345",
  },
};

function transportReturning(status: number, body: unknown) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const transport: UniswapTransport = {
    post: (path, requestBody) => {
      seen.push({ path, body: requestBody as Record<string, unknown> });
      return Promise.resolve({ status, body });
    },
  };
  return { transport, seen };
}

function providerWith(status: number, body: unknown, assets: Asset[] = [cNGN, wARS]) {
  const { transport, seen } = transportReturning(status, body);
  const provider = new UniswapFxProvider({
    assets: registry(assets),
    client: new UniswapClient({ transport, timeoutMs: 5000 }),
    now: () => new Date("2026-11-06T00:00:00Z"),
    quoteSwapper: "0x0000000000000000000000000000000000000001",
  });
  return { provider, seen };
}

const request = (mode: AmountMode = "EXACT_INPUT"): QuoteRequest => ({
  userId: "user-1",
  inputAssetId: cNGN.id,
  outputAssetId: wARS.id,
  amount:
    mode === "EXACT_INPUT"
      ? createMoney("1400000000", cNGN.id)
      : createMoney("1685883838512875350502", wARS.id),
  mode,
});

describe("Uniswap as a price source", () => {
  it("prices a local-to-local pair Textile has no corridor for", async () => {
    const { provider, seen } = providerWith(200, RECORDED);
    const quote = await provider.quote(request());

    assert.equal(quote.provider, "uniswap");
    assert.equal(quote.input.amount, "1400000000");
    assert.equal(quote.output.amount, "1685883838512875350502");
    assert.equal(quote.input.assetId, cNGN.id);
    assert.equal(quote.output.assetId, wARS.id);

    // Uniswap counts slippage in percent; Kaada counts it in basis points everywhere else.
    assert.equal(quote.slippageBps, 250);
    // What the person is guaranteed if the pool moves before the swap lands.
    assert.equal(
      (quote.metadata as Record<string, unknown>)["minimumOutput"],
      "1643736742550053466739",
    );

    const sent = seen[0]?.body ?? {};
    assert.equal(seen[0]?.path, "/quote");
    assert.equal(sent["tokenIn"], CNGN);
    assert.equal(sent["tokenOut"], WARS);
    assert.equal(sent["tokenInChainId"], CELO);
    assert.equal(sent["type"], "EXACT_INPUT");
    // The price shown and the calldata that later executes must be built from the same pool versions.
    assert.deepEqual(sent["protocols"], ["V2", "V3"]);
  });

  // An AMM charges no provider fee on this route, and the pool's spread is already inside the quoted output. The
  // network cost is paid in CELO to the chain, not to Uniswap, so reporting it as a fee would put a number in front
  // of someone that nobody charges them.
  it("reports no fee, because none is charged", async () => {
    const { provider } = providerWith(200, RECORDED);
    assert.equal((await provider.quote(request())).fee, undefined);
  });

  it("refuses a route it cannot execute", async () => {
    // UniswapX is an off-chain filled order with a different lifecycle; a bridge route is not a Celo swap at all.
    const { provider } = providerWith(200, { ...RECORDED, routing: "DUTCH_LIMIT" });
    await assert.rejects(provider.quote(request()), /did not match the request/);
  });

  it("refuses a quote whose fixed side moved", async () => {
    // An AMM moves the side the person did NOT fix. The other one coming back different is a different trade.
    const moved = {
      ...RECORDED,
      quote: { ...RECORDED.quote, input: { ...RECORDED.quote.input, amount: "1399999999" } },
    };
    const { provider } = providerWith(200, moved);
    await assert.rejects(provider.quote(request()), /did not match the request/);
  });

  it("refuses a response for the wrong tokens", async () => {
    const swapped = {
      ...RECORDED,
      quote: { ...RECORDED.quote, output: { ...RECORDED.quote.output, token: CNGN } },
    };
    const { provider } = providerWith(200, swapped);
    await assert.rejects(provider.quote(request()), /did not match the request/);
  });

  it("says a pair is unsupported without calling anyone, when an asset is off Celo", async () => {
    const { provider, seen } = providerWith(200, RECORDED, [cNGN, offChain]);
    const off: QuoteRequest = { ...request(), outputAssetId: offChain.id };
    assert.equal(await provider.supports(off), false);
    assert.equal(seen.length, 0, "structural support is decided locally");
  });

  it("reads 404 as no route rather than as an outage", async () => {
    const { provider } = providerWith(404, { errorCode: "NO_ROUTE" });
    await assert.rejects(provider.quote(request()), /no route/i);
  });

  it("never carries the API key or the person's amounts into an error", async () => {
    const { provider } = providerWith(401, {
      errorCode: "Unauthorized",
      detail: "key abc123 for 1400000000",
    });
    const error = await provider.quote(request()).then(
      () => undefined,
      (e: unknown) => e,
    );
    const serialised = `${String((error as Error).message)} ${JSON.stringify(error)}`;
    assert.ok(!serialised.includes("abc123"), "no key material");
    assert.ok(!serialised.includes("1400000000"), "no amounts out of the provider's prose");
  });

  it("cannot execute: the swap is built and signed by Kaada's own executor", async () => {
    const { provider } = providerWith(200, RECORDED);
    await assert.rejects(provider.execute({} as never, {} as never), /EXECUTION_NOT_ENABLED/);
    await assert.rejects(provider.status("x"), /EXECUTION_NOT_ENABLED/);
  });
});

/*
 * Exact-output is refused at pricing, not only at execution. The firm side cannot carry it out (an AMM's input is a maximum,
 * not a known figure), so a price quoted for it is a promise nothing can keep. Before this the router chose Uniswap for
 * "send exactly 1,500 pesos", and the person met `exact_output_not_supported` only after entering their PIN.
 */
describe("Uniswap does not price what it cannot execute", () => {
  it("says it does not support an exact-output request, without calling anyone", async () => {
    const { provider, seen } = providerWith(200, RECORDED);
    assert.equal(await provider.supports(request("EXACT_OUTPUT")), false);
    assert.equal(seen.length, 0, "decided locally");
  });

  it("refuses to quote one even if asked directly, so a stale capability row cannot revive it", async () => {
    const { provider, seen } = providerWith(200, RECORDED);
    await assert.rejects(provider.quote(request("EXACT_OUTPUT")), /exact-output is not offered/);
    assert.equal(seen.length, 0, "nothing left the process");
  });

  it("still prices exact-input", async () => {
    const { provider } = providerWith(200, RECORDED);
    assert.equal(await provider.supports(request("EXACT_INPUT")), true);
  });
});
