/**
 * The drill scenarios, pinned.
 *
 * These are the cases from the live drilling waves, named by their drill id (A01, B05, ...) so a failure here points at the
 * exact sentence a person typed. Eighteen of them never got an answer in wave 2: the Groq daily token budget ran out, and a
 * scenario that costs ~3,400 tokens cannot be re-run on demand. So each one is reproduced here WITHOUT the model, by giving
 * the pipeline the reading the model produces and asserting on what Kaada does with it.
 *
 * What that covers and what it does not: everything downstream of the interpretation — the currency registry, the
 * wire-to-intent mapping, merging across turns, asset resolution, the assessment guards, the clarification wording and the
 * money formatting. What it cannot cover is whether the model reads a given English (or pidgin, or Spanish) sentence the
 * way these tests assume. That part needs live budget, and is what the remaining waves are for.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createId, mergeAgentIntent, sameCurrency } from "@kaada/domain";
import type { Asset, Interpretation } from "@kaada/domain";

import { describeMoney } from "../src/core/currency/catalog.js";
import { resolveCurrencyLabel } from "../src/core/currency/registry.js";
import { supportedAssetsMessage } from "../src/core/conversation/funding.js";
import { STATE_INSTRUCTIONS } from "../src/core/conversation/instructions.js";
import { deriveResponseState } from "../src/core/conversation/states.js";
import { GroqIntentInterpreter } from "../src/infrastructure/llm/groq-intent-interpreter.js";
import { FakeGroqTransport, amount as wireAmount, wire } from "./support/fake-groq.js";
import { intent } from "./support/harness.js";
import { createRoutingHarness } from "./support/routing-harness.js";
import type { RoutingHarness } from "./support/routing-harness.js";

const fiat = (code: string, name: string, countryCode: string): Asset => ({
  id: createId(),
  symbol: code,
  name,
  kind: "FIAT",
  decimals: 2,
  fiatCode: code,
  countryCode,
  isActive: true,
});

/**
 * The routing harness settles ARS and MXN, so "pesos" is already ambiguous there. The live deployment settles four, which is
 * the whole reason "2000 pesos" has to ask a question, so the two it lacks are added here. Adding MXN as well would seed a
 * second Mexican peso and the question would offer it twice.
 */
function withEveryPeso(r: RoutingHarness): void {
  r.world.addAsset(fiat("COP", "Colombian Peso", "CO"));
  r.world.addAsset(fiat("CLP", "Chilean Peso", "CL"));
}

/** Scripts `text` as `reading` and sends it, as a channel would. */
async function ask(r: RoutingHarness, text: string, reading: Interpretation) {
  r.h.script.set(text, reading);
  return r.h.say(text);
}

const INTERPRETER = { model: "openai/gpt-oss-20b", timeoutMs: 8000 } as const;

/** What the real wire-to-intent mapping makes of one model reply. */
async function readWire(reply: string) {
  const result = await new GroqIntentInterpreter(
    new FakeGroqTransport(() => reply),
    INTERPRETER,
  ).interpret({ message: "x", history: [], now: new Date("2026-01-01T00:00:00Z") });
  assert.equal(result.kind, "INTENT");
  return result.kind === "INTENT" ? result.intent : { type: "UNKNOWN" as const };
}

