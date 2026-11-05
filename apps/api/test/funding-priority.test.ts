import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { intent } from "./support/harness.js";
import { setup, WALLET_ADDRESS } from "./support/payment-world.js";
import type { PaymentWorld } from "./support/payment-world.js";
import type { AgentResponse } from "../src/core/responses/agent-response.js";

/*
 * Which of someone's money pays for a payment, and in what order.
 *
 * The rule: the dollar is the pivot, so a dollar-denominated amount names the SIZE of a payment, never the asset that
 * funds it. When a dollar asset is held it is used — it is already in the middle of every route and needs no first hop.
 * When it is not, whatever they do hold is converted to exactly that many dollars and the payment carries on:
 *
 *     cNGN  ->  exactly $1 USDT  ->  wARS
 *
 * From a live Telegram session, where holding cNGN and asking to send a dollar of pesos answered "Your wallet doesn't
 * hold anything that can pay for this yet. Any of these would work: US Dollar", and naming the naira balance answered
 * "I can't pay with NGN right now."
 */

const RECIPIENT = { type: "WALLET_ADDRESS" as const, value: WALLET_ADDRESS };

/** "Send a dollar's worth of Argentine pesos", as the interpreter reads it. */
let n = 0;
async function sendDollarOfPesos(w: PaymentWorld, options: { from?: string } = {}) {
  const text = `send a dollar of pesos ${String(++n)}`;
  w.r.h.script.set(
    text,
    intent({
      type: "SEND",
      recipient: RECIPIENT,
      amount: { value: "1", currencyOrAsset: "USD", mode: "EXACT_INPUT" },
      destination: { currency: "ARS" },
      ...(options.from !== undefined && { sourceAsset: options.from }),
    } as never),
  );
  return (await w.r.h.say(text)).response;
}

/** The symbols a priced route actually moves through, in order. */
function hopsOf(response: AgentResponse): string[] {
  if (response.type !== "PAYMENT_READY") return [];
  return response.route.hops.map((hop) => `${hop.from}>${hop.to}`);
}

function describeFailure(response: AgentResponse): string {
  return `${response.type}${"code" in response ? `:${response.code}` : ""} ${
    "text" in response ? response.text : ""
  }`;
}

describe("funding priority: the dollar is the size, not the source", () => {
  it("converts the currency they DO hold into exactly the dollars asked for", {
    skip:
      "Needs the planner to pin a fixed amount BETWEEN two hops. Everything up to that point is fixed and in place: the amount no longer pins the source (assessment), a cross-currency token is a candidate (candidate-resolver), and it survives the funding filter unpriced (funding-resolver). The route then fails to price, because spending exactly $1 of naira is EXACT_OUTPUT on hop one and EXACT_INPUT on hop two, and the planner prices a path in one direction throughout.",
  }, async () => {
    const w = setup();
    // Naira, and not a cent of anything else — the wallet in the Telegram session. The mock prices a dollar at 1,530
    // of them, so this is comfortably more than a dollar without the test turning on the exact rate.
    w.port.held.set(w.r.tokens.cNGN.id, 5_000_000n * 10n ** 6n);

    const response = await sendDollarOfPesos(w);

    assert.equal(
      response.type,
      "PAYMENT_READY",
      `holding naira is enough to send a dollar of pesos: ${describeFailure(response)}`,
    );
    assert.deepEqual(
      hopsOf(response),
      ["cNGN>USDT", "USDT>wARS"],
      "their naira becomes exactly the dollars asked for, and those dollars become pesos",
    );
  });

  it("uses a dollar asset when they hold one, rather than converting something else", async () => {
    const w = setup();
    w.fund("USDT", 10n);
    w.port.held.set(w.r.tokens.cNGN.id, 5_000_000n * 10n ** 6n);

    const response = await sendDollarOfPesos(w);

    assert.equal(response.type, "PAYMENT_READY", describeFailure(response));
    assert.deepEqual(
      hopsOf(response),
      ["USDT>wARS"],
      "already holding the dollars, there is nothing to convert first",
    );
  });

  it("reads 'from my naira balance' as the token that settles naira, not as a refusal", {
    skip:
      "Needs the planner to pin a fixed amount BETWEEN two hops. Everything up to that point is fixed and in place: the amount no longer pins the source (assessment), a cross-currency token is a candidate (candidate-resolver), and it survives the funding filter unpriced (funding-resolver). The route then fails to price, because spending exactly $1 of naira is EXACT_OUTPUT on hop one and EXACT_INPUT on hop two, and the planner prices a path in one direction throughout.",
  }, async () => {
    const w = setup();
    w.port.held.set(w.r.tokens.cNGN.id, 5_000_000n * 10n ** 6n);

    // A person names their money by its currency; cNGN is an implementation detail they never see.
    const response = await sendDollarOfPesos(w, { from: "NGN" });

    assert.notEqual(
      response.type,
      "ERROR",
      `naming the naira balance must not be refused: ${describeFailure(response)}`,
    );
    assert.deepEqual(hopsOf(response), ["cNGN>USDT", "USDT>wARS"]);
  });
});
