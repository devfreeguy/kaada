import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMoney } from "@kaada/domain";

import {
  balanceBlock,
  currencyForLabel,
  describeMoney,
  describeSupportedCurrencies,
  summarizeHoldings,
} from "../src/core/currency/catalog.js";
import { presentAgentResponse } from "../src/core/channels/presenter.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";
import { intent } from "./support/harness.js";
import { setup } from "./support/payment-world.js";
import type { PaymentWorld } from "./support/payment-world.js";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const recipient = { type: "WALLET_ADDRESS" as const, value: ADDRESS };
const NGN = (whole: bigint) => whole * 10n ** 6n; // the test cNGN has 6 decimals

let n = 0;
/** Scripts what the interpreter would read from `text`, then sends it. */
async function send(
  w: PaymentWorld,
  label: string,
  options: { mode?: "EXACT_INPUT" | "EXACT_OUTPUT"; value?: string } = {},
) {
  const text = `send ${options.value ?? "300"} ${label} ${String(++n)}`;
  w.r.h.script.set(
    text,
    intent({
      type: "SEND",
      recipient,
      amount: {
        value: options.value ?? "300",
        currencyOrAsset: label,
        ...(options.mode && { mode: options.mode }),
      },
    } as never),
  );
  return w.r.h.say(text);
}

const amountAssetOf = (w: PaymentWorld, intentId: string | undefined) =>
  w.r.world.intents.get(intentId ?? "")?.amount?.money.assetId;

describe("everyday words name a currency first", () => {
  it("knows each currency by its words and symbols", () => {
    const code = (label: string) => currencyForLabel(label)?.code;
    for (const label of ["Naira", "Nigerian Naira", "NGN", "₦", "  naira "]) {
      assert.equal(code(label), "NGN", label);
    }
    for (const label of ["Brazilian Real", "Real", "reais", "BRL", "R$"]) {
      assert.equal(code(label), "BRL", label);
    }
    for (const label of ["Argentine Peso", "Argentine pesos", "Peso", "ARS", "AR$"]) {
      assert.equal(code(label), "ARS", label);
    }
    for (const label of ["Indonesian Rupiah", "Rupiah", "rupiah", "IDR", "Rp"]) {
      assert.equal(code(label), "IDR", label);
    }
    for (const label of ["Dollar", "dollars", "US Dollar", "USD", "$"]) {
      assert.equal(code(label), "USD", label);
    }
    // A token is not a currency word: it is identified as the asset it is.
    for (const label of ["cNGN", "wBRL", "wARS", "IDRX", "USDT", "USDC"]) {
      assert.equal(code(label), undefined, label);
    }
  });

  const cases: [string, string, "NGN" | "BRL" | "ARS" | "IDR"][] = [
    ["300 Naira", "Naira", "NGN"],
    ["₦300", "₦", "NGN"],
    ["300 NGN", "NGN", "NGN"],
    ["50 Brazilian Real", "Brazilian Real", "BRL"],
    ["R$50", "R$", "BRL"],
    ["100 Argentine pesos", "Argentine pesos", "ARS"],
    ["5000 rupiah", "rupiah", "IDR"],
  ];
  for (const [what, label, expected] of cases) {
    it(`"Send ${what}" is ${expected}`, async () => {
      const w = setup();
      const turn = await send(w, label, { value: label === "rupiah" ? "5000" : "300" });
      // Understood as the currency (never "I don't support Naira yet"), as the fiat asset of that code.
      assert.notEqual(turn.response.type, "CLARIFICATION_REQUIRED", JSON.stringify(turn.response));
      const fiat = w.r.h.assets[expected as "NGN" | "BRL" | "ARS"] ?? undefined;
      if (fiat) assert.equal(amountAssetOf(w, turn.intentId), fiat.id);
    });
  }

  it("'Send 300 cNGN' still works as a technical alias, and is worded as Naira", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    const turn = await send(w, "cNGN");
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    if (turn.response.type !== "PAYMENT_READY") return;
    assert.equal(turn.response.senderSpends.expected.display, "₦300");
    assert.doesNotMatch(turn.response.text, /cNGN/);
  });
});

