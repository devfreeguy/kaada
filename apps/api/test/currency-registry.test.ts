import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  currencyForLabel,
  currencyOfCountry,
  isSharedCurrencyWord,
  resolveCurrencyLabel,
} from "../src/core/currency/registry.js";
import { parseRatePair } from "../src/core/intents/focus.js";

/** The ISO code a label resolves to, or the status when it does not resolve to exactly one. */
const code = (label: string) => {
  const result = resolveCurrencyLabel(label);
  return result.status === "RESOLVED" ? result.currency.code : result.status;
};
const candidates = (label: string) => {
  const result = resolveCurrencyLabel(label);
  return result.status === "AMBIGUOUS" ? result.candidates.map((c) => c.code) : [];
};

describe("currency words", () => {
  it("knows a currency by its code, its names, its symbol and its country", () => {
    for (const label of ["NGN", "ngn", "Naira", "nairas", "Nigerian Naira", "₦", "  naira "]) {
      assert.equal(code(label), "NGN", label);
    }
    for (const label of ["BRL", "Real", "reais", "Brazilian Real", "Brazilian reais", "R$"]) {
      assert.equal(code(label), "BRL", label);
    }
    for (const label of ["ARS", "AR$", "Argentine Peso", "Argentine pesos", "Argentina Peso"]) {
      assert.equal(code(label), "ARS", label);
    }
    for (const label of ["IDR", "Rupiah", "Indonesian Rupiah", "Rp"]) {
      assert.equal(code(label), "IDR", label);
    }
    for (const label of ["USD", "dollar", "dollars", "US dollars", "$"]) {
      assert.equal(code(label), "USD", label);
    }
  });

  it("reads the phrases people actually use, built from a country word and a noun", () => {
    assert.equal(code("Nigerian money"), "NGN");
    assert.equal(code("Argentina money"), "ARS");
    assert.equal(code("Argentinian pesos"), "ARS");
    assert.equal(code("Brazilian money"), "BRL");
    assert.equal(code("Mexican pesos"), "MXN");
    assert.equal(code("the Indonesian currency"), "IDR");
    assert.equal(code("Colombian peso"), "COP");
  });

  it("a word that names several currencies names none on its own: it is never guessed", () => {
    assert.equal(code("peso"), "AMBIGUOUS");
    assert.equal(code("pesos"), "AMBIGUOUS");
    assert.deepEqual(candidates("pesos"), ["ARS", "MXN", "COP", "CLP"]);
    assert.equal(currencyForLabel("pesos"), undefined, "the narrow form has no single answer");
    assert.equal(isSharedCurrencyWord("pesos"), true);
    assert.equal(isSharedCurrencyWord("naira"), false);
  });

  it("refuses what it does not know rather than reaching for the nearest match", () => {
    for (const label of ["", "   ", "bitcoin", "galleons", "Nigerian Brazilian", "Argentine real"]) {
      assert.equal(code(label), "UNKNOWN", label);
    }
    // A bare country name is not a currency: "Brazil" alone is a place, not money.
    assert.equal(code("Brazil"), "UNKNOWN");
  });

  it("does not treat a settlement token as a currency word", () => {
    for (const label of ["cNGN", "wBRL", "wARS", "IDRX", "USDT", "USDC"]) {
      assert.equal(code(label), "UNKNOWN", label);
    }
  });

  it("maps a country to the currency used there, for 'someone in Brazil'", () => {
    assert.equal(currencyOfCountry("BR")?.code, "BRL");
    assert.equal(currencyOfCountry("ng")?.code, "NGN");
    assert.equal(currencyOfCountry("ZZ"), undefined);
    assert.equal(currencyOfCountry(undefined), undefined);
  });
});

describe("reading a rate question as a pair", () => {
  it("reads multi-word currency names on either side", () => {
    assert.deepEqual(parseRatePair("Naira to Argentina Peso"), {
      from: "Naira",
      to: "Argentina Peso",
      explicit: false,
    });
    assert.deepEqual(parseRatePair("Nigerian money to Brazilian reais"), {
      from: "Nigerian money",
      to: "Brazilian reais",
      explicit: false,
    });
    assert.equal(parseRatePair("What's the rate of Naira to Argentina money?")?.to, "Argentina money");
    assert.equal(parseRatePair("reais to dollars")?.from, "reais");
    assert.equal(parseRatePair("Argentine pesos to Naira")?.from, "Argentine pesos");
    assert.equal(parseRatePair("Indonesian Rupiah to Naira")?.to, "Naira");
  });

  it("still reads the short forms it always did", () => {
    for (const text of ["wARS to USDT", "wARS/USDT", "wARS -> USDT", "wARS → USDT", "USDT cNGN"]) {
      assert.ok(parseRatePair(text), text);
    }
    assert.equal(parseRatePair("wARS/USDT")?.explicit, true);
    assert.equal(parseRatePair("wARS to USDT")?.explicit, false);
  });

  it("an ambiguous side is still read as a side: the caller asks, the parser does not decide", () => {
    assert.deepEqual(parseRatePair("naira to pesos"), {
      from: "naira",
      to: "pesos",
      explicit: false,
    });
  });

  it("is not a pair when it is something else", () => {
    for (const text of [
      "20",
      "send Daniel $20",
      "hello there friend",
      "USDT",
      "",
      "how much is 20000 naira in pesos",
      "naira to naira",
    ]) {
      assert.equal(parseRatePair(text), null, text);
    }
  });
});
