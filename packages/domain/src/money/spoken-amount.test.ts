import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseHumanAmount } from "./human-amount.js";
import { normalizeSpokenAmount } from "./spoken-amount.js";

describe("normalizeSpokenAmount", () => {
  it("passes plain decimals through unchanged", () => {
    for (const plain of ["20", "20.50", "0.5", "0.500", "0", "1234567", "9.99"]) {
      assert.equal(normalizeSpokenAmount(plain), plain);
    }
    assert.equal(normalizeSpokenAmount("  20.5 "), "20.5");
  });

  it("removes US-style thousands separators", () => {
    assert.equal(normalizeSpokenAmount("10,000"), "10000");
    assert.equal(normalizeSpokenAmount("1,234,567.89"), "1234567.89");
    assert.equal(normalizeSpokenAmount("999"), "999");
  });

  it("expands k and m suffixes with digit shifting only", () => {
    const cases: [string, string][] = [
      ["10k", "10000"],
      ["10K", "10000"],
      ["2.5k", "2500"],
      ["2.5 k", "2500"],
      ["0.5k", "500"],
      ["1.2345k", "1234.5"],
      ["1k", "1000"],
      ["1m", "1000000"],
      ["1.2m", "1200000"],
      ["0.001m", "1000"],
      ["100k", "100000"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeSpokenAmount(input), expected, input);
    }
  });

  it("is exact for values that floating point would corrupt", () => {
    assert.equal(normalizeSpokenAmount("0.1k"), "100");
    assert.equal(normalizeSpokenAmount("1.1k"), "1100");
    assert.equal(normalizeSpokenAmount("9007199254740.993k"), "9007199254740993");
    assert.equal(normalizeSpokenAmount("4.35k"), "4350");
  });

  it("refuses ambiguous separators instead of guessing", () => {
    for (const text of ["1.000", "12.345", "1.234.567", "20,50", "1,5", "1.000k", "1,000k"]) {
      assert.equal(normalizeSpokenAmount(text), undefined, text);
    }
  });

  it("accepts a leading-zero decimal that cannot be a thousands group", () => {
    assert.equal(normalizeSpokenAmount("0.500"), "0.500");
  });

  it("refuses anything that is not a plain number", () => {
    for (const text of [
      "",
      " ",
      "$20",
      "R$500",
      "20 USD",
      "-5",
      "+5",
      "1e3",
      "ten",
      "10 thousand",
      "k",
      "10kk",
      ".5",
      "5.",
      "1 000",
      "0x10",
      "1".repeat(41),
    ]) {
      assert.equal(normalizeSpokenAmount(text), undefined, JSON.stringify(text));
    }
  });

  it("produces output the strict parser accepts, and leaves rounding decisions to it", () => {
    assert.equal(parseHumanAmount(normalizeSpokenAmount("10k") ?? "", 2), "1000000");
    assert.equal(parseHumanAmount(normalizeSpokenAmount("10,000") ?? "", 2), "1000000");
    assert.equal(parseHumanAmount(normalizeSpokenAmount("1.2345k") ?? "", 2), "123450");
    assert.throws(() => parseHumanAmount(normalizeSpokenAmount("1.2345k") ?? "", 0));
  });
});
