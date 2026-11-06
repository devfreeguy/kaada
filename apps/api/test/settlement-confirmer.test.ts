import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SecretValue, createMoney, createSettlementConfirmerRegistry } from "@kaada/domain";
import type { FirmQuoteAttempt, SettlementConfirmer, SettlementQuery } from "@kaada/domain";

import { UniswapSettlementConfirmer } from "../src/infrastructure/fx/uniswap/index.js";

/*
 * Settlement is the step where the two kinds of provider genuinely differ, so this is where the old
 * Textile-shaped assumptions did the most damage.
 *
 * Two of them, both now impossible by construction and both asserted below:
 *
 *  1. `runner.ts` demanded a claim token and THREW when there was none. That code runs after the swap
 *     has confirmed on chain, so for a provider that issues no token it would have thrown with the
 *     money already moved, wedging a paid-out execution in SETTLING with the reconciler re-throwing on
 *     every pass.
 *  2. COMPLETED required a provider to report the order filled. An AMM has no order and no API that
 *     knows anything about one, so such an execution could never have completed at all.
 */

const CNGN = "11111111-1111-4111-8111-111111111111";
const WARS = "22222222-2222-4222-8222-222222222222";
const TX = "0x09EB54507C467CDEEE7EC1D462A3D7D99CC0CBDA5A7E4DF6D763B1A3C22A539C";

const attempt = (overrides: Partial<FirmQuoteAttempt> = {}): FirmQuoteAttempt => ({
  id: "attempt-1",
  paymentAuthorizationId: "auth-1",
  userId: "user-1",
  walletId: "wallet-1",
  providerId: "row-uniswap",
  status: "QUOTED",
  idempotencyKey: "firm:auth-1:row-uniswap:1",
  amountMode: "EXACT_INPUT",
  exactAmount: createMoney("500000000", CNGN),
  takerAddress: "0xwallet",
  providerQuoteId: "uniswap-quote-1",
  input: createMoney("500000000", CNGN),
  output: createMoney("602319185038970179993", WARS),
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

const query = (overrides: Partial<SettlementQuery> = {}): SettlementQuery => ({
  providerQuoteId: "uniswap-quote-1",
  quoteId: "attempt-1",
  txHash: TX,
  ...overrides,
});

/** A stand-in RFQ confirmer: it needs a token and reports what the provider said. */
class FakeRfqConfirmer implements SettlementConfirmer {
  readonly id = "textile";
  readonly notifiesProvider = true;
  readonly notified: string[] = [];
  constructor(private readonly state: "SETTLED" | "FAILED" = "SETTLED") {}
  notify(input: SettlementQuery) {
    if (!input.claimToken) throw new Error("an RFQ cannot be asked without its claim token");
    this.notified.push(input.txHash);
    return Promise.resolve({ state: "SUBMITTED" as const });
  }
  confirm(input: SettlementQuery) {
    if (!input.claimToken) throw new Error("an RFQ cannot be asked without its claim token");
    return Promise.resolve({ state: this.state });
  }
}

describe("the settlement confirmer registry", () => {
  it("resolves by provider slug and refuses duplicates", () => {
    const uniswap = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(attempt()),
    });
    const textile = new FakeRfqConfirmer();
    const registry = createSettlementConfirmerRegistry([textile, uniswap]);

    assert.equal(registry.get("uniswap")?.id, "uniswap");
    assert.equal(registry.get("textile")?.id, "textile");
    assert.equal(registry.get("nobody"), undefined, "an unwired provider resolves to nothing");
    assert.deepEqual(registry.slugs(), ["textile", "uniswap"]);
    assert.throws(
      () => createSettlementConfirmerRegistry([uniswap, uniswap]),
      /same slug/,
      "two confirmers for one provider would make settlement ambiguous",
    );
  });

  /*
   * The two confirmers disagree about claim tokens, and that disagreement is the point: it is what the
   * old single-port design could not express.
   */
  it("lets each provider state its own needs, rather than imposing one shape", () => {
    const uniswap = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(attempt()),
    });
    const textile = new FakeRfqConfirmer();
    assert.equal(textile.notifiesProvider, true, "an RFQ holds an order worth notifying");
    assert.equal(uniswap.notifiesProvider, false, "an AMM has no order to notify");
  });
});

describe("Uniswap settlement reads the chain, because nothing else knows", () => {
  it("settles with the quoted amounts once the receipt has confirmed", async () => {
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(attempt()),
    });
    const outcome = await confirmer.confirm(query());

    assert.equal(outcome.state, "SETTLED");
    // Lowercased, so a hash compares equal however the chain or a provider cased it.
    assert.equal(outcome.txHash, TX.toLowerCase());
    assert.equal(outcome.sellAmount, "500000000");
    assert.equal(outcome.buyAmount, "602319185038970179993");
    // An AMM charges no provider fee; the network fee is paid in CELO to the chain, not to Uniswap.
    assert.equal(outcome.feeAmount, undefined);
  });

  it("needs no claim token, and ignores one if given", async () => {
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(attempt()),
    });
    const without = await confirmer.confirm(query());
    const withToken = await confirmer.confirm(
      query({ claimToken: new SecretValue("not-mine-and-not-needed") }),
    );
    assert.equal(without.state, "SETTLED");
    assert.deepEqual(withToken, without, "a token it never issued changes nothing");
  });

  /*
   * The amounts are read from the stored attempt by Kaada's own id, NOT taken from the caller. The
   * runner then checks them against the authorized bounds, and that check only means something if the
   * two values have independent sources: a confirmer handed the expected figures could echo them back
   * and the bounds check would pass by construction.
   */
  it("reads the amounts from the stored quote, by Kaada's own id", async () => {
    const asked: string[] = [];
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: (quoteId) => {
        asked.push(quoteId);
        return Promise.resolve(attempt());
      },
    });
    await confirmer.confirm(query({ quoteId: "attempt-1", providerQuoteId: "uniswap-quote-1" }));
    assert.deepEqual(asked, ["attempt-1"], "looked up by Kaada's id, not the provider's");
  });

  it("refuses to call it settled when the executed quote cannot be found", async () => {
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(null),
    });
    // Rejects rather than returning SETTLED: the runner then keeps reconciling instead of completing a
    // payment whose amounts it cannot state.
    await assert.rejects(confirmer.confirm(query()), /amounts are unavailable/);
  });

  it("refuses when the stored quote has no amounts recorded", async () => {
    // `exactOptionalPropertyTypes` makes an explicit `undefined` a type error, which is the point:
    // an absent amount is a missing field, not a field holding undefined. So it is deleted.
    const withoutAmounts = attempt();
    delete withoutAmounts.input;
    delete withoutAmounts.output;
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(withoutAmounts),
    });
    await assert.rejects(confirmer.confirm(query()), /amounts are unavailable/);
  });

  it("notifies nobody without erroring, so a correct caller is not punished", async () => {
    const confirmer = new UniswapSettlementConfirmer({
      findAttempt: () => Promise.resolve(attempt()),
    });
    const outcome = await confirmer.notify(query());
    assert.deepEqual(outcome, { state: "SUBMITTED", txHash: TX.toLowerCase() });
  });
});
