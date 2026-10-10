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
  JsonObject,
  QuoteRequest,
} from "@kaada/domain";

import type { AgentLog } from "../../../core/agent/ports.js";
import { noopLog } from "../../../core/agent/ports.js";
import { TextileClientError } from "./client.js";
import type { TextileCallMeta, TextileClient, TextileRfqRequest } from "./client.js";
import type { PreviewResponse } from "./schemas.js";

/*
 * Textile as an FxProvider: QUOTE ONLY. It prices with POST /v2/rfq/preview (an indicative price:
 * no wallet, nothing reserved) and cannot execute. See docs/textile.md for what the documentation
 * does and does not settle.
 *
 * Hard limits of this instance: Celo mainnet (42220) only; domain asset ids in, token addresses from
 * the asset registry (nothing hard-coded here); the response is validated before it is trusted.
 */

/** How long an indicative price is treated as fresh when the planner asks for an expiry. */
export const DEFAULT_INDICATIVE_WINDOW_MS = 10_000;

export interface TextileFxProviderOptions {
  assets: AssetRegistry;
  client: Pick<TextileClient, "preview">;
  now: () => Date;
  /**
   * Textile documents no expiry on a preview ("a few seconds stale, not a promise"), but the planner
   * needs a validity window. This is Kaada's own freshness policy, recorded in the quote metadata as
   * such; a firm quote's real `expiresAt` replaces it once firm quotes are used.
   * TODO(live): confirm the window with Textile; firm quotes need a funded taker wallet.
   */
  indicativeWindowMs?: number;
  log?: AgentLog;
}

interface Token {
  asset: Asset;
  address: string;
}

export class TextileFxProvider implements FxProvider {
  readonly id = "textile";

  private readonly assets: AssetRegistry;
  private readonly client: Pick<TextileClient, "preview">;
  private readonly now: () => Date;
  private readonly windowMs: number;
  private readonly log: AgentLog;

  constructor(options: TextileFxProviderOptions) {
    this.assets = options.assets;
    this.client = options.client;
    this.now = options.now;
    this.windowMs = options.indicativeWindowMs ?? DEFAULT_INDICATIVE_WINDOW_MS;
    this.log = options.log ?? noopLog;
  }

  /** Structural support only (no network): two distinct, active tokens on Celo mainnet. */
  async supports(request: QuoteRequest): Promise<boolean> {
    try {
      await this.tokens(request);
      return true;
    } catch {
      return false;
    }
  }

  async quote(request: QuoteRequest): Promise<FxQuote> {
    // Rejected locally, before any request leaves the process.
    validateQuoteRequest(request);
    assertSmallestUnitAmount(request.amount.amount);
    const { sell, buy } = await this.tokens(request);

    const rfq: TextileRfqRequest = {
      chainId: CELO_CHAIN_ID,
      sellToken: sell.address,
      buyToken: buy.address,
      exact:
        request.mode === "EXACT_INPUT"
          ? { mode: "EXACT_INPUT", sellAmount: request.amount.amount }
          : { mode: "EXACT_OUTPUT", buyAmount: request.amount.amount },
    };

    const started = this.now().getTime();
    const pair = `${sell.asset.symbol}>${buy.asset.symbol}`;
    try {
      const { data, meta } = await this.client.preview(rfq);
      const quote = this.normalize(request, sell, buy, data);
      this.logCall("info", pair, request, started, { outcome: "quoted", ...callFields(meta) });
      return quote;
    } catch (error) {
      const failure = this.toKaadaError(error);
      this.logCall("warn", pair, request, started, {
        outcome: error instanceof TextileClientError ? error.kind : failure.code,
        ...(error instanceof TextileClientError ? errorFields(error) : {}),
      });
      throw failure;
    }
  }