describe("drill: the currency words people actually type", () => {
  // A05, A08, B09, B10, E02, E07, E08 and the peso ambiguity behind A01 and A07 all come down to this one function.
  it("resolves the words from the waves, and refuses the ones Kaada does not support", () => {
    const cases: [string, string][] = [
      // A05: lowercase, sloppy codes.
      ["ngn", "NGN"],
      ["brl", "BRL"],
      // A08: a currency by its local name.
      ["rupiah", "IDR"],
      ["rupiahs", "IDR"],
      // A09 / earlier waves.
      ["soles", "PEN"],
      ["reais", "BRL"],
      // E02: misspellings a person types in a hurry.
      ["dolars", "USD"],
      ["naria", "NGN"],
      // B09 / B10: a country adjective with the noun.
      ["chilean pesos", "CLP"],
      ["pesos argentinos", "ARS"],
      ["mexican pesos", "MXN"],
      ["naira", "NGN"],
    ];
    for (const [label, code] of cases) {
      const resolution = resolveCurrencyLabel(label);
      assert.equal(resolution.status, "RESOLVED", `"${label}" should resolve`);
      assert.equal(
        resolution.status === "RESOLVED" ? resolution.currency.code : "",
        code,
        `"${label}" is ${code}`,
      );
    }
  });

  // A01 / A07. Four real currencies call themselves the peso, and the person used the ordinary word, not a ticker.
  it("A01/A07: 'pesos' names four currencies and is never silently picked for the person", () => {
    const resolution = resolveCurrencyLabel("pesos");
    assert.equal(resolution.status, "AMBIGUOUS");
    assert.deepEqual(
      resolution.status === "AMBIGUOUS" ? resolution.candidates.map((c) => c.code).sort() : [],
      ["ARS", "CLP", "COP", "MXN"],
    );
  });

  // E07 / E08. Kaada settles neither, and saying so is the only honest answer; inventing a rate would be worse than useless.
  it("E07/E08: euros and ether are not currencies Kaada knows, and are not guessed at", () => {
    for (const label of ["euros", "euro", "EUR", "ETH", "ethereum"]) {
      assert.equal(resolveCurrencyLabel(label).status, "UNKNOWN", `"${label}" must not resolve`);
    }
  });
});

describe("drill: A01, the screenshot bug", () => {
  // The bug: ALLOWED_FIELDS.RATE excluded `amount`, so the 2000 was dropped and a one-unit rate probe took its place.
  it("A01: a rate question carrying an amount keeps that amount, and is not a rate probe", async () => {
    const intentRead = await readWire(
      wire({ type: "RATE", amount: wireAmount("2000", "pesos"), toAsset: "naira" }),
    );
    assert.equal(intentRead.type, "QUOTE");
    assert.equal(intentRead.type === "QUOTE" ? intentRead.amount?.value : undefined, "2000");
    assert.equal(
      intentRead.type === "QUOTE" ? intentRead.amount?.currencyOrAsset : undefined,
      "pesos",
    );
    assert.ok(
      intentRead.type === "QUOTE" && intentRead.rateOnly !== true,
      "an amount was named, so this is a conversion, not a rate probe",
    );
  });

  it("A05: a rate question with no amount stays a rate probe", async () => {
    const intentRead = await readWire(
      wire({ type: "RATE", fromAsset: "ngn", toAsset: "brl" }),
    );
    assert.equal(intentRead.type, "QUOTE");
    assert.equal(intentRead.type === "QUOTE" ? intentRead.rateOnly : undefined, true);
  });

  it("A01: asks WHICH peso, in a readable order, and never 'which pair'", async () => {
    const r = createRoutingHarness();
    withEveryPeso(r);
    const out = await ask(
      r,
      "How much is 2000 pesos in naira?",
      intent({
        type: "QUOTE",
        amount: { value: "2000", currencyOrAsset: "pesos", mode: "EXACT_INPUT" },
        fromAsset: "pesos",
        toAsset: "naira",
      }),
    );
    assert.equal(out.response.type, "CLARIFICATION_REQUIRED");
    if (out.response.type !== "CLARIFICATION_REQUIRED") return;
    assert.equal(out.response.reason, "AMBIGUOUS");
    assert.match(out.response.text, /which pesos do you mean\?/i);
    assert.doesNotMatch(out.response.text, /which pair/i, "the pair was already given");
    assert.doesNotMatch(out.response.text, /more than one asset/i, "not the database's wording");
    // Ordered by currency code, so the same question always reads the same way (it used to be ordered by random uuid).
    assert.deepEqual(
      (out.response.options ?? []).map((option) => option.label),
      [
        "🇦🇷 Argentine Peso (ARS)",
        "🇨🇱 Chilean Peso (CLP)",
        "🇨🇴 Colombian Peso (COP)",
        "🇲🇽 Mexican Peso (MXN)",
      ],
    );
  });
});

