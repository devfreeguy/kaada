import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { isKaadaError } from "../errors/index.js";
import { parseHumanAmount } from "./human-amount.js";

const moneyDir = new URL("./", import.meta.url);

/** Source of the money package, excluding tests and comments. */
function moneySources(): [string, string][] {
  return readdirSync(moneyDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name): [string, string] => {
      const code = readFileSync(new URL(name, moneyDir), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return [name, code];
    });
}

describe("money package has no floating point or rounding", () => {
  const forbidden: [RegExp, string][] = [
    [/\bparseFloat\b/, "parseFloat"],
    [/\bNumber\s*\(/, "Number()"],
    [/\bparseInt\b/, "parseInt"],
    [/\bMath\.(round|floor|ceil|trunc)\b/, "Math rounding"],
    [/\btoFixed\b|\btoPrecision\b/, "toFixed/toPrecision"],
    [/\bDecimal\b/, "Decimal"],
    [/unary\s*\+|\+\s*\w+\.amount/, "unary plus coercion"],
  ];

  it("uses none of the forbidden constructs in source", () => {
    for (const [file, code] of moneySources()) {
      for (const [pattern, label] of forbidden) {
        assert.ok(!pattern.test(code), `${file} uses ${label}`);
      }
    }
  });

  it("only uses Number for integer checks on decimals, never on amounts", () => {
    for (const [file, code] of moneySources()) {
      for (const match of code.matchAll(/Number\.\w+\([^)]*\)/g)) {
        assert.match(match[0], /Number\.isInteger\(decimals\)/, `${file}: ${match[0]}`);
      }
    }
  });

  it("turns away every input that is not exactly representable instead of rounding it", () => {
    for (const [value, decimals] of [
      ["0.1", 0],
      ["0.01", 1],
      ["0.015", 2],
      ["2.675", 2],
      ["1.005", 2],
      ["0.3333333333", 6],
    ] as const) {
      assert.throws(
        () => parseHumanAmount(value, decimals),
        (error) => isKaadaError(error, "INVALID_AMOUNT"),
        `${value}@${decimals}`,
      );
    }
  });
});
