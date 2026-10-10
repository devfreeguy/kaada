import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssetRegistry, createMoney, isKaadaError } from "@kaada/domain";
import type { Asset, QuoteRequest } from "@kaada/domain";

import {
  TextileClient,
  TextileClientError,
  TextileFxProvider,
  createFetchTransport,
} from "../src/infrastructure/fx/textile/index.js";
import { assertChainForEnvironment } from "../src/infrastructure/fx/textile/sandbox.js";
import {
  FakeTextileTransport,
  errorReply,
  noQuoteReply,
  previewReply,
  pricingFixture,
} from "./support/textile-fixtures.js";
import type { Reply } from "./support/textile-fixtures.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import { intent } from "./support/harness.js";

/*
 * Offline contract tests for the Textile adapter. Every response is a hand-written TEST FIXTURE in
 * the documented shape (not a captured live response). Nothing here touches the network.
 */

const SECRET = "tx_live_abcd1234.THE-SECRET-VALUE";

function setup(
  replies: Reply[],
  options: { fallback?: ConstructorParameters<typeof FakeTextileTransport>[1] } = {},
) {
  const r = createRoutingHarness();
  const transport = new FakeTextileTransport(replies, options.fallback);
  const sleeps: number[] = [];
  const client = new TextileClient({
    transport,
    timeoutMs: 8000,
    backoffMs: 250,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  const logs: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  const provider = new TextileFxProvider({
    assets: createAssetRegistry(r.world.repositories.assets),
    client,
    now: () => r.clock.now,
    log: (level, event, fields) => void logs.push({ level, event, fields }),
  });
  return {
    ...r,
    transport,
    sleeps,
    client,
    provider,
    logs,
    usdt: r.h.assets.USDT,
    usdc: r.h.assets.USDC_CELO,
    wbrl: r.tokens.wBRL,
  };
}

const exactInput = (from: Asset, to: Asset, amount: string): QuoteRequest => ({
  userId: "u",
  inputAssetId: from.id,
  outputAssetId: to.id,
  amount: createMoney(amount, from.id),
  mode: "EXACT_INPUT",
});
const exactOutput = (from: Asset, to: Asset, amount: string): QuoteRequest => ({
  userId: "u",
  inputAssetId: from.id,
  outputAssetId: to.id,
  amount: createMoney(amount, to.id),
  mode: "EXACT_OUTPUT",
});

// A documented-shape answer for 2 USDT in: fee 200 (1 bps, contained), 1.8 wBRL net... made up.
const TWO_USDT = "2000000";
const goodPreview = (over: Partial<Parameters<typeof previewReply>[0]> = {}) =>
  previewReply({
    sellAmount: TWO_USDT,
    buyAmount: "10838916000000000000",
    feeAmount: "200",
    takerPays: TWO_USDT,
    rateRay: "5420000000000000000000000000",
    ...over,
  });

describe("request mapping", () => {
  it("EXACT_INPUT sends sellAmount (never buyAmount), the Celo chain and token addresses", async () => {
    const s = setup([goodPreview()]);
    await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    const [call] = s.transport.calls;
    assert.equal(call?.path, "/v2/rfq/preview");
    assert.deepEqual(call?.body, {
      chainId: 42220,
      sellToken: s.usdt.contractAddress,
      buyToken: s.wbrl.contractAddress,
      sellAmount: TWO_USDT,
    });
    assert.equal("buyAmount" in (call?.body ?? {}), false);
    assert.equal("taker" in (call?.body ?? {}), false, "an indicative price needs no wallet");
    assert.equal(call?.timeoutMs, 8000);
  });

  it("EXACT_OUTPUT sends buyAmount (never sellAmount)", async () => {
    const s = setup([
      goodPreview({
        sellAmount: "1847000",
        takerPays: "1847000",
        buyAmount: "10000000000000000000",
        feeAmount: "185",
      }),
    ]);
    await s.provider.quote(exactOutput(s.usdt, s.wbrl, "10000000000000000000"));
    assert.deepEqual(s.transport.calls[0]?.body, {
      chainId: 42220,
      sellToken: s.usdt.contractAddress,
      buyToken: s.wbrl.contractAddress,
      buyAmount: "10000000000000000000",
    });
  });

  it("maps addresses from asset metadata for each side and direction", async () => {
    const s = setup([goodPreview({ buyAmount: "1999000", takerPays: TWO_USDT })]);
    await s.provider.quote(exactInput(s.usdc, s.usdt, TWO_USDT));
    assert.equal(s.transport.calls[0]?.body["sellToken"], s.usdc.contractAddress);
    assert.equal(s.transport.calls[0]?.body["buyToken"], s.usdt.contractAddress);
  });

  it("rejects amounts that are not canonical atomic strings before any request is made", async () => {
    const s = setup([]);
    for (const bad of ["", "012", "1.5", "-1", "1e6", " 5", "0"]) {
      await assert.rejects(
        s.provider.quote({
          ...exactInput(s.usdt, s.wbrl, "1"),
          amount: { amount: bad, assetId: s.usdt.id },
        }),
        (error) => isKaadaError(error),
        `amount ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(s.transport.calls.length, 0);
  });

  it("rejects a mismatched fixed side, the wrong chain, fiat, inactive and identical assets locally", async () => {
    const s = setup([]);
    const fiat = s.h.assets.BRL;
    const otherChain = s.h.assets.USDC_OTHER;
    otherChain.isActive = true; // it exists, but on chain 1
    const inactive = s.tokens.wMXN;
    inactive.isActive = false;

    const attempts: [string, QuoteRequest][] = [
      [
        "amount in the wrong asset",
        { ...exactInput(s.usdt, s.wbrl, "1000000"), amount: createMoney("1000000", s.wbrl.id) },
      ],
      ["a fiat asset", exactInput(fiat, s.usdt, "1000")],
      ["a token on another chain", exactInput(otherChain, s.usdt, "1000000")],
      ["an inactive asset", exactInput(s.usdt, inactive, "1000000")],
      ["the same asset on both sides", exactInput(s.usdt, s.usdt, "1000000")],
    ];
    for (const [label, request] of attempts) {
      assert.equal(
        await s.provider.supports(request),
        label === "amount in the wrong asset",
        label,
      );
      await assert.rejects(s.provider.quote(request), (error) => isKaadaError(error), label);
    }
    assert.equal(s.transport.calls.length, 0, "none of these ever reached Textile");
  });

  it("only allows a chain that matches the environment of the key", () => {
    assert.doesNotThrow(() => assertChainForEnvironment("test", 97));
    assert.doesNotThrow(() => assertChainForEnvironment("test", 84532));
    assert.throws(
      () => assertChainForEnvironment("test", 42220),
      /only reaches chains 97 and 84532/,
    );
    assert.doesNotThrow(() => assertChainForEnvironment("live", 42220));
    assert.throws(() => assertChainForEnvironment("live", 97), /Celo mainnet/);
    assert.throws(() => assertChainForEnvironment("live", 1), /Celo mainnet/);
  });
});

describe("response normalisation", () => {
  it("EXACT_INPUT: input is the requested cap, output is buyAmount, the fee is the one Textile gave", async () => {
    const s = setup([goodPreview()]);
    const quote = await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    assert.equal(quote.provider, "textile");
    assert.deepEqual(quote.input, createMoney(TWO_USDT, s.usdt.id));
    assert.deepEqual(quote.output, createMoney("10838916000000000000", s.wbrl.id));
    // Textile's feeAmount is contained in takerPays: it is reported, not added on top.
    assert.deepEqual(quote.fee, createMoney("200", s.usdt.id));
    assert.equal(
      quote.input.amount,
      TWO_USDT,
      "no fee was added to the input (no double counting)",
    );
    assert.ok(BigInt(quote.fee?.amount ?? "0") <= BigInt(quote.input.amount));
  });

  it("keeps the cap as the input even when Textile debits a unit less, and records the real debit", async () => {
    const s = setup([goodPreview({ takerPays: "1999999" })]);
    const quote = await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    assert.equal(quote.input.amount, TWO_USDT);
    assert.equal(quote.metadata?.["takerPays"], "1999999");
  });

  it("EXACT_OUTPUT: output is exactly the requested amount, input is Textile's takerPays", async () => {
    const s = setup([
      goodPreview({
        sellAmount: "1850000",
        takerPays: "1850000",
        buyAmount: "10000000000000000000",
        feeAmount: "185",
      }),
    ]);
    const quote = await s.provider.quote(exactOutput(s.usdt, s.wbrl, "10000000000000000000"));
    assert.equal(quote.output.amount, "10000000000000000000");
    assert.equal(quote.input.amount, "1850000");
    assert.equal(quote.fee?.amount, "185");
  });

  it("does not invent a slippage, a quote id or Textile's expiry; the freshness window is Kaada's own", async () => {
    const s = setup([goodPreview()]);
    const quote = await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    assert.equal(quote.slippageBps, undefined);
    assert.equal(quote.providerQuoteId, undefined);
    assert.equal(quote.expiresAt?.getTime(), s.clock.now.getTime() + 10_000);
    assert.equal(quote.metadata?.["indicative"], true);
    assert.equal(quote.metadata?.["expiryBasis"], "kaada-indicative-window");
    assert.equal(quote.metadata?.["source"], "textile-rfq-preview");
  });

  it("stores no payload, signature or credential in the quote", async () => {
    const s = setup([goodPreview()]);
    const quote = await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    const text = JSON.stringify(quote).toLowerCase();
    for (const forbidden of [
      "calldata",
      "signature",
      "encodedorder",
      "claimtoken",
      "authorization",
      "bearer",
    ]) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  });

  it("rejects a response that does not match what was asked", async () => {
    type Build = (s: ReturnType<typeof setup>) => QuoteRequest;
    const input: Build = (s) => exactInput(s.usdt, s.wbrl, TWO_USDT);
    const output: Build = (s) => exactOutput(s.usdt, s.wbrl, "10000000000000000000");
    const cases: [string, Build, Reply][] = [
      ["sell amount differs", input, goodPreview({ sellAmount: "3000000" })],
      ["spend exceeds the cap", input, goodPreview({ takerPays: "2000001" })],
      ["fee exceeds total", input, goodPreview({ feeAmount: "2000001" })],
      ["zero output", input, goodPreview({ buyAmount: "0" })],
      ["buy amount differs", output, goodPreview({ buyAmount: "9000000000000000000" })],
    ];
    for (const [label, build, reply] of cases) {
      const s = setup([reply]);
      await assert.rejects(
        s.provider.quote(build(s)),
        (error) => isKaadaError(error, "PROVIDER_UNAVAILABLE"),
        label,
      );
      assert.equal(s.transport.calls.length, 1, `${label}: not retried`);
    }
  });

  it("a no_quote answer is a clean 'no route', not a retry", async () => {
    const s = setup([noQuoteReply("no_makers_online")]);
    await assert.rejects(
      s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT)),
      (error) =>
        isKaadaError(error, "NO_ROUTE_AVAILABLE") &&
        error.details?.["providerReason"] === "no_makers_online",
    );
    assert.equal(s.transport.calls.length, 1);
  });
});

describe("malformed responses", () => {
  const malformed: [string, Reply][] = [
    ["an empty body", { status: 200 }],
    ["a body without data", { status: 200, body: { nope: true } }],
    ["an unknown status", { status: 200, body: { data: { status: "weird" } } }],
    [
      "a missing field",
      { status: 200, body: { data: { status: "preview", sellAmount: TWO_USDT } } },
    ],
    ["a decimal amount", goodPreview({ buyAmount: "1.5" })],
    ["a negative amount", goodPreview({ buyAmount: "-5" })],
    ["a leading-zero amount", goodPreview({ feeAmount: "0200" })],
    [
      "a non-string amount",
      {
        status: 200,
        body: {
          data: {
            status: "preview",
            sellAmount: 2000000,
            buyAmount: "1",
            feeAmount: "1",
            takerPays: "1",
          },
        },
      },
    ],
  ];
  for (const [label, reply] of malformed) {
    it(`rejects ${label} once, without retrying`, async () => {
      const s = setup([reply]);
      await assert.rejects(
        s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT)),
        (error) =>
          isKaadaError(error, "PROVIDER_UNAVAILABLE") &&
          error.details?.["providerKind"] === "MALFORMED_RESPONSE",
      );
      assert.equal(s.transport.calls.length, 1);
      assert.deepEqual(s.sleeps, []);
    });
  }
});

describe("provider failures and retries", () => {
  const run = (replies: Reply[]) => {
    const s = setup(replies);
    return { s, result: s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT)) };
  };

  it("maps a timeout to PROVIDER_UNAVAILABLE after one bounded retry", async () => {
    const { s, result } = run([{ throws: "TIMEOUT" }, { throws: "TIMEOUT" }, goodPreview()]);
    await assert.rejects(
      result,
      (error) =>
        isKaadaError(error, "PROVIDER_UNAVAILABLE") &&
        error.details?.["providerKind"] === "TIMEOUT",
    );
    assert.equal(s.transport.calls.length, 2, "first attempt plus exactly one retry");
    assert.deepEqual(s.sleeps, [250]);
  });

  it("retries a transient network error once and then succeeds", async () => {
    const { s, result } = run([{ throws: "NETWORK" }, goodPreview()]);
    assert.equal((await result).provider, "textile");
    assert.equal(s.transport.calls.length, 2);
  });

  it("honours a short Retry-After on 429, then succeeds", async () => {
    const { s, result } = run([
      errorReply(429, "rate_limited", undefined, { "retry-after": "1" }),
      goodPreview(),
    ]);
    await result;
    assert.deepEqual(s.sleeps, [1000]);
    assert.equal(s.transport.calls.length, 2);
  });

  it("does not wait for a long Retry-After, nor retry a 429 that gives none (the RFQ cap)", async () => {
    const long = run([
      errorReply(429, "rate_limited", undefined, { "retry-after": "60" }),
      goodPreview(),
    ]);
    await assert.rejects(
      long.result,
      (error) =>
        isKaadaError(error, "PROVIDER_UNAVAILABLE") &&
        error.details?.["providerKind"] === "RATE_LIMITED",
    );
    assert.equal(long.s.transport.calls.length, 1);

    const cap = run([errorReply(429, "rate_limited"), goodPreview()]);
    await assert.rejects(cap.result, (error) => isKaadaError(error, "PROVIDER_UNAVAILABLE"));
    assert.equal(cap.s.transport.calls.length, 1);
  });

  it("retries a documented transient 5xx once, and gives up if it persists", async () => {
    const recovers = run([errorReply(503, "venue_unavailable"), goodPreview()]);
    await recovers.result;
    assert.equal(recovers.s.transport.calls.length, 2);

    for (const status of [500, 502, 503]) {
      const { s, result } = run([
        errorReply(status, "upstream_error"),
        errorReply(status, "upstream_error"),
        goodPreview(),
      ]);
      await assert.rejects(
        result,
        (error) =>
          isKaadaError(error, "PROVIDER_UNAVAILABLE") && error.details?.["httpStatus"] === status,
      );
      assert.equal(s.transport.calls.length, 2, `${status}: bounded`);
    }
  });

  it("never retries an invalid request, an auth failure or a conflict", async () => {
    for (const reply of [
      errorReply(400, "invalid_request"),
      errorReply(401, "unauthorized"),
      errorReply(403, "forbidden"),
      errorReply(404, "not_found"),
      errorReply(409, "conflict"),
      { status: 418 } as Reply,
    ]) {
      const { s, result } = run([reply, goodPreview()]);
      await assert.rejects(result, (error) => isKaadaError(error));
      assert.equal(s.transport.calls.length, 1);
    }
  });

  it("maps an unsupported pair (400 corridor_unavailable) to PAIR_NOT_SUPPORTED", async () => {
    const { result } = run([
      errorReply(400, "invalid_request", { reason: "corridor_unavailable" }),
    ]);
    await assert.rejects(
      result,
      (error) =>
        isKaadaError(error, "PAIR_NOT_SUPPORTED") &&
        error.details?.["providerCode"] === "invalid_request",
    );
  });

  it("clamps the retry count: never more than two retries, whatever is configured", async () => {
    const transport = new FakeTextileTransport([], () => ({ throws: "NETWORK" }));
    const client = new TextileClient({
      transport,
      timeoutMs: 1000,
      maxRetries: 50,
      sleep: () => Promise.resolve(),
    });
    await assert.rejects(
      client.preview({
        chainId: 42220,
        sellToken: "0xa",
        buyToken: "0xb",
        exact: { mode: "EXACT_INPUT", sellAmount: "1" },
      }),
      (error) => error instanceof TextileClientError && error.meta.attempts === 3,
    );
    assert.equal(transport.calls.length, 3);
  });

  it("keeps the other candidate alive: one failed pair does not poison the next quote", async () => {
    const s = setup([
      errorReply(400, "invalid_request", { reason: "corridor_unavailable" }),
      goodPreview(),
    ]);
    await assert.rejects(s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT)));
    assert.equal(
      (await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT))).provider,
      "textile",
    );
  });
});

describe("no execution, no secrets", () => {
  it("execute() and status() refuse with EXECUTION_NOT_ENABLED and send nothing", async () => {
    const s = setup([goodPreview()]);
    const quote = await s.provider.quote(exactInput(s.usdt, s.wbrl, TWO_USDT));
    await assert.rejects(
      s.provider.execute(quote, { executionId: "e", userId: "u", idempotencyKey: "k" }),
      (error) => isKaadaError(error, "EXECUTION_NOT_ENABLED"),
    );
    await assert.rejects(s.provider.status("x"), (error) =>
      isKaadaError(error, "EXECUTION_NOT_ENABLED"),
    );
    assert.equal(s.transport.calls.length, 1, "only the price request was ever made");
    // The client exposes no way to submit, cancel or swap.
    const methods = Object.getOwnPropertyNames(TextileClient.prototype).filter(
      (n) => !n.startsWith("_"),
    );
    for (const forbidden of ["submit", "cancel", "swap", "execute", "settle"]) {
      assert.equal(methods.includes(forbidden), false, forbidden);
    }
  });

  it("the transport sends the key only as Authorization: Bearer, and never echoes it", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      seen.push({
        url,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? init.body : "",
      });
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "unauthorized" } }), { status: 401 }),
      );
    }) as unknown as typeof fetch;
    const transport = createFetchTransport({
      baseUrl: "https://api.textilecredit.com/",
      apiKey: SECRET,
      fetch: fakeFetch,
    });
    const response = await transport.post(
      "/v2/rfq/preview",
      { chainId: 42220 },
      { timeoutMs: 1000 },
    );

    assert.equal(response.status, 401);
    assert.equal(seen[0]?.url, "https://api.textilecredit.com/v2/rfq/preview");
    assert.equal(seen[0]?.headers["authorization"], `Bearer ${SECRET}`);
    assert.equal(seen[0]?.body.includes("tx_live"), false, "the key is not in the body");
  });

  it("maps an aborted or failed fetch to a typed transport error without leaking the key", async () => {
    const aborting = (() => {
      const error = new Error(`aborted ${SECRET}`);
      error.name = "AbortError";
      return Promise.reject(error);
    }) as unknown as typeof fetch;
    const failing = (() => Promise.reject(new Error(`boom ${SECRET}`))) as unknown as typeof fetch;
    for (const [f, kind] of [
      [aborting, "TIMEOUT"],
      [failing, "NETWORK"],
    ] as const) {
      const transport = createFetchTransport({
        baseUrl: "https://api.textilecredit.com",
        apiKey: SECRET,
        fetch: f,
      });
      await assert.rejects(
        transport.post("/v2/rfq/preview", {}, { timeoutMs: 50 }),
        (error) =>
          error instanceof Error &&
          "failure" in error &&
          error.failure === kind &&
          !error.message.includes("THE-SECRET"),
      );
    }
  });

  it("logs safe facts about every call and never a secret or payload", async () => {
    const ok = setup([goodPreview()]);
    await ok.provider.quote(exactInput(ok.usdt, ok.wbrl, TWO_USDT));
    const bad = setup([errorReply(401, "unauthorized")]);
    await assert.rejects(bad.provider.quote(exactInput(bad.usdt, bad.wbrl, TWO_USDT)));

    for (const entry of [...ok.logs, ...bad.logs]) {
      const text = JSON.stringify(entry);
      assert.equal(text.includes("tx_live"), false);
      assert.equal(text.includes("tx_test"), false);
      assert.equal(text.toLowerCase().includes("bearer"), false);
      assert.equal(entry.event, "textile.quote");
      assert.equal(entry.fields["provider"], "textile");
      assert.equal(entry.fields["pair"], "USDT>wBRL");
      assert.equal(entry.fields["mode"], "EXACT_INPUT");
      assert.equal(typeof entry.fields["latencyMs"], "number");
    }
    assert.equal(ok.logs[0]?.fields["requestId"], "req_fixture_1");
    assert.equal(bad.logs[0]?.fields["httpStatus"], 401);
  });
});

describe("through the RoutingService (offline)", () => {
  const rates = (r: ReturnType<typeof createRoutingHarness>) => {
    const key = (a: Asset, b: Asset) => `${String(a.contractAddress)}>${String(b.contractAddress)}`;
    const { USDT, USDC_CELO } = r.h.assets;
    const { wBRL } = r.tokens;
    return pricingFixture({
      [key(USDT, wBRL)]: { numerator: 542n, denominator: 100n, sellDecimals: 6, buyDecimals: 18 },
      [key(USDC_CELO, USDT)]: { numerator: 1n, denominator: 1n, sellDecimals: 6, buyDecimals: 6 },
    });
  };

  function routed() {
    let transport: FakeTextileTransport | undefined;
    const r = createRoutingHarness({
      pricing: ({ assets, now }) => {
        transport = new FakeTextileTransport([], (call) => rates(r)(call));
        return new TextileFxProvider({
          assets,
          now,
          client: new TextileClient({ transport, timeoutMs: 8000, sleep: () => Promise.resolve() }),
        });
      },
    });
    const joao = { type: "SAVED_BENEFICIARY" as const, value: "João" };
    r.h.script.set(
      "quote 2 usdc",
      intent({
        type: "QUOTE",
        amount: { value: "2", currencyOrAsset: "USDC", mode: "EXACT_INPUT" },
        fromAsset: "USDC",
        destination: { country: "BR" },
      }),
    );
    r.h.script.set(
      "pay exact usdc",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "10", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
        sourceAsset: "USDC",
      }),
    );
    r.h.script.set(
      "pay exact usdt",
      intent({
        type: "SEND",
        recipient: joao,
        amount: { value: "10", currencyOrAsset: "BRL", mode: "EXACT_OUTPUT" },
        sourceAsset: "USDT",
      }),
    );
    return { r, transport: () => transport as FakeTextileTransport };
  }

  it("QUOTE: a USDC -> USDT -> wBRL multi-hop is priced forward through two Textile calls", async () => {
    const { r, transport } = routed();
    const turn = await r.h.say("quote 2 usdc");
    assert.equal(turn.response.type, "QUOTE_RESULT", JSON.stringify(turn.response));
    if (turn.response.type !== "QUOTE_RESULT") return;
    assert.deepEqual(
      turn.response.route.hops.map((h) => `${h.provider}:${h.from}>${h.to}`),
      ["textile:USDC>USDT", "textile:USDT>wBRL"],
    );
    assert.equal(turn.response.indicative, true);
    assert.match(turn.response.text, /indicative price, not a firm quote/);
    assert.match(turn.response.text, /Nothing was sent/);
    const calls = transport().calls;
    assert.deepEqual(
      calls.map((c) => Object.keys(c.body).includes("sellAmount")),
      [true, true],
      "exact input is quoted forward",
    );
    assert.equal(
      calls.every((c) => c.path === "/v2/rfq/preview"),
      true,
      "only price requests were made",
    );
  });

  it("PAYMENT: an exact-output multi-hop is priced backward and persisted under the textile provider", async () => {
    const { r, transport } = routed();
    const turn = await r.h.say("pay exact usdc");
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    if (turn.response.type !== "PAYMENT_READY") return;
    assert.equal(turn.response.recipientReceives.expected.display, "10 wBRL");
    assert.equal(turn.response.indicative, true);
    assert.deepEqual(
      turn.response.route.hops.map((h) => h.provider),
      ["textile", "textile"],
    );

    const calls = transport().calls;
    assert.deepEqual(
      calls.map((c) => Object.keys(c.body).includes("buyAmount")),
      [true, true],
      "exact output is quoted backward",
    );
    assert.equal(
      calls[0]?.body["buyToken"],
      r.tokens.wBRL.contractAddress,
      "the last hop is quoted first",
    );

    const textile = await r.world.repositories.providers.findBySlug("textile");
    assert.equal(r.world.quotes.length, 2);
    assert.ok(r.world.quotes.every((q) => q.providerId === textile?.id));
    assert.ok(r.world.quotes.every((q) => q.providerQuoteId === undefined));
    assert.ok(r.world.quotes.every((q) => q.rawProviderData?.["indicative"] === true));
    assert.ok(r.world.quotes.every((q) => q.rawProviderData?.["adapter"] === "textile"));
    assert.ok(r.world.quotes.every((q) => q.expiresAt));
    // The route expires with its earliest quote.
    const [route] = [...r.world.routes.values()];
    const earliest = Math.min(...r.world.quotes.map((q) => q.expiresAt?.getTime() ?? Infinity));
    assert.equal(route?.expiresAt?.getTime(), earliest);
  });

  it("PAYMENT: a direct USDT route uses one call and never executes anything", async () => {
    const { r, transport } = routed();
    const turn = await r.h.say("pay exact usdt");
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    assert.equal(transport().calls.length, 1);
    for (const message of r.world.messages) {
      assert.notEqual(
        (message.structuredData as { type?: string } | undefined)?.type,
        "AUTHORIZATION_REQUIRED",
      );
    }
    assert.equal([...r.world.intents.values()][0]?.status, "RESOLVED");
  });
});

describe("regression fixtures from the STRUCTURE of live TEST-environment responses", () => {
  // Shapes observed from POST /v2/rfq/preview on BNB testnet (chain 97) with a tx_test_ key. Values are
  // made-up test numbers; no ids, keys or addresses are copied. They guard the schema against drift.
  const routing = {
    preferenceApplied: false,
    restrictionApplied: false,
    fallbackUsed: false,
    targetMakerWallets: [],
    preferredQuotesReceived: 0,
    openMarketQuotesReceived: 1,
  };
  const request = {
    chainId: 42220,
    sellToken: "0xa",
    buyToken: "0xb",
    exact: { mode: "EXACT_INPUT" as const, sellAmount: "100000000" },
  };
  const client = (reply: Reply) =>
    new TextileClient({ transport: new FakeTextileTransport([reply]), timeoutMs: 1000 });

  it("accepts a real-shaped preview with the extra documented fields (routing, availableSellAmount)", async () => {
    const { data, meta } = await client({
      status: 200,
      headers: {
        "x-request-id": "req_fixture",
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "46",
      },
      body: {
        data: {
          status: "preview",
          sellAmount: "100000000",
          buyAmount: "73490754631875000",
          feeAmount: "49975",
          takerPays: "100000000",
          rateRay: "735275000000000000000000",
          routing,
          availableSellAmount: "5000000000",
        },
      },
    }).preview(request);
    assert.equal(data.status, "preview");
    assert.equal(meta.requestId, "req_fixture");
    // Observed: fee = floor(sellAmount * bps / (10000 + bps)), taken out of takerPays (5 bps on test).
    assert.equal(49975n, (100000000n * 5n) / 10005n);
  });

  it("accepts a real-shaped no_quote that comes back as HTTP 200 (a tiny amount)", async () => {
    const { data } = await client({
      status: 200,
      body: {
        data: {
          status: "no_quote",
          reason: "no_valid_quote",
          routing,
          availableSellAmount: "5000000000",
        },
      },
    }).preview(request);
    assert.deepEqual(
      [data.status, data.status === "no_quote" && data.reason],
      ["no_quote", "no_valid_quote"],
    );
  });

  it("classifies a real-shaped corridor_unavailable 400 (seen on Base Sepolia with a test key)", async () => {
    await assert.rejects(
      client(errorReply(400, "invalid_request", { reason: "corridor_unavailable" })).preview(
        request,
      ),
      (error) =>
        error instanceof TextileClientError &&
        error.kind === "INVALID_REQUEST" &&
        error.meta.reason === "corridor_unavailable",
    );
  });
});