describe("drill: A07, answering 'which peso?' by typing the country", () => {
  // The natural answer to "Which pesos do you mean?" is "mexican", not "Mexican pesos". resolveCurrencyLabel refuses a bare
  // country word on purpose ("Mexican" alone is a place), so an asset slot has to grant that reading itself — otherwise the
  // person answers the question correctly and is told their answer is unsupported.
  it("A07: a bare country word in an asset slot names that country's currency", async () => {
    const r = createRoutingHarness();
    withEveryPeso(r);

    // A rate probe carries the one-unit amount that rateCandidate puts there; omitting it would ask for an amount instead.
    const rateProbe = (side: string) =>
      intent({
        type: "QUOTE",
        amount: { value: "1", currencyOrAsset: side, mode: "EXACT_INPUT" },
        fromAsset: side,
        toAsset: "naira",
        rateOnly: true,
      });

    const first = await ask(r, "pesos to naira", rateProbe("pesos"));
    assert.equal(first.response.type, "CLARIFICATION_REQUIRED");
    assert.match(
      first.response.type === "CLARIFICATION_REQUIRED" ? first.response.text : "",
      /which pesos do you mean\?/i,
    );

    const second = await ask(r, "mexican", rateProbe("mexican"));
    assert.notEqual(
      second.response.type,
      "CLARIFICATION_REQUIRED",
      "the question was answered; asking it again is the bug",
    );
  });
});

describe("drill: amounts that must be refused rather than priced", () => {
  it("B05: zero is refused by name, not quoted", async () => {
    const r = createRoutingHarness();
    const out = await ask(
      r,
      "send 0 dollars to Daniel",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "0", currencyOrAsset: "dollars" },
      }),
    );
    assert.equal(out.response.type, "CLARIFICATION_REQUIRED");
    if (out.response.type !== "CLARIFICATION_REQUIRED") return;
    assert.equal(out.response.field, "AMOUNT");
    assert.match(out.response.text, /more than zero/i);
  });

  // The sentence is clear; only the size is impossible. It used to be answered "Sorry, I didn't understand that", which
  // invites the person to rephrase a message that was already perfectly plain.
  it("B06: a negative amount is refused by naming the amount, not by claiming confusion", async () => {
    // Driven through the REAL interpreter over a fake transport: a negative amount is caught in the wire layer, which a
    // scripted intent would skip past entirely.
    const reply = wire({
      type: "SEND",
      recipient: { type: "USERNAME", value: "Daniel" },
      amount: wireAmount("-50", "USDT"),
    });
    const r = createRoutingHarness({
      interpreter: new GroqIntentInterpreter(new FakeGroqTransport(() => reply), INTERPRETER),
    });
    const out = await r.h.say("send -50 USDT to Daniel");
    const text = "text" in out.response ? out.response.text : "";
    assert.match(text, /more than zero/i);
    assert.doesNotMatch(text, /didn't understand|didn't catch/i, "the message was understood");
  });

  it("B06: the wire layer tells a negative amount apart from an unreadable one", async () => {
    for (const raw of ["-50", "- 50", "−50"]) {
      await assert.rejects(
        readWire(
          wire({
            type: "SEND",
            recipient: { type: "USERNAME", value: "Daniel" },
            amount: wireAmount(raw, "USDT"),
          }),
        ),
        (error: unknown) =>
          error instanceof Error && "reason" in error && error.reason === "NEGATIVE_AMOUNT",
        `"${raw}" is a negative amount, not an unreadable one`,
      );
    }
  });

  // B04. Kaada expands the shorthand itself (normalizeSpokenAmount), which is why "5k naira" came back as 5,000 in wave 2.
  it("B04: '1.5m' is expanded to 1500000, and an ambiguous grouping is refused instead of guessed", async () => {
    const expanded = await readWire(
      wire({ type: "RATE", amount: wireAmount("1.5m", "naira"), toAsset: "dollars" }),
    );
    assert.equal(expanded.type === "QUOTE" ? expanded.amount?.value : undefined, "1500000");

    const k = await readWire(
      wire({ type: "RATE", amount: wireAmount("5k", "naira"), toAsset: "dollars" }),
    );
    assert.equal(k.type === "QUOTE" ? k.amount?.value : undefined, "5000");

    // "1.000" could be a thousand or one; guessing either way can be wrong by a factor of a thousand.
    await assert.rejects(
      readWire(wire({ type: "RATE", amount: wireAmount("1.000", "naira"), toAsset: "dollars" })),
      "an ambiguous grouping must be asked about, never assumed",
    );
  });
});

