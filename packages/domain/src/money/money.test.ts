import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isKaadaError } from "../errors/index.js";
import { isSmallestUnitAmount } from "./amount.js";
import {
  addMoney,
  compareMoney,
  createMoney,
  isZeroMoney,
  maxMoney,
  minMoney,
  moneyFromHuman,
  subtractMoney,
} from "./money.js";

const usd = "asset-usd";
const ngn = "asset-ngn";
const m = (amount: string, assetId = usd) => createMoney(amount, assetId);

describe("isSmallestUnitAmount", () => {
  it("accepts only canonical non-negative integer strings", () => {
    for (const ok of ["0", "1", "10", "2050", "1500000000000000000"]) {
      assert.equal(isSmallestUnitAmount(ok), true, ok);
    }
    for (const bad of [
      "",
      "00",
      "0005",
      "-1",
      "+1",
      "1.0",
      "1e3",
      " 1",
      "1 ",
      "0x1",
      5,
      null,
      undefined,
    ]) {
      assert.equal(isSmallestUnitAmount(bad), false, String(bad));
    }
  });

  it("bounds the length to the uint256 digit count", () => {
    assert.equal(isSmallestUnitAmount("9".repeat(78)), true);
    assert.equal(isSmallestUnitAmount("9".repeat(79)), false);
  });
});

describe("createMoney", () => {
  it("rejects non-canonical amounts and missing assets", () => {
    assert.throws(
      () => createMoney("0005", usd),
      (e) => isKaadaError(e, "INVALID_AMOUNT"),
    );
    assert.throws(
      () => createMoney("-1", usd),
      (e) => isKaadaError(e, "INVALID_AMOUNT"),
    );
    assert.throws(
      () => createMoney("1", ""),
      (e) => isKaadaError(e, "ASSET_MISMATCH"),
    );
  });
});

describe("moneyFromHuman", () => {
  it("resolves a human amount against the asset decimals", () => {
    assert.deepEqual(moneyFromHuman("20.50", { id: usd, decimals: 2 }), m("2050"));
    assert.deepEqual(moneyFromHuman("20", { id: "usdc", decimals: 6 }), m("20000000", "usdc"));
  });

  it("rejects amounts that would need rounding", () => {
    assert.throws(() => moneyFromHuman("20.505", { id: usd, decimals: 2 }));
  });
});

describe("money arithmetic", () => {
  it("adds, compares, min and max exactly", () => {
    assert.deepEqual(addMoney(m("2050"), m("1")), m("2051"));
    assert.deepEqual(addMoney(m("0"), m("0")), m("0"));
    assert.equal(compareMoney(m("2"), m("10")), -1, "numeric not lexicographic");
    assert.equal(compareMoney(m("10"), m("2")), 1);
    assert.equal(compareMoney(m("7"), m("7")), 0);
    assert.deepEqual(minMoney(m("2"), m("10")), m("2"));
    assert.deepEqual(maxMoney(m("2"), m("10")), m("10"));
  });

  it("stays exact beyond Number.MAX_SAFE_INTEGER", () => {
    const big = m("9007199254740993");
    assert.deepEqual(addMoney(big, m("1")), m("9007199254740994"));
    assert.deepEqual(subtractMoney(big, m("1")), m("9007199254740992"));
    assert.equal(compareMoney(big, m("9007199254740992")), 1);
    assert.deepEqual(
      addMoney(m("1000000000000000000000000000000"), m("1")),
      m("1000000000000000000000000000001"),
    );
  });

  it("subtracts down to zero but never below", () => {
    assert.deepEqual(subtractMoney(m("10"), m("10")), m("0"));
    assert.deepEqual(subtractMoney(m("10"), m("3")), m("7"));
    assert.throws(
      () => subtractMoney(m("3"), m("10")),
      (e) => isKaadaError(e, "INSUFFICIENT_AMOUNT"),
    );
    assert.throws(
      () => subtractMoney(m("0"), m("1")),
      (e) => isKaadaError(e, "INSUFFICIENT_AMOUNT"),
    );
  });

  it("refuses to mix assets in every operation", () => {
    const mismatch = (e: unknown) => isKaadaError(e, "ASSET_MISMATCH");
    assert.throws(() => addMoney(m("1"), m("1", ngn)), mismatch);
    assert.throws(() => subtractMoney(m("1"), m("1", ngn)), mismatch);
    assert.throws(() => compareMoney(m("1"), m("1", ngn)), mismatch);
    assert.throws(() => minMoney(m("1"), m("1", ngn)), mismatch);
    assert.throws(() => maxMoney(m("1"), m("1", ngn)), mismatch);
  });

  it("rejects hand-built non-canonical money passed to operations", () => {
    const bad = { amount: "0005", assetId: usd };
    assert.throws(
      () => addMoney(bad, m("1")),
      (e) => isKaadaError(e, "INVALID_AMOUNT"),
    );
    assert.throws(() => compareMoney(m("1"), { amount: "-1", assetId: usd }));
  });

  it("detects zero", () => {
    assert.equal(isZeroMoney(m("0")), true);
    assert.equal(isZeroMoney(m("1")), false);
  });

  it("does not mutate its inputs", () => {
    const a = m("5");
    const b = m("6");
    addMoney(a, b);
    assert.deepEqual(a, m("5"));
    assert.deepEqual(b, m("6"));
  });
});
