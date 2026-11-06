import { CELO_CHAIN_ID, createMoney, isTrustedPermit2Spender } from "@kaada/domain";
import type {
  FirmQuoteFailureCode,
  FirmQuoteProvider,
  FirmQuoteProviderResult,
  FirmQuoteRequest,
} from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { encodeApprove } from "../../../core/execution/steps.js";
import { UniswapClientError } from "./client.js";
import type { UniswapClient } from "./client.js";
import { VERIFIED_PROTOCOLS, checkSwapAgainst, readRouterCall } from "./calldata.js";
import type { UniswapQuoteResponse } from "./schemas.js";

/**
 * The Permit2 contract, at the same address on every chain it is deployed to.
 *
 * It is the spender Kaada approves, not the Universal Router: the router pulls the input through
 * Permit2 (`payerIsUser` is true in the calldata Uniswap returns), so the ERC-20 allowance goes to
 * Permit2 and Permit2's own allowance goes to the router. See PERMIT2_PREREQUISITE below.
 */
export const PERMIT2_ADDRESS = "0x000000000022d473030f116ddee9f6b43ac78ba3";

/**
 * The second allowance, which this adapter CANNOT express and deliberately does not pretend to.
 *
 * `Permit2.approve(token, spender, amount, expiration)` has its own four-argument selector
 * (0x87517c45), which is not in Kaada's payment-path selector allowlist and must not be added to it.
 * It is a one-time grant per token, so it belongs to wallet setup rather than to a payment, and it is
 * installed through the root-confirmed action path instead.
 *
 * A swap sent without it reverts on chain: gas is spent and no funds move. That is a safe failure, not
 * a silent one, but it is a poor one, so the setup is a prerequisite rather than a fallback.
 */
export const PERMIT2_PREREQUISITE = "PERMIT2_ROUTER_ALLOWANCE";

export interface UniswapFirmProviderOptions {
  client: Pick<UniswapClient, "quote" | "swap">;
  /** The slippage bound written into the swap calldata, in percent, as Uniswap counts it. */
  slippagePercent: number;
  /**
   * How much of the router's own deadline must remain for the quote to be worth returning.
   *
   * The deadline comes from the calldata, is enforced on chain, and is observed at about 30 minutes.
   * A quote with almost none of it left would be accepted by Kaada's expiry gate and then revert, so
   * it is refused here instead.
   */
  minDeadlineMs?: number;
  /**
   * How long a quote stays acceptable, counted from when it was made. The router deadline (about 30 minutes)
   * is only the outer limit: a pool price moves, so Kaada stops honouring the quote far sooner and quotes again.
   */
  quoteLifetimeMs?: number;
  now?: () => Date;
  log?: AgentLog;
}

/** A quote with less than this much of the router deadline left is not worth returning. */
export const DEFAULT_MIN_DEADLINE_MS = 60_000;

/** How long a Uniswap quote is good for once made: 3 minutes. */
export const DEFAULT_QUOTE_LIFETIME_MS = 180_000;

const lower = (value: string) => value.toLowerCase();

/**
 * The firm-quote side of Uniswap: a price, plus the Universal Router calldata that executes it.
 *
 * HOW THIS DIFFERS FROM AN RFQ, AND WHY THAT IS NOT PAPERED OVER
 *
 * Textile reserves a price for one wallet, holds one of the key's outstanding slots, and returns a
 * one-time claim token proving ownership of that reservation. Uniswap reserves NOTHING. A quote is a
 * reading of a pool at a block, and two things protect the person instead of a reservation, both
 * written into the calldata and both enforced on chain:
 *
 *   - `amountOutMin`, so the swap reverts rather than filling below the quoted minimum;
 *   - the router's `deadline`, so a stale swap reverts rather than executing at a moved price.
 *
 * So `issuesClaimToken` is false, there is no slot to count, and `expiresAt` is the router's own
 * deadline rather than a provider promise — a figure read back out of the bytes that will execute.
 *
 * It requests, decodes, validates and normalizes. It never signs, never sends, and never builds swap
 * calldata: the swap transaction is Uniswap's, handed back untouched.
 */
export class UniswapFirmQuoteProvider implements FirmQuoteProvider {
  readonly id = "uniswap";
  /** An AMM reserves nothing, so there is no reservation to prove ownership of. */
  readonly issuesClaimToken = false;
  /**
   * No cap. Nothing is reserved and no slot is held, so there is no limit to respect and nothing a
   * concurrent quote could exhaust.
   */
  readonly maxOutstanding = null;

  private readonly now: () => Date;
  private readonly log: AgentLog;
  private readonly minDeadlineMs: number;
  private readonly quoteLifetimeMs: number;

