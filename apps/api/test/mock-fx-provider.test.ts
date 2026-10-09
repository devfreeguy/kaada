import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAssetRegistry, createMoney, isKaadaError } from "@kaada/domain";
import type { QuoteRequest } from "@kaada/domain";

import { MOCK_FX_FIXTURES } from "../src/infrastructure/fx/mock-fx-provider.js";
import { createRoutingService } from "../src/infrastructure/fx/pricing.js";
import { createRoutingHarness } from "./support/routing-harness.js";

/*
 * Every number below is from MOCK / TEST fixtures: 1 USDT = 5.42 wBRL, fee 1 bps of the input
 * (rounded up), slippage 5 bps. They say nothing about real prices.
 */

function setup(options: Parameters<typeof createRoutingHarness>[0] = {}) {
  const r = createRoutingHarness(options);
  const { USDT, USDC_CELO } = r.h.assets;
  const { wBRL, wARS, wMXN } = r.tokens;
  return { ...r, USDT, USDC: USDC_CELO, wBRL, wARS, wMXN };
}

const exactInput = (
  r: ReturnType<typeof setup>,
  amount: string,
  input = r.USDT,
  output = r.wBRL,
): QuoteRequest => ({
  userId: "u",
  inputAssetId: input.id,
  outputAssetId: output.id,
  amount: createMoney(amount, input.id),
  mode: "EXACT_INPUT",
});

const exactOutput = (
  r: ReturnType<typeof setup>,
  amount: string,
  input = r.USDT,
  output = r.wBRL,
): QuoteRequest => ({
  userId: "u",
  inputAssetId: input.id,
  outputAssetId: output.id,
  amount: createMoney(amount, output.id),
  mode: "EXACT_OUTPUT",
});

