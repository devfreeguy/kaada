import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  bpsOf,
  divRoundDown,
  divRoundUp,
  inputForOutput,
  outputForInput,
  rescaleAmount,
} from "./rounding.js";

const usdtToBrl = { numerator: 542n, denominator: 100n }; // 1 USDT = 5.42 wBRL

describe("rounding helpers", () => {
  it("rounds down and up explicitly", () => {
    assert.equal(divRoundDown(7n, 2n), 3n);
    assert.equal(divRoundUp(7n, 2n), 4n);
    assert.equal(divRoundUp(8n, 2n), 4n);
    assert.equal(divRoundDown(0n, 5n), 0n);
    assert.throws(() => divRoundUp(1n, 0n), RangeError);
  });

  it("rescales exactly upward and with requested rounding downward", () => {
    assert.equal(rescaleAmount(50000n, 2, 18), 500n * 10n ** 18n);
    assert.equal(rescaleAmount(1999n, 3, 2, "DOWN"), 199n);
    assert.equal(rescaleAmount(1991n, 3, 2, "UP"), 200n);
  });

  it("EXACT_INPUT output rounds down: the user never gets more than the rate allows", () => {
    // 1 smallest USDT unit (6dp) at 5.42 wBRL (18dp) is exact; pick a rate that is not.
    const third = { numerator: 1n, denominator: 3n };
    assert.equal(outputForInput(1n, third, 0, 0), 0n);
    assert.equal(outputForInput(10n, third, 0, 0), 3n);
    assert.equal(outputForInput(20_000_000n, usdtToBrl, 6, 18), 108_400_000_000_000_000_000n);
  });

  it("EXACT_OUTPUT input rounds up and always delivers at least the output", () => {
    const third = { numerator: 1n, denominator: 3n };
    assert.equal(inputForOutput(3n, third, 0, 0), 9n);
    for (const output of [1n, 2n, 3n, 7n, 100n, 12345n]) {
      const input = inputForOutput(output, third, 0, 0);
      assert.ok(outputForInput(input, third, 0, 0) >= output, `output ${output}`);
      assert.ok(input === 0n || outputForInput(input - 1n, third, 0, 0) < output, "and minimal");
    }
  });

  it("takes basis points with the requested rounding", () => {
    assert.equal(bpsOf(20_000_000n, 1n, "UP"), 2000n);
    assert.equal(bpsOf(1n, 1n, "UP"), 1n);
    assert.equal(bpsOf(1n, 1n, "DOWN"), 0n);
  });
});