describe("the same currency is a direct transfer", () => {
  it("'Send 300 Naira' to an address, from a wallet holding Naira, is never priced", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    if (turn.response.type !== "PAYMENT_READY") return;
    assert.deepEqual(w.priced, [], "no FX provider was asked for anything");
    assert.equal(turn.response.senderSpends.expected.display, "₦300");
    assert.equal(turn.response.recipientReceives.expected.display, "₦300");
    assert.match(turn.response.text, /₦300/);
    assert.doesNotMatch(turn.response.text, /cNGN|NGN\b|0x/);
    // Exactly one step, a plain transfer, in the exact token and exact smallest units.
    const route = [...w.r.world.routes.values()][0];
    assert.deepEqual(
      route?.steps.map((step) => step.type),
      ["TRANSFER"],
    );
    assert.equal(route?.input.assetId, w.r.tokens.cNGN.id);
    assert.equal(route?.input.amount, "300000000");
  });

  it("this is the case that used to be priced: Naira fixed on the receiving side, with dollars also in the wallet", async () => {
    // The amount fixes what the recipient gets, and no source was named. The sender side used to default to the USD settlement
    // assets only, so a USDT -> cNGN conversion was priced even though the wallet held Naira. Held Naira is now a candidate too.
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    w.fund("USDT", 100n);
    const turn = await send(w, "Naira", { mode: "EXACT_OUTPUT" });
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    assert.deepEqual(w.priced, [], "no conversion was priced");
    if (turn.response.type !== "PAYMENT_READY") return;
    assert.equal(turn.response.senderSpends.expected.display, "₦300");
  });

  it("with not enough Naira but enough dollars it converts, as before", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(10n));
    w.fund("USDT", 100n);
    const turn = await send(w, "Naira", { mode: "EXACT_OUTPUT" });
    assert.equal(turn.response.type, "PAYMENT_READY", JSON.stringify(turn.response));
    assert.ok(w.priced.length > 0, "a real conversion needs a price");
  });

  it("a payment is still a payment: the settlement asset's identity is exact", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "PAYMENT_READY");
    const asset = w.r.tokens.cNGN;
    assert.equal(asset.chainId, 42220);
    assert.equal(asset.decimals, 6);
    const route = [...w.r.world.routes.values()][0];
    assert.deepEqual(
      route?.input,
      createMoney("300000000", asset.id),
      "smallest units, by asset id",
    );
    assert.deepEqual(route?.output, createMoney("300000000", asset.id));
  });
});

describe("balance and fee are different requirements", () => {
  it("lacking Naira is a Naira problem, said in Naira, and offers funding", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(100n));
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "ERROR");
    if (turn.response.type !== "ERROR") return;
    assert.equal(turn.response.code, "INSUFFICIENT_BALANCE");
    assert.match(turn.response.text, /Nigerian Naira/);
    assert.match(turn.response.text, /₦300/);
    assert.match(turn.response.text, /₦100/);
    assert.doesNotMatch(turn.response.text, /CELO|fee|cNGN/i);
  });

  it("enough Naira but no CELO is a network-fee problem and nothing else", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    w.port.feeBalance = false;
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "ERROR");
    if (turn.response.type !== "ERROR") return;
    assert.equal(turn.response.code, "GAS_FUNDING_REQUIRED");
    assert.equal(
      turn.response.text,
      "You need a small amount of CELO to cover the network fee for this transfer.",
    );
    assert.doesNotMatch(
      turn.response.text,
      /Naira|insufficient|bundler|UserOperation|paymaster|4337/i,
    );
    assert.deepEqual(w.priced, []);
    // The words people see: the fee, a way to fund CELO, a way to drop the payment. No jargon.
    const shown = presentAgentResponse(turn.response, new Date());
    assert.equal(shown.text, turn.response.text);
    assert.deepEqual(shown.suggestions, ["FUND_CELO"]);
    assert.equal(shown.cancellable, true);
  });

  it("enough Naira and enough CELO goes on to authorization", async () => {
    const w = setup({ authorize: true });
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    w.port.feeBalance = true;
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "AUTHORIZATION_REQUIRED", JSON.stringify(turn.response));
    if (turn.response.type !== "AUTHORIZATION_REQUIRED") return;
    assert.equal(turn.response.summary.senderSpends.display, "₦300");
    assert.equal(turn.response.summary.recipientReceives.display, "₦300");
  });

  it("a fee balance that cannot be read never blocks (execution checks again)", async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, NGN(1_000n));
    w.port.feeBalance = undefined;
    const turn = await send(w, "Naira");
    assert.equal(turn.response.type, "PAYMENT_READY");
  });
});

