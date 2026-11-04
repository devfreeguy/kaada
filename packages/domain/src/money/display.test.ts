import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CRYPTO_DISPLAY_STYLE,
  fiatDisplayStyle,
  formatDisplayAmount,
  formatRate,
} from "./display.js";

/** The two amounts from the screenshot that started this: exact in storage, unreadable on screen. */
const SCREENSHOT_CELO = "634149494131350000"; // 0.63414949413135 CELO, 18 decimals
const SCREENSHOT_ARS = "1658664477012781275141"; // AR$1,658.664477012781275141, 18 decimals

describe("fiat display", () => {
  const ngn = fiatDisplayStyle("NGN");

  it("shows the screenshot's Argentine peso amount to the centavo", () => {
    assert.equal(formatDisplayAmount(SCREENSHOT_ARS, 18, fiatDisplayStyle("ARS")), "1,658.66");
  });

  it("groups thousands and drops a fraction that is only zeros", () => {
    assert.equal(formatDisplayAmount("140000", 2, ngn), "1,400");
    assert.equal(formatDisplayAmount("1234567890", 2, ngn), "12,345,678.90");
    assert.equal(formatDisplayAmount("0", 2, ngn), "0");
  });

  it("keeps both decimals of a fractional fiat amount, never one", () => {
    assert.equal(formatDisplayAmount("140050", 2, ngn), "1,400.50");
    assert.equal(formatDisplayAmount("140005", 2, ngn), "1,400.05");
  });

  it("follows each currency's own convention, including zero-decimal IDR", () => {
    assert.equal(fiatDisplayStyle("IDR").decimals, 0);
    assert.equal(formatDisplayAmount("20000500", 3, fiatDisplayStyle("IDR")), "20,001");
    assert.equal(fiatDisplayStyle("BRL").decimals, 2);
    assert.equal(fiatDisplayStyle("ars").decimals, 2, "the code is read case-insensitively");
    assert.equal(fiatDisplayStyle("ZZZ").decimals, 2, "an unlisted currency uses the usual two");
  });

  it("rounds half up at the displayed precision, exactly", () => {
    assert.equal(formatDisplayAmount("1005", 3, ngn), "1.01");
    assert.equal(formatDisplayAmount("1004", 3, ngn), "1");
    assert.equal(formatDisplayAmount("1015", 3, ngn), "1.02");
    assert.equal(formatDisplayAmount("999999", 3, ngn), "1,000");
  });

  it("never shows a nonzero fiat amount as zero: dust is shown as a bound", () => {
    assert.equal(formatDisplayAmount("1", 18, ngn), "<0.01");
    assert.equal(formatDisplayAmount("4999999999999999", 18, ngn), "<0.01");
    assert.equal(formatDisplayAmount("5000000000000000", 18, ngn), "0.01");
    assert.equal(formatDisplayAmount("1", 6, fiatDisplayStyle("IDR")), "<1");
  });

  it("handles amounts far larger than a float could hold exactly", () => {
    assert.equal(
      formatDisplayAmount("123456789012345678901234567890", 18, ngn),
      "123,456,789,012.35",
    );
  });
});

describe("token display", () => {
  it("shows the screenshot's CELO balance to three decimals", () => {
    assert.equal(formatDisplayAmount(SCREENSHOT_CELO, 18, CRYPTO_DISPLAY_STYLE), "0.634");
  });

  it("drops meaningless trailing zeros", () => {
    assert.equal(formatDisplayAmount("2000000000000000000", 18, CRYPTO_DISPLAY_STYLE), "2");
    assert.equal(formatDisplayAmount("1500000000000000000", 18, CRYPTO_DISPLAY_STYLE), "1.5");
    assert.equal(formatDisplayAmount("1050000000000000000", 18, CRYPTO_DISPLAY_STYLE), "1.05");
  });

  it("adapts to very small nonzero balances instead of rounding them away", () => {
    assert.equal(formatDisplayAmount("42130000000000", 18, CRYPTO_DISPLAY_STYLE), "0.000042");
    assert.equal(formatDisplayAmount("1", 18, CRYPTO_DISPLAY_STYLE), "0.000000000000000001");
    assert.notEqual(formatDisplayAmount("1", 18, CRYPTO_DISPLAY_STYLE), "0");
  });

  it("refuses an input that is not an exact smallest-unit amount", () => {
    assert.throws(() => formatDisplayAmount("1.5", 18, CRYPTO_DISPLAY_STYLE), /smallest-unit/);
    assert.throws(() => formatDisplayAmount("-1", 18, CRYPTO_DISPLAY_STYLE), /smallest-unit/);
    assert.throws(() => formatDisplayAmount("1", 99, CRYPTO_DISPLAY_STYLE), /decimals/);
  });
});

describe("rate display", () => {
  it("reads a large rate to two decimals and a small one to more", () => {
    // 1 USDT (6 decimals) -> 1658.664477012781275141 ARS (18 decimals)
    assert.equal(
      formatRate({ amount: "1000000", decimals: 6 }, { amount: SCREENSHOT_ARS, decimals: 18 }),
      "1,658.66",
    );
    // 1 USD -> 1.0523 BRL
    assert.equal(
      formatRate({ amount: "100", decimals: 2 }, { amount: "105230", decimals: 5 }),
      "1.0523",
    );
    // 1 NGN -> 0.00094 USD
    assert.equal(
      formatRate({ amount: "100", decimals: 2 }, { amount: "94", decimals: 5 }),
      "0.00094",
    );
  });

  it("always shows at least two decimals", () => {
    assert.equal(formatRate({ amount: "100", decimals: 2 }, { amount: "150", decimals: 2 }), "1.50");
    assert.equal(formatRate({ amount: "100", decimals: 2 }, { amount: "100", decimals: 2 }), "1.00");
  });

  it("has no answer when either side is zero, rather than inventing one", () => {
    assert.equal(formatRate({ amount: "0", decimals: 2 }, { amount: "100", decimals: 2 }), undefined);
    assert.equal(formatRate({ amount: "100", decimals: 2 }, { amount: "0", decimals: 2 }), undefined);
  });

  it("is computed exactly, with no floating point drift", () => {
    // 0.1 + 0.2 territory: 3 units of 1e-18 into 1 unit gives exactly 0.333333333333333333.
    const rate = formatRate(
      { amount: "3000000000000000000", decimals: 18 },
      { amount: "1000000000000000000", decimals: 18 },
    );
    assert.equal(rate, "0.33333");
  });
});
