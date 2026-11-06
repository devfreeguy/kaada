import { KaadaError } from "@kaada/domain";
import type {
  FirmQuoteAttempt,
  SettlementConfirmer,
  SettlementOutcome,
  SettlementQuery,
} from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";

/*
 * How a Uniswap swap's settlement is confirmed: by reading the chain.
 *
 * WHY THERE IS NOTHING TO ASK A PROVIDER
 *
 * An RFQ provider holds an order off chain. It knows things the chain cannot tell you — whether the
 * maker filled, the amounts it settled, a fill that lands hours later — so it is the authority and it
 * is asked, with a claim token as proof of ownership.
 *
 * An AMM holds nothing. There is no order, no reservation, no claim token and no off-chain state of any
 * kind. The swap either executed in a block or it did not. So the chain is not a fallback here, it is
 * the ONLY authority that exists; asking Uniswap's API "how did my swap settle" would be asking a
 * question it has no record of.
 *
 * WHAT A SUCCESSFUL RECEIPT DOES AND DOES NOT PROVE
 *
 * Kaada sends the swap and the payout as ONE UserOperation (see `plannedSteps`): the swap call, then a
 * `transfer(recipient, payoutAmount)` for the exact firm output. So a successful receipt proves two things:
 * the input left the wallet, and the RECIPIENT received exactly the quoted output. The amounts reported
 * here are those two facts.
 *
 * It does NOT prove the swap itself delivered that much. The transfer draws on the wallet's WHOLE balance of
 * the buy token, so if the swap delivers a little less than quoted (the calldata permits up to the slippage
 * bound) and the wallet already holds some of that token, the transfer still succeeds and the shortfall is
 * quietly paid out of the wallet's own holdings. Measured on Celo mainnet (2026-11-06) the swap delivered
 * the quote to the unit, so this is a corner of the design and not an observed loss, but it is real: the
 * "either both happen or neither does" guarantee holds in full only for a wallet that holds none of the
 * buy token. The shortfall is bounded by the slippage the person authorised and by the session key's
 * payout limit, so it cannot exceed what they agreed to.
 *
 * This class performs no network call of its own: the runner has already awaited and confirmed the
 * receipt before it is reached, and re-reading it would answer a question already answered.
 */

export interface UniswapSettlementConfirmerOptions {
  /**
   * The stored firm-quote attempt, by Kaada's own id for it.
   *
   * Read here rather than handed in, so the amounts this confirmer reports come from the record of what
   * was quoted and not from whoever is asking. The runner then checks them against the authorized
   * bounds, and that check is only worth anything if the two values have independent sources.
   */
  findAttempt: (quoteId: string) => Promise<FirmQuoteAttempt | null>;
  log?: AgentLog;
}

export class UniswapSettlementConfirmer implements SettlementConfirmer {
  readonly id = "uniswap";
  /** There is no order to notify: the swap is the settlement. `notify` is therefore a no-op. */
  readonly notifiesProvider = false;

  private readonly log: AgentLog;

  constructor(private readonly options: UniswapSettlementConfirmerOptions) {
    this.log = options.log ?? noopLog;
  }

  /**
   * Nothing to report to anyone. Returns the state without pretending a call was made.
   *
   * It is not an error: the runner only calls this when `notifiesProvider` is true, and a confirmer
   * that threw here would make a correct caller look broken.
   */
  notify(input: SettlementQuery): Promise<SettlementOutcome> {
    return Promise.resolve({ state: "SUBMITTED", txHash: input.txHash.toLowerCase() });
  }

  /**
   * The receipt has already confirmed success, so this is settled. The amounts come from the firm quote
   * because the batched payout makes them exact (see the file comment).
   *
   * A claim token, if one were somehow passed, is ignored rather than rejected: this provider never
   * issued one, so its presence would say nothing about this swap either way.
   */
  async confirm(input: SettlementQuery): Promise<SettlementOutcome> {
    const attempt = await this.options.findAttempt(input.quoteId);
    const amounts =
      attempt?.input && attempt.output
        ? { sellAmount: attempt.input.amount, buyAmount: attempt.output.amount }
        : undefined;
    if (!amounts) {
      // The quote that was executed cannot be found. Not reported as settled: the runner then keeps
      // the execution under reconciliation rather than completing a payment it cannot describe.
      this.log("error", "settlement.quote_amounts_missing", {
        provider: this.id,
        providerQuoteId: input.providerQuoteId,
        quoteId: input.quoteId,
      });
      throw new KaadaError("PROVIDER_UNAVAILABLE", "the executed quote's amounts are unavailable", {
        details: { kind: "QUOTE_AMOUNTS_MISSING", retryable: false },
      });
    }
    return {
      state: "SETTLED",
      txHash: input.txHash.toLowerCase(),
      sellAmount: amounts.sellAmount,
      buyAmount: amounts.buyAmount,
      // No fee: Uniswap charges none on these routes, and the pool spread is already inside the output.
      // The network fee is paid in CELO to the chain, not to a provider, so it is not a settlement fee.
    };
  }
}
