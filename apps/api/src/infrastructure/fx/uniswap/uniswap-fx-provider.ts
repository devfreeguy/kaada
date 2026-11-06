import {
  CELO_CHAIN_ID,
  KaadaError,
  assertSmallestUnitAmount,
  createId,
  createMoney,
  validateQuoteRequest,
} from "@kaada/domain";
import type {
  Asset,
  AssetRegistry,
  FxExecutionContext,
  FxExecutionResult,
  FxExecutionStatus,
  FxProvider,
  FxQuote,
  QuoteRequest,
} from "@kaada/domain";

import { errorDetails } from "../../../core/channels/error-details.js";
import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { VERIFIED_PROTOCOLS } from "./calldata.js";
import { UniswapClientError } from "./client.js";
import type { UniswapClient } from "./client.js";
import type { UniswapQuoteResponse } from "./schemas.js";

/*
 * Uniswap as an FxProvider: QUOTE ONLY, like Textile. It prices with POST /v1/quote and cannot execute; the swap
 * calldata lives on the firm-quote side, because that is where a price becomes something a wallet can sign.
 *
 * WHY THIS EXISTS ALONGSIDE TEXTILE
 *
 * Textile is an RFQ network, and it has no corridor between two local currencies: cNGN -> wARS answers "No RFQ
 * corridor for this pair on chain 42220". The only way across is USDT, in two legs that cannot settle atomically.
 * Uniswap holds the pools, so the same conversion is ONE transaction that either completes or reverts — which is a
 * different thing to offer someone than two legs with a gap in the middle.
 *
 * Hard limits of this instance: Celo mainnet (42220) only; domain asset ids in, token addresses from the asset
 * registry (nothing hard-coded here); the response is validated before it is trusted.
 */

/**
 * How long an AMM price is treated as fresh.
 *
 * Shorter than an RFQ's expiry on purpose, and for a different reason: nothing is reserved here. An AMM price is a
 * reading of a pool at a block, and the pool moves. The protection against it moving is the slippage bound written
 * into the calldata, not this window; this only decides when the planner asks for a new reading.
 */
export const DEFAULT_AMM_WINDOW_MS = 10_000;

/** Uniswap's own slippage default, observed on a live quote, used when none is configured. */
export const DEFAULT_SLIPPAGE_PERCENT = 2.5;

/**
 * The address an INDICATIVE price is quoted against.
 *
 * Uniswap takes a `swapper` on every quote and writes it into the route it prices, so a price needs one even though
 * nothing here is signed and no wallet is touched. It is not a Kaada wallet and never will be: using a real person's
 * address to shop for a price would put it in a third party's logs for no gain, since the firm quote re-prices against
 * the wallet that will actually sign. Accepted by the live API (verified: 200 on cNGN -> wARS).
 */
export const INDICATIVE_SWAPPER = "0x0000000000000000000000000000000000000001";

export interface UniswapFxProviderOptions {
  assets: AssetRegistry;
  client: Pick<UniswapClient, "quote">;
  now: () => Date;
  /**
   * The wallet a price is quoted against. Uniswap takes a `swapper` on every quote and writes it into the route it
   * prices, so an indicative price needs one even though nothing is signed. A real wallet is used when the request
   * carries one; otherwise this stands in, and the firm quote re-prices against the wallet that will actually sign.
   */
  quoteSwapper: string;
  /** Percent, as Uniswap counts it: 0.5 means 0.5%. */
  slippagePercent?: number;
  windowMs?: number;
  log?: AgentLog;
}

interface Token {
  asset: Asset;
  address: string;
}

export class UniswapFxProvider implements FxProvider {
  readonly id = "uniswap";

  private readonly assets: AssetRegistry;
  private readonly client: Pick<UniswapClient, "quote">;
  private readonly now: () => Date;
  private readonly windowMs: number;
  private readonly slippagePercent: number;
  private readonly quoteSwapper: string;
  private readonly log: AgentLog;