describe("what people see is currencies, not tokens", () => {
  it("formats amounts the way people write them", () => {
    const naira = { symbol: "cNGN", fiatCode: "NGN", decimals: 6 };
    assert.equal(describeMoney(naira, "300000000"), "₦300");
    assert.equal(describeMoney(naira, "1234500000"), "₦1,234.5");
    assert.equal(
      describeMoney(
        { symbol: "wBRL", fiatCode: "BRL", decimals: 18 },
        (50n * 10n ** 18n).toString(),
      ),
      "R$50",
    );
    assert.equal(
      describeMoney({ symbol: "IDRX", fiatCode: "IDR", decimals: 2 }, "500000"),
      "Rp5,000",
    );
    assert.equal(
      describeMoney({ symbol: "XYZ", decimals: 2 }, "1250"),
      "12.5 XYZ",
      "not a familiar currency: unchanged",
    );
  });

  it("a single balance reads as money", () => {
    const text = balanceBlock([
      { symbol: "cNGN", fiatCode: "NGN", decimals: 6, amount: "1000000000" },
      { symbol: "USDC", fiatCode: "USD", decimals: 6, amount: "0" },
    ]);
    assert.equal(text, "₦1,000 Nigerian Naira");
    assert.doesNotMatch(text, /cNGN|USDC|0x/);
  });

  it("several currencies are one line each, and tokens of one currency are added together", () => {
    const text = balanceBlock([
      { symbol: "cNGN", fiatCode: "NGN", decimals: 6, amount: "1000000000" },
      { symbol: "wBRL", fiatCode: "BRL", decimals: 18, amount: (250n * 10n ** 18n).toString() },
      { symbol: "USDT", fiatCode: "USD", decimals: 6, amount: "10000000" },
      { symbol: "USDC", fiatCode: "USD", decimals: 6, amount: "5000000" },
    ]);
    assert.equal(text, "🇳🇬 Nigerian Naira: ₦1,000\n🇧🇷 Brazilian Real: R$250\n🇺🇸 US Dollar: $15");
    assert.doesNotMatch(text, /cNGN|wBRL|USDT|USDC/);
    assert.deepEqual(summarizeHoldings([{ symbol: "XYZ", decimals: 0, amount: "7" }]), [
      { name: "XYZ", amount: "7" },
    ]);
  });

  it("the supported list is currencies in a fixed order, never tickers", () => {
    const lines = describeSupportedCurrencies([
      { symbol: "USDC", fiatCode: "USD" },
      { symbol: "cNGN", fiatCode: "NGN" },
      { symbol: "wARS", fiatCode: "ARS" },
      { symbol: "IDRX", fiatCode: "IDR" },
      { symbol: "wBRL", fiatCode: "BRL" },
      { symbol: "USDT", fiatCode: "USD" },
    ]);
    assert.deepEqual(lines, [
      "🇳🇬 Nigerian Naira",
      "🇧🇷 Brazilian Real",
      "🇦🇷 Argentine Peso",
      "🇮🇩 Indonesian Rupiah",
      "🇺🇸 US Dollar",
    ]);
  });

  it("the balance answer in chat shows Naira and hides the token", async () => {
    const { createHarness } = await import("./support/harness.js");
    const h = createHarness({
      balances: {
        read: () =>
          Promise.resolve({
            lines: [
              {
                symbol: "cNGN",
                display: "1000",
                fiatCode: "NGN",
                decimals: 6,
                amount: "1000000000",
              },
              { symbol: "USDC", display: "0", fiatCode: "USD", decimals: 6, amount: "0" },
            ].filter((line) => line.amount !== "0"),
          }),
      },
    });
    h.script.set("balance", intent({ type: "BALANCE" }));
    const turn = await h.say("balance");
    assert.equal(turn.response.type, "BALANCE_RESULT");
    assert.equal(turn.response.text, "₦1,000 Nigerian Naira");
  });

  it("a balance question can name the currency in words", async () => {
    const { createHarness } = await import("./support/harness.js");
    const h = createHarness({
      balances: {
        read: () =>
          Promise.resolve({
            lines: [
              {
                symbol: "cNGN",
                display: "1000",
                fiatCode: "NGN",
                decimals: 6,
                amount: "1000000000",
              },
            ],
          }),
      },
    });
    h.script.set("my naira balance", intent({ type: "BALANCE", asset: "Naira" } as never));
    const turn = await h.say("my naira balance");
    assert.equal(turn.response.text, "₦1,000 Nigerian Naira");
    h.script.set("my real balance", intent({ type: "BALANCE", asset: "Real" } as never));
    const other = await h.say("my real balance");
    assert.match(other.response.text, /You don't have any Brazilian Real/);
  });

  it("payment errors and summaries never print a token ticker for a familiar currency", () => {
    const response: AgentResponse = {
      type: "ERROR",
      code: "INSUFFICIENT_BALANCE",
      asset: "cNGN",
      text: "You don't currently have enough Nigerian Naira for this payment. You need ₦300 and have ₦100.",
    };
    const shown = presentAgentResponse(response, new Date());
    assert.doesNotMatch(shown.text, /cNGN/);
    assert.match(shown.text, /Nigerian Naira/);
  });
});
