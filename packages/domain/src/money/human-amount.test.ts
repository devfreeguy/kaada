import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isKaadaError } from "../errors/index.js";
import { formatSmallestUnit, isHumanAmountValue, parseHumanAmount } from "./human-amount.js";

const rejects = (value: string, decimals: number) =>
  assert.throws(
    () => parseHumanAmount(value, decimals),
    (error) => isKaadaError(error, "INVALID_AMOUNT"),
    `expected ${JSON.stringify(value)} @${decimals} to be rejected`,
  );

describe("parseHumanAmount", () => {
  it("converts exact decimals to smallest units", () => {
    assert.equal(parseHumanAmount("20", 2), "2000");
    assert.equal(parseHumanAmount("20.5", 2), "2050");
    assert.equal(parseHumanAmount("20.50", 2), "2050");
    assert.equal(parseHumanAmount("0.01", 2), "1");
    assert.equal(parseHumanAmount("1.000001", 6), "1000001");
    assert.equal(parseHumanAmount("0", 18), "0");
    assert.equal(parseHumanAmount("1500.25", 2), "150025");
    assert.equal(parseHumanAmount("20", 6), "20000000");
    assert.equal(parseHumanAmount("1.5", 18), "1500000000000000000");
    assert.equal(parseHumanAmount("0.000000000000000001", 18), "1");
    assert.equal(parseHumanAmount("7", 0), "7");
  });

  it("is exact for values far beyond Number precision", () => {
    assert.equal(parseHumanAmount("9007199254740993", 0), "9007199254740993");
    assert.equal(
      parseHumanAmount("9007199254740993.000000000000000001", 18),
      "9007199254740993000000000000000001",
    );
    assert.equal(
      parseHumanAmount("115792089237316195423570985008687907853269984665640564039457", 18).length,
      78,
    );
  });

  it("accepts trailing zeros that need no rounding, and trims outer whitespace", () => {
    assert.equal(parseHumanAmount("20.500", 2), "2050");
    assert.equal(parseHumanAmount("20.0", 0), "20");
    assert.equal(parseHumanAmount("  20.50\n", 2), "2050");
  });

  it("never rounds: rejects values needing more precision than the asset has", () => {
    rejects("20.505", 2);
    rejects("0.001", 2);
    rejects("0.5", 0);
    rejects("1.0000001", 6);
    rejects("0.0000000000000000001", 18);
    // Would round up or down depending on mode; either way it must be rejected.
    rejects("0.999", 2);
    rejects("0.994", 2);
  });

  it("rejects malformed input", () => {
    for (const bad of [
      "",
      " ",
      ".",
      "1.",
      ".5",
      "-1",
      "+1",
      "-0",
      "1e6",
      "1E6",
      "1,000",
      "1 000",
      "1_000",
      "1.2.3",
      "00",
      "01",
      "007.5",
      "0x10",
      "NaN",
      "Infinity",
      "20 USD",
      "$20",
      "٣", // non-ASCII digit
    ]) {
      rejects(bad, 2);
    }
  });

  it("rejects non-string input and invalid decimals", () => {
    assert.throws(() => parseHumanAmount(20 as unknown as string, 2));
    rejects("1", -1);
    rejects("1", 37);
    rejects("1", 1.5);
    rejects("1", Number.NaN);
  });

  it("rejects amounts longer than the supported digit limit", () => {
    rejects("1".repeat(79), 0);
    rejects("1".repeat(101), 0);
    assert.equal(parseHumanAmount("1".repeat(78), 0), "1".repeat(78));
  });
});

describe("isHumanAmountValue", () => {
  it("matches the syntax parseHumanAmount accepts", () => {
    for (const ok of ["0", "20", "20.50", "0.01", " 5 "])
      assert.equal(isHumanAmountValue(ok), true, ok);
    for (const bad of ["", ".5", "1.", "-1", "1e3", "1,0", "00", 5, null]) {
      assert.equal(isHumanAmountValue(bad), false, String(bad));
    }
  });
});

describe("formatSmallestUnit", () => {
  it("renders every digit exactly", () => {
    assert.equal(formatSmallestUnit("2050", 2), "20.50");
    assert.equal(formatSmallestUnit("1", 6), "0.000001");
    assert.equal(formatSmallestUnit("1000000", 6), "1.000000");
    assert.equal(formatSmallestUnit("0", 2), "0.00");
    assert.equal(formatSmallestUnit("0", 0), "0");
    assert.equal(formatSmallestUnit("150025", 2), "1500.25");
    assert.equal(formatSmallestUnit("42", 0), "42");
    assert.equal(formatSmallestUnit("1500000000000000000", 18), "1.500000000000000000");
    assert.equal(formatSmallestUnit("1", 18), "0.000000000000000001");
    assert.equal(formatSmallestUnit("9007199254740993", 2), "90071992547409.93");
  });

  it("rejects non-canonical amounts and invalid decimals", () => {
    for (const bad of ["", "-1", "01", "1.5", "1e3", " 1"]) {
      assert.throws(
        () => formatSmallestUnit(bad, 2),
        (e) => isKaadaError(e, "INVALID_AMOUNT"),
        bad,
      );
    }
    assert.throws(() => formatSmallestUnit("1", -1));
    assert.throws(() => formatSmallestUnit("1", 40));
  });

  it("round-trips with parseHumanAmount", () => {
    for (const decimals of [0, 2, 6, 18]) {
      for (const amount of [
        "0",
        "1",
        "10",
        "999999",
        "1000000",
        "123456789012345678901234567890",
      ]) {
        assert.equal(parseHumanAmount(formatSmallestUnit(amount, decimals), decimals), amount);
      }
    }
  });
});