  constructor(options: UniswapFxProviderOptions) {
    this.assets = options.assets;
    this.client = options.client;
    this.now = options.now;
    this.windowMs = options.windowMs ?? DEFAULT_AMM_WINDOW_MS;
    this.slippagePercent = options.slippagePercent ?? DEFAULT_SLIPPAGE_PERCENT;
    this.quoteSwapper = options.quoteSwapper.toLowerCase();
    this.log = options.log ?? noopLog;
  }

  /**
   * Structural support only (no network): two distinct, active tokens on Celo mainnet, EXACT_INPUT only.
   *
   * Exact-output is refused here, not just downstream. The firm side cannot execute it (an AMM's input is a maximum,
   * not a known figure, while Kaada's approval and quoted input are one number), so a price quoted for it would be a
   * promise nothing can keep. Before this check the router happily chose Uniswap for "send exactly 1,500 pesos" and the
   * person met `exact_output_not_supported` only after entering their PIN (reproduced on 2026-11-06).
   */
  async supports(request: QuoteRequest): Promise<boolean> {
    if (request.mode === "EXACT_OUTPUT") return false;
    try {
      await this.tokens(request);
      return true;
    } catch (error) {
      this.log("warn", "fx.pair_unsupported", { provider: this.id, ...errorDetails(error) });
      return false;
    }
  }

  async quote(request: QuoteRequest): Promise<FxQuote> {
    // Rejected locally, before any request leaves the process.
    if (request.mode === "EXACT_OUTPUT") {
      throw new KaadaError("PAIR_NOT_SUPPORTED", "exact-output is not offered on this provider");
    }
    validateQuoteRequest(request);
    assertSmallestUnitAmount(request.amount.amount);
    const { sell, buy } = await this.tokens(request);

    const started = this.now().getTime();
    const pair = `${sell.asset.symbol}>${buy.asset.symbol}`;
    try {
      const response = await this.client.quote({
        chainId: CELO_CHAIN_ID,
        tokenIn: sell.address,
        tokenOut: buy.address,
        amount: request.amount.amount,
        type: request.mode,
        swapper: this.quoteSwapper,
        slippagePercent: this.slippagePercent,
        protocols: VERIFIED_PROTOCOLS,
      });
      const quote = this.normalize(request, sell, buy, response);
      this.log("info", "fx.quote", {
        provider: this.id,
        pair,
        mode: request.mode,
        latencyMs: this.now().getTime() - started,
        outcome: "quoted",
      });
      return quote;
    } catch (error) {
      const failure = this.toKaadaError(error);
      this.log("warn", "fx.quote", {
        provider: this.id,
        pair,
        mode: request.mode,
        latencyMs: this.now().getTime() - started,
        outcome: error instanceof UniswapClientError ? error.kind : failure.code,
        ...(error instanceof UniswapClientError && error.detail !== undefined
          ? { detail: error.detail }
          : {}),
      });
      throw failure;
    }
  }

  /** Quote-only: this provider can never move funds. The swap is built and signed by Kaada's own executor. */
  execute(_quote: FxQuote, _context: FxExecutionContext): Promise<FxExecutionResult> {
    return Promise.reject(
      new KaadaError(
        "EXECUTION_NOT_ENABLED",
        "EXECUTION_NOT_ENABLED: the Uniswap provider only quotes; it never submits or executes",
      ),
    );
  }

  status(_providerExecutionId: string): Promise<FxExecutionStatus> {
    return Promise.reject(
      new KaadaError(
        "EXECUTION_NOT_ENABLED",
        "EXECUTION_NOT_ENABLED: there is no execution to report on",
      ),
    );
  }

  /** The two tokens of a request, resolved from asset metadata and checked against Celo. */
  private async tokens(request: QuoteRequest): Promise<{ sell: Token; buy: Token }> {
    if (request.inputAssetId === request.outputAssetId) {
      throw new KaadaError("PAIR_NOT_SUPPORTED", "input and output assets are the same");
    }
    const [sell, buy] = await Promise.all([
      this.token(request.inputAssetId),
      this.token(request.outputAssetId),
    ]);
    return { sell, buy };
  }