  /** Quote-only: this provider can never move funds. */
  execute(_quote: FxQuote, _context: FxExecutionContext): Promise<FxExecutionResult> {
    return Promise.reject(
      new KaadaError(
        "EXECUTION_NOT_ENABLED",
        "EXECUTION_NOT_ENABLED: the Textile provider only quotes; it never submits or executes",
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
   * Preview -> FxQuote. Textile's own numbers are used as given (no recomputation):
   * - `takerPays` is the gross, fee-inclusive debit; `feeAmount` is contained in it (documented).
   * - `buyAmount` is the net amount received.
   * EXACT_INPUT: Textile calls `sellAmount` a spend CAP and says `takerPays` is never more than it
   *   (it can differ by the odd atomic unit). Kaada's input is the requested cap, so the planner's
   *   "never spends more than asked" holds; the real debit is kept in metadata.
   * EXACT_OUTPUT: the output must be exactly the requested `buyAmount`; the input is `takerPays`.
   * There is no slippage figure, quote id or expiry on a preview, so none is invented.
   */
  private normalize(
    request: QuoteRequest,
    sell: Token,
    buy: Token,
    data: PreviewResponse["data"],
  ): FxQuote {
    if (data.status === "no_quote") {
      throw new KaadaError("NO_ROUTE_AVAILABLE", "Textile has no quote for this request", {
        details: { providerReason: data.reason ?? "unspecified" },
      });
    }

    const requested = BigInt(request.amount.amount);
    const takerPays = BigInt(data.takerPays);
    const fee = BigInt(data.feeAmount);
    const buyAmount = BigInt(data.buyAmount);
    const mismatch = (reason: string): KaadaError =>
      new KaadaError("PROVIDER_UNAVAILABLE", "the provider response did not match the request", {
        details: { reason },
      });

    if (buyAmount === 0n || takerPays === 0n) throw mismatch("zero_amount");
    if (fee > takerPays) throw mismatch("fee_exceeds_total");

    let input: bigint;
    if (request.mode === "EXACT_INPUT") {
      if (BigInt(data.sellAmount) !== requested) throw mismatch("sell_amount_differs");
      if (takerPays > requested) throw mismatch("spend_exceeds_cap");
      input = requested;
    } else {
      if (buyAmount !== requested) throw mismatch("buy_amount_differs");
      input = takerPays;
    }

    const metadata: JsonObject = {
      source: "textile-rfq-preview",
      // A preview is a price, not a promise: not executable, and not a firm quote.
      indicative: true,
      expiryBasis: "kaada-indicative-window",
      takerPays: data.takerPays,
      ...(data.rateRay !== undefined && { rateRay: data.rateRay }),
    };
    return {
      id: createId(),
      provider: this.id,
      input: createMoney(input.toString(), sell.asset.id),
      output: createMoney(buyAmount.toString(), buy.asset.id),
      fee: createMoney(fee.toString(), sell.asset.id),
      expiresAt: new Date(this.now().getTime() + this.windowMs),
      metadata,
    };
  }

  /** Provider failures become Kaada errors; no provider text, header or key crosses this line. */
  private toKaadaError(error: unknown): KaadaError {
    if (error instanceof KaadaError) return error;
    if (error instanceof TextileClientError) {
      const details = {
        providerKind: error.kind,
        ...(error.meta.httpStatus !== undefined && { httpStatus: error.meta.httpStatus }),
        ...(error.meta.providerCode && { providerCode: error.meta.providerCode }),
        ...(error.meta.requestId && { requestId: error.meta.requestId }),
      };
      if (error.kind === "INVALID_REQUEST") {
        if (error.meta.reason === "corridor_unavailable") {
          return new KaadaError("PAIR_NOT_SUPPORTED", "no corridor for this pair", { details });
        }
        return new KaadaError("NO_ROUTE_AVAILABLE", "the provider rejected the request", {
          details,
        });
      }
      return new KaadaError("PROVIDER_UNAVAILABLE", "the provider is unavailable right now", {
        details,
      });
    }
    return new KaadaError("PROVIDER_UNAVAILABLE", "the provider is unavailable right now");
  }

  private logCall(
    level: "info" | "warn",
    pair: string,
    request: QuoteRequest,
    started: number,
    fields: Record<string, string | number | boolean | undefined>,
  ): void {
    this.log(level, "textile.quote", {
      provider: this.id,
      endpoint: "rfq/preview",
      pair,
      mode: request.mode,
      latencyMs: this.now().getTime() - started,
      ...fields,
    });
  }
}

function callFields(meta: TextileCallMeta) {
  return {
    httpStatus: meta.httpStatus,
    attempts: meta.attempts,
    ...(meta.requestId && { requestId: meta.requestId }),
  };
}

function errorFields(error: TextileClientError) {
  return {
    attempts: error.meta.attempts,
    ...(error.meta.httpStatus !== undefined && { httpStatus: error.meta.httpStatus }),
    ...(error.meta.providerCode && { providerCode: error.meta.providerCode }),
    ...(error.meta.requestId && { requestId: error.meta.requestId }),
  };
}
