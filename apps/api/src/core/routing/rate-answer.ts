import { formatRate } from "@kaada/domain";

import { currencyByCode } from "../currency/catalog.js";
import type { MoneyView } from "../responses/agent-response.js";

/*
 * The words of a RATE answer, and nothing else: no provider is called here and no figure is invented. Every number comes in
 * already priced, as exact smallest-unit amounts, and the rate itself is derived from those two amounts (see formatRate), never
 * from anything a model said.
 *
 * A rate answer and a payment quote are deliberately different things and are worded differently:
 *  - a rate is indicative and informational, and says so;
 *  - a firm quote is executable, reserved and expiring, and is built elsewhere (the firm-quote path).
 * Nothing here may describe a preview as executable, and nothing here starts, prices or authorizes a payment.
 */

export interface RateAnswerInput {
  /** What was priced: one unit of the source. */
  source: MoneyView;
  destination: MoneyView;
  /** The fiat code each side stands for, when it stands for one. Used only for wording. */
  sourceCurrency?: string | undefined;
  destinationCurrency?: string | undefined;
  /** Development mock pricing: never a real rate, and must be labelled loudest. */
  mock?: boolean;
  /** The provider gave an indicative price rather than a firm, reserved one. */
  indicative?: boolean;
  /** Whether a payment in this direction can actually be made (a route exists). */
  routeAvailable?: boolean;
  /** Whether the person asked for a specific amount; when false the answer offers to work one out. */
  amountAsked?: boolean;
}

/** How one side is named in a rate line: "Nigerian Naira (NGN)" where it is a currency, else the token symbol. */
function nameOf(view: MoneyView, fiatCode: string | undefined): string {
  const currency = currencyByCode(fiatCode);
  return currency ? `${currency.name} (${currency.code})` : view.symbol;
}

/** The unit symbol written before a figure: "₦", "AR$", or the token symbol with a space. */
function unitOf(view: MoneyView, fiatCode: string | undefined): string {
  return currencyByCode(fiatCode)?.symbol ?? `${view.symbol} `;
}

/** Whether a side stands for US dollars — the base every rate is read against when it is one of the two. */
function isDollar(fiatCode: string | undefined): boolean {
  return fiatCode?.trim().toUpperCase() === "USD";
}

/**
 * The answer to "what's the rate?": the pair, the rate itself, what it means for one unit, how fresh it is, and whether money
 * can actually move that way. It never asks for an amount it does not need; it offers.
 */
export function buildRateAnswer(input: RateAnswerInput): string {
  // The dollar is the base whenever it is in the pair, whichever way round the person asked.
  //
  // "₦1 = $0.0007246" is arithmetically correct and practically unreadable: nobody holds a mental model of a naira in
  // ten-thousandths of a dollar, and the figure changes shape as currencies move. "$1 = ₦1,380.00" is the rate every
  // Nigerian already knows, and it stays comparable across every currency Kaada settles, because they all have the same
  // base. The two statements carry identical information — formatRate is a ratio of the two priced amounts, so reading
  // it the other way round is a division, not a second price. No provider is called twice for this.
  const anchored = isDollar(input.destinationCurrency) && !isDollar(input.sourceCurrency);
  const source = anchored ? input.destination : input.source;
  const destination = anchored ? input.source : input.destination;
  const sourceCode = anchored ? input.destinationCurrency : input.sourceCurrency;
  const destinationCode = anchored ? input.sourceCurrency : input.destinationCurrency;
  const rate = formatRate(source, destination);
  const sourceUnit = unitOf(source, sourceCode);
  const destinationUnit = unitOf(destination, destinationCode);
  const pair = `${nameOf(source, sourceCode)} → ${nameOf(destination, destinationCode)}`;

  const lines: string[] = [pair];
  lines.push(
    rate === undefined
      ? `${source.display} currently gives ${destination.display}.`
      : `${sourceUnit}1 = ${destinationUnit}${rate}`,
  );

  // No fee line: a rate is priced from a ONE-UNIT probe, so its fee says nothing about what a real payment would cost.
  // Fees belong to a quote for an actual amount, where they are the provider's own figures for that amount.
  if (input.mock) {
    lines.push("Development mock pricing: this is not a real rate.");
  } else {
    lines.push(
      input.indicative
        ? "Live indicative rate. The exact rate is locked in when you confirm a payment."
        : "Live rate, as quoted just now.",
    );
  }
  if (input.routeAvailable === false) {
    lines.push("I can't move money along this pair right now, so this is for reference only.");
  }
  // Only offered when they have not already named an amount: they asked a rate, not a riddle.
  if (input.amountAsked !== true) lines.push("Want me to work out a specific amount?");
  return lines.join("\n");
}
