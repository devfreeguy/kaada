import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

/*
 * Routing and money code does financial arithmetic in BigInt only. This scans the source (comments
 * removed) for floating-point or implicit-rounding constructs.
 */

const roots = [
  new URL("../../../packages/domain/src/routing/", import.meta.url),
  new URL("../../../packages/domain/src/money/", import.meta.url),
  new URL("../src/core/routing/", import.meta.url),
  new URL("../src/infrastructure/fx/", import.meta.url),
];

function sources(): [string, string][] {
  return roots.flatMap((root) =>
    readdirSync(root)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name): [string, string] => {
        const code = readFileSync(new URL(name, root), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return [`${root.pathname.split("/").slice(-3).join("/")}${name}`, code];
      }),
  );
}

describe("routing and money source", () => {
  const forbidden: [RegExp, string][] = [
    [/\bparseFloat\b/, "parseFloat"],
    [/\bNumber\s*\(/, "Number()"],
    [/\bparseInt\b/, "parseInt"],
    [/\bMath\.(round|floor|ceil|trunc)\b/, "Math.round/floor/ceil/trunc"],
    [/\btoFixed\b|\btoPrecision\b/, "toFixed/toPrecision"],
    [/\bDecimal\b/, "Decimal"],
    [/\b\d+\.\d+\s*\*|\*\s*\d+\.\d+\b/, "fractional literal in arithmetic"],
  ];

  it("scans a non-trivial amount of code", () => {
    assert.ok(sources().length >= 15);
  });

  it("uses none of the forbidden constructs", () => {
    for (const [file, code] of sources()) {
      for (const [pattern, label] of forbidden) {
        assert.ok(!pattern.test(code), `${file} uses ${label}`);
      }
    }
  });

  it("only touches Number for integer checks on decimals", () => {
    for (const [file, code] of sources()) {
      for (const match of code.matchAll(/Number\.\w+\([^)]*\)/g)) {
        assert.match(match[0], /Number\.isInteger\(decimals\)/, `${file}: ${match[0]}`);
      }
    }
  });
});