describe("drill: the gaps a payment has to ask about", () => {
  it("C01: no amount asks for the amount", async () => {
    const r = createRoutingHarness();
    const out = await ask(
      r,
      "send money to Daniel",
      intent({ type: "SEND", recipient: { type: "USERNAME", value: "Daniel" } }),
    );
    assert.equal(out.response.type, "CLARIFICATION_REQUIRED");
    if (out.response.type !== "CLARIFICATION_REQUIRED") return;
    assert.ok(
      ["AMOUNT", "RECIPIENT"].includes(out.response.field),
      `asked about ${out.response.field}`,
    );
  });

  it("C03: a number with no currency asks which currency, and does not guess one", async () => {
    const r = createRoutingHarness();
    const out = await ask(
      r,
      "send 300 to Daniel",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "300" },
      }),
    );
    assert.equal(out.response.type, "CLARIFICATION_REQUIRED");
    if (out.response.type !== "CLARIFICATION_REQUIRED") return;
    assert.ok(
      ["CURRENCY", "RECIPIENT"].includes(out.response.field),
      `asked about ${out.response.field}`,
    );
    assert.doesNotMatch(out.response.text, /\bUSD\b|\bdollar/i, "no currency was named, so none is assumed");
  });
});

describe("drill: C07, changing your mind about the currency", () => {
  // "actually make it reais" has to change the currency and keep everything else. The amount's own currency and fromAsset
  // must move together, or the next turn asks a question that was already answered.
  it("C07: a corrected currency replaces the old one and keeps the recipient and size", () => {
    const outcome = mergeAgentIntent(
      {
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "500", currencyOrAsset: "naira", mode: "EXACT_INPUT" },
      },
      {
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "500", currencyOrAsset: "reais", mode: "EXACT_INPUT" },
      },
    );
    assert.equal(outcome.intent.type, "SEND");
    if (outcome.intent.type !== "SEND") return;
    assert.equal(outcome.intent.amount?.currencyOrAsset, "reais");
    assert.equal(outcome.intent.amount?.value, "500");
    assert.deepEqual(outcome.intent.recipient, { type: "USERNAME", value: "Daniel" });
  });

  it("C07: a converted amount's currency and its source side stay in step", () => {
    const outcome = mergeAgentIntent(
      {
        type: "CONVERT",
        amount: { value: "500", currencyOrAsset: "naira", mode: "EXACT_INPUT" },
        fromAsset: "naira",
        toAsset: "dollars",
      },
      {
        type: "CONVERT",
        amount: { value: "500", currencyOrAsset: "reais", mode: "EXACT_INPUT" },
        fromAsset: "reais",
        toAsset: "dollars",
      },
    );
    assert.equal(outcome.intent.type, "CONVERT");
    if (outcome.intent.type !== "CONVERT") return;
    assert.ok(
      sameCurrency(outcome.intent.amount?.currencyOrAsset, outcome.intent.fromAsset),
      "the amount's currency and fromAsset must not drift apart",
    );
  });
});

describe("drill: D09, a question Kaada must not answer", () => {
  // "Should I buy more USDT right now?" is investment advice. Kaada has no trusted answer and must not invent one.
  it("D09: a finance question routes to the state whose rules forbid advising", async () => {
    const r = createRoutingHarness();
    const out = await ask(r, "should I buy more USDT right now?", intent({
      type: "HELP",
      topic: "FINANCE_QUESTION",
    }));
    assert.equal(out.response.type, "CHAT");

    const state = deriveResponseState({ response: out.response });
    assert.equal(state, "FINANCIAL_QUESTION");
    const rules = (STATE_INSTRUCTIONS[state]?.rules ?? []).join(" ");
    assert.match(rules, /not answer the question|financial advice/i);
  });

  it("D09: the deterministic answer offers no view on whether to buy", () => {
    const fallback = STATE_INSTRUCTIONS.FINANCIAL_QUESTION;
    assert.ok(fallback !== undefined);
    assert.match(fallback.objective, /does not have a reliable answer/i);
  });
});