  private async token(assetId: string): Promise<Token> {
    const asset = await this.assets.getById(assetId);
    if (!asset || !asset.isActive) {
      throw new KaadaError("ASSET_NOT_SUPPORTED", "asset is unknown or inactive", {
        details: { assetId },
      });
    }
    if (asset.chainId !== CELO_CHAIN_ID || asset.contractAddress === undefined) {
      throw new KaadaError("ASSET_NOT_SUPPORTED", "this provider only prices Celo mainnet tokens", {
        details: { assetId },
      });
    }
    return { asset, address: asset.contractAddress };
  }

  /**
   * Quote response -> FxQuote. Uniswap's own numbers are used as given; nothing is recomputed.
   *
   * There is no fee: Uniswap charges none on this route ("Fee: Free" in its own interface), and the pool's own
   * spread is already inside the quoted output. The network cost is NOT a fee in Kaada's sense — the wallet pays it
   * in CELO to the chain, not to a provider — so it is not reported as one. Inventing a fee figure here would put a
   * number in front of someone that nobody charges them.
   */
  private normalize(
    request: QuoteRequest,
    sell: Token,
    buy: Token,
    response: UniswapQuoteResponse,
  ): FxQuote {
    const mismatch = (reason: string): KaadaError =>
      new KaadaError("PROVIDER_UNAVAILABLE", "the provider response did not match the request", {
        details: { reason },
      });

    // CLASSIC is an on-chain AMM route, which is the only kind this build can execute. UniswapX is an off-chain
    // filled order with a different lifecycle entirely, and a bridge route is not a Celo swap at all.
    if (response.routing !== "CLASSIC") throw mismatch(`routing_${response.routing}`);

    const { quote } = response;
    if (quote.chainId !== CELO_CHAIN_ID) throw mismatch("chain_differs");
    if (quote.tradeType !== request.mode) throw mismatch("mode_differs");
    if (quote.input.token.toLowerCase() !== sell.address.toLowerCase()) {
      throw mismatch("sell_token_differs");
    }
    if (quote.output.token.toLowerCase() !== buy.address.toLowerCase()) {
      throw mismatch("buy_token_differs");
    }

    const input = BigInt(quote.input.amount);
    const output = BigInt(quote.output.amount);
    if (input === 0n || output === 0n) throw mismatch("zero_amount");

    // The side the person fixed must come back exactly as asked. An AMM moves the OTHER side, never this one.
    const fixed = BigInt(request.amount.amount);
    if (request.mode === "EXACT_INPUT" && input !== fixed) throw mismatch("sell_amount_differs");
    if (request.mode === "EXACT_OUTPUT" && output !== fixed) throw mismatch("buy_amount_differs");

    return {
      id: createId(),
      provider: this.id,
      input: createMoney(quote.input.amount, sell.asset.id),
      output: createMoney(quote.output.amount, buy.asset.id),
      // Percent to basis points, which is how Kaada counts slippage everywhere else.
      ...(quote.slippage !== undefined && { slippageBps: Math.round(quote.slippage * 100) }),
      expiresAt: new Date(this.now().getTime() + this.windowMs),
      ...(quote.quoteId !== undefined && { providerQuoteId: quote.quoteId }),
      metadata: {
        requestId: response.requestId,
        routing: response.routing,
        ...(quote.routeString !== undefined && { routeString: quote.routeString }),
        ...(quote.priceImpact !== undefined && { priceImpact: quote.priceImpact }),
        ...(quote.blockNumber !== undefined && { blockNumber: quote.blockNumber }),
        // What the person is guaranteed if the pool moves against them before the swap lands.
        ...(quote.output.minimumAmount !== undefined && {
          minimumOutput: quote.output.minimumAmount,
        }),
        indicativeWindowMs: this.windowMs,
      },
    };
  }

  private toKaadaError(error: unknown): KaadaError {
    if (error instanceof KaadaError) return error;
    if (error instanceof UniswapClientError) {
      if (error.kind === "NO_QUOTE") {
        return new KaadaError("NO_ROUTE_AVAILABLE", "Uniswap has no route for this request");
      }
      return new KaadaError("PROVIDER_UNAVAILABLE", "the pricing provider could not be reached", {
        details: { kind: error.kind },
      });
    }
    return new KaadaError("PROVIDER_UNAVAILABLE", "the pricing provider could not be reached");
  }
}
