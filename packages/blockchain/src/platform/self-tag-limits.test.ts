import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_COST_WEI,
  assertSelfTagLimits,
  endsWithAttribution,
  planCostWei,
} from "./self-tag-limits.js";
import type { SelfTagPlan } from "./self-tag-limits.js";
import { attributionSuffix, withAttribution } from "../attribution.js";

const WALLET = "0x92fd470fC469585749a3CedA736A1e426F7D85D5";
const OTHER = "0x3274805f27cdb4d83b6Dc20Fec338AA4eb7B2BA4";

/** 21,600 gas at 250 gwei: about 0.0054 CELO, well under the limit. */
const ok: SelfTagPlan = {
  from: WALLET,
  to: WALLET,
  value: 0n,
  gas: 21_600n,
  maxFeePerGas: 250_000_000_000n,
  balance: 10_000_000_000_000_000n,
};

describe("send-tagged-self limits", () => {
  it("accepts a zero-value self-transfer that is cheap and affordable", () => {
    assert.doesNotThrow(() => assertSelfTagLimits(ok));
  });

  it("compares addresses by value, not by letter case", () => {
    assert.doesNotThrow(() =>
      assertSelfTagLimits({ ...ok, to: WALLET.toLowerCase() as `0x${string}` }),
    );
  });

  it("refuses any recipient but the wallet itself", () => {
    assert.throws(
      () => assertSelfTagLimits({ ...ok, to: OTHER }),
      /recipient must be the platform wallet's own address/,
    );
  });

  it("refuses a non-zero value", () => {
    assert.throws(() => assertSelfTagLimits({ ...ok, value: 1n }), /value must be 0/);
  });

  it("refuses a cost at or over 0.02 CELO and accepts one wei under", () => {
    const gas = 100_000n;
    const exactly = { ...ok, gas, maxFeePerGas: MAX_COST_WEI / gas, balance: 10n ** 18n };
    assert.equal(planCostWei(exactly), MAX_COST_WEI);
    assert.throws(() => assertSelfTagLimits(exactly), /not under/);
    assert.throws(
      () => assertSelfTagLimits({ ...exactly, maxFeePerGas: exactly.maxFeePerGas * 2n }),
      /not under/,
    );
    assert.doesNotThrow(() =>
      assertSelfTagLimits({ ...exactly, maxFeePerGas: exactly.maxFeePerGas - 1n }),
    );
  });

  it("stops with a clear message when the balance cannot pay for it", () => {
    const needed = planCostWei(ok);
    assert.throws(
      () => assertSelfTagLimits({ ...ok, balance: needed - 1n }),
      /cannot pay.*fund 0x92fd470f/,
    );
    assert.doesNotThrow(() => assertSelfTagLimits({ ...ok, balance: needed }));
    assert.throws(() => assertSelfTagLimits({ ...ok, balance: 0n }), /cannot pay/);
  });

  it("checks the recipient and value before the cost and balance", () => {
    assert.throws(() => assertSelfTagLimits({ ...ok, to: OTHER, balance: 0n }), /recipient/);
    assert.throws(() => assertSelfTagLimits({ ...ok, value: 1n, balance: 0n }), /value/);
  });
});

describe("the tag check", () => {
  it("is yes only when the attribution suffix is at the very end of the input", () => {
    assert.equal(endsWithAttribution(withAttribution("0x")), true);
    assert.equal(endsWithAttribution(withAttribution("0xdeadbeef")), true);
    assert.equal(endsWithAttribution(`${attributionSuffix()}00`), false);
    assert.equal(endsWithAttribution("0x"), false);
  });

  it("a bare tagged transaction's calldata is exactly the 35-byte suffix", () => {
    const data = withAttribution(undefined);
    assert.equal((data.length - 2) / 2, 35);
    assert.equal(data, attributionSuffix());
  });
});