describe("MockFxProvider", () => {
  it("prices EXACT_INPUT: the input is exactly what was asked and the output follows", async () => {
    const r = setup();
    const quote = await r.mock.quote(exactInput(r, "20000000")); // 20 USDT
    assert.equal(quote.input.amount, "20000000");
    // fee = ceil(20 USDT * 1 bps) = 0.002 USDT; net 19.998 USDT * 5.42 = 108.38916 wBRL, exactly.
    assert.equal(quote.fee?.amount, "2000");
    assert.equal(quote.fee?.assetId, r.USDT.id);
    assert.equal(quote.output.amount, "108389160000000000000");
    assert.equal(quote.slippageBps, 5);
    assert.equal(quote.provider, "mock-textile");
  });

  it("prices EXACT_OUTPUT: the output is exactly what was asked and the input is the minimum that covers it", async () => {
    const r = setup();
    const quote = await r.mock.quote(exactOutput(r, "500000000000000000000")); // 500 wBRL
    assert.equal(quote.output.amount, "500000000000000000000");
    // net needed = ceil(500 / 5.42 USDT) = 92.250923; gross = smallest G with G - ceil(G/10000) >= net.
    assert.equal(quote.input.amount, "92260150");
    assert.equal(quote.fee?.amount, "9227");
  });

  it("EXACT_INPUT rounds the output DOWN, never in the user's favour", async () => {
    const r = setup();
    // wARS -> USDT at 1/1020: 0.98... USDT, never representable exactly.
    for (const wars of [1n, 7n, 1001n, 123456n, 99999n]) {
      const amount = wars * 10n ** 18n + 12345n; // awkward amounts on purpose
      const quote = await r.mock.quote(exactInput(r, amount.toString(), r.wARS, r.USDT));
      const fee = BigInt(quote.fee?.amount ?? "0");
      const net = amount - fee;
      const out = BigInt(quote.output.amount);
      // out = floor(net / 1020 in USDT units) <=> out * 1020 * 1e12 <= net < (out + 1) * 1020 * 1e12
      const per = 1020n * 10n ** 12n;
      assert.ok(out * per <= net, `output ${out} does not exceed what ${net} buys`);
      assert.ok(net < (out + 1n) * per, `output ${out} is the largest whole unit`);
    }
  });

  it("EXACT_OUTPUT rounds the input UP: the output is never short and the input is minimal", async () => {
    const r = setup();
    for (const usdt of [1n, 7n, 91n, 12345n]) {
      const target = usdt * 10n ** 6n + 777n;
      const quote = await r.mock.quote(exactOutput(r, target.toString(), r.wARS, r.USDT));
      assert.equal(quote.output.amount, target.toString());
      const gross = BigInt(quote.input.amount);
      const feeOf = (g: bigint) => (g + 9_999n) / 10_000n;
      const covers = (g: bigint) => ((g - feeOf(g)) * 10n ** 6n) / (1020n * 10n ** 18n) >= target;
      // wARS -> USDT: out = floor(net_wARS * 1e6 / (1020 * 1e18)) must reach the target.
      assert.ok(covers(gross), "enough input to deliver at least the requested output");
      assert.ok(!covers(gross - 1n), "one smaller unit would fall short: the input is minimal");
    }
  });

  it("uses no floating point: huge amounts keep every digit", async () => {
    const r = setup();
    const huge = 10n ** 30n + 1n;
    const quote = await r.mock.quote(exactInput(r, huge.toString(), r.wARS, r.USDT));
    assert.equal(quote.input.amount, huge.toString());
    assert.match(quote.output.amount, /^[0-9]+$/);
  });

  it("expires quotes after the configured time", async () => {
    const r = setup({ quoteTtlMs: 12_000 });
    const quote = await r.mock.quote(exactInput(r, "20000000"));
    assert.equal(quote.expiresAt?.getTime(), r.clock.now.getTime() + 12_000);
  });

  it("supports exactly its fixture pairs, in the direction given", async () => {
    const r = setup();
    assert.equal(await r.mock.supports(exactInput(r, "1000000")), true);
    assert.equal(await r.mock.supports(exactInput(r, "1000000", r.wBRL, r.USDT)), true);
    assert.equal(await r.mock.supports(exactInput(r, "1000000", r.USDT, r.wMXN)), false);
    assert.equal(await r.mock.supports(exactInput(r, "1000000", r.USDT, r.USDT)), false);
    assert.equal(await r.mock.supports(exactInput(r, "1000000", r.wBRL, r.wARS)), false);
    await assert.rejects(r.mock.quote(exactInput(r, "1000000", r.USDT, r.wMXN)), (error) =>
      isKaadaError(error, "PAIR_NOT_SUPPORTED"),
    );
  });

  it("covers all ten verified directions and no others", () => {
    const pairs = MOCK_FX_FIXTURES.map((f) => `${f.input}>${f.output}`).sort();
    assert.deepEqual(pairs, [
      "IDRX>USDT",
      "USDC>USDT",
      "USDT>IDRX",
      "USDT>USDC",
      "USDT>cNGN",
      "USDT>wARS",
      "USDT>wBRL",
      "cNGN>USDT",
      "wARS>USDT",
      "wBRL>USDT",
    ]);
  });

  it("is labelled as mock, hides its fixture internals, and never executes", async () => {
    const r = setup();
    const quote = await r.mock.quote(exactInput(r, "20000000"));
    assert.equal(quote.metadata?.["mock"], true);
    assert.match(JSON.stringify(quote.metadata?.["label"]), /MOCK/);
    assert.match(quote.providerQuoteId ?? "", /^mock-/);
    assert.equal(JSON.stringify(quote).toLowerCase().includes("rate"), false);
    await assert.rejects(
      r.mock.execute(quote, { executionId: "e", userId: "u", idempotencyKey: "k" }),
      (error) => isKaadaError(error, "EXECUTION_FAILED"),
    );
    await assert.rejects(r.mock.status("x"), (error) => isKaadaError(error, "EXECUTION_FAILED"));
  });

  it("supports configured failures per pair", async () => {
    const r = setup();
    r.mock.setFailure("USDT", "wBRL", "UNAVAILABLE");
    await assert.rejects(r.mock.quote(exactInput(r, "20000000")), (error) =>
      isKaadaError(error, "PROVIDER_UNAVAILABLE"),
    );
    r.mock.setFailure("USDT", "wBRL", "ERROR");
    await assert.rejects(r.mock.quote(exactInput(r, "20000000")), /configured failure/);
    r.mock.setFailure("USDT", "wBRL", undefined);
    await r.mock.quote(exactInput(r, "20000000"));
  });

  it("treats an inactive asset as unsupported", async () => {
    const r = setup();
    r.wBRL.isActive = false;
    assert.equal(await r.mock.supports(exactInput(r, "20000000")), false);
    const registry = createAssetRegistry(r.world.repositories.assets);
    assert.ok(registry);
  });
});

describe("pricing configuration", () => {
  const deps = (r: ReturnType<typeof setup>) => ({
    assets: r.world.repositories.assets,
    providers: r.world.repositories.providers,
    read: r.world.repositories,
  });

  it("is off with FX_PROVIDER=none", () => {
    const r = setup();
    assert.equal(
      createRoutingService({ nodeEnv: "development", fx: { provider: "none" } }, deps(r)),
      null,
    );
  });

  it("builds the mock service in development and test", () => {
    const r = setup();
    for (const nodeEnv of ["development", "test"] as const) {
      assert.ok(createRoutingService({ nodeEnv, fx: { provider: "mock" } }, deps(r)));
    }
  });

  it("refuses the mock provider in production", () => {
    const r = setup();
    assert.throws(
      () => createRoutingService({ nodeEnv: "production", fx: { provider: "mock" } }, deps(r)),
      /cannot be used in production/,
    );
  });
});