describe("drill: E09, a rate between a currency and itself", () => {
  it("E09: naira to naira is refused instead of answered as 1:1", async () => {
    const r = createRoutingHarness();
    const out = await ask(
      r,
      "naira to naira rate",
      intent({ type: "QUOTE", fromAsset: "naira", toAsset: "naira", rateOnly: true }),
    );
    assert.notEqual(out.response.type, "QUOTE_RESULT", "there is no rate between a currency and itself");
    if (out.response.type === "CLARIFICATION_REQUIRED") {
      assert.match(out.response.text, /same currency/i);
    }
  });
});

describe("drill: E07 and E08, currencies Kaada does not settle", () => {
  for (const [id, label, text] of [
    ["E07", "euros", "how much is 100 euros in naira"],
    ["E08", "ETH", "convert 1 ETH to naira"],
  ] as const) {
    it(`${id}: says plainly that ${label} is not supported, and invents no rate`, async () => {
      const r = createRoutingHarness();
      const out = await ask(
        r,
        text,
        intent({
          type: "QUOTE",
          amount: { value: "100", currencyOrAsset: label },
          fromAsset: label,
          toAsset: "naira",
        }),
      );
      assert.notEqual(out.response.type, "QUOTE_RESULT", "nothing to quote");
      assert.notEqual(out.response.type, "PAYMENT_READY");
      const text_ = "text" in out.response ? out.response.text : "";
      assert.doesNotMatch(text_, /\d+(\.\d+)?\s*(naira|NGN|₦)/i, "no fabricated figure");
    });
  }
});

describe("drill: C09, thanks in the middle of a payment", () => {
  // "thanks man" used to be read as a sign-off, which answered with "Catch you later" and abandoned the payment the person
  // was halfway through. Gratitude is not a cancellation.
  it("C09: a farewell does not cancel the payment in progress", async () => {
    const r = createRoutingHarness();
    const opened = await ask(
      r,
      "send 20 dollars to Daniel",
      intent({
        type: "SEND",
        recipient: { type: "USERNAME", value: "Daniel" },
        amount: { value: "20", currencyOrAsset: "dollars" },
      }),
    );
    assert.equal(opened.response.type, "CLARIFICATION_REQUIRED");

    const thanks = await ask(r, "thanks man", intent({ type: "HELP", topic: "FAREWELL" }));
    assert.notEqual(thanks.response.type, "CANCELLED", "gratitude is not a cancellation");
    assert.ok(thanks.resume !== undefined, "the open payment is carried, not dropped");
  });
});

describe("drill: B09, a currency with no cents", () => {
  // Chile quotes whole pesos. Showing "CLP$1.234,00"-style cents is wrong in the way that makes a product look foreign.
  // describeMoney takes a smallest-unit integer, so 1234.56 of a 2-decimal asset is "123456".
  it("B09: Chilean pesos are shown without cents", () => {
    const shown = describeMoney(fiat("CLP", "Chilean Peso", "CL"), "123456");
    assert.equal(shown, "CLP$1,235");
    assert.doesNotMatch(shown, /\.\d/, "Chile quotes whole pesos");
  });

  it("B09: a two-decimal currency still shows its cents", () => {
    assert.equal(describeMoney(fiat("NGN", "Nigerian Naira", "NG"), "123456"), "₦1,234.56");
  });
});

describe("drill: D08, which currencies Kaada supports", () => {
  // "Do you support bitcoin?" is a question about the product, not about the person's wallet. It used to be answered with a
  // wallet-setup nag, which is both unhelpful and a non-answer.
  it("D08: the catalogue answers from the asset list, with no wallet involved", () => {
    const message = supportedAssetsMessage({
      network: "Celo",
      assets: ["Nigerian Naira (cNGN)", "US Dollar (USDC)"],
    });
    assert.match(message, /cNGN/);
    assert.match(message, /USDC/);
    assert.doesNotMatch(message, /set up|setup|create a wallet/i, "not a wallet nag");
  });
});