  constructor(private readonly options: UniswapFirmProviderOptions) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? noopLog;
    this.minDeadlineMs = options.minDeadlineMs ?? DEFAULT_MIN_DEADLINE_MS;
    this.quoteLifetimeMs = options.quoteLifetimeMs ?? DEFAULT_QUOTE_LIFETIME_MS;
  }

  async requestFirm(request: FirmQuoteRequest): Promise<FirmQuoteProviderResult> {
    const failed = (code: FirmQuoteFailureCode, reason: string) => this.failure(code, reason);

    if (request.chainId !== CELO_CHAIN_ID) return failed("NO_QUOTE", "chain_not_supported");
    /*
     * EXACT_OUTPUT is deliberately refused, rather than approximated.
     *
     * On an AMM the unfixed side moves, so an exact-output trade has a MAXIMUM input rather than a
     * known one. Kaada's approval and its quoted input are a single figure, so serving this would mean
     * either approving less than the swap may pull (it reverts) or telling the person they will pay the
     * worst case (it overstates the price). Both are worse than declining: the planner then reaches the
     * same pair through Textile's dollar corridors, which do price an exact output.
     */
    if (request.mode === "EXACT_OUTPUT") return failed("NO_QUOTE", "exact_output_not_supported");

    let response: UniswapQuoteResponse;
    try {
      response = await this.options.client.quote({
        chainId: request.chainId,
        tokenIn: request.sellToken,
        tokenOut: request.buyToken,
        amount: request.exactAmount,
        type: "EXACT_INPUT",
        swapper: request.taker,
        slippagePercent: this.options.slippagePercent,
        protocols: VERIFIED_PROTOCOLS,
      });
    } catch (error) {
      return this.callFailed(error);
    }

    if (response.routing !== "CLASSIC") {
      return failed("QUOTE_MISMATCH", `routing_${response.routing}`);
    }
    const { quote } = response;
    if (quote.chainId !== request.chainId) return failed("QUOTE_MISMATCH", "chain_differs");
    if (quote.tradeType !== "EXACT_INPUT") return failed("QUOTE_MISMATCH", "mode_differs");
    if (lower(quote.swapper) !== lower(request.taker))
      return failed("QUOTE_MISMATCH", "taker_differs");
    if (lower(quote.input.token) !== lower(request.sellToken)) {
      return failed("QUOTE_MISMATCH", "sell_token_differs");
    }
    if (lower(quote.output.token) !== lower(request.buyToken)) {
      return failed("QUOTE_MISMATCH", "buy_token_differs");
    }
    // The side the person fixed must come back exactly as asked; an AMM moves only the other one.
    if (BigInt(quote.input.amount) !== BigInt(request.exactAmount)) {
      return failed("QUOTE_MISMATCH", "sell_amount_differs");
    }
    if (BigInt(quote.output.amount) === 0n) return failed("QUOTE_MISMATCH", "zero_output");
    if (
      quote.output.recipient !== undefined &&
      lower(quote.output.recipient) !== lower(request.taker)
    ) {
      // The output must land in the wallet; Kaada's own transfer leg pays the recipient from there.
      return failed("QUOTE_MISMATCH", "output_recipient_differs");
    }

    let swap;
    try {
      swap = (await this.options.client.swap(quote)).swap;
    } catch (error) {
      return this.callFailed(error);
    }

    if (swap.chainId !== request.chainId) return failed("QUOTE_MISMATCH", "swap_chain_differs");
    /*
     * The swap must target a contract Kaada has deliberately decided to trust, not whatever address the response
     * names. That address becomes the root-signed Permit2 grant's spender and the permission's swap target, so a
     * response pointing elsewhere would turn one routine confirmation into a standing allowance for a stranger.
     */
    if (!isTrustedPermit2Spender(request.chainId, swap.to)) {
      return failed("QUOTE_MISMATCH", "swap_target_not_trusted");
    }
    // Every Kaada swap carries no native value; the input is an ERC-20 pulled through Permit2.
    if (BigInt(swap.value) !== 0n) return failed("QUOTE_MISMATCH", "swap_carries_value");

    /*
     * The calldata is the authority on what will happen, so it is decoded rather than trusted. This
     * refuses a router command Kaada is not prepared to execute, and any command marked allow-revert —
     * which could leave the swap undone inside a transaction that still succeeds.
     */
    const router = readRouterCall(swap.data);
    if (!router.ok) {
      return failed("QUOTE_MISMATCH", `calldata_${router.problem.toLowerCase()}`);
    }
    /*
     * And what the bytes DO must be what the person was promised: output to the wallet, exactly the authorised amount
     * spent, paid by the wallet, the right start and end tokens, and a minimum output close to the agreed slippage.
     */
    const wrong = checkSwapAgainst(router.call, {
      taker: request.taker,
      sellToken: request.sellToken,
      buyToken: request.buyToken,
      exactIn: BigInt(request.exactAmount),
      outputAmount: BigInt(quote.output.amount),
      slippageBps: Math.round(this.options.slippagePercent * 100),
    });
    if (wrong) return failed("QUOTE_MISMATCH", `calldata_${wrong}`);

    /*
     * The router's own deadline (read from the bytes, enforced on chain) is the hard limit: past it the
     * swap reverts and no funds move. Kaada honours the quote for a much shorter time than that, because
     * a pool price moves; after that a fresh quote is made.
     */
    const now = this.now();
    const remaining = router.call.deadline.getTime() - now.getTime();
    if (remaining < this.minDeadlineMs) {
      return failed("NO_QUOTE", "deadline_too_close");
    }
    const expiresAt = new Date(now.getTime() + Math.min(remaining, this.quoteLifetimeMs));

    const spent = BigInt(quote.input.amount);
    this.log("info", "uniswap.firm_quoted", {
      pair: `${request.sellToken}>${request.buyToken}`,
      commands: router.call.commandNames.join(","),
      deadlineMs: remaining,
      quoteId: quote.quoteId ?? "none",
    });

    return {
      status: "QUOTED",
      quote: {
        provider: this.id,
        // Uniswap's own id for the quote when it gives one; its requestId otherwise, so the executed
        // quote can always be traced back to a call that was actually made.
        providerQuoteId: quote.quoteId ?? response.requestId,
        chainId: request.chainId,
        input: createMoney(quote.input.amount, request.sellAssetId),
        output: createMoney(quote.output.amount, request.buyAssetId),
        // No fee: Uniswap charges none on these routes and the pool spread is already inside the
        // output. The network fee is paid in CELO to the chain, not to a provider.
        expiresAt,
        // Same figure: for an AMM the accept cutoff and the settlement deadline are one deadline.
        orderDeadline: expiresAt,
        /*
         * Permit2, not the router. The router pulls the input through Permit2, so this is the spender
         * Kaada's bounded ERC-20 approval must name. The SECOND allowance, Permit2 -> router, is a
         * one-time setup and is not expressible here: see PERMIT2_PREREQUISITE.
         */
        spender: PERMIT2_ADDRESS,
        taker: lower(request.taker),
        executionReference: quote.quoteId ?? response.requestId,
        indicative: false,
      },
      transactions: {
        /*
         * Kaada's OWN bounded approval, not Uniswap's.
         *
         * `POST /v1/check_approval` answers with `approve(Permit2, MAX_UINT256)`, which Kaada refuses
         * outright (APPROVAL_UNLIMITED). The exact amount is built here with the same encoder the
         * executor uses, so what is inspected before signing and what is signed are the same bytes,
         * and the allowance can never exceed this one swap's input.
         */
        approval: {
          to: lower(request.sellToken),
          data: encodeApprove(PERMIT2_ADDRESS, spent),
          value: "0",
          chainId: request.chainId,
        },
        /*
         * Uniswap's swap transaction. The calldata is handed back untouched; the VALUE is converted.
         *
         * Uniswap answers with an eth_call-style hex quantity ("0x00"), while Kaada's
         * UnsignedTransaction.value is documented as a DECIMAL wei string. Passing the hex through made
         * `inspectSwapTransaction` raise SWAP_CARRIES_UNEXPECTED_VALUE for a swap carrying nothing, and
         * the validated signer refuse the call outright, because both compare against the string "0".
         * Every Uniswap payment would have been blocked. Normalised here, where the provider's own
         * conventions stop and Kaada's begin. The amount itself is still checked to be zero above.
         */
        swap: {
          to: lower(swap.to),
          data: swap.data,
          value: BigInt(swap.value).toString(),
          chainId: swap.chainId,
        },
      },
      // No claim token: there is no reservation to claim. `issuesClaimToken` says so up front, so this
      // absence is a declared trait rather than something downstream has to discover.
    };
  }

  /**
   * A failed attempt. `mayHoldSlot` is always false: an AMM reserves nothing, so a failure here cannot
   * have left a quote held at the provider the way an RFQ timeout can.
   */
  private failure(code: FirmQuoteFailureCode, reason: string): FirmQuoteProviderResult {
    this.log("warn", "uniswap.firm_failed", { code, reason });
    return { status: "FAILED", code, mayHoldSlot: false, providerReason: reason };
  }

  /** A transport or HTTP failure, reduced to a domain code. Never carries a URL, header or key. */
  private callFailed(error: unknown): FirmQuoteProviderResult {
    if (!(error instanceof UniswapClientError)) {
      return this.failure("PROVIDER_UNAVAILABLE", "unknown_error");
    }
    switch (error.kind) {
      case "NO_QUOTE":
        return this.failure("NO_QUOTE", "no_route");
      case "TIMEOUT":
        return this.failure("PROVIDER_TIMEOUT", "timeout");
      case "RATE_LIMITED":
        return this.failure("PROVIDER_CAPACITY_REACHED", "rate_limited");
      case "MALFORMED":
        return this.failure("MALFORMED_RESPONSE", "malformed");
      default:
        return this.failure("PROVIDER_UNAVAILABLE", error.kind.toLowerCase());
    }
  }
}
